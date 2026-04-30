import type { World } from '@core/ECS';
import type { GameCommandPayload } from '@network/Protocol';
import type { GameCommandContext } from '@sim/commands/GameCommands';

import {
  POSITION, MOVE_COMMAND, ATTACK_TARGET,
  RESUPPLY_SEEK, REPAIR_COMMAND, BUILD_COMMAND, TURRET,
  PRODUCTION_QUEUE, BUILDING, CONSTRUCTION, TEAM, HEALTH,
  UNIT_TYPE, SELECTABLE,
} from '@sim/components/ComponentTypes';

import type { PositionComponent } from '@sim/components/Position';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { AttackTargetComponent } from '@sim/components/AttackTarget';
import type { RepairCommandComponent } from '@sim/components/RepairCommand';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';

import { buildStructure, trainUnit, repairAllPoles } from '@sim/commands/GameCommands';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UnitCategory } from '@sim/components/UnitType';
import { SeededRandom } from '@sim/utils/SeededRandom';

// Formation offset computation (same pure function as SelectionController)
function computeFormationOffsets(count: number, spacing: number): { x: number; z: number }[] {
  const offsets: { x: number; z: number }[] = [];
  offsets.push({ x: 0, z: 0 });
  let ring = 1;
  while (offsets.length < count) {
    const slotsInRing = 6 * ring;
    const radius = ring * spacing;
    for (let i = 0; i < slotsInRing && offsets.length < count; i++) {
      const angle = (2 * Math.PI * i) / slotsInRing;
      offsets.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
    }
    ring++;
  }
  return offsets;
}

function clearMoveCommands(world: World, entity: number): void {
  if (world.hasComponent(entity, MOVE_COMMAND)) world.removeComponent(entity, MOVE_COMMAND);
}

function clearCombatCommands(world: World, entity: number): void {
  if (world.hasComponent(entity, RESUPPLY_SEEK)) world.removeComponent(entity, RESUPPLY_SEEK);
  if (world.hasComponent(entity, REPAIR_COMMAND)) world.removeComponent(entity, REPAIR_COMMAND);
  if (world.hasComponent(entity, ATTACK_TARGET)) world.removeComponent(entity, ATTACK_TARGET);
}

function issueMoveToEntity(world: World, entity: number, destX: number, destZ: number): void {
  clearMoveCommands(world, entity);
  world.addComponent<MoveCommandComponent>(entity, MOVE_COMMAND, {
    path: [], currentWaypoint: 0, destX, destZ,
  });
}

/**
 * Execute a game command payload against the ECS world.
 * This is the single point where all player commands (local + remote) mutate game state.
 */
export function executeCommand(
  cmd: GameCommandPayload,
  ctx: GameCommandContext,
  world: World,
): void {
  switch (cmd.type) {
    case 'moveUnits':
      executeMoveUnits(cmd.entityIds, cmd.destX, cmd.destZ, cmd.jitterSeed, world);
      break;

    case 'attackMove':
      executeAttackMove(cmd.entityIds, cmd.targetEntity, cmd.targetX, cmd.targetZ, world);
      break;

    case 'buildStructure':
      buildStructure(ctx, cmd.team, cmd.buildingType as BuildingType, cmd.x, cmd.z, cmd.workerEntity);
      break;

    case 'trainUnit':
      trainUnit(ctx, cmd.team, cmd.factoryEntity, cmd.unitType as UnitCategory, cmd.rallyX, cmd.rallyZ);
      break;

    case 'setRallyPoint':
      executeSetRallyPoint(cmd.buildingEntity, cmd.rallyX, cmd.rallyZ, world);
      break;

    case 'demolish':
      executeDemolish(cmd.entityId, cmd.team, ctx, world);
      break;

    case 'repairBuilding':
      executeRepairBuilding(cmd.workerEntities, cmd.targetBuildingEntity, world);
      break;

    case 'reassignWorker':
      executeReassignWorker(cmd.workerEntity, cmd.constructionSiteEntity, world);
      break;

    case 'repairAllPoles':
      repairAllPoles(ctx, cmd.team, ctx.powerGrid);
      break;

    case 'rebuildLines':
      ctx.powerGrid.markDirty(cmd.team);
      ctx.powerGrid.markHealPending(cmd.team);
      break;
  }
}

function executeMoveUnits(
  entityIds: number[], destX: number, destZ: number, jitterSeed: number, world: World,
): void {
  if (entityIds.length === 0) return;

  if (entityIds.length === 1) {
    const e = entityIds[0];
    clearCombatCommands(world, e);
    issueMoveToEntity(world, e, destX, destZ);
    return;
  }

  // Multi-unit formation
  let maxRadius = 0;
  for (const e of entityIds) {
    const ut = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
    const r = ut ? ut.radius : 0.5;
    if (r > maxRadius) maxRadius = r;
  }

  const spacing = Math.max(maxRadius * 3, 1.5);
  const offsets = computeFormationOffsets(entityIds.length, spacing);
  const jitterMax = maxRadius * 0.4;
  const rng = new SeededRandom(jitterSeed);

  for (let i = 0; i < entityIds.length; i++) {
    const e = entityIds[i];
    clearCombatCommands(world, e);
    const jitterX = (rng.next() - 0.5) * jitterMax;
    const jitterZ = (rng.next() - 0.5) * jitterMax;
    issueMoveToEntity(world, e, destX + offsets[i].x + jitterX, destZ + offsets[i].z + jitterZ);
  }
}

function executeAttackMove(
  entityIds: number[], targetEntity: number, targetX: number, targetZ: number, world: World,
): void {
  for (const e of entityIds) {
    clearCombatCommands(world, e);

    if (world.hasComponent(e, TURRET)) {
      world.addComponent<AttackTargetComponent>(e, ATTACK_TARGET, { entity: targetEntity });
    }

    issueMoveToEntity(world, e, targetX, targetZ);
  }
}

function executeSetRallyPoint(
  buildingEntity: number, rallyX: number, rallyZ: number, world: World,
): void {
  const queue = world.getComponent<ProductionQueueComponent>(buildingEntity, PRODUCTION_QUEUE);
  if (queue) {
    queue.rallyX = rallyX;
    queue.rallyZ = rallyZ;
  }
}

function executeDemolish(
  entityId: number, team: number, ctx: GameCommandContext, world: World,
): void {
  const building = world.getComponent<BuildingComponent>(entityId, BUILDING);
  if (!building || building.buildingType === BuildingType.HQ) return;
  const t = world.getComponent<TeamComponent>(entityId, TEAM);
  if (!t || t.team !== team) return;
  if (world.hasComponent(entityId, CONSTRUCTION)) return;

  const def = BUILDING_DEFS[building.buildingType];
  if (def) {
    const refund = Math.floor(def.matterCost * 0.7);
    ctx.resources.get(team).matter += refund;
  }

  // Trigger normal death pipeline: flash, explosion, rubble, power grid cleanup
  const health = world.getComponent<HealthComponent>(entityId, HEALTH);
  if (health) {
    health.dead = true;
  } else {
    world.destroyEntity(entityId);
  }
}

function executeRepairBuilding(
  workerEntities: number[], targetBuildingEntity: number, world: World,
): void {
  const buildingPos = world.getComponent<PositionComponent>(targetBuildingEntity, POSITION);
  if (!buildingPos) return;

  for (const w of workerEntities) {
    if (world.hasComponent(w, BUILD_COMMAND)) world.removeComponent(w, BUILD_COMMAND);
    if (world.hasComponent(w, RESUPPLY_SEEK)) world.removeComponent(w, RESUPPLY_SEEK);
    if (world.hasComponent(w, REPAIR_COMMAND)) world.removeComponent(w, REPAIR_COMMAND);

    world.addComponent<RepairCommandComponent>(w, REPAIR_COMMAND, {
      targetEntity: targetBuildingEntity,
      state: 'moving',
    });

    issueMoveToEntity(world, w, buildingPos.x, buildingPos.z);
  }
}

function executeReassignWorker(
  workerEntity: number, constructionSiteEntity: number, world: World,
): void {
  const sitePos = world.getComponent<PositionComponent>(constructionSiteEntity, POSITION);
  const construction = world.getComponent<ConstructionComponent>(constructionSiteEntity, CONSTRUCTION);
  if (!sitePos || !construction) return;

  if (world.hasComponent(workerEntity, BUILD_COMMAND)) world.removeComponent(workerEntity, BUILD_COMMAND);
  if (world.hasComponent(workerEntity, RESUPPLY_SEEK)) world.removeComponent(workerEntity, RESUPPLY_SEEK);
  if (world.hasComponent(workerEntity, REPAIR_COMMAND)) world.removeComponent(workerEntity, REPAIR_COMMAND);

  construction.builderEntity = workerEntity;

  world.addComponent<BuildCommandComponent>(workerEntity, BUILD_COMMAND, {
    buildingType: construction.buildingType,
    targetX: sitePos.x,
    targetZ: sitePos.z,
    state: 'moving',
    siteEntity: constructionSiteEntity,
  });

  issueMoveToEntity(world, workerEntity, sitePos.x, sitePos.z);
}
