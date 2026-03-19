import type { System, World } from '@core/ECS';
import { GARAGE_ENTER, POSITION, VELOCITY, STEERING } from '@sim/components/ComponentTypes';
import type { GarageEnterComponent } from '@sim/components/GarageEnter';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';

export class GarageEnterSystem implements System {
  readonly name = 'GarageEnterSystem';

  update(world: World, _dt: number): void {
    const entities = world.query(GARAGE_ENTER, POSITION, VELOCITY);

    for (const e of entities) {
      const enter = world.getComponent<GarageEnterComponent>(e, GARAGE_ENTER)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;

      // Align X to HQ center
      pos.x = enter.hqX;

      if (pos.z <= enter.enterZ) {
        // Reached interior — destroy the ferry
        world.destroyEntity(e);
      } else {
        // Drive straight -Z into the garage
        vel.x = 0;
        vel.z = -vel.speed;
        // Clear any steering forces
        const steering = world.getComponent<SteeringComponent>(e, STEERING);
        if (steering) {
          steering.forceX = 0;
          steering.forceZ = 0;
        }
      }
    }
  }
}
