import { POSITION } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState, Squad, AttackState, IntelligenceReport } from '@sim/ai/AITypes';
import { WORKER_SCALING_BASE } from '@sim/ai/AITypes';

import { getBuildingCount } from '@sim/ai/AIQueries';
import { trainUnit, trainFromHQ } from '@sim/ai/AIActions';
import { updateSquads, executeSquadOrders } from '@sim/ai/AISquads';

export class MilitaryManager {
  private squads: Squad[] = [];
  private nextSquadId = 0;
  private unitsProduced = 0;

  private attackState: AttackState = {
    attackTargetX: -1,
    attackTargetZ: -1,
    attackPhase: 'idle',
    stagingX: -1,
    stagingZ: -1,
    stagingTimer: 0,
    reattackTimer: -1,
    forceAttackTimer: 0,
  };

  update(ctx: AIContext, report: IntelligenceReport): void {
    const { state, influenceGrid } = report;

    this.attackState.forceAttackTimer++;

    this.executeProduction(ctx, state);

    const result = updateSquads(ctx, state, this.squads, this.nextSquadId);
    this.squads = result.squads;
    this.nextSquadId = result.nextSquadId;
    executeSquadOrders(ctx, state, this.squads, influenceGrid, this.attackState);
  }

  private executeProduction(ctx: AIContext, state: AIWorldState): void {
    const extractors = getBuildingCount(state, BuildingType.EnergyExtractor) + (state.myConstructions.get(BuildingType.EnergyExtractor) ?? 0);
    const plants = getBuildingCount(state, BuildingType.MatterPlant) + (state.myConstructions.get(BuildingType.MatterPlant) ?? 0);
    const factories = getBuildingCount(state, BuildingType.DroneFactory) + (state.myConstructions.get(BuildingType.DroneFactory) ?? 0);
    const currentEnergy = ctx.resources.get(ctx.team).energy;

    // Worker suppression: don't train workers while bootstrapping fundamentals
    const suppressWorkers = extractors === 0 || plants === 0
      || (factories === 0 && currentEnergy < 150);

    const targetWorkers = Math.min(8, WORKER_SCALING_BASE + state.depotCount);
    if (state.myWorkers.length < targetWorkers && !suppressWorkers) {
      trainFromHQ(ctx, UnitCategory.WorkerDrone, ctx.hqEntity);
    }

    const threatsNearBase = state.enemiesNearBase.length > 0;
    const hasBasicEconomy = extractors >= 1 && plants >= 1;
    const hasMilitaryEconomy = extractors >= 1 && plants >= 1;
    const factoryEntities = state.myBuildings.get(BuildingType.DroneFactory) ?? [];

    for (const factory of factoryEntities) {
      let unitType: UnitCategory;

      if (state.myAerial.length < 1 && hasBasicEconomy) {
        unitType = UnitCategory.AerialDrone;
      } else if (threatsNearBase) {
        unitType = UnitCategory.CombatDrone;
      } else if (!hasMilitaryEconomy) {
        continue;
      } else {
        // Dynamic counter-composition based on enemy intel
        const allEnemyUnits = [
          ...state.knownEnemyUnits,
          ...state.rememberedEnemyUnits.filter(e => e.unitCategory !== null),
        ];
        const enemyCount = allEnemyUnits.length;
        let enemyAssault = 0;
        let enemyAerial = 0;
        for (const eu of allEnemyUnits) {
          const cat = 'category' in eu ? eu.category : eu.unitCategory;
          if (cat === UnitCategory.AssaultPlatform) enemyAssault++;
          if (cat === UnitCategory.AerialDrone) enemyAerial++;
        }

        if (enemyCount > 0 && enemyAssault / enemyCount > 0.3) {
          // Counter assault-heavy with aerials
          unitType = this.unitsProduced % 3 === 0 ? UnitCategory.CombatDrone : UnitCategory.AerialDrone;
        } else if (enemyCount > 0 && enemyAerial / enemyCount > 0.3) {
          // Counter aerial-heavy with combat drones
          unitType = UnitCategory.CombatDrone;
        } else if (this.unitsProduced % 4 === 3) {
          unitType = UnitCategory.AssaultPlatform;
        } else {
          unitType = UnitCategory.CombatDrone;
        }
      }

      let rallyX = ctx.rallyX;
      let rallyZ = ctx.rallyZ;
      if ((this.attackState.attackPhase === 'staging' || this.attackState.attackPhase === 'attacking') && this.attackState.stagingX >= 0) {
        rallyX = this.attackState.stagingX;
        rallyZ = this.attackState.stagingZ;
      }

      if (trainUnit(ctx, factory, unitType, rallyX, rallyZ)) {
        this.unitsProduced++;
      }
    }
  }

  serialize(): Record<string, unknown> {
    return {
      squads: this.squads,
      nextSquadId: this.nextSquadId,
      unitsProduced: this.unitsProduced,
      attackPhase: this.attackState.attackPhase,
      attackTargetX: this.attackState.attackTargetX,
      attackTargetZ: this.attackState.attackTargetZ,
      stagingX: this.attackState.stagingX,
      stagingZ: this.attackState.stagingZ,
      stagingTimer: this.attackState.stagingTimer,
      reattackTimer: this.attackState.reattackTimer,
      forceAttackTimer: this.attackState.forceAttackTimer,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    this.squads = (data.squads as Squad[]) ?? [];
    this.nextSquadId = (data.nextSquadId as number) ?? 0;
    this.unitsProduced = (data.unitsProduced as number) ?? 0;

    if (typeof data.attackPhase === 'string') {
      this.attackState.attackPhase = data.attackPhase as 'idle' | 'staging' | 'attacking';
    }
    this.attackState.attackTargetX = (data.attackTargetX as number) ?? -1;
    this.attackState.attackTargetZ = (data.attackTargetZ as number) ?? -1;
    this.attackState.stagingX = (data.stagingX as number) ?? -1;
    this.attackState.stagingZ = (data.stagingZ as number) ?? -1;
    this.attackState.stagingTimer = (data.stagingTimer as number) ?? 0;
    this.attackState.reattackTimer = (data.reattackTimer as number) ?? -1;
    this.attackState.forceAttackTimer = (data.forceAttackTimer as number) ?? 0;
  }
}
