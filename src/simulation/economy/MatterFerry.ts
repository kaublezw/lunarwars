import type { World } from '@core/ECS';
import { POSITION, RENDERABLE, MATTER_DELIVERY, TEAM, HEALTH, VOXEL_STATE, VELOCITY, STEERING, UNIT_TYPE, MOVE_COMMAND } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { MatterDeliveryComponent } from '@sim/components/MatterDelivery';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { UnitCategory } from '@sim/components/UnitType';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { TEAM_COLORS } from '@sim/ai/AITypes';
import type { TerrainData } from '@sim/terrain/TerrainData';

/** Spawn a temporary matter delivery ferry from source entity to dest entity.
 *  The ferry is free, travels to the destination, and disappears on arrival.
 *  Matter is already deducted — this is purely visual.
 *  Uses pathfinding (MOVE_COMMAND) so it moves identically to trained Ferry Drones. */
export function spawnMatterFerry(
  world: World,
  sourceEntity: number,
  destEntity: number,
  team: number,
  terrain: TerrainData,
): void {
  const sourcePos = world.getComponent<PositionComponent>(sourceEntity, POSITION);
  const destPos = world.getComponent<PositionComponent>(destEntity, POSITION);
  if (!sourcePos || !destPos) return;

  const destHealth = world.getComponent<HealthComponent>(destEntity, HEALTH);
  if (destHealth && destHealth.dead) return;

  const ferryDef = UNIT_DEFS[UnitCategory.FerryDrone];
  const spawnY = terrain.getHeight(sourcePos.x, sourcePos.z) + 0.02;

  const e = world.createEntity();

  world.addComponent<PositionComponent>(e, POSITION, {
    x: sourcePos.x,
    y: spawnY,
    z: sourcePos.z,
    prevX: sourcePos.x,
    prevY: spawnY,
    prevZ: sourcePos.z,
    rotation: 0,
  });

  world.addComponent<VelocityComponent>(e, VELOCITY, {
    x: 0, z: 0, speed: ferryDef.speed,
  });

  world.addComponent<SteeringComponent>(e, STEERING, { forceX: 0, forceZ: 0 });

  world.addComponent<UnitTypeComponent>(e, UNIT_TYPE, {
    category: UnitCategory.FerryDrone,
    radius: ferryDef.radius,
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
    speed: ferryDef.speed,
  });

  // Use pathfinding to move like trained Ferry Drones
  world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
    path: [], currentWaypoint: 0,
    destX: destPos.x, destZ: destPos.z,
  });
}
