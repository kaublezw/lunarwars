import type { System, World } from '@core/ECS';
import { GARAGE_ENTER, POSITION, VELOCITY, STEERING } from '@sim/components/ComponentTypes';
import type { GarageEnterComponent } from '@sim/components/GarageEnter';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';

/**
 * Exact reverse of GarageExitSystem.
 * GarageExit: spawns at hqPos.z, drives +Z at vel.speed, exits at exitZ (hqPos.z + 2.5).
 * GarageEnter: starts at hqPos.z + 2.5, drives -Z at vel.speed, destroyed at enterZ (hqPos.z).
 *
 * Because MovementSystem blocks movement INTO building footprints (isClearAt),
 * we directly update position here instead of relying on velocity alone.
 */
export class GarageEnterSystem implements System {
  readonly name = 'GarageEnterSystem';

  update(world: World, dt: number): void {
    const entities = world.query(GARAGE_ENTER, POSITION, VELOCITY);

    for (const e of entities) {
      const enter = world.getComponent<GarageEnterComponent>(e, GARAGE_ENTER)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;

      // Align X to HQ center
      pos.x = enter.hqX;

      if (pos.z <= enter.enterZ) {
        // Reached interior — destroy the ferry (mirrors GarageExit removal)
        world.destroyEntity(e);
      } else {
        // Save previous position for interpolation
        pos.prevX = pos.x;
        pos.prevY = pos.y;
        pos.prevZ = pos.z;

        // Drive straight -Z into the garage by directly updating position,
        // bypassing MovementSystem's building collision checks
        pos.z -= vel.speed * dt;

        // Set velocity for rotation display (face -Z)
        vel.x = 0;
        vel.z = -vel.speed;

        // Clear steering forces so CollisionAvoidance/Movement don't interfere
        const steering = world.getComponent<SteeringComponent>(e, STEERING);
        if (steering) {
          steering.forceX = 0;
          steering.forceZ = 0;
        }
      }
    }
  }
}
