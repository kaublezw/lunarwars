import type { System, World } from '@core/ECS';
import {
  POSITION, HEALTH, TEAM, TRAIN_LINK, TRACK_FOLLOWER,
  BUILDING,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import { SpatialHash } from '@sim/spatial/SpatialHash';

/** Distance between linked train entities (world units). */
const CAR_SPACING = 2.0;
/** Radius around the train path to check for blocking units. */
const CRUSH_RADIUS = 1.2;

/**
 * Moves train engines along their high-resolution spline waypoints.
 *
 * - Rotation locks to atan2 toward the next waypoint (smooth with dense splines).
 * - Halts when arriving at a stop waypoint (entityId or isHQ) for logistics.
 * - Friendly units are pushed off the track; enemy units are instakilled.
 * - Cargo cars trail the entity ahead at CAR_SPACING distance.
 */
export class TrainMovementSystem implements System {
  readonly name = 'TrainMovementSystem';

  private spatialHash = new SpatialHash(4, 276, 276);

  update(world: World, dt: number): void {
    this.rebuildSpatialHash(world);

    const engines = world.query(TRACK_FOLLOWER, TRAIN_LINK, POSITION);
    for (const engine of engines) {
      const link = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!;
      if (!link.isEngine) continue;

      const health = world.getComponent<HealthComponent>(engine, HEALTH);
      if (health && health.dead) continue;

      const follower = world.getComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER)!;
      if (follower.path.length < 2) continue;
      if (follower.halted) continue;

      const team = world.getComponent<TeamComponent>(engine, TEAM);
      const teamNum = team ? team.team : -1;

      // Push any nearby friendly units off the track (train never halts for friendlies)
      const enginePos = world.getComponent<PositionComponent>(engine, POSITION)!;
      this.handleBlockingUnits(world, enginePos.x, enginePos.z, engine, teamNum);

      // Check for broken chain and handle reconnection
      this.checkChainIntegrity(world, engine, follower, link);

      // Advance along the spline
      const speed = 4;
      this.advanceEngine(world, engine, follower, dt, speed, teamNum);

      // Drag cargo cars behind
      this.dragCars(world, engine, teamNum);
    }
  }

  /**
   * Step the engine forward (or backward) through dense spline waypoints.
   * When a stop waypoint is reached (entityId or isHQ), halt for logistics.
   */
  private advanceEngine(
    world: World,
    engine: number,
    follower: TrackFollowerComponent,
    dt: number,
    speed: number,
    team: number,
  ): void {
    const path = follower.path;
    let remaining = speed * dt;

    while (remaining > 0) {
      const idx = follower.currentWaypointIndex;

      if (follower.direction === 1) {
        // Forward
        if (idx >= path.length - 1) {
          follower.currentWaypointIndex = 0;
          follower.distanceAlongSegment = 0;
          continue;
        }

        const a = path[idx];
        const b = path[idx + 1];
        const segLen = this.dist2D(a, b);

        if (segLen < 0.001) {
          follower.currentWaypointIndex++;
          follower.distanceAlongSegment = 0;
          // Check if we just arrived at a stop
          if (this.isStopWaypoint(path[follower.currentWaypointIndex])) {
            follower.halted = true;
            remaining = 0;
          }
          continue;
        }

        const spaceLeft = segLen - follower.distanceAlongSegment;
        if (remaining >= spaceLeft) {
          remaining -= spaceLeft;
          follower.currentWaypointIndex++;
          follower.distanceAlongSegment = 0;
          // Check if we just arrived at a stop
          if (this.isStopWaypoint(path[follower.currentWaypointIndex])) {
            follower.halted = true;
            remaining = 0;
          }
        } else {
          follower.distanceAlongSegment += remaining;
          remaining = 0;
        }
      } else {
        // Reverse (reconnecting)
        if (idx <= 0 && follower.distanceAlongSegment <= 0) {
          follower.currentWaypointIndex = path.length - 2;
          follower.distanceAlongSegment = this.dist2D(path[path.length - 2], path[path.length - 1]);
          continue;
        }

        if (follower.distanceAlongSegment <= 0) {
          follower.currentWaypointIndex--;
          if (follower.currentWaypointIndex >= 0 && follower.currentWaypointIndex < path.length - 1) {
            follower.distanceAlongSegment = this.dist2D(
              path[follower.currentWaypointIndex],
              path[follower.currentWaypointIndex + 1],
            );
          }
          continue;
        }

        if (remaining >= follower.distanceAlongSegment) {
          remaining -= follower.distanceAlongSegment;
          follower.distanceAlongSegment = 0;
        } else {
          follower.distanceAlongSegment -= remaining;
          remaining = 0;
        }
      }
    }

    // Update position from current segment interpolation
    const idx = Math.min(follower.currentWaypointIndex, path.length - 2);
    if (idx < 0) return;

    const a = path[idx];
    const b = path[idx + 1];
    const segLen = this.dist2D(a, b);
    const t = segLen > 0.001 ? follower.distanceAlongSegment / segLen : 0;

    const pos = world.getComponent<PositionComponent>(engine, POSITION)!;
    pos.prevX = pos.x;
    pos.prevY = pos.y;
    pos.prevZ = pos.z;
    pos.x = a.x + (b.x - a.x) * t;
    pos.y = a.y + (b.y - a.y) * t;
    pos.z = a.z + (b.z - a.z) * t;

    // Rotation: aim at the next waypoint (smooth with dense splines)
    const lookIdx = Math.min(idx + 1, path.length - 1);
    const target = path[lookIdx];
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    if (dx !== 0 || dz !== 0) {
      pos.rotation = follower.direction === 1
        ? Math.atan2(dx, dz)
        : Math.atan2(-dx, -dz);
    }

    this.handleBlockingUnits(world, pos.x, pos.z, engine, team);
  }

  /** Check if a waypoint is a stop (plant or HQ). */
  private isStopWaypoint(wp: TrackFollowerComponent['path'][0] | undefined): boolean {
    if (!wp) return false;
    return wp.entityId != null || wp.isHQ;
  }

  /**
   * Position each cargo car along the track path behind the engine.
   * Cars follow the exact waypoint spline instead of cutting corners.
   */
  private dragCars(world: World, engine: number, team: number): void {
    const follower = world.getComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER)!;
    const path = follower.path;
    if (path.length < 2) return;

    let carNum = 0;
    let current: number | null = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!.nextEntity;

    while (current != null) {
      const carHealth = world.getComponent<HealthComponent>(current, HEALTH);
      if (carHealth && carHealth.dead) {
        const nextLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
        current = nextLink ? nextLink.nextEntity : null;
        continue;
      }

      carNum++;
      const carPos = world.getComponent<PositionComponent>(current, POSITION);
      if (!carPos) break;

      const target = this.walkBackAlongPath(
        path, follower.currentWaypointIndex, follower.distanceAlongSegment,
        carNum * CAR_SPACING,
      );

      carPos.prevX = carPos.x;
      carPos.prevY = carPos.y;
      carPos.prevZ = carPos.z;
      carPos.x = target.x;
      carPos.y = target.y;
      carPos.z = target.z;
      carPos.rotation = target.rotation;

      this.handleBlockingUnits(world, carPos.x, carPos.z, current, team);

      const link = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      current = link ? link.nextEntity : null;
    }
  }

  /**
   * Walk backward along the waypoint path by `walkBack` world units
   * from the given segment position. Wraps around for looping circuits.
   */
  private walkBackAlongPath(
    path: TrackFollowerComponent['path'],
    waypointIndex: number,
    distAlongSeg: number,
    walkBack: number,
  ): { x: number; y: number; z: number; rotation: number } {
    let remaining = walkBack;
    let idx = waypointIndex;
    let dist = distAlongSeg;

    // Consume distance within current segment (backward)
    if (remaining <= dist) {
      dist -= remaining;
      remaining = 0;
    } else {
      remaining -= dist;
      idx--;

      // Walk backward through previous segments
      while (remaining > 0 && idx >= 0) {
        const segLen = this.dist2D(path[idx], path[idx + 1]);
        if (remaining <= segLen) {
          dist = segLen - remaining;
          remaining = 0;
        } else {
          remaining -= segLen;
          idx--;
        }
      }

      // Wrap around to end of path (looping circuit)
      if (remaining > 0) {
        idx = path.length - 2;
        while (remaining > 0 && idx >= 0) {
          const segLen = this.dist2D(path[idx], path[idx + 1]);
          if (remaining <= segLen) {
            dist = segLen - remaining;
            remaining = 0;
          } else {
            remaining -= segLen;
            idx--;
          }
        }
      }
    }

    idx = Math.max(0, Math.min(idx, path.length - 2));
    const a = path[idx];
    const b = path[idx + 1];
    const segLen = this.dist2D(a, b);
    const t = segLen > 0.001 ? dist / segLen : 0;

    // Rotation: face along segment direction (forward along track)
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const rotation = (dx !== 0 || dz !== 0) ? Math.atan2(dx, dz) : 0;

    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      rotation,
    };
  }

  /** Check for broken chain (dead car) and trigger reverse reconnection. */
  private checkChainIntegrity(
    world: World,
    engine: number,
    follower: TrackFollowerComponent,
    engineLink: TrainLinkComponent,
  ): void {
    if (follower.reconnectTarget >= 0) {
      const targetPos = world.getComponent<PositionComponent>(follower.reconnectTarget, POSITION);
      const enginePos = world.getComponent<PositionComponent>(engine, POSITION);
      if (!targetPos || !enginePos) {
        follower.reconnectTarget = -1;
        follower.direction = 1;
        return;
      }
      const dx = enginePos.x - targetPos.x;
      const dz = enginePos.z - targetPos.z;
      if (dx * dx + dz * dz < CAR_SPACING * CAR_SPACING * 1.5) {
        this.relinkChain(world, engine);
        follower.direction = 1;
        follower.reconnectTarget = -1;
      }
      return;
    }

    let current: number | null = engineLink.nextEntity;
    while (current != null) {
      const carHealth = world.getComponent<HealthComponent>(current, HEALTH);
      const carLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      if (!carLink) break;

      if (carHealth && carHealth.dead) {
        let orphan: number | null = carLink.nextEntity;
        while (orphan != null) {
          const orphanHealth = world.getComponent<HealthComponent>(orphan, HEALTH);
          if (orphanHealth && !orphanHealth.dead) break;
          const orphanLink = world.getComponent<TrainLinkComponent>(orphan, TRAIN_LINK);
          orphan = orphanLink ? orphanLink.nextEntity : null;
        }

        if (orphan != null) {
          follower.direction = -1;
          follower.reconnectTarget = orphan;
        } else {
          this.relinkChain(world, engine);
        }
        return;
      }

      current = carLink.nextEntity;
    }
  }

  /** Rebuild linked list skipping dead cars. */
  private relinkChain(world: World, engine: number): void {
    const living: number[] = [engine];
    let current: number | null = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!.nextEntity;

    while (current != null) {
      const health = world.getComponent<HealthComponent>(current, HEALTH);
      const link = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      if (!link) break;
      if (!health || !health.dead) living.push(current);
      current = link.nextEntity;
    }

    for (let i = 0; i < living.length; i++) {
      const link = world.getComponent<TrainLinkComponent>(living[i], TRAIN_LINK);
      if (!link) continue;
      link.prevEntity = i > 0 ? living[i - 1] : null;
      link.nextEntity = i < living.length - 1 ? living[i + 1] : null;
    }
  }

  /**
   * Handle blocking units. Enemies instakilled, friendlies pushed off track.
   * Train never halts — it pushes friendlies aside and keeps moving.
   */
  private handleBlockingUnits(
    world: World, x: number, z: number, selfEntity: number, selfTeam: number,
  ): void {
    const nearby = this.spatialHash.query(x, z, CRUSH_RADIUS);
    for (const other of nearby) {
      if (other === selfEntity) continue;
      if (world.hasComponent(other, TRAIN_LINK)) continue;
      if (world.hasComponent(other, BUILDING)) continue;

      const otherPos = world.getComponent<PositionComponent>(other, POSITION);
      if (!otherPos) continue;
      const dx = otherPos.x - x;
      const dz = otherPos.z - z;
      if (dx * dx + dz * dz > CRUSH_RADIUS * CRUSH_RADIUS) continue;

      const otherHealth = world.getComponent<HealthComponent>(other, HEALTH);
      if (!otherHealth || otherHealth.dead) continue;

      const otherTeam = world.getComponent<TeamComponent>(other, TEAM);
      if (otherTeam && otherTeam.team === selfTeam) {
        this.pushUnitOffTrack(world, other, otherPos, x, z);
      } else {
        otherHealth.current = 0;
        otherHealth.dead = true;
      }
    }
  }

  private pushUnitOffTrack(
    _world: World, _entity: number, pos: PositionComponent, trackX: number, trackZ: number,
  ): void {
    let dx = pos.x - trackX;
    let dz = pos.z - trackZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) { dx = 1; dz = 0; } else { dx /= dist; dz /= dist; }

    // Immediately teleport the unit out of the crush radius
    const pushDist = CRUSH_RADIUS + 0.5;
    pos.x = Math.max(4, Math.min(252, trackX + dx * pushDist));
    pos.z = Math.max(4, Math.min(252, trackZ + dz * pushDist));
  }

  private rebuildSpatialHash(world: World): void {
    this.spatialHash.clear();
    const entities = world.query(POSITION, HEALTH);
    for (const e of entities) {
      if (world.hasComponent(e, TRAIN_LINK)) continue;
      if (world.hasComponent(e, BUILDING)) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      this.spatialHash.insert(e, pos.x, pos.z);
    }
  }

  private dist2D(a: { x: number; z: number }, b: { x: number; z: number }): number {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
}
