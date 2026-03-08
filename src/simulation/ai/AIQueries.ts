import type { World } from '@core/ECS';
import {
  POSITION, UNIT_TYPE, HEALTH, TEAM, BUILDING,
  BUILD_COMMAND, CONSTRUCTION, SUPPLY_ROUTE,
  MATTER_STORAGE, RESUPPLY_SEEK, PRODUCTION_QUEUE,
  REPAIR_COMMAND,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { SupplyRouteComponent } from '@sim/components/SupplyRoute';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';

import type {
  AIContext, AIWorldState, AIPhase, EnemyMemoryEntry,
} from '@sim/ai/AITypes';
import {
  BASE_DEFENSE_RADIUS, EXTRACTOR_DEFENSE_RADIUS, MEMORY_DECAY_TICKS,
  MEMORY_MAX_ENTRIES,
} from '@sim/ai/AITypes';

export function findHQ(ctx: AIContext): number | null {
  const buildings = ctx.world.query(BUILDING, TEAM, HEALTH);
  for (const e of buildings) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const building = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    if (building.buildingType !== BuildingType.HQ) continue;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    return e;
  }
  return null;
}

export function getBuildingCount(state: AIWorldState, type: BuildingType): number {
  return (state.myBuildings.get(type) ?? []).length;
}

export function getIdleWorkers(ctx: AIContext, state: AIWorldState): number[] {
  return state.myWorkers.filter(
    e => !ctx.world.hasComponent(e, BUILD_COMMAND)
      && !ctx.world.hasComponent(e, REPAIR_COMMAND)
  );
}

export function getDamagedBuildings(ctx: AIContext): { entity: number; hpFraction: number; type: BuildingType }[] {
  const result: { entity: number; hpFraction: number; type: BuildingType }[] = [];
  const buildings = ctx.world.query(BUILDING, TEAM, HEALTH, POSITION);
  for (const e of buildings) {
    if (ctx.world.hasComponent(e, CONSTRUCTION)) continue;
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    if (health.current >= health.max) continue;
    const building = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    result.push({ entity: e, hpFraction: health.current / health.max, type: building.buildingType });
  }
  // Sort: HQ first, then by damage severity (lowest HP fraction first)
  result.sort((a, b) => {
    const aHQ = a.type === BuildingType.HQ ? 0 : 1;
    const bHQ = b.type === BuildingType.HQ ? 0 : 1;
    if (aHQ !== bHQ) return aHQ - bHQ;
    return a.hpFraction - b.hpFraction;
  });
  return result;
}

export function getCompletedDepots(ctx: AIContext, state: AIWorldState): number[] {
  const depots = state.myBuildings.get(BuildingType.SupplyDepot) ?? [];
  return depots.filter(
    d => !ctx.world.hasComponent(d, CONSTRUCTION) && ctx.world.hasComponent(d, MATTER_STORAGE)
  );
}

export function getFactoriesWithOpenSlots(ctx: AIContext, state: AIWorldState, maxQueueDepth: number): number[] {
  const factories = state.myBuildings.get(BuildingType.DroneFactory) ?? [];
  return factories.filter(f => {
    const pq = ctx.world.getComponent<ProductionQueueComponent>(f, PRODUCTION_QUEUE);
    return pq && pq.queue.length < maxQueueDepth;
  });
}

export function getFerryCountByDepot(ctx: AIContext): Map<number, number> {
  const ferryCountByDepot = new Map<number, number>();
  const units = ctx.world.query(UNIT_TYPE, TEAM, SUPPLY_ROUTE);
  for (const e of units) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const ut = ctx.world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
    if (ut.category !== UnitCategory.FerryDrone) continue;
    const route = ctx.world.getComponent<SupplyRouteComponent>(e, SUPPLY_ROUTE)!;
    const count = ferryCountByDepot.get(route.destEntity) ?? 0;
    ferryCountByDepot.set(route.destEntity, count + 1);
  }
  return ferryCountByDepot;
}

export function isUnderAttack(state: AIWorldState): boolean {
  return state.enemiesNearBase.length > 0;
}

export function assessWorldState(
  ctx: AIContext,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): AIWorldState {
  const myWorkers: number[] = [];
  const myCombat: number[] = [];
  const myAerial: number[] = [];
  const myBuildings = new Map<BuildingType, number[]>();
  const myConstructions = new Map<string, number>();
  const enemiesNearBase: { entity: number; x: number; z: number }[] = [];
  const knownEnemyBuildings: { entity: number; x: number; z: number; type: BuildingType }[] = [];
  const knownEnemyUnits: { entity: number; x: number; z: number; category: UnitCategory }[] = [];

  const visibleEnemyIds = new Set<number>();

  const units = ctx.world.query(UNIT_TYPE, TEAM, POSITION, HEALTH);
  for (const e of units) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;

    const unitType = ctx.world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;

    if (team.team === ctx.team) {
      switch (unitType.category) {
        case UnitCategory.WorkerDrone:
          myWorkers.push(e);
          break;
        case UnitCategory.CombatDrone:
        case UnitCategory.AssaultPlatform:
          myCombat.push(e);
          break;
        case UnitCategory.AerialDrone:
          myAerial.push(e);
          break;
      }
    } else {
      if (ctx.fog.isVisible(ctx.team, pos.x, pos.z)) {
        visibleEnemyIds.add(e);
        knownEnemyUnits.push({ entity: e, x: pos.x, z: pos.z, category: unitType.category });

        enemyMemory.set(e, {
          entityId: e, x: pos.x, z: pos.z,
          type: 'unit', unitCategory: unitType.category, buildingType: null,
          lastSeenTick: ctx.totalTicks, isAlive: true,
        });

        const dx = pos.x - ctx.baseX;
        const dz = pos.z - ctx.baseZ;
        if (dx * dx + dz * dz < BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS) {
          enemiesNearBase.push({ entity: e, x: pos.x, z: pos.z });
        }
      }
    }
  }

  const myExtractorPositions: { x: number; z: number }[] = [];

  const buildings = ctx.world.query(BUILDING, TEAM, POSITION, HEALTH);
  for (const e of buildings) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;

    const building = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;

    if (team.team === ctx.team) {
      if (!myBuildings.has(building.buildingType)) {
        myBuildings.set(building.buildingType, []);
      }
      myBuildings.get(building.buildingType)!.push(e);
      if (building.buildingType === BuildingType.EnergyExtractor) {
        myExtractorPositions.push({ x: pos.x, z: pos.z });
      }
    } else {
      if (ctx.fog.isVisible(ctx.team, pos.x, pos.z)) {
        visibleEnemyIds.add(e);
        knownEnemyBuildings.push({ entity: e, x: pos.x, z: pos.z, type: building.buildingType });

        enemyMemory.set(e, {
          entityId: e, x: pos.x, z: pos.z,
          type: 'building', unitCategory: null, buildingType: building.buildingType,
          lastSeenTick: ctx.totalTicks, isAlive: true,
        });
      }
    }
  }

  // Mark entries as dead if their location is visible but entity is gone
  for (const [id, entry] of enemyMemory) {
    if (visibleEnemyIds.has(id)) continue;
    if (ctx.fog.isVisible(ctx.team, entry.x, entry.z)) {
      entry.isAlive = false;
    }
  }

  // Prune dead/expired entries
  for (const [id, entry] of enemyMemory) {
    if (!entry.isAlive || ctx.totalTicks - entry.lastSeenTick > MEMORY_DECAY_TICKS) {
      enemyMemory.delete(id);
    }
  }

  // Cap memory size
  if (enemyMemory.size > MEMORY_MAX_ENTRIES) {
    const sorted = [...enemyMemory.entries()].sort((a, b) => a[1].lastSeenTick - b[1].lastSeenTick);
    while (enemyMemory.size > MEMORY_MAX_ENTRIES) {
      enemyMemory.delete(sorted.shift()![0]);
    }
  }

  // Build remembered enemy lists (not currently visible)
  const rememberedEnemyBuildings: EnemyMemoryEntry[] = [];
  const rememberedEnemyUnits: EnemyMemoryEntry[] = [];
  for (const [id, entry] of enemyMemory) {
    if (visibleEnemyIds.has(id)) continue;
    if (entry.type === 'building') rememberedEnemyBuildings.push(entry);
    else rememberedEnemyUnits.push(entry);
  }

  // Count in-progress constructions
  const constructions = ctx.world.query(CONSTRUCTION, TEAM);
  for (const e of constructions) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const construction = ctx.world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
    const current = myConstructions.get(construction.buildingType) ?? 0;
    myConstructions.set(construction.buildingType, current + 1);
  }

  // Detect enemies near AI extractors
  const enemiesNearExtractors: { entity: number; x: number; z: number; extractorX: number; extractorZ: number }[] = [];
  const edrSq = EXTRACTOR_DEFENSE_RADIUS * EXTRACTOR_DEFENSE_RADIUS;
  for (const enemy of knownEnemyUnits) {
    for (const ext of myExtractorPositions) {
      const dx = enemy.x - ext.x;
      const dz = enemy.z - ext.z;
      if (dx * dx + dz * dz < edrSq) {
        enemiesNearExtractors.push({ entity: enemy.entity, x: enemy.x, z: enemy.z, extractorX: ext.x, extractorZ: ext.z });
        break; // only count each enemy once
      }
    }
  }

  const depotEntities = (myBuildings.get(BuildingType.SupplyDepot) ?? []).filter(
    d => !ctx.world.hasComponent(d, CONSTRUCTION) && ctx.world.hasComponent(d, MATTER_STORAGE)
  );
  const totalMatter = ctx.resources.get(ctx.team).matter;
  const totalArmySize = myCombat.length + Math.max(0, myAerial.length - 1);

  return {
    myWorkers, myCombat, myAerial, myBuildings, myConstructions,
    enemiesNearBase, enemiesNearExtractors, knownEnemyBuildings, knownEnemyUnits,
    depotCount: depotEntities.length, depotEntities, totalMatter, totalArmySize,
    rememberedEnemyBuildings, rememberedEnemyUnits,
  };
}

export function determinePhase(state: AIWorldState): AIPhase {
  const factoryCount = getBuildingCount(state, BuildingType.DroneFactory);
  const combatCount = state.myCombat.length;

  if (factoryCount === 0) return 'early';
  if (combatCount < 5) return 'buildup';
  if (factoryCount >= 3 && combatCount >= 12) return 'lategame';
  return 'midgame';
}

export function estimateEnemyPosition(
  ctx: AIContext,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): { x: number; z: number } {
  const enemyBuildings: { x: number; z: number }[] = [];
  const buildings = ctx.world.query(BUILDING, TEAM, POSITION, HEALTH);
  for (const e of buildings) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team === ctx.team) continue;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
    if (ctx.fog.isVisible(ctx.team, pos.x, pos.z)) {
      enemyBuildings.push({ x: pos.x, z: pos.z });
    }
  }

  if (enemyBuildings.length > 0) {
    const avgX = enemyBuildings.reduce((s, b) => s + b.x, 0) / enemyBuildings.length;
    const avgZ = enemyBuildings.reduce((s, b) => s + b.z, 0) / enemyBuildings.length;
    return { x: avgX, z: avgZ };
  }

  const remembered: { x: number; z: number }[] = [];
  for (const [, entry] of enemyMemory) {
    if (entry.type === 'building') {
      remembered.push({ x: entry.x, z: entry.z });
    }
  }
  if (remembered.length > 0) {
    const avgX = remembered.reduce((s, b) => s + b.x, 0) / remembered.length;
    const avgZ = remembered.reduce((s, b) => s + b.z, 0) / remembered.length;
    return { x: avgX, z: avgZ };
  }

  return ctx.team === 0 ? { x: 192, z: 192 } : { x: 64, z: 64 };
}

export function findIsolatedTarget(state: AIWorldState): { x: number; z: number } | null {
  const allBuildings: { x: number; z: number; type: BuildingType }[] = [];
  for (const b of state.knownEnemyBuildings) {
    allBuildings.push({ x: b.x, z: b.z, type: b.type });
  }
  for (const entry of state.rememberedEnemyBuildings) {
    if (entry.buildingType) {
      allBuildings.push({ x: entry.x, z: entry.z, type: entry.buildingType });
    }
  }

  if (allBuildings.length === 0) return null;

  let cx = 0, cz = 0;
  for (const b of allBuildings) {
    cx += b.x;
    cz += b.z;
  }
  cx /= allBuildings.length;
  cz /= allBuildings.length;

  let bestTarget = null;
  let maxDistSq = 0;

  for (const b of allBuildings) {
    if (b.type === BuildingType.EnergyExtractor || b.type === BuildingType.MatterPlant) {
      let distSq = (b.x - cx) ** 2 + (b.z - cz) ** 2;
      // Boost extractors so they get preferred over matter plants
      if (b.type === BuildingType.EnergyExtractor) distSq += 2000;
      if (distSq > 900 && distSq > maxDistSq) {
        maxDistSq = distSq;
        bestTarget = { x: b.x, z: b.z };
      }
    }
  }
  return bestTarget;
}

export function getNextScoutTarget(
  ctx: AIContext, waypointIndex: number, waypoints: { x: number; z: number }[],
): { x: number; z: number } {
  for (let i = 0; i < waypoints.length; i++) {
    const idx = (waypointIndex + i) % waypoints.length;
    const wp = waypoints[idx];
    if (!ctx.fog.isExplored(ctx.team, wp.x, wp.z)) {
      return wp;
    }
  }

  // Prefer far, non-visible waypoints for re-scouting
  let bestWp = waypoints[waypointIndex % waypoints.length];
  let bestDistSq = -1;
  for (const wp of waypoints) {
    if (ctx.fog.isVisible(ctx.team, wp.x, wp.z)) continue;
    const dx = wp.x - ctx.baseX;
    const dz = wp.z - ctx.baseZ;
    const distSq = dx * dx + dz * dz;
    if (distSq > bestDistSq) {
      bestDistSq = distSq;
      bestWp = wp;
    }
  }
  return bestWp;
}
