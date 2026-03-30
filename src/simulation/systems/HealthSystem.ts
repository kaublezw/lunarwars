import type { System, World } from '@core/ECS';
import { HEALTH, VOXEL_STATE, DEATH_TIMER, BUILDING, POSITION } from '@sim/components/ComponentTypes';
import type { HealthComponent } from '@sim/components/Health';
import type { DeathTimerComponent } from '@sim/components/DeathTimer';
import type { PositionComponent } from '@sim/components/Position';
import type { EventBus } from '@core/EventBus';

const DEATH_DELAY = 0.3; // seconds of shimmer before explosion

export class HealthSystem implements System {
  readonly name = 'HealthSystem';
  private eventBus?: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus;
  }

  update(world: World, dt: number): void {
    // Process death timers
    const dyingEntities = world.query(DEATH_TIMER);
    for (const e of dyingEntities) {
      const timer = world.getComponent<DeathTimerComponent>(e, DEATH_TIMER)!;
      timer.timeRemaining -= dt;
      // Emit explosion sound the tick the timer expires (flash -> explosion transition)
      if (timer.timeRemaining <= 0 && timer.timeRemaining + dt > 0 && this.eventBus) {
        const pos = world.getComponent<PositionComponent>(e, POSITION);
        if (pos) {
          const event = world.hasComponent(e, BUILDING) ? 'explosion:building' : 'explosion:unit';
          this.eventBus.emit(event, pos.x, pos.z);
        }
      }
      if (timer.timeRemaining <= 0 && timer.exploded) {
        world.destroyEntity(e);
      }
    }

    // Process dead entities
    const entities = world.query(HEALTH);
    for (const e of entities) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (!health.dead) continue;

      // For voxel entities: add death timer for explosion animation
      if (world.hasComponent(e, VOXEL_STATE) && !world.hasComponent(e, DEATH_TIMER)) {
        world.addComponent<DeathTimerComponent>(e, DEATH_TIMER, {
          timeRemaining: DEATH_DELAY,
          exploded: false,
        });
        continue;
      }

      // Non-voxel entities or entities that have already exploded
      if (!world.hasComponent(e, DEATH_TIMER)) {
        world.destroyEntity(e);
      }
    }
  }
}
