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
   * Geometric corner filleting: straight lines with fixed-radius arcs at corners.
   *
   * 1. Nearest-neighbor TSP determines stop order.
   * 2. Offset stops outward from centroid so track runs beside buildings.
   * 3. For each corner, compute a circular fillet arc that smoothly connects
   *    the incoming and outgoing straight segments.
   * 4. Stitch arcs and sampled straights together into the final route.
   */
  private computeCircuit(
    hqPos: PositionComponent,
    plants: { entity: number; x: number; z: number }[],
  ): TrackWaypoint[] {
    if (plants.length === 0) return [];

    // 1. Nearest-neighbor TSP to determine stop order
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
    // DO NOT push HQ again — modulo arithmetic closes the loop.

    // Special case: with only 1 plant (2 stops), expand into a 4-point loop
    // by adding two synthetic waypoints offset perpendicular to the HQ-plant line.
    // This gives the fillet algorithm enough corners to work with.
    if (stopOrder.length === 2) {
      const hq = stopOrder[0];
      const plant = stopOrder[1];
      const dx = plant.x - hq.x;
      const dz = plant.z - hq.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      // Perpendicular direction
      const perpX = -dz / len;
      const perpZ = dx / len;
      const offset = TRACK_ADJACENCY_OFFSET;
      // Insert two synthetic points to form a rectangle: HQ -> side1 -> plant -> side2
      stopOrder.length = 0;
      stopOrder.push(
        { x: hq.x + perpX * offset, z: hq.z + perpZ * offset, entity: null, isHQ: true },
        { x: plant.x + perpX * offset, z: plant.z + perpZ * offset, entity: plant.entity, isHQ: false },
        { x: plant.x - perpX * offset, z: plant.z - perpZ * offset, entity: null, isHQ: false },
        { x: hq.x - perpX * offset, z: hq.z - perpZ * offset, entity: null, isHQ: false },
      );
    }

    // 2. Outward offset calculation
    let cx = 0, cz = 0;
    for (const s of stopOrder) { cx += s.x; cz += s.z; }
    cx /= stopOrder.length; cz /= stopOrder.length;

    const rawPoints = stopOrder.map(stop => {
      let outDx = stop.x - cx, outDz = stop.z - cz;
      const outLen = Math.sqrt(outDx * outDx + outDz * outDz);
      if (outLen > 0.5) { outDx /= outLen; outDz /= outLen; }
      else { outDx = 1; outDz = 0; }
      return {
        x: stop.x + outDx * TRACK_ADJACENCY_OFFSET,
        z: stop.z + outDz * TRACK_ADJACENCY_OFFSET,
        entity: stop.entity,
        isHQ: stop.isHQ,
      };
    });

    // 3. Fillet generation
    const TURN_RADIUS = 4.0;
    const SAMPLE_DIST = 2.0;
    const route: TrackWaypoint[] = [];

    interface CornerData {
      t1: { x: number; z: number };
      t2: { x: number; z: number };
      cx: number; cz: number;
      startAng: number; sweep: number; radius: number;
      entity: number | null; isHQ: boolean;
    }
    const corners: CornerData[] = [];

    // First pass: calculate geometry for all corners
    for (let i = 0; i < rawPoints.length; i++) {
      const p1 = rawPoints[(i - 1 + rawPoints.length) % rawPoints.length];
      const p2 = rawPoints[i];
      const p3 = rawPoints[(i + 1) % rawPoints.length];

      const d1x = p1.x - p2.x, d1z = p1.z - p2.z;
      const len1 = Math.sqrt(d1x * d1x + d1z * d1z);
      const u1x = d1x / len1, u1z = d1z / len1;

      const d2x = p3.x - p2.x, d2z = p3.z - p2.z;
      const len2 = Math.sqrt(d2x * d2x + d2z * d2z);
      const u2x = d2x / len2, u2z = d2z / len2;

      const dot = u1x * u2x + u1z * u2z;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

      // If the track is basically straight, no arc needed
      if (angle > Math.PI - 0.05) {
        corners.push({
          t1: p2, t2: p2, cx: p2.x, cz: p2.z, startAng: 0, sweep: 0, radius: 0,
          entity: p2.entity, isHQ: p2.isHQ,
        });
        continue;
      }

      // Tangent distance (how far back from the corner the arc starts)
      let tangentDist = TURN_RADIUS / Math.tan(angle / 2);

      // Clamp to prevent arcs from overlapping on short track segments
      const maxDist = Math.min(len1 / 2.1, len2 / 2.1);
      let actualRadius = TURN_RADIUS;
      if (tangentDist > maxDist) {
        tangentDist = maxDist;
        actualRadius = tangentDist * Math.tan(angle / 2);
      }

      const t1 = { x: p2.x + u1x * tangentDist, z: p2.z + u1z * tangentDist };
      const t2 = { x: p2.x + u2x * tangentDist, z: p2.z + u2z * tangentDist };

      // Center of the circular arc
      const bx = u1x + u2x, bz = u1z + u2z;
      const bLen = Math.sqrt(bx * bx + bz * bz);
      const hDist = actualRadius / Math.sin(angle / 2);
      const arcCx = p2.x + (bx / bLen) * hDist;
      const arcCz = p2.z + (bz / bLen) * hDist;

      const startAng = Math.atan2(t1.z - arcCz, t1.x - arcCx);
      const endAng = Math.atan2(t2.z - arcCz, t2.x - arcCx);

      let sweep = endAng - startAng;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;

      corners.push({
        t1, t2, cx: arcCx, cz: arcCz, startAng, sweep, radius: actualRadius,
        entity: p2.entity, isHQ: p2.isHQ,
      });
    }

    // Second pass: stitch arcs and straights together
    for (let i = 0; i < corners.length; i++) {
      const c1 = corners[i];
      const c2 = corners[(i + 1) % corners.length];

      // A. Draw the arc for this corner
      if (c1.radius > 0) {
        const arcSamples = Math.max(6, Math.ceil(Math.abs(c1.sweep) * c1.radius));
        for (let j = 0; j <= arcSamples; j++) {
          const t = j / arcSamples;
          const a = c1.startAng + c1.sweep * t;
          const px = c1.cx + Math.cos(a) * c1.radius;
          const pz = c1.cz + Math.sin(a) * c1.radius;

          // Map the stop entity to the middle of the arc so the train docks smoothly
          const isMid = j === Math.floor(arcSamples / 2);
          route.push({
            x: px, y: this.terrainData.getHeight(px, pz), z: pz,
            entityId: isMid ? c1.entity : null,
            isHQ: isMid ? c1.isHQ : false,
          });
        }
      } else {
        route.push({
          x: c1.t2.x, y: this.terrainData.getHeight(c1.t2.x, c1.t2.z), z: c1.t2.z,
          entityId: c1.entity, isHQ: c1.isHQ,
        });
      }

      // B. Draw straight line to next corner (sampled for terrain height)
      const dx = c2.t1.x - c1.t2.x;
      const dz = c2.t1.z - c1.t2.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const steps = Math.floor(dist / SAMPLE_DIST);

      for (let j = 1; j < steps; j++) {
        const t = j / steps;
        const px = c1.t2.x + dx * t;
        const pz = c1.t2.z + dz * t;
        route.push({
          x: px, y: this.terrainData.getHeight(px, pz), z: pz,
          entityId: null, isHQ: false,
        });
      }
    }

    // Close the loop: append the first waypoint so the last segment connects back
    if (route.length > 0) {
      route.push({ ...route[0], entityId: null, isHQ: false });
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
