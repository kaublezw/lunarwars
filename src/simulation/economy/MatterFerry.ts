import type { World } from '@core/ECS';
import { POSITION, RENDERABLE, MATTER_DELIVERY, TEAM, HEALTH, VOXEL_STATE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { MatterDeliveryComponent } from '@sim/components/MatterDelivery';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import { TEAM_COLORS } from '@sim/ai/AITypes';

/** Speed matches trained Ferry Drones (2.4 wu/s) */
const FERRY_SPEED = 2.4;

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
    color: TEAM_COLORS[team] ?? 0xffffff,
    scale: 1.0,
  });

  world.addComponent<TeamComponent>(e, TEAM, { team });

  // Add voxel state so it renders identically to trained Ferry Drones
  const ferryModel = VOXEL_MODELS['ferry_drone'];
  if (ferryModel) {
    world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
      modelId: 'ferry_drone',
      totalVoxels: ferryModel.totalSolid,
      destroyedCount: 0,
      destroyed: new Uint8Array(Math.ceil(ferryModel.totalSolid / 8)),
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }

  world.addComponent<MatterDeliveryComponent>(e, MATTER_DELIVERY, {
    destEntity,
    destX: destPos.x,
    destZ: destPos.z,
    speed: FERRY_SPEED,
  });
}
