import type { System, World } from '@core/ECS';
import { HEALTH } from '@sim/components/ComponentTypes';
import type { HealthComponent } from '@sim/components/Health';

export class HealthSystem implements System {
  readonly name = 'HealthSystem';

  update(world: World, _dt: number): void {
    const entities = world.query(HEALTH);
    for (const e of entities) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) {
        world.destroyEntity(e);
      }
    }
  }
}
