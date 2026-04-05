import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION, HEALTH, TRAIN_LINK, TRACK_FOLLOWER, PENDING_CAR_ATTACH, MOVE_COMMAND, UNIT_TYPE } from '@sim/components/ComponentTypes';
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

  /**
   * Compute grid-snapped intermediate waypoints between two points.
   * Moves diagonally (45 degrees) first, then straight along the remaining axis.
   * Returns only the corner point (if any), NOT including from or to.
   */
  private octilePath(
    fromX: number, fromZ: number,
    toX: number, toZ: number,
  ): { x: number; z: number }[] {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const absDx = Math.abs(dx);
    const absDz = Math.abs(dz);

    // If already aligned on one axis or perfectly diagonal, no corner needed
    if (absDx < 0.5 || absDz < 0.5 || Math.abs(absDx - absDz) < 0.5) {
      return [];
    }

    const signX = dx > 0 ? 1 : -1;
    const signZ = dz > 0 ? 1 : -1;

    // Diagonal distance is the shorter axis
    const diagDist = Math.min(absDx, absDz);

    // Corner point: move diagonally first, then straight
    const cornerX = fromX + signX * diagDist;
    const cornerZ = fromZ + signZ * diagDist;

    return [{ x: cornerX, z: cornerZ }];
  }

  /**
   * 1. Compute the optimal route through building centers (nearest-neighbor TSP).
   * 2. For each building, generate a circular arc at TRACK_ADJACENCY_OFFSET radius.
   *    The arc connects where the incoming segment hits the circle to where
   *    the outgoing segment leaves it, taking the short way around in 45-degree steps.
   * 3. Connect arcs with octile straight segments.
   */
  private computeCircuit(
    hqPos: PositionComponent,
    plants: { entity: number; x: number; z: number }[],
  ): TrackWaypoint[] {
    if (plants.length === 0) return [];

    // Step 1: Optimal route through building centers (nearest-neighbor TSP)
    interface Stop { x: number; z: number; entity: number | null }
    const hqStop: Stop = { x: hqPos.x, z: hqPos.z, entity: null };
    const visited = new Array<boolean>(plants.length).fill(false);
    const stopOrder: Stop[] = [hqStop];

    let curX = hqPos.x;
    let curZ = hqPos.z;

    for (let step = 0; step < plants.length; step++) {
      let bestIdx = -1;
      let bestDistSq = Infinity;
      for (let i = 0; i < plants.length; i++) {
        if (visited[i]) continue;
        const dx = plants[i].x - curX;
        const dz = plants[i].z - curZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      visited[bestIdx] = true;
      const p = plants[bestIdx];
      curX = p.x;
      curZ = p.z;
      stopOrder.push({ x: p.x, z: p.z, entity: p.entity });
    }
    stopOrder.push(hqStop); // close the loop

    // Step 2: For each stop, compute the arc around the building.
    // Entry angle = direction from building toward previous stop (where the track arrives from)
    // Exit angle = direction from building toward next stop (where the track departs to)
    const r = TRACK_ADJACENCY_OFFSET;
    const route: TrackWaypoint[] = [];

    for (let i = 0; i < stopOrder.length - 1; i++) {
      const stop = stopOrder[i];
      const prev = i > 0 ? stopOrder[i - 1] : stopOrder[stopOrder.length - 2];
      const next = stopOrder[i + 1];

      const entryAngle = Math.atan2(prev.z - stop.z, prev.x - stop.x);
      const exitAngle = Math.atan2(next.z - stop.z, next.x - stop.x);

      // Generate arc points (entry -> exit, short way around)
      const arc = this.generateArc(stop.x, stop.z, r, entryAngle, exitAngle);

      // First arc point is the "stop" — gets entityId for loading/unloading
      for (let j = 0; j < arc.length; j++) {
        route.push({
          x: arc[j].x,
          y: this.terrainData.getHeight(arc[j].x, arc[j].z),
          z: arc[j].z,
          entityId: j === 0 ? stop.entity : null,
          isHQ: j === 0 && stop.entity === null,
        });
      }

      // Step 3: Octile path from last arc point to the entry of the next stop's arc
      const lastArc = arc[arc.length - 1];
      const nextStop = stopOrder[i + 1];
      const nextEntryAngle = Math.atan2(stop.z - nextStop.z, stop.x - nextStop.x);
      const nextEntryX = nextStop.x + r * Math.cos(nextEntryAngle);
      const nextEntryZ = nextStop.z + r * Math.sin(nextEntryAngle);

      const midpoints = this.octilePath(lastArc.x, lastArc.z, nextEntryX, nextEntryZ);
      for (const mp of midpoints) {
        route.push({
          x: mp.x,
          y: this.terrainData.getHeight(mp.x, mp.z),
          z: mp.z,
          entityId: null,
          isHQ: false,
        });
      }
    }

    // Close the loop: add the first waypoint again so the train can wrap
    if (route.length > 0) {
      route.push({ ...route[0] });
    }

    return route;
  }

  /**
   * Generate arc waypoints around (cx, cz) at radius r,
   * from startAngle to endAngle stepping in 45-degree increments.
   * Takes the shorter arc direction. Always includes start and end.
   */
  private generateArc(
    cx: number, cz: number, r: number,
    startAngle: number, endAngle: number,
  ): { x: number; z: number }[] {
    const ARC_STEP = Math.PI / 18; // 10 degrees — smooth circular arcs
    const points: { x: number; z: number }[] = [];

    // Normalize to [0, 2PI)
    const a0 = ((startAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a1 = ((endAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // If entry and exit are the same angle, just return that single point
    if (Math.abs(a0 - a1) < 0.01) {
      return [{ x: cx + r * Math.cos(a0), z: cz + r * Math.sin(a0) }];
    }

    // Determine shorter arc direction
    const cwDist = ((a0 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const ccwDist = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const useCCW = ccwDist <= cwDist;
    const totalDist = useCCW ? ccwDist : cwDist;
    const steps = Math.max(2, Math.round(totalDist / ARC_STEP));
    const stepSize = totalDist / steps;

    for (let s = 0; s <= steps; s++) {
      const angle = useCCW ? a0 + s * stepSize : a0 - s * stepSize;
      points.push({
        x: cx + r * Math.cos(angle),
        z: cz + r * Math.sin(angle),
      });
    }

    return points;
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
