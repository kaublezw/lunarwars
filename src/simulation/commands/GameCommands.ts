import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';

import {
  POSITION, RENDERABLE, SELECTABLE, HEALTH, TEAM,
  BUILDING, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND,
  PRODUCTION_QUEUE, VOXEL_STATE, POWER_NODE,
  REPAIR_COMMAND, WALL_BUILD_QUEUE, POWER_POLE_RUIN,
  MACRO_GRID_SIZE,
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

import { BuildingType } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import { validateAndSnapPlacement } from '@sim/ai/PlacementValidator';
import { teamHasEngine, engineInProduction } from '@sim/logistics/TrainSpawner';
import type { PowerGridState } from '@sim/economy/PowerGridState';
import type { TrackState } from '@sim/logistics/TrackState';
import { TEAM_COLORS } from '@sim/ai/AITypes';

export interface GameCommandContext {
  world: World;
  resources: ResourceState;
  terrain: TerrainData;
  energyNodes: EnergyNode[];
  oreDeposits: OreDeposit[];
  powerGrid: PowerGridState;
  trackState?: TrackState;
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

  // Supply depots: limit 1 per player
  if (type === BuildingType.SupplyDepot) {
    let depotCount = 0;
    const allBuildings = ctx.world.query(BUILDING, TEAM);
    for (const e of allBuildings) {
      const t = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const b = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (b.buildingType === BuildingType.SupplyDepot) depotCount++;
    }
    const allSites = ctx.world.query(CONSTRUCTION, TEAM);
    for (const e of allSites) {
      const t = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const c = ctx.world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
      if (c.buildingType === BuildingType.SupplyDepot) depotCount++;
    }
    if (depotCount >= 1) return false;
  }

  // Affordability
  if (!ctx.resources.canAfford(team, def.energyCost)) return false;
  if (!ctx.resources.canAffordMatter(team, def.matterCost)) return false;

  // Spatial validation + snap
  const placement = validateAndSnapPlacement(
    type, x, z, ctx.world, ctx.terrain, ctx.energyNodes, ctx.oreDeposits, ctx.trackState, team,
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

  // Block production at unpowered buildings
  const powerNode = ctx.world.getComponent<PowerNodeComponent>(factory, POWER_NODE);
  if (powerNode && !powerNode.powered) return false;

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
 * Rebuild all destroyed power poles for a team as construction sites.
 * Poles build up voxel-by-voxel via autoConstruct (no worker needed).
 * Power grid edges are restored when each pole completes in BuildSystem.
 */
export function repairAllPoles(
  ctx: GameCommandContext,
  team: number,
  _powerGrid: PowerGridState,
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

  // Create construction sites at each ruin position
  const ruins = ctx.world.query(POWER_POLE_RUIN, TEAM, POSITION);
  for (const e of ruins) {
    const t = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
    const ruin = ctx.world.getComponent<PowerPoleRuinComponent>(e, POWER_POLE_RUIN)!;

    const site = ctx.world.createEntity();
    ctx.world.addComponent<PositionComponent>(site, POSITION, {
      x: pos.x, y: pos.y, z: pos.z,
      prevX: pos.x, prevY: pos.y, prevZ: pos.z,
      rotation: 0,
    });
    ctx.world.addComponent<RenderableComponent>(site, RENDERABLE, {
      meshType: def.meshType,
      color: TEAM_COLORS[team] ?? 0xffffff,
      scale: 1.0,
    });
    ctx.world.addComponent<TeamComponent>(site, TEAM, { team });
    ctx.world.addComponent<BuildingComponent>(site, BUILDING, { buildingType: BuildingType.PowerPole });
    ctx.world.addComponent<HealthComponent>(site, HEALTH, {
      current: 50, max: def.hp, dead: false,
    });
    ctx.world.addComponent<SelectableComponent>(site, SELECTABLE, { selected: false });

    // Voxel state: foundation only visible, rest destroyed
    const voxelModel = VOXEL_MODELS[def.meshType];
    if (voxelModel) {
      const destroyedMask = new Uint8Array(Math.ceil(voxelModel.totalSolid / 8));
      destroyedMask.fill(255);
      for (let i = 0; i < voxelModel.firstLayerCount; i++) {
        const solidIdx = voxelModel.buildOrder[i];
        destroyedMask[solidIdx >> 3] &= ~(1 << (solidIdx & 7));
      }
      ctx.world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
        modelId: def.meshType,
        totalVoxels: voxelModel.totalSolid,
        destroyedCount: voxelModel.totalSolid - voxelModel.firstLayerCount,
        destroyed: destroyedMask,
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    ctx.world.addComponent<ConstructionComponent>(site, CONSTRUCTION, {
      buildingType: BuildingType.PowerPole,
      progress: 0,
      buildTime: def.buildTime,
      builderEntity: -1,
      autoConstruct: true,
      poleNeighbors: ruin.neighborGridPositions ?? [],
    });

    ctx.world.destroyEntity(e);
  }

  return true;
}
