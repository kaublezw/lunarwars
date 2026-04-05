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
   * Compute a smooth spline circuit using Catmull-Rom interpolation.
   *
   * 1. Nearest-neighbor TSP determines stop order.
   * 2. Offset stops by TRACK_ADJACENCY_OFFSET so the track runs beside buildings.
   * 3. Generate a closed Catmull-Rom spline through the offset points.
   * 4. Sample the spline at high resolution.
   * 5. Map entityIds to the closest generated waypoint for each building.
   */
  private computeCircuit(
    hqPos: PositionComponent,
    plants: { entity: number; x: number; z: number }[],
  ): TrackWaypoint[] {
    if (plants.length === 0) return [];

    // Step 1: Nearest-neighbor TSP to determine stop order
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
    // Note: do NOT push hqStop again — the spline is closed, it wraps automatically

    // Step 2: Compute circuit centroid for consistent outward offset
    let cx = 0, cz = 0;
    for (const s of stopOrder) { cx += s.x; cz += s.z; }
    cx /= stopOrder.length;
    cz /= stopOrder.length;

    // Offset each stop outward from centroid so track runs beside buildings
    const controlPoints: { x: number; z: number; entity: number | null }[] = [];
    for (const stop of stopOrder) {
      let outDx = stop.x - cx;
      let outDz = stop.z - cz;
      const outLen = Math.sqrt(outDx * outDx + outDz * outDz);
      if (outLen > 0.5) {
        outDx /= outLen;
        outDz /= outLen;
      } else {
        outDx = 1; outDz = 0;
      }
      controlPoints.push({
        x: stop.x + outDx * TRACK_ADJACENCY_OFFSET,
        z: stop.z + outDz * TRACK_ADJACENCY_OFFSET,
        entity: stop.entity,
      });
    }

    // Step 3: Sample the closed Catmull-Rom spline at high resolution
    const totalLen = this.estimateLoopLength(controlPoints);
    const numSamples = Math.max(60, Math.round(totalLen * 2));
    const splinePoints = this.sampleClosedCatmullRom(controlPoints, numSamples);

    // Step 4: Convert to TrackWaypoint[] with terrain height
    const route: TrackWaypoint[] = splinePoints.map(p => ({
      x: p.x,
      y: this.terrainData.getHeight(p.x, p.z),
      z: p.z,
      entityId: null,
      isHQ: false,
    }));

    // Step 5: Map entityIds — for each original stop, find the closest waypoint
    for (const cp of controlPoints) {
      let bestIdx = 0;
      let bestDistSq = Infinity;
      for (let i = 0; i < route.length; i++) {
        const dx = route[i].x - cp.x;
        const dz = route[i].z - cp.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestIdx = i;
        }
      }
      route[bestIdx].entityId = cp.entity;
      route[bestIdx].isHQ = cp.entity === null;
    }

    // Close the loop by appending the first point
    route.push({ ...route[0] });

    return route;
  }

  /** Estimate total perimeter of a closed polygon for dynamic sample count. */
  private estimateLoopLength(points: { x: number; z: number }[]): number {
    let len = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len;
  }

  /**
   * Sample a closed Catmull-Rom spline (centripetal, alpha=0.5).
   * Control points form a closed loop; the output smoothly wraps from last to first.
   */
  private sampleClosedCatmullRom(
    points: { x: number; z: number }[],
    numSamples: number,
  ): { x: number; z: number }[] {
    const n = points.length;
    if (n < 2) return points.map(p => ({ x: p.x, z: p.z }));

    const result: { x: number; z: number }[] = [];
    for (let i = 0; i < numSamples; i++) {
      const t = i / numSamples; // [0, 1) around the entire loop
      const segment = t * n;
      const segIdx = Math.floor(segment);
      const segT = segment - segIdx;

      // 4 control points for this segment (wrap around for closed loop)
      const p0 = points[((segIdx - 1) % n + n) % n];
      const p1 = points[segIdx % n];
      const p2 = points[(segIdx + 1) % n];
      const p3 = points[(segIdx + 2) % n];

      result.push(this.catmullRomPoint(p0, p1, p2, p3, segT));
    }
    return result;
  }

  /** Evaluate a single point on a Catmull-Rom segment (uniform, tension 0.5). */
  private catmullRomPoint(
    p0: { x: number; z: number },
    p1: { x: number; z: number },
    p2: { x: number; z: number },
    p3: { x: number; z: number },
    t: number,
  ): { x: number; z: number } {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    };
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
