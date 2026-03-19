import type { System, World } from '@core/ECS';
import { MATTER_DELIVERY, POSITION, HEALTH, MOVE_COMMAND } from '@sim/components/ComponentTypes';
import type { MatterDeliveryComponent } from '@sim/components/MatterDelivery';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';

const ARRIVAL_DIST_SQ = 25.0; // 5 wu arrival threshold (matches SupplySystem)

export class MatterDeliverySystem implements System {
  readonly name = 'MatterDeliverySystem';

  update(world: World, _dt: number): void {
    const entities = world.query(MATTER_DELIVERY, POSITION);

    for (const e of entities) {
      const delivery = world.getComponent<MatterDeliveryComponent>(e, MATTER_DELIVERY)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Check if destination is still alive
      const destHealth = world.getComponent<HealthComponent>(delivery.destEntity, HEALTH);
      if (destHealth && destHealth.dead) {
        world.destroyEntity(e);
        continue;
      }

      // Movement is handled by PathfindingSystem + MovementSystem via MOVE_COMMAND.
      // Check if we've arrived (MOVE_COMMAND removed by PathfindingSystem on arrival).
      if (!world.hasComponent(e, MOVE_COMMAND)) {
        const dx = delivery.destX - pos.x;
        const dz = delivery.destZ - pos.z;
        const distSq = dx * dx + dz * dz;

        if (distSq <= ARRIVAL_DIST_SQ) {
          // Arrived — disappear
          world.destroyEntity(e);
        } else {
          // Re-issue move command (path may have been cleared without arriving)
          world.addComponent(e, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: delivery.destX, destZ: delivery.destZ,
          });
        }
      }
    }
  }
}
