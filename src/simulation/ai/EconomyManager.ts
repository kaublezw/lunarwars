import { POSITION, MOVE_COMMAND, UNIT_TYPE, RESUPPLY_SEEK, BUILDING, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';

import type { AIContext, AIWorldState, AIPhase, IntelligenceReport } from '@sim/ai/AITypes';
import { WALL_SEGMENT_COST, MAX_AI_WALLS } from '@sim/ai/AITypes';

import {
  getBuildingCount, getIdleWorkers, getCompletedDepots,
  getFerryCountByDepot, getDamagedBuildings,
} from '@sim/ai/AIQueries';
import {
  findBuildLocation, findEnergyNodeLocation, findOreDepositLocation,
  findExtractorWallPlan, findChokepointWallPlan, findBasePerimeterWallPlan,
} from '@sim/ai/AILocationFinder';
import {
  issueMove, createConstructionSite, trainUnit, assignRepair, createWallSegments,
} from '@sim/ai/AIActions';

import type { EnemyMemoryEntry } from '@sim/ai/AITypes';

export class EconomyManager {
  update(ctx: AIContext, report: IntelligenceReport): void {
    const { state, phase, enemyMemory } = report;

    this.executeBuildOrder(ctx, state, enemyMemory);
    this.executeWallBuilding(ctx, state, phase, enemyMemory);
    this.executeFerry(ctx, state);
  }

  private executeBuildOrder(
    ctx: AIContext,
    state: AIWorldState,
    enemyMemory: Map<number, EnemyMemoryEntry>,
  ): void {
    const idleWorkers = getIdleWorkers(ctx, state);
    if (idleWorkers.length === 0) return;

    // Repair critically damaged buildings before building new ones
    const damaged = getDamagedBuildings(ctx);
    if (damaged.length > 0 && damaged[0].hpFraction < 0.5) {
      assignRepair(ctx, idleWorkers[0], damaged[0].entity);
      return;
    }

    const extractors = getBuildingCount(state, BuildingType.EnergyExtractor) + (state.myConstructions.get(BuildingType.EnergyExtractor) ?? 0);
    const plants = getBuildingCount(state, BuildingType.MatterPlant) + (state.myConstructions.get(BuildingType.MatterPlant) ?? 0);
    const factories = getBuildingCount(state, BuildingType.DroneFactory) + (state.myConstructions.get(BuildingType.DroneFactory) ?? 0);
    const depots = getBuildingCount(state, BuildingType.SupplyDepot) + (state.myConstructions.get(BuildingType.SupplyDepot) ?? 0);

    const energyIncome = extractors * 5;
    const energyDrain = plants * 2;
    const netEnergy = energyIncome - energyDrain;
    const matterIncome = plants * 2;
    const targetMatter = Math.max(2, factories * 1.5);
    const hasUnclaimedNode = findEnergyNodeLocation(ctx) !== null;
    const hasUnclaimedDeposit = findOreDepositLocation(ctx) !== null;

    const rules: { condition: boolean; type: BuildingType; save: boolean }[] = [
      { condition: extractors === 0, type: BuildingType.EnergyExtractor, save: true },
      { condition: plants === 0 && hasUnclaimedDeposit, type: BuildingType.MatterPlant, save: true },
      { condition: plants < extractors && netEnergy >= 4 && hasUnclaimedDeposit, type: BuildingType.MatterPlant, save: false },
      { condition: netEnergy <= 0 && extractors > 0, type: BuildingType.EnergyExtractor, save: false },
      { condition: factories === 0, type: BuildingType.DroneFactory, save: true },
      { condition: depots === 0 && factories >= 1, type: BuildingType.SupplyDepot, save: false },
      { condition: netEnergy <= 2, type: BuildingType.EnergyExtractor, save: false },
      { condition: matterIncome < targetMatter && netEnergy >= 3 && hasUnclaimedDeposit, type: BuildingType.MatterPlant, save: false },
      { condition: state.totalMatter > 300 && factories < 8, type: BuildingType.DroneFactory, save: false },
      { condition: depots < 1 + Math.floor(factories / 2), type: BuildingType.SupplyDepot, save: false },
      { condition: extractors < Math.ceil((plants * 2 + factories) / 5) + 1, type: BuildingType.EnergyExtractor, save: false },
      { condition: matterIncome < factories * 1.5 && netEnergy >= 4 && hasUnclaimedDeposit, type: BuildingType.MatterPlant, save: false },
      { condition: state.totalMatter > 450 && factories < 8, type: BuildingType.DroneFactory, save: false },
      { condition: hasUnclaimedNode, type: BuildingType.EnergyExtractor, save: false },
      { condition: plants < extractors && netEnergy >= 4 && hasUnclaimedDeposit, type: BuildingType.MatterPlant, save: false },
    ];

    for (const rule of rules) {
      if (!rule.condition) continue;

      const def = BUILDING_DEFS[rule.type];
      if (!def) continue;

      const canAfford = ctx.resources.canAfford(ctx.team, def.energyCost)
        && ctx.resources.canAffordMatter(ctx.team, def.matterCost);

      if (!canAfford) {
        if (rule.save) return;
        continue;
      }

      const location = findBuildLocation(ctx, rule.type, state, enemyMemory);
      if (!location) continue;

      ctx.resources.spend(ctx.team, def.energyCost);
      if (def.matterCost > 0) {
        ctx.resources.spendMatter(ctx.team, def.matterCost);
      }

      createConstructionSite(ctx, rule.type, location.x, location.z, idleWorkers[0]);

      // Escort remote builds with a combat drone
      const dx = location.x - ctx.baseX;
      const dz = location.z - ctx.baseZ;
      if (dx * dx + dz * dz > 30 * 30) {
        let bestEscort = -1;
        let bestDistSq = Infinity;
        for (const unit of state.myCombat) {
          if (ctx.world.hasComponent(unit, MOVE_COMMAND)) continue;
          if (ctx.world.hasComponent(unit, RESUPPLY_SEEK)) continue;
          const ut = ctx.world.getComponent<UnitTypeComponent>(unit, UNIT_TYPE);
          if (!ut || ut.category !== UnitCategory.CombatDrone) continue;
          const upos = ctx.world.getComponent<PositionComponent>(unit, POSITION);
          if (!upos) continue;
          const edx = upos.x - location.x;
          const edz = upos.z - location.z;
          const distSq = edx * edx + edz * edz;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestEscort = unit;
          }
        }
        if (bestEscort >= 0) {
          issueMove(ctx, bestEscort, location.x, location.z);
        }
      }

      return;
    }
  }

  private executeWallBuilding(
    ctx: AIContext,
    state: AIWorldState,
    phase: AIPhase,
    enemyMemory: Map<number, EnemyMemoryEntry>,
  ): void {
    if (phase === 'early') return;

    const idleWorkers = getIdleWorkers(ctx, state);
    if (idleWorkers.length < 2) return;

    let wallCount = 0;
    const buildings = ctx.world.query(BUILDING, TEAM, HEALTH);
    for (const e of buildings) {
      const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== ctx.team) continue;
      const bldg = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType !== BuildingType.Wall) continue;
      const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      wallCount++;
    }
    if (wallCount >= MAX_AI_WALLS) return;

    type PlanFinder = () => ReturnType<typeof findExtractorWallPlan>;
    const planners: PlanFinder[] = [];

    if (phase === 'buildup' || phase === 'midgame' || phase === 'lategame') {
      planners.push(() => findExtractorWallPlan(ctx, state, enemyMemory));
    }
    if ((phase === 'midgame' || phase === 'lategame') && state.totalArmySize >= 5) {
      planners.push(() => findChokepointWallPlan(ctx, state, enemyMemory));
    }
    if (phase === 'lategame') {
      planners.push(() => findBasePerimeterWallPlan(ctx, state, enemyMemory));
    }

    for (const planner of planners) {
      const plan = planner();
      if (!plan) continue;

      const maxNew = MAX_AI_WALLS - wallCount;
      const segments = plan.slice(0, maxNew);
      if (segments.length < 2) continue;

      const totalCost = segments.length * WALL_SEGMENT_COST;
      if (!ctx.resources.canAffordMatter(ctx.team, totalCost)) continue;

      ctx.resources.spendMatter(ctx.team, totalCost);
      createWallSegments(ctx, segments, idleWorkers[0]);
      return;
    }
  }

  private executeFerry(ctx: AIContext, state: AIWorldState): void {
    const hqPos = ctx.world.getComponent<PositionComponent>(ctx.hqEntity, POSITION)!;
    const completedDepots = getCompletedDepots(ctx, state);
    if (completedDepots.length === 0) return;

    const ferryCountMap = getFerryCountByDepot(ctx);

    for (const depot of completedDepots) {
      const depotPos = ctx.world.getComponent<PositionComponent>(depot, POSITION)!;
      const dx = depotPos.x - hqPos.x;
      const dz = depotPos.z - hqPos.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      const requiredFerries = Math.max(1, Math.min(4, Math.ceil(distance / 40)));
      const currentFerries = ferryCountMap.get(depot) ?? 0;

      if (currentFerries >= requiredFerries) continue;

      trainUnit(ctx, depot, UnitCategory.FerryDrone, hqPos.x, hqPos.z);
    }
  }

  serialize(): Record<string, unknown> {
    return {};
  }

  deserialize(_data: Record<string, unknown>): void {
    // No persistent state
  }
}
