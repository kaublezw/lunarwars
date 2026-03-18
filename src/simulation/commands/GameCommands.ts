import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import { spawnEnergyBeam } from '@sim/economy/EnergyBeam';
import { spawnMatterFerry } from '@sim/economy/MatterFerry';

import {
  POSITION, RENDERABLE, SELECTABLE, HEALTH, TEAM,
  BUILDING, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND,
  PRODUCTION_QUEUE, SUPPLY_ROUTE, VOXEL_STATE,
  REPAIR_COMMAND, WALL_BUILD_QUEUE,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { WallBuildQueueComponent } from '@sim/components/WallBuildQueue';

import { BuildingType } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import { validateAndSnapPlacement } from '@sim/ai/PlacementValidator';

import { TEAM_COLORS, MAX_QUEUE_DEPTH } from '@sim/ai/AITypes';

export interface GameCommandContext {
  world: World;
  resources: ResourceState;
  terrain: TerrainData;
  energyNodes: EnergyNode[];
  oreDeposits: OreDeposit[];
}

export interface WallSegment {
  x: number;
  z: number;
  meshType: 'wall_x' | 'wall_z' | 'wall_corner';
}

// --- Construction site creation (shared by buildStructure and buildWallSegments) ---

function createConstructionSiteEntity(
  ctx: GameCommandContext,
  team: number,
  type: BuildingType,
  meshType: string,
  x: number,
  z: number,
  workerEntity: number,
): number {
  const def = BUILDING_DEFS[type];
  const site = ctx.world.createEntity();
  const siteY = ctx.terrain.getHeight(x, z);

  ctx.world.addComponent<PositionComponent>(site, POSITION, {
    x, y: siteY, z,
    prevX: x, prevY: siteY, prevZ: z,
    rotation: 0,
  });

  ctx.world.addComponent<RenderableComponent>(site, RENDERABLE, {
    meshType,
    color: TEAM_COLORS[team],
    scale: 1.0,
  });

  ctx.world.addComponent<TeamComponent>(site, TEAM, { team });

  ctx.world.addComponent<BuildingComponent>(site, BUILDING, {
    buildingType: type,
  });

  ctx.world.addComponent<HealthComponent>(site, HEALTH, {
    current: 50,
    max: def.hp,
    dead: false,
  });

  ctx.world.addComponent<ConstructionComponent>(site, CONSTRUCTION, {
    buildingType: type,
    progress: 0,
    buildTime: def.buildTime,
    builderEntity: workerEntity,
  });

  ctx.world.addComponent<SelectableComponent>(site, SELECTABLE, { selected: false });

  const finalModel = VOXEL_MODELS[meshType];
  if (finalModel) {
    const destroyedMask = new Uint8Array(Math.ceil(finalModel.totalSolid / 8));
    destroyedMask.fill(255);
    for (let i = 0; i < finalModel.firstLayerCount; i++) {
      const solidIdx = finalModel.buildOrder[i];
      destroyedMask[solidIdx >> 3] &= ~(1 << (solidIdx & 7));
    }
    ctx.world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
      modelId: meshType,
      totalVoxels: finalModel.totalSolid,
      destroyedCount: finalModel.totalSolid - finalModel.firstLayerCount,
      destroyed: destroyedMask,
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }

  return site;
}

function clearWorkerCommands(world: World, workerEntity: number): void {
  if (world.hasComponent(workerEntity, BUILD_COMMAND)) {
    world.removeComponent(workerEntity, BUILD_COMMAND);
  }
  if (world.hasComponent(workerEntity, SUPPLY_ROUTE)) {
    world.removeComponent(workerEntity, SUPPLY_ROUTE);
  }
  if (world.hasComponent(workerEntity, REPAIR_COMMAND)) {
    world.removeComponent(workerEntity, REPAIR_COMMAND);
  }
  if (world.hasComponent(workerEntity, WALL_BUILD_QUEUE)) {
    world.removeComponent(workerEntity, WALL_BUILD_QUEUE);
  }
}

function issueWorkerBuild(
  world: World,
  workerEntity: number,
  type: BuildingType,
  x: number,
  z: number,
  siteEntity: number,
): void {
  if (world.hasComponent(workerEntity, MOVE_COMMAND)) {
    world.removeComponent(workerEntity, MOVE_COMMAND);
  }
  world.addComponent<MoveCommandComponent>(workerEntity, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: x,
    destZ: z,
  });

  world.addComponent<BuildCommandComponent>(workerEntity, BUILD_COMMAND, {
    buildingType: type,
    targetX: x,
    targetZ: z,
    state: 'moving',
    siteEntity,
  });
}

// --- Public API ---

/**
 * Build a structure: validate placement, check affordability, deduct resources,
 * create construction site, and issue build command to worker.
 * Returns true if successful.
 */
export function buildStructure(
  ctx: GameCommandContext,
  team: number,
  type: BuildingType,
  x: number,
  z: number,
  workerEntity: number,
): boolean {
  // Worker must not already be building
  if (ctx.world.hasComponent(workerEntity, BUILD_COMMAND)) return false;

  const def = BUILDING_DEFS[type];
  if (!def) return false;

  // Affordability
  if (!ctx.resources.canAfford(team, def.energyCost)) return false;
  if (!ctx.resources.canAffordMatter(team, def.matterCost)) return false;

  // Spatial validation + snap
  const placement = validateAndSnapPlacement(
    type, x, z, ctx.world, ctx.terrain, ctx.energyNodes, ctx.oreDeposits,
  );
  if (!placement.valid) return false;

  // Deduct resources
  ctx.resources.spend(team, def.energyCost);
  const energySiloSource = ctx.resources.lastSourceSilo;
  if (def.matterCost > 0) {
    ctx.resources.spendMatter(team, def.matterCost);
  }
  const matterSiloSource = ctx.resources.lastSourceSilo;

  // Create construction site entity
  const site = createConstructionSiteEntity(
    ctx, team, type, def.meshType, placement.x, placement.z, workerEntity,
  );

  // Visual: energy beam from source silo to build site
  if (energySiloSource >= 0 && def.energyCost > 0) {
    spawnEnergyBeam(ctx.world, energySiloSource, site, team);
  }
  // Visual: matter ferry from source silo to build site
  if (matterSiloSource >= 0 && def.matterCost > 0) {
    spawnMatterFerry(ctx.world, matterSiloSource, site, team);
  }

  // Clear existing worker commands and issue new build
  clearWorkerCommands(ctx.world, workerEntity);
  issueWorkerBuild(ctx.world, workerEntity, type, placement.x, placement.z, site);

  return true;
}

/**
 * Build wall segments: check affordability for all segments, deduct resources,
 * create construction sites, and issue build command to worker.
 * Returns true if successful.
 */
export function buildWallSegments(
  ctx: GameCommandContext,
  team: number,
  segments: WallSegment[],
  workerEntity: number,
): boolean {
  if (segments.length === 0) return false;

  // Worker must not already be building
  if (ctx.world.hasComponent(workerEntity, BUILD_COMMAND)) return false;

  const def = BUILDING_DEFS[BuildingType.Wall];
  if (!def) return false;

  // Total cost
  const totalEnergyCost = def.energyCost * segments.length;
  const totalMatterCost = def.matterCost * segments.length;

  // Affordability
  if (totalEnergyCost > 0 && !ctx.resources.canAfford(team, totalEnergyCost)) return false;
  if (totalMatterCost > 0 && !ctx.resources.canAffordMatter(team, totalMatterCost)) return false;

  // Deduct resources
  if (totalEnergyCost > 0) ctx.resources.spend(team, totalEnergyCost);
  const wallEnergySilo = ctx.resources.lastSourceSilo;
  if (totalMatterCost > 0) ctx.resources.spendMatter(team, totalMatterCost);

  // Clear existing worker commands
  clearWorkerCommands(ctx.world, workerEntity);

  // Create all wall construction site entities
  const siteEntities: number[] = [];
  for (const seg of segments) {
    const site = createConstructionSiteEntity(
      ctx, team, BuildingType.Wall, seg.meshType, seg.x, seg.z, workerEntity,
    );
    siteEntities.push(site);
  }

  // Visual: energy beam from source silo to first wall segment
  if (wallEnergySilo >= 0 && totalEnergyCost > 0 && siteEntities.length > 0) {
    spawnEnergyBeam(ctx.world, wallEnergySilo, siteEntities[0], team);
  }

  // Issue move + build command for first segment
  const firstSeg = segments[0];
  issueWorkerBuild(ctx.world, workerEntity, BuildingType.Wall, firstSeg.x, firstSeg.z, siteEntities[0]);

  // Add wall build queue if multiple segments
  if (siteEntities.length > 1) {
    ctx.world.addComponent<WallBuildQueueComponent>(workerEntity, WALL_BUILD_QUEUE, {
      siteEntities,
      currentIndex: 0,
    });
  }

  return true;
}

/**
 * Train a unit at a production building: check affordability, deduct resources,
 * add to production queue.
 * Returns true if successful.
 */
export function trainUnit(
  ctx: GameCommandContext,
  team: number,
  factory: number,
  unitType: UnitCategory,
  rallyX: number,
  rallyZ: number,
): boolean {
  const def = UNIT_DEFS[unitType];
  if (!def) return false;

  // Affordability
  if (!ctx.resources.canAfford(team, def.energyCost)) return false;
  if (!ctx.resources.canAffordMatter(team, def.matterCost)) return false;

  // Production queue
  const pq = ctx.world.getComponent<ProductionQueueComponent>(factory, PRODUCTION_QUEUE);
  if (!pq) return false;
  if (pq.queue.length >= MAX_QUEUE_DEPTH) return false;

  // Deduct resources
  ctx.resources.spend(team, def.energyCost);
  const trainEnergySilo = ctx.resources.lastSourceSilo;
  if (def.matterCost > 0) {
    ctx.resources.spendMatter(team, def.matterCost);
  }
  const trainMatterSilo = ctx.resources.lastSourceSilo;

  // Visual: energy beam from source silo to production building
  if (trainEnergySilo >= 0 && def.energyCost > 0) {
    spawnEnergyBeam(ctx.world, trainEnergySilo, factory, team);
  }
  // Visual: matter ferry from source silo to production building
  if (trainMatterSilo >= 0 && def.matterCost > 0) {
    spawnMatterFerry(ctx.world, trainMatterSilo, factory, team);
  }

  pq.queue.push({
    unitType,
    timeRemaining: def.trainTime,
    totalTime: def.trainTime,
  });

  pq.rallyX = rallyX;
  pq.rallyZ = rallyZ;

  return true;
}
