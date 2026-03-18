import type { World } from '@core/ECS';
import { POSITION, RENDERABLE, ENERGY_PACKET, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { EnergyPacketComponent } from '@sim/components/EnergyPacket';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';

/** Height above building base for beam travel */
const BEAM_ELEVATION = 5.5;
/** Speed of beam voxels (world units per second) */
const BEAM_SPEED = 12;

/** Spawn a visual-only energy beam packet from source entity to dest entity.
 *  The packet travels as a glowing voxel with point light (handled by BuildingEffectsRenderer).
 *  energyAmount=0 means no resource is added on arrival — purely visual. */
export function spawnEnergyBeam(
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

  const startY = sourcePos.y + BEAM_ELEVATION;

  world.addComponent<PositionComponent>(e, POSITION, {
    x: sourcePos.x,
    y: startY,
    z: sourcePos.z,
    prevX: sourcePos.x,
    prevY: startY,
    prevZ: sourcePos.z,
    rotation: 0,
  });

  world.addComponent<RenderableComponent>(e, RENDERABLE, {
    meshType: 'energy_packet',
    color: 0x66ccff,
    scale: 1.0,
  });

  world.addComponent<TeamComponent>(e, TEAM, { team });

  world.addComponent<EnergyPacketComponent>(e, ENERGY_PACKET, {
    sourceEntity,
    targetEntity: destEntity,
    targetX: destPos.x,
    targetY: destPos.y + BEAM_ELEVATION,
    targetZ: destPos.z,
    speed: BEAM_SPEED,
    energyAmount: 0, // Visual only — energy already deducted
    team,
  });
}
