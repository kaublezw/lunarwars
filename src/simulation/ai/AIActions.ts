import {
  POSITION, RENDERABLE, SELECTABLE, HEALTH, TEAM,
  BUILDING, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND,
  PRODUCTION_QUEUE, MATTER_STORAGE, SUPPLY_ROUTE,
  VOXEL_STATE, RESUPPLY_SEEK, REPAIR_COMMAND,
  WALL_BUILD_QUEUE,
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
import type { RepairCommandComponent } from '@sim/components/RepairCommand';
import type { WallBuildQueueComponent } from '@sim/components/WallBuildQueue';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

import type { AIContext, AIWorldState, Squad, WallSegmentPlan } from '@sim/ai/AITypes';
import {
  TEAM_COLORS, RETREAT_HP_FRACTION, OVERWHELMING_ARMY,
  MAX_QUEUE_DEPTH, MEMORY_DECAY_TICKS,
} from '@sim/ai/AITypes';

export function issueMove(ctx: AIContext, entity: number, x: number, z: number): void {
  x = Math.max(4, Math.min(252, x));
  z = Math.max(4, Math.min(252, z));

  if (ctx.world.hasComponent(entity, MOVE_COMMAND)) {
    ctx.world.removeComponent(entity, MOVE_COMMAND);
  }

  ctx.world.addComponent<MoveCommandComponent>(entity, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: x,
    destZ: z,
  });
}

export function sendSquadTo(ctx: AIContext, squad: Squad, x: number, z: number): void {
  for (const unitId of squad.unitIds) {
    if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
    const existing = ctx.world.getComponent<MoveCommandComponent>(unitId, MOVE_COMMAND);
    if (existing) {
      const dx = existing.destX - x;
      const dz = existing.destZ - z;
      if (dx * dx + dz * dz < 25) continue;
    }
    issueMove(ctx, unitId, x, z);
  }
}

export function createConstructionSite(
  ctx: AIContext,
  type: BuildingType,
  x: number,
  z: number,
  workerEntity: number,
): void {
  const def = BUILDING_DEFS[type];
  if (!def) return;

  const site = ctx.world.createEntity();
  const siteY = ctx.terrain.getHeight(x, z);

  ctx.world.addComponent<PositionComponent>(site, POSITION, {
    x, y: siteY, z,
    prevX: x, prevY: siteY, prevZ: z,
    rotation: 0,
  });

  ctx.world.addComponent<RenderableComponent>(site, RENDERABLE, {
    meshType: def.meshType,
    color: TEAM_COLORS[ctx.team],
    scale: 1.0,
  });

  ctx.world.addComponent<TeamComponent>(site, TEAM, { team: ctx.team });

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

  // Start with first layer visible, rest destroyed — BuildSystem reveals progressively
  const finalModel = VOXEL_MODELS[def.meshType];
  if (finalModel) {
    const destroyedMask = new Uint8Array(Math.ceil(finalModel.totalSolid / 8));
    destroyedMask.fill(255);
    // Reveal the first Y layer immediately
    for (let i = 0; i < finalModel.firstLayerCount; i++) {
      const solidIdx = finalModel.buildOrder[i];
      destroyedMask[solidIdx >> 3] &= ~(1 << (solidIdx & 7));
    }
    ctx.world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
      modelId: def.meshType,
      totalVoxels: finalModel.totalSolid,
      destroyedCount: finalModel.totalSolid - finalModel.firstLayerCount,
      destroyed: destroyedMask,
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }

  ctx.world.addComponent<MoveCommandComponent>(workerEntity, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: x,
    destZ: z,
  });

  ctx.world.addComponent<BuildCommandComponent>(workerEntity, BUILD_COMMAND, {
    buildingType: type,
    targetX: x,
    targetZ: z,
    state: 'moving',
    siteEntity: site,
  });
}

export function trainUnit(
  ctx: AIContext,
  factory: number,
  unitType: UnitCategory,
  rallyX: number,
  rallyZ: number,
): boolean {
  const def = UNIT_DEFS[unitType];
  if (!def) return false;
  if (!ctx.resources.canAfford(ctx.team, def.energyCost)) return false;
  if (!ctx.resources.canAffordMatter(ctx.team, def.matterCost)) return false;

  const pq = ctx.world.getComponent<ProductionQueueComponent>(factory, PRODUCTION_QUEUE);
  if (!pq) return false;
  if (pq.queue.length >= MAX_QUEUE_DEPTH) return false;

  ctx.resources.spend(ctx.team, def.energyCost);
  if (def.matterCost > 0) {
    ctx.resources.spendMatter(ctx.team, def.matterCost);
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

export function trainFromHQ(ctx: AIContext, unitType: UnitCategory, hq: number): boolean {
  const def = UNIT_DEFS[unitType];
  if (!def) return false;
  if (!ctx.resources.canAfford(ctx.team, def.energyCost)) return false;
  if (!ctx.resources.canAffordMatter(ctx.team, def.matterCost)) return false;

  const pq = ctx.world.getComponent<ProductionQueueComponent>(hq, PRODUCTION_QUEUE);
  if (!pq) return false;
  if (pq.queue.length >= MAX_QUEUE_DEPTH) return false;

  ctx.resources.spend(ctx.team, def.energyCost);
  if (def.matterCost > 0) {
    ctx.resources.spendMatter(ctx.team, def.matterCost);
  }

  pq.queue.push({
    unitType,
    timeRemaining: def.trainTime,
    totalTime: def.trainTime,
  });

  return true;
}

export function retreatWounded(ctx: AIContext, squad: Squad): void {
  const depotEntities: number[] = [];

  const buildings = ctx.world.query(BUILDING, TEAM, POSITION, HEALTH, MATTER_STORAGE);
  for (const e of buildings) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const bldg = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    if (bldg.buildingType === BuildingType.SupplyDepot) {
      depotEntities.push(e);
    }
  }

  for (const unitId of squad.unitIds) {
    if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
    const health = ctx.world.getComponent<HealthComponent>(unitId, HEALTH);
    if (!health) continue;
    if (health.current / health.max < RETREAT_HP_FRACTION) {
      if (depotEntities.length > 0) {
        const pos = ctx.world.getComponent<PositionComponent>(unitId, POSITION);
        if (!pos) continue;
        let bestDepot = depotEntities[0];
        let bestDistSq = Infinity;
        for (const depot of depotEntities) {
          const depotPos = ctx.world.getComponent<PositionComponent>(depot, POSITION);
          if (!depotPos) continue;
          const dx = depotPos.x - pos.x;
          const dz = depotPos.z - pos.z;
          const distSq = dx * dx + dz * dz;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestDepot = depot;
          }
        }
        const depotPos = ctx.world.getComponent<PositionComponent>(bestDepot, POSITION);
        if (depotPos) {
          issueMove(ctx, unitId, depotPos.x, depotPos.z);
          continue;
        }
      }
      issueMove(ctx, unitId, ctx.baseX, ctx.baseZ);
    }
  }
}

export function pickAttackTarget(
  ctx: AIContext,
  state: AIWorldState,
): { x: number; z: number } | null {
  let bestTarget: { x: number; z: number } | null = null;
  let bestDistSq = Infinity;

  if (state.totalArmySize >= OVERWHELMING_ARMY) {
    for (const bldg of state.knownEnemyBuildings) {
      if (bldg.type === BuildingType.HQ) return { x: bldg.x, z: bldg.z };
    }
  }

  // 1. TOP PRIORITY: Kill enemy Energy Extractors (closest first)
  for (const bldg of state.knownEnemyBuildings) {
    if (bldg.type === BuildingType.EnergyExtractor) {
      const dx = bldg.x - ctx.baseX;
      const dz = bldg.z - ctx.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestTarget = { x: bldg.x, z: bldg.z };
      }
    }
  }
  if (bestTarget) return bestTarget;

  // 2. Hunt Forward Supply Depots
  for (const bldg of state.knownEnemyBuildings) {
    if (bldg.type === BuildingType.SupplyDepot) {
      const dx = bldg.x - ctx.baseX;
      const dz = bldg.z - ctx.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestTarget = { x: bldg.x, z: bldg.z };
      }
    }
  }
  if (bestTarget) return bestTarget;

  // 3. Disrupt Worker Ferries
  for (const unit of state.knownEnemyUnits) {
     const dx = unit.x - ctx.baseX;
     const dz = unit.z - ctx.baseZ;
     const distSq = dx * dx + dz * dz;
     if (distSq < bestDistSq) {
       bestDistSq = distSq;
       bestTarget = { x: unit.x, z: unit.z };
     }
  }
  if (bestTarget) return bestTarget;

  // 4. Matter Plants + Factories (extractors handled above)
  bestDistSq = Infinity;
  for (const bldg of state.knownEnemyBuildings) {
    if (bldg.type === BuildingType.MatterPlant || bldg.type === BuildingType.DroneFactory) {
      const dx = bldg.x - ctx.baseX;
      const dz = bldg.z - ctx.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestTarget = { x: bldg.x, z: bldg.z };
      }
    }
  }
  if (bestTarget) return bestTarget;

  // Fall back to remembered buildings scored by typeScore * freshness
  if (state.rememberedEnemyBuildings.length > 0) {
    let bestMemTarget: { x: number; z: number } | null = null;
    let bestMemScore = -Infinity;

    const typeScore = (bt: BuildingType | null): number => {
      switch (bt) {
        case BuildingType.HQ: return 5;
        case BuildingType.SupplyDepot: return 4;
        case BuildingType.EnergyExtractor: return 4;
        case BuildingType.DroneFactory: return 3;
        case BuildingType.MatterPlant: return 2;
        default: return 0;
      }
    };

    for (const entry of state.rememberedEnemyBuildings) {
      const freshness = Math.max(0, 1 - (ctx.totalTicks - entry.lastSeenTick) / MEMORY_DECAY_TICKS);
      const score = typeScore(entry.buildingType) * freshness;
      if (score > bestMemScore) {
        bestMemScore = score;
        bestMemTarget = { x: entry.x, z: entry.z };
      }
    }

    if (bestMemTarget) return bestMemTarget;
  }

  return null;
}

export function createWallSegments(
  ctx: AIContext,
  segments: WallSegmentPlan[],
  workerEntity: number,
): void {
  if (segments.length === 0) return;

  // Clear existing worker commands
  if (ctx.world.hasComponent(workerEntity, BUILD_COMMAND)) {
    ctx.world.removeComponent(workerEntity, BUILD_COMMAND);
  }
  if (ctx.world.hasComponent(workerEntity, SUPPLY_ROUTE)) {
    ctx.world.removeComponent(workerEntity, SUPPLY_ROUTE);
  }
  if (ctx.world.hasComponent(workerEntity, REPAIR_COMMAND)) {
    ctx.world.removeComponent(workerEntity, REPAIR_COMMAND);
  }
  if (ctx.world.hasComponent(workerEntity, WALL_BUILD_QUEUE)) {
    ctx.world.removeComponent(workerEntity, WALL_BUILD_QUEUE);
  }

  const def = BUILDING_DEFS[BuildingType.Wall];
  if (!def) return;

  const siteEntities: number[] = [];
  for (const seg of segments) {
    const site = ctx.world.createEntity();
    const siteY = ctx.terrain.getHeight(seg.x, seg.z);

    ctx.world.addComponent<PositionComponent>(site, POSITION, {
      x: seg.x, y: siteY, z: seg.z,
      prevX: seg.x, prevY: siteY, prevZ: seg.z,
      rotation: 0,
    });

    ctx.world.addComponent<RenderableComponent>(site, RENDERABLE, {
      meshType: seg.meshType,
      color: TEAM_COLORS[ctx.team],
      scale: 1.0,
    });

    ctx.world.addComponent<TeamComponent>(site, TEAM, { team: ctx.team });

    ctx.world.addComponent<BuildingComponent>(site, BUILDING, {
      buildingType: BuildingType.Wall,
    });

    ctx.world.addComponent<HealthComponent>(site, HEALTH, {
      current: 50,
      max: def.hp,
      dead: false,
    });

    ctx.world.addComponent<ConstructionComponent>(site, CONSTRUCTION, {
      buildingType: BuildingType.Wall,
      progress: 0,
      buildTime: def.buildTime,
      builderEntity: workerEntity,
    });

    ctx.world.addComponent<SelectableComponent>(site, SELECTABLE, { selected: false });

    const finalModel = VOXEL_MODELS[seg.meshType];
    if (finalModel) {
      const destroyedMask = new Uint8Array(Math.ceil(finalModel.totalSolid / 8));
      destroyedMask.fill(255);
      for (let i = 0; i < finalModel.firstLayerCount; i++) {
        const solidIdx = finalModel.buildOrder[i];
        destroyedMask[solidIdx >> 3] &= ~(1 << (solidIdx & 7));
      }
      ctx.world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
        modelId: seg.meshType,
        totalVoxels: finalModel.totalSolid,
        destroyedCount: finalModel.totalSolid - finalModel.firstLayerCount,
        destroyed: destroyedMask,
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    siteEntities.push(site);
  }

  // Issue move + build command for first segment
  const firstSeg = segments[0];
  if (ctx.world.hasComponent(workerEntity, MOVE_COMMAND)) {
    ctx.world.removeComponent(workerEntity, MOVE_COMMAND);
  }
  ctx.world.addComponent<MoveCommandComponent>(workerEntity, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: firstSeg.x,
    destZ: firstSeg.z,
  });

  ctx.world.addComponent<BuildCommandComponent>(workerEntity, BUILD_COMMAND, {
    buildingType: BuildingType.Wall,
    targetX: firstSeg.x,
    targetZ: firstSeg.z,
    state: 'moving',
    siteEntity: siteEntities[0],
  });

  // Add wall build queue if multiple segments
  if (siteEntities.length > 1) {
    ctx.world.addComponent<WallBuildQueueComponent>(workerEntity, WALL_BUILD_QUEUE, {
      siteEntities: siteEntities,
      currentIndex: 0,
    });
  }
}

export function assignRepair(ctx: AIContext, worker: number, buildingEntity: number): void {
  // Cancel existing commands
  if (ctx.world.hasComponent(worker, BUILD_COMMAND)) {
    ctx.world.removeComponent(worker, BUILD_COMMAND);
  }
  if (ctx.world.hasComponent(worker, SUPPLY_ROUTE)) {
    ctx.world.removeComponent(worker, SUPPLY_ROUTE);
  }
  if (ctx.world.hasComponent(worker, RESUPPLY_SEEK)) {
    ctx.world.removeComponent(worker, RESUPPLY_SEEK);
  }
  if (ctx.world.hasComponent(worker, REPAIR_COMMAND)) {
    ctx.world.removeComponent(worker, REPAIR_COMMAND);
  }

  const buildingPos = ctx.world.getComponent<PositionComponent>(buildingEntity, POSITION)!;

  ctx.world.addComponent<RepairCommandComponent>(worker, REPAIR_COMMAND, {
    targetEntity: buildingEntity,
    state: 'moving',
  });

  if (ctx.world.hasComponent(worker, MOVE_COMMAND)) {
    ctx.world.removeComponent(worker, MOVE_COMMAND);
  }
  ctx.world.addComponent<MoveCommandComponent>(worker, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: buildingPos.x,
    destZ: buildingPos.z,
  });
}
