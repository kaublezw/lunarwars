import type { System, World } from '@core/ECS';
import { POSITION, MOVE_COMMAND, UNIT_TYPE, RESUPPLY_SEEK, BUILDING, TEAM, CONSTRUCTION, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { EnergyNode } from '@sim/terrain/MapFeatures';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';

import type {
  AIContext, AIWorldState, AIPhase, EnemyMemoryEntry,
  Squad, AttackState,
} from '@sim/ai/AITypes';
import {
  TICK_INTERVAL, RALLY_OFFSET, INFLUENCE_GRID,
  WORKER_SCALING_BASE,
  SCOUT_WAYPOINTS,
  WALL_SEGMENT_COST, MAX_AI_WALLS,
} from '@sim/ai/AITypes';

import {
  findHQ, assessWorldState, determinePhase,
  getBuildingCount, getIdleWorkers, getCompletedDepots,
  getFerryCountByDepot, findIsolatedTarget, getNextScoutTarget,
  getDamagedBuildings,
} from '@sim/ai/AIQueries';
import {
  findBuildLocation, findEnergyNodeLocation,
  findExtractorWallPlan, findChokepointWallPlan, findBasePerimeterWallPlan,
} from '@sim/ai/AILocationFinder';
import {
  issueMove, createConstructionSite, trainUnit,
  trainFromHQ, assignFerry, assignRepair, createWallSegments,
} from '@sim/ai/AIActions';
import { updateInfluenceGrid } from '@sim/ai/AIInfluence';
import { updateSquads, executeSquadOrders } from '@sim/ai/AISquads';

export class AISystem implements System {
  readonly name = 'AISystem';

  private tickCounter = 0;
  private totalTicks = 0;
  private team: number;
  private resources: ResourceState;
  private terrainData: TerrainData;
  private fogState: FogOfWarState;
  private energyNodes: EnergyNode[];
  private occupancy: BuildingOccupancy;

  // AI state
  private baseX: number;
  private baseZ: number;
  private rallyX: number;
  private rallyZ: number;
  private scoutWaypointIndex = 0;
  private scoutWaypointIndex2 = 12;
  private unitsProduced = 0;

  // Enemy Memory
  private enemyMemory: Map<number, EnemyMemoryEntry> = new Map();

  // Influence Map (interleaved [threat, value, ownPresence] per cell, NOT serialized)
  private influenceGrid: Float32Array = new Float32Array(INFLUENCE_GRID * INFLUENCE_GRID * 3);

  // Squad System
  private squads: Squad[] = [];
  private nextSquadId = 0;

  // Attack state
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

  // Dynamic Economy
  private lastMatterSnapshot = 0;
  private estimatedMatterRate = 0;

  constructor(
    team: number,
    resources: ResourceState,
    terrainData: TerrainData,
    fogState: FogOfWarState,
    energyNodes: EnergyNode[],
    occupancy: BuildingOccupancy,
  ) {
    this.team = team;
    this.resources = resources;
    this.terrainData = terrainData;
    this.fogState = fogState;
    this.energyNodes = energyNodes;
    this.occupancy = occupancy;

    this.baseX = team === 0 ? 64 : 192;
    this.baseZ = team === 0 ? 64 : 192;
    const dir = team === 0 ? 1 : -1;
    this.rallyX = this.baseX + RALLY_OFFSET * dir;
    this.rallyZ = this.baseZ + RALLY_OFFSET * dir;
  }

  serialize(): Record<string, unknown> {
    return {
      tickCounter: this.tickCounter,
      totalTicks: this.totalTicks,
      scoutWaypointIndex: this.scoutWaypointIndex,
      scoutWaypointIndex2: this.scoutWaypointIndex2,
      unitsProduced: this.unitsProduced,
      attackPhase: this.attackState.attackPhase,
      attackTargetX: this.attackState.attackTargetX,
      attackTargetZ: this.attackState.attackTargetZ,
      stagingX: this.attackState.stagingX,
      stagingZ: this.attackState.stagingZ,
      stagingTimer: this.attackState.stagingTimer,
      reattackTimer: this.attackState.reattackTimer,
      forceAttackTimer: this.attackState.forceAttackTimer,
      // Enemy Memory
      enemyMemory: [...this.enemyMemory.values()],
      // Squads
      squads: this.squads,
      nextSquadId: this.nextSquadId,
      // Dynamic Economy
      lastMatterSnapshot: this.lastMatterSnapshot,
      estimatedMatterRate: this.estimatedMatterRate,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    this.tickCounter = data.tickCounter as number;
    this.totalTicks = data.totalTicks as number;
    this.scoutWaypointIndex = data.scoutWaypointIndex as number;
    this.scoutWaypointIndex2 = (data.scoutWaypointIndex2 as number) ?? 12;
    this.unitsProduced = data.unitsProduced as number;

    if (typeof data.attackPhase === 'string') {
      this.attackState.attackPhase = data.attackPhase as 'idle' | 'staging' | 'attacking';
    } else {
      this.attackState.attackPhase = (data.isAttacking as boolean) ? 'attacking' : 'idle';
    }
    this.attackState.attackTargetX = data.attackTargetX as number;
    this.attackState.attackTargetZ = data.attackTargetZ as number;
    this.attackState.stagingX = (data.stagingX as number) ?? -1;
    this.attackState.stagingZ = (data.stagingZ as number) ?? -1;
    this.attackState.stagingTimer = (data.stagingTimer as number) ?? 0;
    this.attackState.reattackTimer = (data.reattackTimer as number) ?? -1;
    this.attackState.forceAttackTimer = (data.forceAttackTimer as number) ?? 0;

    // Enemy Memory
    this.enemyMemory = new Map();
    if (Array.isArray(data.enemyMemory)) {
      for (const entry of data.enemyMemory as EnemyMemoryEntry[]) {
        this.enemyMemory.set(entry.entityId, entry);
      }
    }

    // Squads
    this.squads = (data.squads as Squad[]) ?? [];
    this.nextSquadId = (data.nextSquadId as number) ?? 0;

    // Dynamic Economy
    this.lastMatterSnapshot = (data.lastMatterSnapshot as number) ?? 0;
    this.estimatedMatterRate = (data.estimatedMatterRate as number) ?? 0;
  }

  update(world: World, _dt: number): void {
    this.tickCounter++;
    if (this.tickCounter < TICK_INTERVAL) return;
    this.tickCounter = 0;
    this.totalTicks++;

    const ctx = this.makeContext(world);

    const hq = findHQ(ctx);
    if (hq === null) return;

    // Update base position from HQ
    const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;
    this.baseX = hqPos.x;
    this.baseZ = hqPos.z;
    const dir = this.team === 0 ? 1 : -1;
    this.rallyX = this.baseX + RALLY_OFFSET * dir;
    this.rallyZ = this.baseZ + RALLY_OFFSET * dir;
    // Refresh ctx after base position update
    ctx.baseX = this.baseX;
    ctx.baseZ = this.baseZ;
    ctx.rallyX = this.rallyX;
    ctx.rallyZ = this.rallyZ;

    this.attackState.forceAttackTimer++;

    // Track matter rate
    const currentMatter = this.resources.get(this.team).matter;
    this.estimatedMatterRate = (currentMatter - this.lastMatterSnapshot) / (TICK_INTERVAL / 60);
    this.lastMatterSnapshot = currentMatter;

    // === PERCEIVE ===
    const state = assessWorldState(ctx, this.enemyMemory);
    const phase = determinePhase(state);
    updateInfluenceGrid(this.influenceGrid, ctx, state);

    // === ECONOMY ===
    this.executeBuildOrder(ctx, state, phase);
    this.executeWallBuilding(ctx, state, phase);
    this.executeProduction(ctx, state, hq);

    // === LOGISTICS ===
    this.executeFerry(ctx, state, hq);

    // === MILITARY ===
    const result = updateSquads(ctx, state, this.squads, this.nextSquadId);
    this.squads = result.squads;
    this.nextSquadId = result.nextSquadId;
    executeSquadOrders(ctx, state, this.squads, this.influenceGrid, this.attackState);

    // === SCOUTING ===
    this.executeScouting(ctx, state);
  }

  private makeContext(world: World): AIContext {
    return {
      world,
      team: this.team,
      resources: this.resources,
      terrain: this.terrainData,
      fog: this.fogState,
      energyNodes: this.energyNodes,
      occupancy: this.occupancy,
      baseX: this.baseX,
      baseZ: this.baseZ,
      rallyX: this.rallyX,
      rallyZ: this.rallyZ,
      totalTicks: this.totalTicks,
    };
  }

  // --- Build Order ---

  private executeBuildOrder(ctx: AIContext, state: AIWorldState, _phase: AIPhase): void {
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

    // Ranked rule list — evaluated top-down, first match wins.
    // saveForThis: if true and unaffordable, stop evaluating (save resources).
    const rules: { condition: boolean; type: BuildingType; save: boolean }[] = [
      // 1. No extractors — fundamental
      { condition: extractors === 0, type: BuildingType.EnergyExtractor, save: true },
      // 2. No plants — fundamental
      { condition: plants === 0, type: BuildingType.MatterPlant, save: true },
      // 3. Plants behind extractors — enforce 1:1 parity early
      { condition: plants < extractors && netEnergy >= 4, type: BuildingType.MatterPlant, save: false },
      // 4. Energy stalled (net <= 0) — emergency extractor
      { condition: netEnergy <= 0 && extractors > 0, type: BuildingType.EnergyExtractor, save: false },
      // 5. No factory — fundamental
      { condition: factories === 0, type: BuildingType.DroneFactory, save: true },
      // 6. No depot once factory exists
      { condition: depots === 0 && factories >= 1, type: BuildingType.SupplyDepot, save: false },
      // 7. Energy running low (net <= 2)
      { condition: netEnergy <= 2, type: BuildingType.EnergyExtractor, save: false },
      // 8. Factories starving for matter
      { condition: matterIncome < targetMatter && netEnergy >= 3, type: BuildingType.MatterPlant, save: false },
      // 9. Floating matter — add factory
      { condition: state.totalMatter > 300 && factories < 8, type: BuildingType.DroneFactory, save: false },
      // 10. Depot scaling
      { condition: depots < 1 + Math.floor(factories / 2), type: BuildingType.SupplyDepot, save: false },
      // 11. Energy headroom (tighter +1 to avoid over-expanding extractors)
      { condition: extractors < Math.ceil((plants * 2 + factories) / 5) + 1, type: BuildingType.EnergyExtractor, save: false },
      // 12. Matter scaling
      { condition: matterIncome < factories * 1.5 && netEnergy >= 4, type: BuildingType.MatterPlant, save: false },
      // 13. Late-game overflow
      { condition: state.totalMatter > 450 && factories < 8, type: BuildingType.DroneFactory, save: false },
      // 14. Always expand to unclaimed energy nodes
      { condition: hasUnclaimedNode, type: BuildingType.EnergyExtractor, save: false },
      // 15. Late-game catchup — reinforce 1:1 parity
      { condition: plants < extractors && netEnergy >= 4, type: BuildingType.MatterPlant, save: false },
    ];

    for (const rule of rules) {
      if (!rule.condition) continue;

      const def = BUILDING_DEFS[rule.type];
      if (!def) continue;

      const canAfford = ctx.resources.canAfford(ctx.team, def.energyCost)
        && ctx.resources.canAffordMatter(ctx.team, def.matterCost);

      if (!canAfford) {
        if (rule.save) return; // Save resources for this building
        continue; // Skip to next rule
      }

      const location = findBuildLocation(ctx, rule.type, state, this.enemyMemory);
      if (!location) continue; // Location failed (e.g. no energy node), try next rule

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

  // --- Wall Building ---

  private executeWallBuilding(ctx: AIContext, state: AIWorldState, phase: AIPhase): void {
    if (phase === 'early') return;

    const idleWorkers = getIdleWorkers(ctx, state);
    if (idleWorkers.length < 2) return; // Keep at least one worker free

    // Count existing walls + wall constructions
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

    // Priority order by phase
    type PlanFinder = () => ReturnType<typeof findExtractorWallPlan>;
    const planners: PlanFinder[] = [];

    // 1. Extractor defense from buildup phase onward
    if (phase === 'buildup' || phase === 'midgame' || phase === 'lategame') {
      planners.push(() => findExtractorWallPlan(ctx, state, this.enemyMemory));
    }

    // 2. Chokepoint control from midgame with army >= 5
    if ((phase === 'midgame' || phase === 'lategame') && state.totalArmySize >= 5) {
      planners.push(() => findChokepointWallPlan(ctx, state, this.enemyMemory));
    }

    // 3. Base perimeter in lategame only
    if (phase === 'lategame') {
      planners.push(() => findBasePerimeterWallPlan(ctx, state, this.enemyMemory));
    }

    for (const planner of planners) {
      const plan = planner();
      if (!plan) continue;

      // Cap segments so we don't exceed MAX_AI_WALLS
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

  // --- Production ---

  private executeProduction(ctx: AIContext, state: AIWorldState, hq: number): void {
    const extractors = getBuildingCount(state, BuildingType.EnergyExtractor) + (state.myConstructions.get(BuildingType.EnergyExtractor) ?? 0);
    const plants = getBuildingCount(state, BuildingType.MatterPlant) + (state.myConstructions.get(BuildingType.MatterPlant) ?? 0);
    const factories = getBuildingCount(state, BuildingType.DroneFactory) + (state.myConstructions.get(BuildingType.DroneFactory) ?? 0);
    const currentEnergy = ctx.resources.get(ctx.team).energy;

    // Worker suppression: don't train workers while bootstrapping fundamentals
    const suppressWorkers = extractors === 0 || plants === 0
      || (factories === 0 && currentEnergy < 150);

    const targetWorkers = Math.min(8, WORKER_SCALING_BASE + state.depotCount);
    if (state.myWorkers.length < targetWorkers && !suppressWorkers) {
      trainFromHQ(ctx, UnitCategory.WorkerDrone, hq);
    }

    const threatsNearBase = state.enemiesNearBase.length > 0;
    const hasBasicEconomy = extractors >= 1 && plants >= 1;
    const hasMilitaryEconomy = extractors >= 2 && plants >= 2;
    const factoryEntities = state.myBuildings.get(BuildingType.DroneFactory) ?? [];

    for (const factory of factoryEntities) {
      let unitType: UnitCategory;

      // Aerial drone gate: build scouts once basic economy exists
      if (state.myAerial.length < 2 && hasBasicEconomy) {
        unitType = UnitCategory.AerialDrone;
      } else if (threatsNearBase) {
        // Emergency: always build combat drones if base is under attack
        unitType = UnitCategory.CombatDrone;
      } else if (!hasMilitaryEconomy) {
        // Military gate: skip military production until 2+ extractors AND 2+ plants
        continue;
      } else if (this.unitsProduced % 4 === 3) {
        unitType = UnitCategory.AssaultPlatform;
      } else {
        unitType = UnitCategory.CombatDrone;
      }

      // Determine rally point
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

  // --- Ferry Assignment ---

  private executeFerry(ctx: AIContext, state: AIWorldState, hq: number): void {
    const hqPos = ctx.world.getComponent<PositionComponent>(hq, POSITION)!;
    const completedDepots = getCompletedDepots(ctx, state);

    // Rally idle workers near HQ even before any depots exist
    if (completedDepots.length === 0) {
      const allIdle = getIdleWorkers(ctx, state);
      for (const worker of allIdle) {
        if (ctx.world.hasComponent(worker, MOVE_COMMAND)) continue;
        const pos = ctx.world.getComponent<PositionComponent>(worker, POSITION);
        if (pos && Math.abs(pos.x - hqPos.x) < 5 && Math.abs(pos.z - hqPos.z) < 5) {
          issueMove(ctx, worker, ctx.rallyX, ctx.rallyZ);
        }
      }
      return;
    }

    const ferryCountMap = getFerryCountByDepot(ctx, state);
    const idleWorkers = getIdleWorkers(ctx, state);
    const maxFerryAssignments = Math.max(0, idleWorkers.length - 1);
    let assigned = 0;

    for (const depot of completedDepots) {
      if (assigned >= maxFerryAssignments) break;

      const depotPos = ctx.world.getComponent<PositionComponent>(depot, POSITION)!;
      const dx = depotPos.x - hqPos.x;
      const dz = depotPos.z - hqPos.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      const requiredFerries = Math.max(1, Math.min(4, Math.ceil(distance / 40)));
      const currentFerries = ferryCountMap.get(depot) ?? 0;

      if (currentFerries >= requiredFerries) continue;

      const worker = idleWorkers[assigned];
      if (!worker) break;

      assignFerry(ctx, worker, depot, hq);
      assigned++;
    }

    // Rally idle workers away from HQ spawn so they don't clump
    for (let i = assigned; i < idleWorkers.length; i++) {
      const worker = idleWorkers[i];
      if (ctx.world.hasComponent(worker, MOVE_COMMAND)) continue;
      const pos = ctx.world.getComponent<PositionComponent>(worker, POSITION);
      if (pos && Math.abs(pos.x - hqPos.x) < 5 && Math.abs(pos.z - hqPos.z) < 5) {
        issueMove(ctx, worker, ctx.rallyX, ctx.rallyZ);
      }
    }
  }

  // --- Scouting ---

  private executeScouting(ctx: AIContext, state: AIWorldState): void {
    const scouts = state.myAerial.slice(0, 2);
    const raidTarget = findIsolatedTarget(state);

    for (let i = 0; i < scouts.length; i++) {
      const scout = scouts[i];
      if (ctx.world.hasComponent(scout, MOVE_COMMAND)) continue;

      // Only the first scout can divert to raid targets; second always patrols
      if (i === 0 && raidTarget) {
        issueMove(ctx, scout, raidTarget.x, raidTarget.z);
      } else {
        const waypointIndex = i === 0 ? this.scoutWaypointIndex : this.scoutWaypointIndex2;
        const target = getNextScoutTarget(ctx, waypointIndex);
        issueMove(ctx, scout, target.x, target.z);

        if (i === 0) {
          this.scoutWaypointIndex = (this.scoutWaypointIndex + 1) % SCOUT_WAYPOINTS.length;
        } else {
          this.scoutWaypointIndex2 = (this.scoutWaypointIndex2 + 1) % SCOUT_WAYPOINTS.length;
        }
      }
    }
  }
}
