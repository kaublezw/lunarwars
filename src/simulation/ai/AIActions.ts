import {
  POSITION, HEALTH, TEAM,
  BUILDING, BUILD_COMMAND, MOVE_COMMAND, DEPOT_RADIUS,
  SUPPLY_ROUTE, RESUPPLY_SEEK,
  REPAIR_COMMAND,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { RepairCommandComponent } from '@sim/components/RepairCommand';

import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState, Squad } from '@sim/ai/AITypes';
import {
  RETREAT_HP_FRACTION, OVERWHELMING_ARMY,
  MEMORY_DECAY_TICKS,
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

export function retreatWounded(ctx: AIContext, squad: Squad): void {
  const depotEntities: number[] = [];

  const buildings = ctx.world.query(BUILDING, TEAM, POSITION, HEALTH, DEPOT_RADIUS);
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

  // 1. TOP PRIORITY: Raid enemy silos (they hold the actual resources)
  // Prefer silos with more stored resources; closest as tiebreaker
  let bestSiloScore = -1;
  for (const silo of state.knownEnemySilos) {
    const dx = silo.x - ctx.baseX;
    const dz = silo.z - ctx.baseZ;
    const distSq = dx * dx + dz * dz;
    // Score: stored amount (higher = better target), penalized by distance
    const score = silo.stored - distSq * 0.001;
    if (score > bestSiloScore) {
      bestSiloScore = score;
      bestTarget = { x: silo.x, z: silo.z };
    }
  }
  if (bestTarget) return bestTarget;

  // 2. Kill enemy Energy Extractors and production buildings (closest first)
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

  // 3. Hunt Forward Supply Depots
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

  // 4. Disrupt Worker Ferries
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

  // 5. Matter Plants + Factories
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
