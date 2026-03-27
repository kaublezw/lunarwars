import type { System, World } from '@core/ECS';
import { ROOF_EXIT, POSITION, VELOCITY, STEERING, MOVE_COMMAND } from '@sim/components/ComponentTypes';
import type { RoofExitComponent } from '@sim/components/RoofExit';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';

const RISE_SPEED = 3.0; // world units per second

export class RoofExitSystem implements System {
  readonly name = 'RoofExitSystem';

  update(world: World, dt: number): void {
    const entities = world.query(ROOF_EXIT, POSITION, VELOCITY);

    for (const e of entities) {
      const exit = world.getComponent<RoofExitComponent>(e, ROOF_EXIT)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;

      if (pos.y >= exit.exitY) {
        // Reached roof altitude — switch to normal behavior
        world.removeComponent(e, ROOF_EXIT);
        vel.x = 0;
        vel.z = 0;
        world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
          path: [], currentWaypoint: 0,
          destX: exit.rallyX, destZ: exit.rallyZ,
        });
      } else {
        // Rise straight up
        pos.prevY = pos.y;
        pos.y += RISE_SPEED * dt;
        // Suppress XZ movement
        vel.x = 0;
        vel.z = 0;
        const steering = world.getComponent<SteeringComponent>(e, STEERING);
        if (steering) {
          steering.forceX = 0;
          steering.forceZ = 0;
        }
      }
    }
  }
}
