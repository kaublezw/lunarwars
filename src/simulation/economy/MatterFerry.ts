import type { World } from '@core/ECS';
import { POSITION, RENDERABLE, MATTER_DELIVERY, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { MatterDeliveryComponent } from '@sim/components/MatterDelivery';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';

/** Speed of temporary delivery ferries (world units per second) */
const FERRY_SPEED = 4;

/** Spawn a temporary matter delivery ferry from source entity to dest entity.
 *  The ferry is free, travels to the destination, and disappears on arrival.
 *  Matter is already deducted — this is purely visual. */
export function spawnMatterFerry(
  world: World,
  sourceEntity: number,
  destEntity: number,
  team: number,
): void {
  const sourcePos = world.getComponent<PositionComponent>(sourceEntity, POSITION);
  const destPos = world.getComponent<PositionComponent>(destEntity, POSITION);
  if (!sourcePos || !destPos) return;

  const destHealth = world.getComponent<HealthComponent>(destEntity, HEALTH);
  if (destHealth && destHealth.dead) return;

  const e = world.createEntity();

  world.addComponent<PositionComponent>(e, POSITION, {
    x: sourcePos.x,
    y: sourcePos.y + 0.5,
    z: sourcePos.z,
    prevX: sourcePos.x,
    prevY: sourcePos.y + 0.5,
    prevZ: sourcePos.z,
    rotation: 0,
  });

  world.addComponent<RenderableComponent>(e, RENDERABLE, {
    meshType: 'ferry_drone',
    color: 0x554433,
    scale: 0.6,
  });

  world.addComponent<TeamComponent>(e, TEAM, { team });

  world.addComponent<MatterDeliveryComponent>(e, MATTER_DELIVERY, {
    destEntity,
    destX: destPos.x,
    destZ: destPos.z,
    speed: FERRY_SPEED,
  });
}
