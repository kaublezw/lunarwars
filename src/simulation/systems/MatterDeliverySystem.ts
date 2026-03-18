import type { System, World } from '@core/ECS';
import { MATTER_DELIVERY, POSITION, HEALTH } from '@sim/components/ComponentTypes';
import type { MatterDeliveryComponent } from '@sim/components/MatterDelivery';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';

const ARRIVAL_DIST_SQ = 4.0; // 2 wu arrival threshold

export class MatterDeliverySystem implements System {
  readonly name = 'MatterDeliverySystem';

  update(world: World, dt: number): void {
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

      // Move toward destination
      const dx = delivery.destX - pos.x;
      const dz = delivery.destZ - pos.z;
      const distSq = dx * dx + dz * dz;

      if (distSq <= ARRIVAL_DIST_SQ) {
        // Arrived — disappear
        world.destroyEntity(e);
        continue;
      }

      const dist = Math.sqrt(distSq);
      const step = delivery.speed * dt;
      const ratio = Math.min(step / dist, 1);

      pos.prevX = pos.x;
      pos.prevY = pos.y;
      pos.prevZ = pos.z;
      pos.x += dx * ratio;
      pos.z += dz * ratio;
    }
  }
}
