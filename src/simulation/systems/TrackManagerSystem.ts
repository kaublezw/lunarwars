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
import { appendCarToTrain } from '@sim/logistics/TrainSpawner';

/** How close (squared distance) an engine must be to HQ to count as "docked". */
const DOCK_DIST_SQ = 25; // 5 wu (accounts for track running adjacent to HQ)
/** How far from the track segment center-line a unit must be to need clearing. */
const TRACK_CLEAR_RADIUS = 2.0;
/** How far the track waypoint is offset from the building center. */
const TRACK_ADJACENCY_OFFSET = 3.5;
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

    // 2. Collect all completed, living plants (extractors + matter plants) for this team
    const plants = this.collectPlants(world, team);
    const plantIds = plants.map(p => p.entity).sort((a, b) => a - b);

    // 3. Check if the plant set has changed since the last route computation
    const lastSnapshot = ts.pendingRoute != null ? ts.pendingPlantSnapshot : ts.activePlantSnapshot;
    if (!this.arraysEqual(plantIds, lastSnapshot)) {
      // 4. Compute new optimal circuit
      const hqPos = world.getComponent<PositionComponent>(hqEntity, POSITION)!;
      const route = this.computeCircuit(hqPos, plants);

      // 5. Store as pending
      this.trackState.setPendingRoute(team, route, plantIds);
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
        follower.currentWaypointIndex = 0;
        follower.distanceAlongSegment = 0;
        follower.direction = 1;
        follower.reconnectTarget = -1;
        follower.halted = false;
      }
      this.clearFriendlyUnitsFromTrack(world, team, ts.activeRoute);
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

  // ───────────────────────────────────────────────────────────────────────
  // Step 3: Momentum-Aware Circuit Generation
  // ───────────────────────────────────────────────────────────────────────

  private computeCircuit(
    hqPos: PositionComponent,
    plants: { entity: number; x: number; z: number }[],
  ): TrackWaypoint[] {
    if (plants.length === 0) return [];

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

    // 3b. Snap stops to grid + offset so track runs beside buildings
    let centX = 0, centZ = 0;
    for (const s of stopOrder) { centX += s.x; centZ += s.z; }
    centX /= stopOrder.length; centZ /= stopOrder.length;

    const gridStops = stopOrder.map(stop => {
      let outDx = stop.x - centX, outDz = stop.z - centZ;
      const outLen = Math.sqrt(outDx * outDx + outDz * outDz);
      if (outLen > 0.5) { outDx /= outLen; outDz /= outLen; }
      else { outDx = 1; outDz = 0; }
      const offX = stop.x + outDx * TRACK_ADJACENCY_OFFSET;
      const offZ = stop.z + outDz * TRACK_ADJACENCY_OFFSET;
      return {
        gx: Math.round(offX / MACRO_GRID_SIZE),
        gz: Math.round(offZ / MACRO_GRID_SIZE),
        entity: stop.entity,
        isHQ: stop.isHQ,
        origX: stop.x,
        origZ: stop.z,
      };
    });

    // 3c. Chain findDiscretePath calls with momentum awareness.
    // exitDir from each segment feeds as startDir into the next.
    const masterPath: TrackStateNode[] = [];
    let momentum = 0; // First segment leaving HQ starts at dir=0 (North)

    for (let i = 0; i < gridStops.length; i++) {
      const from = gridStops[i];
      const to = gridStops[(i + 1) % gridStops.length];
      const result = this.findDiscretePath(from.gx, from.gz, momentum, to.gx, to.gz);

      // Skip first node if it duplicates the tail of the previous segment
      const startIdx = (masterPath.length > 0 && result.path.length > 0) ? 1 : 0;
      for (let j = startIdx; j < result.path.length; j++) {
        masterPath.push(result.path[j]);
      }
      momentum = result.exitDir;
    }

    if (masterPath.length < 2) return [];

    // 3d. Convert master node path to world-space TrackWaypoints (Step 4)
    const route = this.nodesToWaypoints(masterPath);

    // 3e. Map entityIds — for each stop, find the closest generated waypoint
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

    // Close the loop
    if (route.length > 0) {
      route.push({ ...route[0], entityId: null, isHQ: false });
    }

    return route;
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
  ): { path: TrackStateNode[]; exitDir: number } {
    const key = (x: number, z: number, d: number) => `${x},${z},${d}`;
    const heuristic = (x: number, z: number) =>
      Math.abs(x - goalGx) + Math.abs(z - goalGz);

    const open: TrackStateNode[] = [];
    const bestG = new Map<string, number>();

    // Seed with preferred starting direction (slight penalty for others)
    for (let d = 0; d < 4; d++) {
      const g = d === startDir ? 0 : 0.5;
      const node: TrackStateNode = {
        x: startGx, z: startGz, dir: d,
        gCost: g, hCost: heuristic(startGx, startGz),
        parent: null,
      };
      open.push(node);
      bestG.set(key(startGx, startGz, d), g);
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

      if (current.x === goalGx && current.z === goalGz) {
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
      const fallback: TrackStateNode[] = [
        { x: startGx, z: startGz, dir: startDir, gCost: 0, hCost: 0, parent: null },
        { x: goalGx, z: goalGz, dir: startDir, gCost: 0, hCost: 0, parent: null },
      ];
      return { path: fallback, exitDir: startDir };
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
   * Convert TrackStateNode[] to world-space TrackWaypoint[].
   * Straights emit a single waypoint at the grid center.
   * Curves emit a smooth 90-degree arc with radius = full MACRO_GRID_SIZE,
   * using proper pivot alignment and standard angular normalization.
   */
  private nodesToWaypoints(nodes: TrackStateNode[]): TrackWaypoint[] {
    const route: TrackWaypoint[] = [];
    const R = MACRO_GRID_SIZE; // Full grid size radius, not half

    for (let i = 0; i < nodes.length; i++) {
      const curr = nodes[i];
      const prev = i > 0 ? nodes[i - 1] : null;

      const wx = curr.x * MACRO_GRID_SIZE;
      const wz = curr.z * MACRO_GRID_SIZE;

      // Straight piece
      if (!prev || prev.dir === curr.dir) {
        route.push({
          x: wx, y: this.terrainData.getHeight(wx, wz), z: wz,
          entityId: null, isHQ: false,
        });
        continue;
      }

      // Curve piece
      const prevWx = prev.x * MACRO_GRID_SIZE;
      const prevWz = prev.z * MACRO_GRID_SIZE;
      const turn = ((curr.dir - prev.dir + 4) % 4) === 1 ? 'RIGHT' : 'LEFT';

      let pivotX = prevWx;
      let pivotZ = prevWz;

      if (prev.dir === 0) { // Facing North (-Z)
        pivotX += turn === 'RIGHT' ? R : -R;
      } else if (prev.dir === 1) { // Facing East (+X)
        pivotZ += turn === 'RIGHT' ? R : -R;
      } else if (prev.dir === 2) { // Facing South (+Z)
        pivotX += turn === 'RIGHT' ? -R : R;
      } else if (prev.dir === 3) { // Facing West (-X)
        pivotZ += turn === 'RIGHT' ? -R : R;
      }

      const startAng = Math.atan2(prevWz - pivotZ, prevWx - pivotX);
      const endAng = Math.atan2(wz - pivotZ, wx - pivotX);

      // Clean angular normalization
      let sweep = endAng - startAng;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;

      const ARC_SAMPLES = 8;
      for (let j = 0; j <= ARC_SAMPLES; j++) {
        const t = j / ARC_SAMPLES;
        const ang = startAng + sweep * t;
        const px = pivotX + Math.cos(ang) * R;
        const pz = pivotZ + Math.sin(ang) * R;
        route.push({
          x: px, y: this.terrainData.getHeight(px, pz), z: pz,
          entityId: null, isHQ: false,
        });
      }
    }

    return route;
  }

  /** Find completed, living extractors and matter plants for a team. */
  private collectPlants(world: World, team: number): { entity: number; x: number; z: number }[] {
    const result: { entity: number; x: number; z: number }[] = [];
    const entities = world.query(BUILDING, TEAM);

    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (
        building.buildingType !== BuildingType.EnergyExtractor &&
        building.buildingType !== BuildingType.MatterPlant
      ) continue;
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

  /** Find the train engine for a team. */
  private findEngine(world: World, team: number): number | null {
    const entities = world.query(TRAIN_LINK, TEAM);
    for (const e of entities) {
      const link = world.getComponent<TrainLinkComponent>(e, TRAIN_LINK)!;
      if (!link.isEngine) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      return e;
    }
    return null;
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
