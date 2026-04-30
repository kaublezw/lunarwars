import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION, HEALTH, TRAIN_LINK, TRACK_FOLLOWER, PENDING_CAR_ATTACH, MOVE_COMMAND, UNIT_TYPE, MACRO_GRID_SIZE } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { PendingCarAttachComponent } from '@sim/components/PendingCarAttach';
import type { TrackState, TrackWaypoint } from '@sim/logistics/TrackState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { appendCarToTrain, STUB_BEHIND_CELLS, STUB_AHEAD_CELLS } from '@sim/logistics/TrainSpawner';

/** How close (squared distance) an engine must be to HQ to count as "docked". */
const DOCK_DIST_SQ = 36; // 6 wu (track passes 1 grid cell from HQ center)
/** How far from the track segment center-line a unit must be to need clearing. */
const TRACK_CLEAR_RADIUS = 2.0;
/** How far the track waypoint is offset from the building center (1 grid cell). */
const TRACK_ADJACENCY_OFFSET = MACRO_GRID_SIZE;
/** Number of arc samples for 90-degree turns. */
const TURN_ARC_SAMPLES = 6;

/** Direction deltas: 0=North(-Z), 1=East(+X), 2=South(+Z), 3=West(-X) */
const DIR_DX = [0, 1, 0, -1];
const DIR_DZ = [-1, 0, 1, 0];

/** A* search node for grid-based track routing. */
interface TrackStateNode {
  x: number;
  z: number;
  /** 0=North, 1=East, 2=South, 3=West */
  dir: number;
  gCost: number;
  hCost: number;
  parent: TrackStateNode | null;
}

/**
 * TrackManagerSystem computes optimal track circuits (nearest-neighbor TSP)
 * from each team's HQ through all their completed energy extractors and matter
 * plants, returning to HQ.
 *
 * Key behaviors:
 * - Recalculates the optimal circuit whenever the set of living plants changes.
 * - Caches the result as a "pending" route in TrackState.
 * - Only swaps the pending route to active when the team's train engine is
 *   docked at HQ (position within DOCK_DIST_SQ).
 * - If no engine exists yet, the pending route is promoted immediately so the
 *   first train spawned picks it up.
 * - Tracks are visual-only: they do NOT block movement or the spatial hash.
 */
export class TrackManagerSystem implements System {
  readonly name = 'TrackManagerSystem';

  constructor(
    private trackState: TrackState,
    private terrainData: TerrainData,
    private teamCount: number,
  ) {}

  update(world: World, _dt: number): void {
    for (let team = 0; team < this.teamCount; team++) {
      this.updateTeam(world, team);
    }
  }

  private updateTeam(world: World, team: number): void {
    const ts = this.trackState.get(team);

    // 1. Find HQ for this team
    const hqEntity = this.findHQ(world, team);
    if (hqEntity == null) {
      // No HQ = no track
      if (ts.activeRoute.length > 0) {
        ts.activeRoute = [];
        ts.activePlantSnapshot = [];
        ts.pendingRoute = null;
        ts.pendingPlantSnapshot = [];
      }
      return;
    }

    // 2. Collect all completed, living stops (matter plants + supply depots) for this team
    const plants = this.collectStops(world, team);
    const plantIds = plants.map(p => p.entity).sort((a, b) => a - b);

    // 3. Check if the plant set has changed since the last route computation
    const lastSnapshot = ts.pendingRoute != null ? ts.pendingPlantSnapshot : ts.activePlantSnapshot;
    const stopsChanged = !this.arraysEqual(plantIds, lastSnapshot);

    // Also recompute if any non-stop building now sits on the active track
    const buildingOnTrack = !stopsChanged && ts.activeTrackCells.size > 0 &&
      this.hasBuildingOnTrack(world, team, ts.activeTrackCells);

    if (stopsChanged || buildingOnTrack) {
      // 4. Compute new optimal circuit
      const hqPos = world.getComponent<PositionComponent>(hqEntity, POSITION)!;
      const { route, trackCells } = this.computeCircuit(world, hqPos, plants, team);

      // 5. Store as pending (applied when engine docks at HQ)
      this.trackState.setPendingRoute(team, route, plantIds, trackCells);
    }

    // 6. Handle dock operations (route swap + pending car attachment)
    this.handleDockOperations(world, team, hqEntity);
  }

  /** When the engine is docked at HQ: swap pending route and attach pending cargo cars. */
  private handleDockOperations(world: World, team: number, hqEntity: number): void {
    const ts = this.trackState.get(team);
    const engine = this.findEngine(world, team);

    if (engine == null) {
      // No engine yet — promote pending route immediately so it's ready on first spawn
      if (ts.pendingRoute) {
        this.trackState.applyPendingRoute(team);
        this.clearFriendlyUnitsFromTrack(world, team, ts.activeRoute);
      }
      return;
    }

    // Check if engine is docked at HQ
    const enginePos = world.getComponent<PositionComponent>(engine, POSITION);
    const hqPos = world.getComponent<PositionComponent>(hqEntity, POSITION);
    if (!enginePos || !hqPos) return;

    const dx = enginePos.x - hqPos.x;
    const dz = enginePos.z - hqPos.z;
    const docked = dx * dx + dz * dz <= DOCK_DIST_SQ;
    if (!docked) return;

    // Swap pending route to active
    if (ts.pendingRoute) {
      this.trackState.applyPendingRoute(team);
      const follower = world.getComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER);
      if (follower) {
        follower.path = ts.activeRoute.map(w => ({ x: w.x, y: w.y, z: w.z, entityId: w.entityId, isHQ: w.isHQ }));
        follower.distanceAlongSegment = 0;
        follower.direction = 1;
        follower.reconnectTarget = -1;
        follower.halted = false;

        // Find the HQ stop waypoint and start from there so the engine
        // continues in the stub direction without flipping
        const hqIdx = this.findHQWaypointIndex(follower.path);
        follower.currentWaypointIndex = hqIdx;

        // Snap engine to the HQ waypoint position (engine is already nearby)
        if (follower.path.length >= 2) {
          const w0 = follower.path[hqIdx];
          const nextIdx = (hqIdx + 1) % follower.path.length;
          const w1 = follower.path[nextIdx];
          const ePos = world.getComponent<PositionComponent>(engine, POSITION)!;
          ePos.x = w0.x;
          ePos.z = w0.z;
          ePos.y = w0.y;
          ePos.prevX = w0.x;
          ePos.prevZ = w0.z;
          ePos.prevY = w0.y;
          ePos.rotation = Math.atan2(w1.x - w0.x, w1.z - w0.z);
        }
      }
      this.clearFriendlyUnitsFromTrack(world, team, ts.activeRoute);
    } else if (ts.activeRoute.length > 0) {
      // Fill follower from existing active route if path is empty (newly spawned engine)
      const follower = world.getComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER);
      if (follower && follower.path.length === 0) {
        follower.path = ts.activeRoute.map(w => ({ x: w.x, y: w.y, z: w.z, entityId: w.entityId, isHQ: w.isHQ }));
        const hqIdx = this.findHQWaypointIndex(follower.path);
        follower.currentWaypointIndex = hqIdx;
        follower.distanceAlongSegment = 0;
        follower.direction = 1;
        follower.reconnectTarget = -1;
        // Stay halted on stub track (no plants); only run on a real circuit
        follower.halted = ts.activePlantSnapshot.length === 0;
      }
    }

    // Attach any pending cargo cars to the train chain
    const pendingCars = world.query(PENDING_CAR_ATTACH, TRAIN_LINK);
    for (const car of pendingCars) {
      const pending = world.getComponent<PendingCarAttachComponent>(car, PENDING_CAR_ATTACH)!;
      if (pending.team !== team) continue;

      // Move car to HQ position before attaching
      const carPos = world.getComponent<PositionComponent>(car, POSITION);
      if (carPos) {
        carPos.x = hqPos.x;
        carPos.z = hqPos.z;
        carPos.y = hqPos.y;
        carPos.prevX = hqPos.x;
        carPos.prevZ = hqPos.z;
        carPos.prevY = hqPos.y;
      }

      appendCarToTrain(world, engine, car);
      world.removeComponent(car, PENDING_CAR_ATTACH);
    }
  }

  /**
   * Push friendly units off the track when a new route is activated.
   * For each segment, find nearby friendly non-train units and issue move commands
   * to push them perpendicular to the track.
   */
  private clearFriendlyUnitsFromTrack(world: World, team: number, route: TrackWaypoint[]): void {
    if (route.length < 2) return;

    const units = world.query(POSITION, TEAM, HEALTH, UNIT_TYPE);
    for (const e of units) {
      if (world.hasComponent(e, TRAIN_LINK)) continue;
      if (world.hasComponent(e, BUILDING)) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const h = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (h.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Check if this unit is near any track segment
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i];
        const b = route[i + 1];
        const dist = this.pointToSegmentDist(pos.x, pos.z, a.x, a.z, b.x, b.z);
        if (dist < TRACK_CLEAR_RADIUS) {
          // Push perpendicular to the segment
          const segDx = b.x - a.x;
          const segDz = b.z - a.z;
          const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
          // Perpendicular direction (rotate segment 90 degrees)
          let perpX = -segDz / (segLen || 1);
          let perpZ = segDx / (segLen || 1);
          // Pick the side the unit is already leaning toward
          const toUnitX = pos.x - a.x;
          const toUnitZ = pos.z - a.z;
          if (toUnitX * perpX + toUnitZ * perpZ < 0) {
            perpX = -perpX;
            perpZ = -perpZ;
          }
          const pushDist = TRACK_CLEAR_RADIUS + 1.5;
          const destX = Math.max(4, Math.min(252, pos.x + perpX * pushDist));
          const destZ = Math.max(4, Math.min(252, pos.z + perpZ * pushDist));

          if (world.hasComponent(e, MOVE_COMMAND)) {
            world.removeComponent(e, MOVE_COMMAND);
          }
          world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
            path: [],
            currentWaypoint: 0,
            destX,
            destZ,
          });
          break; // Only push once per unit
        }
      }
    }
  }

  /** Distance from point (px,pz) to line segment (ax,az)-(bx,bz). */
  private pointToSegmentDist(
    px: number, pz: number,
    ax: number, az: number,
    bx: number, bz: number,
  ): number {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 0.001) {
      const ex = px - ax;
      const ez = pz - az;
      return Math.sqrt(ex * ex + ez * ez);
    }
    let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = ax + t * dx;
    const closestZ = az + t * dz;
    const ex = px - closestX;
    const ez = pz - closestZ;
    return Math.sqrt(ex * ex + ez * ez);
  }

  /** Append nodes to target, skipping the first node if it duplicates the tail. */
  private appendNodesDedup(target: TrackStateNode[], source: TrackStateNode[]): void {
    for (let j = 0; j < source.length; j++) {
      if (j === 0 && target.length > 0) {
        const last = target[target.length - 1];
        if (last.x === source[0].x && last.z === source[0].z &&
            last.dir === source[0].dir) {
          continue;
        }
      }
      target.push(source[j]);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Step 3: Momentum-Aware Circuit Generation
  // ───────────────────────────────────────────────────────────────────────

  private computeCircuit(
    world: World,
    hqPos: PositionComponent,
    plants: { entity: number; x: number; z: number }[],
    team: number,
  ): { route: TrackWaypoint[]; trackCells: Set<string> } {
    if (plants.length === 0) return { route: [], trackCells: new Set() };

    // 3a. Nearest-neighbor TSP to determine stop order
    const stopOrder: { x: number; z: number; entity: number | null; isHQ: boolean }[] =
      [{ x: hqPos.x, z: hqPos.z, entity: null, isHQ: true }];
    const visited = new Array<boolean>(plants.length).fill(false);
    let curX = hqPos.x, curZ = hqPos.z;

    for (let step = 0; step < plants.length; step++) {
      let bestIdx = -1, bestDistSq = Infinity;
      for (let i = 0; i < plants.length; i++) {
        if (visited[i]) continue;
        const dx = plants[i].x - curX, dz = plants[i].z - curZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) { bestDistSq = distSq; bestIdx = i; }
      }
      visited[bestIdx] = true;
      curX = plants[bestIdx].x; curZ = plants[bestIdx].z;
      stopOrder.push({ x: curX, z: curZ, entity: plants[bestIdx].entity, isHQ: false });
    }

    // 3b. Build a set of blocked grid cells (all buildings + construction sites).
    const blockedCells = new Set<string>();
    const allBuildings = world.query(BUILDING, POSITION);
    for (const e of allBuildings) {
      const b = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (b.buildingType === BuildingType.PowerPole) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const bgx = Math.round(pos.x / MACRO_GRID_SIZE);
      const bgz = Math.round(pos.z / MACRO_GRID_SIZE);
      blockedCells.add(`${bgx},${bgz}`);
    }
    const allSites = world.query(CONSTRUCTION, POSITION);
    for (const e of allSites) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const bgx = Math.round(pos.x / MACRO_GRID_SIZE);
      const bgz = Math.round(pos.z / MACRO_GRID_SIZE);
      blockedCells.add(`${bgx},${bgz}`);
    }

    // 3c. For each building, pick the best adjacent grid cell as the track target.
    // Skip stops that have no valid adjacent cell (hemmed in by terrain/buildings).
    const ts = this.trackState.get(team);
    const gridStops: { gx: number; gz: number; entity: number | null; isHQ: boolean; origX: number; origZ: number }[] = [];
    for (const stop of stopOrder) {
      const bgx = Math.round(stop.x / MACRO_GRID_SIZE);
      const bgz = Math.round(stop.z / MACRO_GRID_SIZE);

      // HQ: use the predetermined stub cell so the train doesn't warp
      if (stop.isHQ && ts.hqStubCell) {
        gridStops.push({
          gx: ts.hqStubCell.gx, gz: ts.hqStubCell.gz,
          entity: stop.entity, isHQ: true,
          origX: stop.x, origZ: stop.z,
        });
        continue;
      }

      // Pick the adjacent cell that is farthest from other blocked cells
      // (to give the A* the most room to maneuver)
      let bestGx = bgx + 1, bestGz = bgz;
      let bestScore = -Infinity;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = bgx + dx;
        const nz = bgz + dz;
        const wx = nx * MACRO_GRID_SIZE;
        const wz = nz * MACRO_GRID_SIZE;
        if (wx < 4 || wx > 252 || wz < 4 || wz > 252) continue;
        if (!this.terrainData.isPassable(wx, wz)) continue;
        if (blockedCells.has(`${nx},${nz}`)) continue;
        // Score: count how many of this cell's cardinal neighbors are passable and not blocked
        let freeNeighbors = 0;
        for (const [dx2, dz2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nwx = (nx + dx2) * MACRO_GRID_SIZE;
          const nwz = (nz + dz2) * MACRO_GRID_SIZE;
          if (!blockedCells.has(`${nx + dx2},${nz + dz2}`) &&
              this.terrainData.isPassable(nwx, nwz)) freeNeighbors++;
        }
        if (freeNeighbors > bestScore) {
          bestScore = freeNeighbors;
          bestGx = nx;
          bestGz = nz;
        }
      }
      // HQ is always included; skip non-HQ stops with no valid adjacent cell
      if (bestScore === -Infinity && !stop.isHQ) continue;
      gridStops.push({
        gx: bestGx,
        gz: bestGz,
        entity: stop.entity,
        isHQ: stop.isHQ,
        origX: stop.x,
        origZ: stop.z,
      });
    }
    // Need at least HQ + 1 plant to form a circuit
    if (gridStops.length < 2) return { route: [], trackCells: new Set<string>() };

    // 3d. Build stub track nodes (always conserved as the start of the circuit).
    // The stub is a straight track extending behind/ahead of the engine cell.
    const stubDir = ts.hqStubCell?.direction ?? 2;
    const stubGx = gridStops[0].gx;
    const stubGz = gridStops[0].gz;

    const stubNodes: TrackStateNode[] = [];
    for (let i = -STUB_BEHIND_CELLS; i <= STUB_AHEAD_CELLS; i++) {
      const gx = stubGx + DIR_DX[stubDir] * i;
      const gz = stubGz + DIR_DZ[stubDir] * i;
      const wx = gx * MACRO_GRID_SIZE;
      const wz = gz * MACRO_GRID_SIZE;
      if (wx < 4 || wx > 252 || wz < 4 || wz > 252) continue;
      if (!this.terrainData.isPassable(wx, wz)) continue;
      if (blockedCells.has(`${gx},${gz}`)) continue;
      stubNodes.push({ x: gx, z: gz, dir: stubDir, gCost: 0, hCost: 0, parent: null });
    }
    if (stubNodes.length < 2) return { route: [], trackCells: new Set<string>() };

    const stubSouthEnd = stubNodes[stubNodes.length - 1];
    const stubNorthEnd = stubNodes[0];

    // Plant stops only (HQ is handled by the stub)
    const plantStops = gridStops.filter(gs => !gs.isHQ);
    if (plantStops.length === 0) return { route: [], trackCells: new Set<string>() };

    // 3e. Chain A* from stub south end through all plants, returning to stub north end.
    const masterPath: TrackStateNode[] = [...stubNodes];
    let mom = stubDir;
    let fromGx = stubSouthEnd.x;
    let fromGz = stubSouthEnd.z;

    for (let i = 0; i < plantStops.length; i++) {
      const to = plantStops[i];
      const result = this.findDiscretePath(fromGx, fromGz, mom, to.gx, to.gz, blockedCells);
      if (result.path.length === 0) return { route: [], trackCells: new Set<string>() };
      this.appendNodesDedup(masterPath, result.path);
      mom = result.exitDir;
      const end = result.path[result.path.length - 1];
      fromGx = end.x;
      fromGz = end.z;
    }

    // Return leg: back to stub north end, preferring arrival in stub direction
    // so the loop wraps smoothly into the stub
    let returnResult = this.findDiscretePath(
      fromGx, fromGz, mom, stubNorthEnd.x, stubNorthEnd.z, blockedCells, stubDir,
    );
    if (returnResult.path.length === 0) {
      // Fallback: no direction constraint
      returnResult = this.findDiscretePath(
        fromGx, fromGz, mom, stubNorthEnd.x, stubNorthEnd.z, blockedCells,
      );
    }
    if (returnResult.path.length === 0) return { route: [], trackCells: new Set<string>() };
    this.appendNodesDedup(masterPath, returnResult.path);

    if (masterPath.length < 2) return { route: [], trackCells: new Set<string>() };

    // VALIDATE: every consecutive pair must be same-dir (straight) or +-1 dir (90-degree turn)
    const DIR_NAMES = ['N', 'E', 'S', 'W'];
    for (let i = 0; i < masterPath.length - 1; i++) {
      const a = masterPath[i];
      const b = masterPath[i + 1];
      const dd = ((b.dir - a.dir) + 4) % 4;
      if (dd !== 0 && dd !== 1 && dd !== 3) {
        console.error(`TRACK VIOLATION dir at [${i}]: ${DIR_NAMES[a.dir]}->${DIR_NAMES[b.dir]} pos (${a.x},${a.z})->(${b.x},${b.z})`);
      }
      if (a.dir === b.dir) {
        const expectedX = a.x + DIR_DX[a.dir];
        const expectedZ = a.z + DIR_DZ[a.dir];
        if (b.x !== expectedX || b.z !== expectedZ) {
          console.error(`TRACK VIOLATION straight at [${i}]: dir=${DIR_NAMES[a.dir]} (${a.x},${a.z})->(${b.x},${b.z}) expected (${expectedX},${expectedZ})`);
        }
      } else {
        // Curve: check diagonal move is correct
        const isRight = dd === 1;
        const sideDir = isRight ? (a.dir + 1) % 4 : (a.dir + 3) % 4;
        const expectedX = a.x + DIR_DX[a.dir] + DIR_DX[sideDir];
        const expectedZ = a.z + DIR_DZ[a.dir] + DIR_DZ[sideDir];
        if (b.x !== expectedX || b.z !== expectedZ) {
          console.error(`TRACK VIOLATION curve at [${i}]: dir=${DIR_NAMES[a.dir]}->${DIR_NAMES[b.dir]} (${a.x},${a.z})->(${b.x},${b.z}) expected (${expectedX},${expectedZ})`);
        }
      }
    }

    // 3e. Extract grid cells occupied by the track (for placement blocking).
    const trackCells = new Set<string>();
    for (let i = 0; i < masterPath.length; i++) {
      trackCells.add(`${masterPath[i].x},${masterPath[i].z}`);
      // For curves, also include the diagonal cell the arc sweeps through
      if (i > 0 && masterPath[i].dir !== masterPath[i - 1].dir) {
        const prev = masterPath[i - 1];
        const isRight = ((masterPath[i].dir - prev.dir + 4) % 4) === 1;
        const perpDir = isRight ? (prev.dir + 1) % 4 : (prev.dir + 3) % 4;
        trackCells.add(`${prev.x + DIR_DX[perpDir]},${prev.z + DIR_DZ[perpDir]}`);
      }
    }

    // 3f. Convert master node path to world-space TrackWaypoints
    const route = this.nodesToWaypoints(masterPath);

    // 3g. Map entityIds — for each building, find the closest waypoint
    // (which will be on an adjacent grid cell, close enough for load/unload)
    for (const gs of gridStops) {
      let bestIdx = 0;
      let bestDistSq = Infinity;
      for (let i = 0; i < route.length; i++) {
        const dx = route[i].x - gs.origX;
        const dz = route[i].z - gs.origZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) { bestDistSq = distSq; bestIdx = i; }
      }
      route[bestIdx].entityId = gs.entity;
      route[bestIdx].isHQ = gs.isHQ;
    }

    return { route, trackCells };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Step 2: The A* Pathfinder
  // ───────────────────────────────────────────────────────────────────────

  /**
   * State-space A* on the track grid.
   * State = (gridX, gridZ, facing direction).
   *
   * Three moves:
   * - Straight: forward 1 grid unit in current dir. Cost = 1.0.
   * - Curve Right: dir+1, position = forward 1 + right 1. Cost = 1.5.
   * - Curve Left: dir-1, position = forward 1 + left 1. Cost = 1.5.
   *
   * Returns the path and the exit direction of the final node.
   */
  private findDiscretePath(
    startGx: number, startGz: number, startDir: number,
    goalGx: number, goalGz: number,
    blockedCells?: Set<string>,
    goalDir?: number,
  ): { path: TrackStateNode[]; exitDir: number } {
    const key = (x: number, z: number, d: number) => `${x},${z},${d}`;
    const heuristic = (x: number, z: number) =>
      Math.abs(x - goalGx) + Math.abs(z - goalGz);

    const open: TrackStateNode[] = [];
    const bestG = new Map<string, number>();

    // Seed with ONLY the exact starting direction (strict momentum).
    // The A* will use curve moves to change direction — no in-place turns.
    {
      const node: TrackStateNode = {
        x: startGx, z: startGz, dir: startDir,
        gCost: 0, hCost: heuristic(startGx, startGz),
        parent: null,
      };
      open.push(node);
      bestG.set(key(startGx, startGz, startDir), 0);
    }

    let found: TrackStateNode | null = null;
    let iterations = 0;
    const MAX_ITERATIONS = 10000;

    while (open.length > 0 && iterations < MAX_ITERATIONS) {
      iterations++;

      // Pop lowest fCost
      let bestI = 0;
      for (let i = 1; i < open.length; i++) {
        const fa = open[bestI].gCost + open[bestI].hCost;
        const fb = open[i].gCost + open[i].hCost;
        if (fb < fa || (fb === fa && open[i].hCost < open[bestI].hCost)) {
          bestI = i;
        }
      }
      const current = open[bestI];
      open[bestI] = open[open.length - 1];
      open.pop();

      if (current.x === goalGx && current.z === goalGz &&
          (goalDir == null || current.dir === goalDir)) {
        found = current;
        break;
      }

      const ck = key(current.x, current.z, current.dir);
      if ((bestG.get(ck) ?? Infinity) < current.gCost) continue;

      const rightDir = (current.dir + 1) % 4;
      const leftDir = (current.dir + 3) % 4;

      const neighbors: { nx: number; nz: number; nd: number; cost: number }[] = [
        // Straight
        {
          nx: current.x + DIR_DX[current.dir],
          nz: current.z + DIR_DZ[current.dir],
          nd: current.dir,
          cost: 1.0,
        },
        // Curve Right: forward + right (heavy penalty to prefer straightaways)
        {
          nx: current.x + DIR_DX[current.dir] + DIR_DX[rightDir],
          nz: current.z + DIR_DZ[current.dir] + DIR_DZ[rightDir],
          nd: rightDir,
          cost: 2.5,
        },
        // Curve Left: forward + left (heavy penalty to prefer straightaways)
        {
          nx: current.x + DIR_DX[current.dir] + DIR_DX[leftDir],
          nz: current.z + DIR_DZ[current.dir] + DIR_DZ[leftDir],
          nd: leftDir,
          cost: 2.5,
        },
      ];

      for (const n of neighbors) {
        const wx = n.nx * MACRO_GRID_SIZE;
        const wz = n.nz * MACRO_GRID_SIZE;
        if (wx < 4 || wx > 252 || wz < 4 || wz > 252) continue;
        if (!this.terrainData.isPassable(wx, wz)) continue;
        if (blockedCells && blockedCells.has(`${n.nx},${n.nz}`)) continue;

        // For curve moves, check the diagonal cell the arc swings through.
        // The pivot is perpendicular to current dir; the arc midpoint passes
        // through the cell that is diagonally adjacent (forward + turn side).
        if (n.nd !== current.dir) {
          const isRight = n.nd === rightDir;
          const perpD = isRight ? rightDir : leftDir;
          // The diagonal cell the arc interior passes closest to
          const diagGx = current.x + DIR_DX[perpD];
          const diagGz = current.z + DIR_DZ[perpD];
          const diagWx = diagGx * MACRO_GRID_SIZE;
          const diagWz = diagGz * MACRO_GRID_SIZE;
          if (!this.terrainData.isPassable(diagWx, diagWz)) {
            continue; // Arc would clip a mountain
          }
          if (blockedCells && blockedCells.has(`${diagGx},${diagGz}`)) {
            continue; // Arc would clip a building
          }
        }

        const g = current.gCost + n.cost;
        const nk = key(n.nx, n.nz, n.nd);
        if (g >= (bestG.get(nk) ?? Infinity)) continue;
        bestG.set(nk, g);

        open.push({
          x: n.nx, z: n.nz, dir: n.nd,
          gCost: g, hCost: heuristic(n.nx, n.nz),
          parent: current,
        });
      }
    }

    // Reconstruct
    if (!found) {
      console.warn(`A* FAILED: (${startGx},${startGz}) dir=${startDir} -> (${goalGx},${goalGz}), iterations=${iterations}, open=${open.length}`);
      // Return empty path — do NOT emit an invalid straight line
      return { path: [], exitDir: startDir };
    }

    const result: TrackStateNode[] = [];
    let node: TrackStateNode | null = found;
    while (node) {
      result.push(node);
      node = node.parent;
    }
    result.reverse();
    return { path: result, exitDir: found.dir };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Step 4: Perfect Arc Generation
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Convert TrackStateNode[] to world-space waypoints using tangentially
   * connected track pieces (straights + quarter-circle arcs).
   *
   * GEOMETRY (worked example: North then right-turn to East):
   *
   *   Node A at grid (3,5) facing North. Node B at grid (4,4) facing East.
   *   World: A = (12, 20), B = (16, 16). G = 4, R = 4.
   *
   *   The STRAIGHT piece before A runs along -Z through A's grid center.
   *   The STRAIGHT piece after B runs along +X through B's grid center.
   *
   *   The CURVE connects them. For a right turn from North:
   *     - Pivot = A's center + R in the RIGHT direction (+X) = (16, 20)
   *     - Arc entry (tangent to incoming -Z straight) = A center = (12, 20)
   *       Tangent direction at entry = North = (0, -1) CHECK
   *     - Arc exit = pivot + R in the outgoing-backward direction (-X from East)
   *       = (16, 20) + (0, -4) = (16, 16) = B center
   *       Tangent direction at exit = East = (1, 0) CHECK
   *     - Arc sweeps CW from entry to exit: -PI/2
   *
   *   The entry/exit points coincide with grid centers A and B.
   *   The tangent at entry matches the incoming straight direction.
   *   The tangent at exit matches the outgoing straight direction.
   *   No kink at any junction.
   *
   * APPROACH:
   *   1. Walk the node list. For each consecutive pair:
   *      - Same direction: this is part of a straight run. Collect the points.
   *      - Direction change: emit a curve arc.
   *   2. Between curves (or at start/end), emit the straight waypoints.
   *   3. Curves emit sampled arc waypoints from entry to exit.
   *      The first arc sample IS the entry point (= prev straight's last point).
   *      The last arc sample IS the exit point (= next straight's first point).
   *      So we skip the first sample of each arc to avoid duplicate waypoints.
   */
  private nodesToWaypoints(nodes: TrackStateNode[]): TrackWaypoint[] {
    if (nodes.length < 2) return [];

    const route: TrackWaypoint[] = [];
    const G = MACRO_GRID_SIZE;
    const R = G;
    const ARC_SAMPLES = 16;

    // Helper: push a world-space waypoint
    const emit = (x: number, z: number) => {
      route.push({
        x, y: this.terrainData.getHeight(x, z), z,
        entityId: null, isHQ: false,
      });
    };

    // Emit the first node
    emit(nodes[0].x * G, nodes[0].z * G);

    for (let i = 0; i < nodes.length - 1; i++) {
      const prev = nodes[i];
      const curr = nodes[i + 1];

      if (prev.dir === curr.dir) {
        // Straight: emit the next grid center
        emit(curr.x * G, curr.z * G);
      } else {
        // Curve: quarter-circle arc from prev's center to curr's center
        const prevWx = prev.x * G;
        const prevWz = prev.z * G;
        const currWx = curr.x * G;
        const currWz = curr.z * G;

        const isRight = ((curr.dir - prev.dir + 4) % 4) === 1;

        // Pivot: R perpendicular to incoming direction, on the turn side
        const perpDir = isRight ? (prev.dir + 1) % 4 : (prev.dir + 3) % 4;
        const pivotX = prevWx + DIR_DX[perpDir] * R;
        const pivotZ = prevWz + DIR_DZ[perpDir] * R;

        // Start angle: from pivot toward prev center (the arc entry)
        const startAng = Math.atan2(prevWz - pivotZ, prevWx - pivotX);
        // Sweep: exactly 90 degrees.
        // Right turn = CCW from pivot's perspective (+PI/2)
        // Left turn = CW from pivot's perspective (-PI/2)
        const sweep = isRight ? Math.PI / 2 : -Math.PI / 2;

        // Emit arc samples (skip j=0 since it equals prevWx,prevWz which is already emitted)
        for (let j = 1; j <= ARC_SAMPLES; j++) {
          const t = j / ARC_SAMPLES;
          const ang = startAng + sweep * t;
          emit(pivotX + Math.cos(ang) * R, pivotZ + Math.sin(ang) * R);
        }
        // The last sample (j=ARC_SAMPLES) should land exactly at currWx, currWz.
        // Due to floating point, force it exact:
        const lastIdx = route.length - 1;
        route[lastIdx].x = currWx;
        route[lastIdx].z = currWz;
        route[lastIdx].y = this.terrainData.getHeight(currWx, currWz);
      }
    }

    return route;
  }

  /** Find completed, living matter plants and supply depots for a team. */
  private collectStops(world: World, team: number): { entity: number; x: number; z: number }[] {
    const result: { entity: number; x: number; z: number }[] = [];
    const entities = world.query(BUILDING, TEAM);

    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.MatterPlant && building.buildingType !== BuildingType.SupplyDepot) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      result.push({ entity: e, x: pos.x, z: pos.z });
    }

    return result;
  }

  /** Find HQ entity for a team. */
  private findHQ(world: World, team: number): number | null {
    const entities = world.query(BUILDING, TEAM);
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      return e;
    }
    return null;
  }

  /** Find the index of the HQ stop waypoint in a path. Falls back to 0. */
  private findHQWaypointIndex(path: { isHQ: boolean }[]): number {
    for (let i = 0; i < path.length; i++) {
      if (path[i].isHQ) return i;
    }
    return 0;
  }

  /** Find the train engine for a team. */
  private findEngine(world: World, team: number): number | null {
    const entities = world.query(TRAIN_LINK, TEAM);
    for (const e of entities) {
      const link = world.getComponent<TrainLinkComponent>(e, TRAIN_LINK)!;
      if (!link.isEngine) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const h = world.getComponent<HealthComponent>(e, HEALTH);
      if (h && h.dead) continue;
      return e;
    }
    return null;
  }

  /** Check if any completed building (non-pole) sits on one of the given track cells. */
  private hasBuildingOnTrack(world: World, team: number, trackCells: Set<string>): boolean {
    const buildings = world.query(BUILDING, POSITION, TEAM);
    for (const e of buildings) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const b = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (b.buildingType === BuildingType.PowerPole) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const gx = Math.round(pos.x / MACRO_GRID_SIZE);
      const gz = Math.round(pos.z / MACRO_GRID_SIZE);
      if (trackCells.has(`${gx},${gz}`)) return true;
    }
    // Also check construction sites
    const sites = world.query(CONSTRUCTION, POSITION, TEAM);
    for (const e of sites) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const gx = Math.round(pos.x / MACRO_GRID_SIZE);
      const gz = Math.round(pos.z / MACRO_GRID_SIZE);
      if (trackCells.has(`${gx},${gz}`)) return true;
    }
    return false;
  }

  /** Compare two sorted number arrays for equality. */
  private arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
