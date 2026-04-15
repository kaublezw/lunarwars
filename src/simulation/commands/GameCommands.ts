import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';

import {
  POSITION, RENDERABLE, SELECTABLE, HEALTH, TEAM,
  BUILDING, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND,
  PRODUCTION_QUEUE, SUPPLY_ROUTE, VOXEL_STATE,
  REPAIR_COMMAND, WALL_BUILD_QUEUE, POWER_POLE_RUIN,
  POWER_NODE, POWER_POLE, VISION, MACRO_GRID_SIZE,
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
import type { PowerPoleRuinComponent } from '@sim/components/PowerPoleRuin';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { PowerPoleComponent } from '@sim/components/PowerPole';
import type { VisionComponent } from '@sim/components/Vision';

import { BuildingType } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import { validateAndSnapPlacement } from '@sim/ai/PlacementValidator';
import { teamHasEngine, engineInProduction } from '@sim/logistics/TrainSpawner';
import type { PowerGridState } from '@sim/economy/PowerGridState';
import { routePowerConnection } from '@sim/economy/PowerGridRouter';

import { TEAM_COLORS } from '@sim/ai/AITypes';

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

export function issueWorkerBuild(
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
  if (def.matterCost > 0) {
    ctx.resources.spendMatter(team, def.matterCost);
  }

  // Create construction site entity
  const site = createConstructionSiteEntity(
    ctx, team, type, def.meshType, placement.x, placement.z, workerEntity,
  );

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

  // Single engine rule: only 1 TrainEngine per team
  if (unitType === UnitCategory.TrainEngine) {
    if (teamHasEngine(ctx.world, team) || engineInProduction(ctx.world, team)) {
      return false;
    }
  }

  // Affordability
  if (!ctx.resources.canAfford(team, def.energyCost)) return false;
  if (!ctx.resources.canAffordMatter(team, def.matterCost)) return false;

  // Production queue
  const pq = ctx.world.getComponent<ProductionQueueComponent>(factory, PRODUCTION_QUEUE);
  if (!pq) return false;
  // Deduct resources
  ctx.resources.spend(team, def.energyCost);
  if (def.matterCost > 0) {
    ctx.resources.spendMatter(team, def.matterCost);
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

/**
 * Count pole ruins for a team and return the total repair cost.
 */
export function getPoleRepairCost(
  world: World,
  team: number,
): { count: number; energyCost: number; matterCost: number } {
  const def = BUILDING_DEFS[BuildingType.PowerPole];
  if (!def) return { count: 0, energyCost: 0, matterCost: 0 };

  const ruins = world.query(POWER_POLE_RUIN, TEAM, POSITION);
  let count = 0;
  for (const e of ruins) {
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team === team) count++;
  }

  return {
    count,
    energyCost: count * def.energyCost,
    matterCost: count * def.matterCost,
  };
}

/**
 * Instantly repair all destroyed power poles for a team.
 * Spawns fully built poles at each ruin position, destroys ruins, reconnects grid.
 * Requires PowerGridState for edge reconnection.
 */
export function repairAllPoles(
  ctx: GameCommandContext,
  team: number,
  powerGrid: PowerGridState,
): boolean {
  const { count, energyCost, matterCost } = getPoleRepairCost(ctx.world, team);
  if (count === 0) return false;

  // Affordability
  if (!ctx.resources.canAfford(team, energyCost)) return false;
  if (!ctx.resources.canAffordMatter(team, matterCost)) return false;

  // Deduct resources
  ctx.resources.spend(team, energyCost);
  if (matterCost > 0) ctx.resources.spendMatter(team, matterCost);

  const def = BUILDING_DEFS[BuildingType.PowerPole]!;

  // Collect all ruins for this team
  const ruins = ctx.world.query(POWER_POLE_RUIN, TEAM, POSITION);
  const toRepair: { entity: number; x: number; y: number; z: number; gridX: number; gridZ: number }[] = [];
  for (const e of ruins) {
    const t = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
    const ruin = ctx.world.getComponent<PowerPoleRuinComponent>(e, POWER_POLE_RUIN)!;
    toRepair.push({ entity: e, x: pos.x, y: pos.y, z: pos.z, gridX: ruin.gridX, gridZ: ruin.gridZ });
  }

  // Spawn fully built poles and destroy ruins
  for (const r of toRepair) {
    // Create the pole entity
    const pole = ctx.world.createEntity();
    ctx.world.addComponent<PositionComponent>(pole, POSITION, {
      x: r.x, y: r.y, z: r.z,
      prevX: r.x, prevY: r.y, prevZ: r.z,
      rotation: 0,
    });
    ctx.world.addComponent<RenderableComponent>(pole, RENDERABLE, {
      meshType: 'power_pole',
      color: TEAM_COLORS[team] ?? 0xffffff,
      scale: 1.0,
    });
    ctx.world.addComponent<HealthComponent>(pole, HEALTH, {
      current: def.hp, max: def.hp, dead: false,
    });
    ctx.world.addComponent<TeamComponent>(pole, TEAM, { team });
    ctx.world.addComponent<BuildingComponent>(pole, BUILDING, { buildingType: BuildingType.PowerPole });
    ctx.world.addComponent<SelectableComponent>(pole, SELECTABLE, { selected: false });
    ctx.world.addComponent<VisionComponent>(pole, VISION, { range: def.visionRange });

    const voxelModel = VOXEL_MODELS[def.meshType];
    if (voxelModel) {
      ctx.world.addComponent<VoxelStateComponent>(pole, VOXEL_STATE, {
        modelId: def.meshType,
        totalVoxels: voxelModel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    ctx.world.addComponent<PowerNodeComponent>(pole, POWER_NODE, {
      powered: false,
      nodeId: powerGrid.allocateNodeId(),
    });
    ctx.world.addComponent<PowerPoleComponent>(pole, POWER_POLE, {
      gridX: r.gridX,
      gridZ: r.gridZ,
    });

    // Reconnect to nearest existing powered nodes
    routePowerConnection(ctx.world, team, pole, powerGrid, ctx.terrain, null);

    // Destroy the ruin
    ctx.world.destroyEntity(r.entity);
  }

  powerGrid.markDirty(team);
  return true;
}
