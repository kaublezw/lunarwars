import type { System, World } from '@core/ECS';
import {
  POSITION, HEALTH, TEAM, UNIT_TYPE, TRAIN_LINK, TRACK_FOLLOWER,
  BUILDING, DEATH_TIMER, VOXEL_STATE, MOVE_COMMAND,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { UnitCategory } from '@sim/components/UnitType';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { DeathTimerComponent } from '@sim/components/DeathTimer';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { SpatialHash } from '@sim/spatial/SpatialHash';

/** Distance between linked train entities (world units). */
const CAR_SPACING = 2.5;
/** Radius around the train path to check for blocking units. */
const CRUSH_RADIUS = 1.2;

/**
 * Moves train engines along their TrackFollower path and drags cargo cars behind.
 *
 * Key behaviors:
 * - Bypasses standard velocity/steering/collision systems entirely.
 * - Cargo cars follow the exact path of the entity ahead at a fixed spacing.
 * - If a cargo car is destroyed, the engine reverses along the track to reconnect
 *   with the first orphaned (disconnected) car.
 * - Any non-train unit within CRUSH_RADIUS of the train's current position is
 *   instantly killed (the "unstoppable force" rule).
 */
export class TrainMovementSystem implements System {
  readonly name = 'TrainMovementSystem';

  private spatialHash = new SpatialHash(4, 276, 276);

  update(world: World, dt: number): void {
    // Rebuild spatial hash with all non-train units for crush detection
    this.rebuildSpatialHash(world);

    // Process each train engine
    const engines = world.query(TRACK_FOLLOWER, TRAIN_LINK, POSITION);
    for (const engine of engines) {
      const link = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!;
      if (!link.isEngine) continue;

      const health = world.getComponent<HealthComponent>(engine, HEALTH);
      if (health && health.dead) continue;

      const follower = world.getComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER)!;
      if (follower.path.length < 2) continue; // No route yet
      if (follower.halted) continue; // Stopped for loading/unloading

      const team = world.getComponent<TeamComponent>(engine, TEAM);
      const teamNum = team ? team.team : -1;

      // Check for friendly units blocking the train — if so, push them and skip this tick
      const enginePos = world.getComponent<PositionComponent>(engine, POSITION)!;
      if (this.handleBlockingUnits(world, enginePos.x, enginePos.z, engine, teamNum)) {
        continue; // Friendly blocking — train waits
      }

      // Check for broken chain and handle reconnection
      this.checkChainIntegrity(world, engine, follower, link);

      // Move the engine along the track
      const speed = 4; // wu/s, matches UnitDef
      this.advanceEngine(world, engine, follower, dt, speed, teamNum);

      // Drag cargo cars behind the engine
      this.dragCars(world, engine, teamNum);
    }
  }

  /** Move the engine forward (or backward if reconnecting) along the path. */
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
      const segIdx = follower.currentWaypointIndex;

      if (follower.direction === 1) {
        // Forward
        if (segIdx >= path.length - 1) {
          // Reached end of loop — wrap to start
          follower.currentWaypointIndex = 0;
          follower.distanceAlongSegment = 0;
          continue;
        }
        const a = path[segIdx];
        const b = path[segIdx + 1];
        const segLen = this.dist(a, b);
        if (segLen < 0.001) {
          follower.currentWaypointIndex++;
          follower.distanceAlongSegment = 0;
          continue;
        }

        const spaceLeft = segLen - follower.distanceAlongSegment;
        if (remaining >= spaceLeft) {
          remaining -= spaceLeft;
          follower.currentWaypointIndex++;
          follower.distanceAlongSegment = 0;
        } else {
          follower.distanceAlongSegment += remaining;
          remaining = 0;
        }
      } else {
        // Reverse (reconnecting)
        if (segIdx <= 0 && follower.distanceAlongSegment <= 0) {
          // Reached the start — wrap to end
          follower.currentWaypointIndex = path.length - 2;
          const a = path[path.length - 2];
          const b = path[path.length - 1];
          follower.distanceAlongSegment = this.dist(a, b);
          continue;
        }

        if (follower.distanceAlongSegment <= 0) {
          // Move to previous segment
          follower.currentWaypointIndex--;
          if (follower.currentWaypointIndex >= 0 && follower.currentWaypointIndex < path.length - 1) {
            const a = path[follower.currentWaypointIndex];
            const b = path[follower.currentWaypointIndex + 1];
            follower.distanceAlongSegment = this.dist(a, b);
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

    // Update engine position from path interpolation
    this.setPositionFromPath(world, engine, follower, team);
  }

  /** Interpolate position along the current segment and apply to entity. */
  private setPositionFromPath(
    world: World,
    entity: number,
    follower: TrackFollowerComponent,
    team: number,
  ): void {
    const path = follower.path;
    const idx = Math.min(follower.currentWaypointIndex, path.length - 2);
    if (idx < 0) return;

    const a = path[idx];
    const b = path[idx + 1];
    const segLen = this.dist(a, b);
    const t = segLen > 0.001 ? follower.distanceAlongSegment / segLen : 0;

    const pos = world.getComponent<PositionComponent>(entity, POSITION)!;
    pos.prevX = pos.x;
    pos.prevY = pos.y;
    pos.prevZ = pos.z;
    pos.x = a.x + (b.x - a.x) * t;
    pos.y = a.y + (b.y - a.y) * t;
    pos.z = a.z + (b.z - a.z) * t;

    // Face direction of travel
    const dx = follower.direction === 1 ? b.x - a.x : a.x - b.x;
    const dz = follower.direction === 1 ? b.z - a.z : a.z - b.z;
    if (dx !== 0 || dz !== 0) {
      pos.rotation = Math.atan2(dx, dz);
    }

    // Handle any unit in the way (kill enemies, push friendlies)
    this.handleBlockingUnits(world, pos.x, pos.z, entity, team);
  }

  /**
   * Drag each cargo car to trail the entity ahead of it in the chain,
   * maintaining CAR_SPACING along the path.
   */
  private dragCars(world: World, engine: number, team: number): void {
    const enginePos = world.getComponent<PositionComponent>(engine, POSITION)!;

    let prevX = enginePos.x;
    let prevY = enginePos.y;
    let prevZ = enginePos.z;

    let current: number | null = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!.nextEntity;

    while (current != null) {
      const carHealth = world.getComponent<HealthComponent>(current, HEALTH);
      if (carHealth && carHealth.dead) {
        // Skip dead cars but continue to next
        const nextLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
        current = nextLink ? nextLink.nextEntity : null;
        continue;
      }

      const carPos = world.getComponent<PositionComponent>(current, POSITION);
      if (!carPos) break;

      // Compute direction from car to leader
      const dx = prevX - carPos.x;
      const dy = prevY - carPos.y;
      const dz = prevZ - carPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist > CAR_SPACING) {
        // Move toward leader, maintaining exactly CAR_SPACING gap
        const overshoot = dist - CAR_SPACING;
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;

        carPos.prevX = carPos.x;
        carPos.prevY = carPos.y;
        carPos.prevZ = carPos.z;
        carPos.x += nx * overshoot;
        carPos.y += ny * overshoot;
        carPos.z += nz * overshoot;
      } else {
        carPos.prevX = carPos.x;
        carPos.prevY = carPos.y;
        carPos.prevZ = carPos.z;
      }

      // Face toward leader
      const faceDx = prevX - carPos.x;
      const faceDz = prevZ - carPos.z;
      if (faceDx !== 0 || faceDz !== 0) {
        carPos.rotation = Math.atan2(faceDx, faceDz);
      }

      // Handle blocking units around this car too
      this.handleBlockingUnits(world, carPos.x, carPos.z, current, team);

      prevX = carPos.x;
      prevY = carPos.y;
      prevZ = carPos.z;

      const link = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      current = link ? link.nextEntity : null;
    }
  }

  /**
   * Check if the train's linked list is broken (a car died).
   * If so, trigger reverse reconnection to the first orphaned car.
   */
  private checkChainIntegrity(
    world: World,
    engine: number,
    follower: TrackFollowerComponent,
    engineLink: TrainLinkComponent,
  ): void {
    // If already reconnecting, check if we've reached the target
    if (follower.reconnectTarget >= 0) {
      const targetPos = world.getComponent<PositionComponent>(follower.reconnectTarget, POSITION);
      const enginePos = world.getComponent<PositionComponent>(engine, POSITION);
      if (!targetPos || !enginePos) {
        // Target was destroyed — scan again
        follower.reconnectTarget = -1;
        follower.direction = 1;
        return;
      }

      const dx = enginePos.x - targetPos.x;
      const dz = enginePos.z - targetPos.z;
      if (dx * dx + dz * dz < CAR_SPACING * CAR_SPACING * 1.5) {
        // Close enough — relink the chain
        this.relinkChain(world, engine);
        follower.direction = 1;
        follower.reconnectTarget = -1;
        return;
      }
      return; // Still reversing, don't re-scan
    }

    // Scan the chain for a broken link (dead car)
    let current: number | null = engineLink.nextEntity;
    while (current != null) {
      const carHealth = world.getComponent<HealthComponent>(current, HEALTH);
      const carLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      if (!carLink) break;

      if (carHealth && carHealth.dead) {
        // This car is dead — find the first living car after it (the orphan)
        let orphan: number | null = carLink.nextEntity;
        while (orphan != null) {
          const orphanHealth = world.getComponent<HealthComponent>(orphan, HEALTH);
          if (orphanHealth && !orphanHealth.dead) break;
          const orphanLink = world.getComponent<TrainLinkComponent>(orphan, TRAIN_LINK);
          orphan = orphanLink ? orphanLink.nextEntity : null;
        }

        if (orphan != null) {
          // Begin reverse to reconnect
          follower.direction = -1;
          follower.reconnectTarget = orphan;
        } else {
          // No surviving cars after the dead one — just remove dead links
          this.relinkChain(world, engine);
        }
        return;
      }

      current = carLink.nextEntity;
    }
  }

  /**
   * Rebuild the linked list, skipping dead cars.
   * Re-wires prevEntity/nextEntity so the chain is contiguous.
   */
  private relinkChain(world: World, engine: number): void {
    const living: number[] = [engine];
    let current: number | null = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!.nextEntity;

    // Collect all living entities in chain order
    while (current != null) {
      const health = world.getComponent<HealthComponent>(current, HEALTH);
      const link = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      if (!link) break;

      if (!health || !health.dead) {
        living.push(current);
      }
      current = link.nextEntity;
    }

    // Rewire links
    for (let i = 0; i < living.length; i++) {
      const link = world.getComponent<TrainLinkComponent>(living[i], TRAIN_LINK);
      if (!link) continue;
      link.prevEntity = i > 0 ? living[i - 1] : null;
      link.nextEntity = i < living.length - 1 ? living[i + 1] : null;
    }
  }

  /**
   * Handle units blocking the track. Enemy units are instakilled.
   * Friendly units cause the train to halt and are pushed sideways off the track.
   * Returns true if a friendly unit is blocking (train should stop).
   */
  private handleBlockingUnits(
    world: World,
    x: number,
    z: number,
    selfEntity: number,
    selfTeam: number,
  ): boolean {
    let friendlyBlocking = false;
    const nearby = this.spatialHash.query(x, z, CRUSH_RADIUS);
    for (const other of nearby) {
      if (other === selfEntity) continue;

      // Don't affect other train entities
      if (world.hasComponent(other, TRAIN_LINK)) continue;

      // Don't affect buildings
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
        // Friendly unit — push it sideways off the track, halt the train
        friendlyBlocking = true;
        this.pushUnitOffTrack(world, other, otherPos, x, z);
      } else {
        // Enemy unit — instakill
        otherHealth.current = 0;
        otherHealth.dead = true;
      }
    }
    return friendlyBlocking;
  }

  /** Push a friendly unit perpendicular to the track to get it out of the way. */
  private pushUnitOffTrack(
    world: World,
    entity: number,
    pos: PositionComponent,
    trackX: number,
    trackZ: number,
  ): void {
    // Push perpendicular to the vector from track center to unit
    let dx = pos.x - trackX;
    let dz = pos.z - trackZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) {
      // Unit is exactly on track center — pick an arbitrary perpendicular
      dx = 1;
      dz = 0;
    } else {
      dx /= dist;
      dz /= dist;
    }

    const pushDist = CRUSH_RADIUS + 1.5;
    const destX = Math.max(4, Math.min(252, trackX + dx * pushDist));
    const destZ = Math.max(4, Math.min(252, trackZ + dz * pushDist));

    if (world.hasComponent(entity, MOVE_COMMAND)) {
      world.removeComponent(entity, MOVE_COMMAND);
    }
    world.addComponent<MoveCommandComponent>(entity, MOVE_COMMAND, {
      path: [],
      currentWaypoint: 0,
      destX,
      destZ,
    });
  }

  /** Rebuild spatial hash with all non-train units for crush checks. */
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

  private dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
