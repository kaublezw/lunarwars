import type { System, World } from '@core/ECS';
import { GARAGE_EXIT, POSITION, VELOCITY, STEERING, MOVE_COMMAND } from '@sim/components/ComponentTypes';
import type { GarageExitComponent } from '@sim/components/GarageExit';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';

export class GarageExitSystem implements System {
  readonly name = 'GarageExitSystem';

  update(world: World, _dt: number): void {
    const entities = world.query(GARAGE_EXIT, POSITION, VELOCITY);

    for (const e of entities) {
      const exit = world.getComponent<GarageExitComponent>(e, GARAGE_EXIT)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;

      if (pos.z >= exit.exitZ) {
        // Reached exit — switch to normal behavior
        world.removeComponent(e, GARAGE_EXIT);
        vel.x = 0;
        vel.z = 0;
        world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
          path: [], currentWaypoint: 0,
          destX: exit.rallyX, destZ: exit.rallyZ,
        });
      } else {
        // Drive straight +Z at unit speed
        vel.x = 0;
        vel.z = vel.speed;
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
