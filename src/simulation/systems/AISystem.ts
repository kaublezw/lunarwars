import type { System, World } from '@core/ECS';
import {
  POSITION, RENDERABLE, UNIT_TYPE, SELECTABLE,
  HEALTH, TEAM, BUILDING, BUILD_COMMAND, CONSTRUCTION,
  MOVE_COMMAND, PRODUCTION_QUEUE, RESUPPLY_SEEK, MATTER_STORAGE,
  SUPPLY_ROUTE,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { SupplyRouteComponent } from '@sim/components/SupplyRoute';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { EnergyNode } from '@sim/terrain/MapFeatures';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const TICK_INTERVAL = 30; // Run AI every 30 frames (0.5s at 60fps)
const BASE_DEFENSE_RADIUS = 30;
const RALLY_OFFSET = 15;
const ATTACK_THRESHOLD = 10; // Min combat units before attacking
const RETREAT_HP_FRACTION = 0.3;
const MAX_QUEUE_DEPTH = 3;
const FORCE_ATTACK_TICKS = 900; // 7.5 min at 30-tick intervals (0.5s each)
const REATTACK_COOLDOWN_TICKS = 120; // 60s / 0.5s
const OVERWHELMING_ARMY = 12;
const REATTACK_THRESHOLD = 6; // Lower threshold after reattack cooldown
const STAGING_DISTANCE_FRACTION = 0.7; // Staging point at 70% of the way to target
const STAGING_RADIUS = 15; // Units must be within this radius of staging point
const STAGING_READY_FRACTION = 0.75; // 75% of army must arrive before advancing
const MAX_STAGING_TICKS = 20; // 10s timeout (20 ticks at 0.5s each)

type AIPhase = 'early' | 'buildup' | 'midgame' | 'lategame';

interface BuildOrder {
  type: BuildingType;
  maxCount: number;
}

const EARLY_BUILD_ORDER: BuildOrder[] = [
  { type: BuildingType.EnergyExtractor, maxCount: 1 },
  { type: BuildingType.MatterPlant, maxCount: 1 },
  { type: BuildingType.SupplyDepot, maxCount: 1 },
  { type: BuildingType.EnergyExtractor, maxCount: 2 },
  { type: BuildingType.DroneFactory, maxCount: 1 },
  { type: BuildingType.MatterPlant, maxCount: 2 },
  { type: BuildingType.EnergyExtractor, maxCount: 3 },
  { type: BuildingType.SupplyDepot, maxCount: 2 },
  { type: BuildingType.DroneFactory, maxCount: 2 },
];

const LATE_EXPANSION: BuildOrder[] = [
  { type: BuildingType.EnergyExtractor, maxCount: 6 },
  { type: BuildingType.MatterPlant, maxCount: 4 },
  { type: BuildingType.DroneFactory, maxCount: 3 },
  { type: BuildingType.SupplyDepot, maxCount: 3 },
];

// Scout waypoints: 5x5 grid covering the 256x256 map at 48-unit spacing
const SCOUT_WAYPOINTS: { x: number; z: number }[] = [];
for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 5; col++) {
    SCOUT_WAYPOINTS.push({ x: 32 + col * 48, z: 32 + row * 48 });
  }
}

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
  private scoutWaypointIndex2 = 12; // Second scout starts on opposite side of map
  private unitsProduced = 0;
  private attackTargetX = -1;
  private attackTargetZ = -1;
  private attackPhase: 'idle' | 'staging' | 'attacking' = 'idle';
  private stagingX = -1;
  private stagingZ = -1;
  private stagingTimer = 0;
  private reattackTimer = -1; // -1 = no pending reattack, >0 = cooling down, 0 = ready to reattack
  private forceAttackTimer = 0;

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

    // Default base position (will be updated when HQ is found)
    this.baseX = 192;
    this.baseZ = 192;
    this.rallyX = this.baseX - RALLY_OFFSET;
    this.rallyZ = this.baseZ - RALLY_OFFSET;
  }

  serialize(): Record<string, unknown> {
    return {
      tickCounter: this.tickCounter,
      totalTicks: this.totalTicks,
      scoutWaypointIndex: this.scoutWaypointIndex,
      scoutWaypointIndex2: this.scoutWaypointIndex2,
      unitsProduced: this.unitsProduced,
      attackPhase: this.attackPhase,
      attackTargetX: this.attackTargetX,
      attackTargetZ: this.attackTargetZ,
      stagingX: this.stagingX,
      stagingZ: this.stagingZ,
      stagingTimer: this.stagingTimer,
      reattackTimer: this.reattackTimer,
      forceAttackTimer: this.forceAttackTimer,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    this.tickCounter = data.tickCounter as number;
    this.totalTicks = data.totalTicks as number;
    this.scoutWaypointIndex = data.scoutWaypointIndex as number;
    this.scoutWaypointIndex2 = (data.scoutWaypointIndex2 as number) ?? 12;
    this.unitsProduced = data.unitsProduced as number;
    // Backward compat: old saves have isAttacking (boolean), new saves have attackPhase (string)
    if (typeof data.attackPhase === 'string') {
      this.attackPhase = data.attackPhase as 'idle' | 'staging' | 'attacking';
    } else {
      this.attackPhase = (data.isAttacking as boolean) ? 'attacking' : 'idle';
    }
    this.attackTargetX = data.attackTargetX as number;
    this.attackTargetZ = data.attackTargetZ as number;
    this.stagingX = (data.stagingX as number) ?? -1;
    this.stagingZ = (data.stagingZ as number) ?? -1;
    this.stagingTimer = (data.stagingTimer as number) ?? 0;
    this.reattackTimer = (data.reattackTimer as number) ?? -1;
    this.forceAttackTimer = (data.forceAttackTimer as number) ?? 0;
  }

  update(world: World, _dt: number): void {
    this.tickCounter++;
    this.totalTicks++;

    if (this.tickCounter < TICK_INTERVAL) return;
    this.tickCounter = 0;

    // Locate our HQ and update base position
    const hq = this.findHQ(world);
    if (!hq) return; // HQ destroyed, game over for AI

    const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;
    this.baseX = hqPos.x;
    this.baseZ = hqPos.z;
    this.rallyX = this.baseX - RALLY_OFFSET;
    this.rallyZ = this.baseZ - RALLY_OFFSET;

    // Increment force attack timer each AI tick
    this.forceAttackTimer++;

    // Gather world state
    const state = this.assessWorldState(world);
    const phase = this.determinePhase(state);

    // Execute AI behaviors
    this.executeBuildOrder(world, state, phase);
    this.executeProduction(world, state, phase);
    this.executeFerry(world, state);
    this.executeArmyControl(world, state);
    this.executeScouting(world, state);
  }

  // --- World State Assessment ---

  private assessWorldState(world: World): AIWorldState {
    const myWorkers: number[] = [];
    const myCombat: number[] = [];
    const myAerial: number[] = [];
    const myBuildings = new Map<BuildingType, number[]>();
    const myConstructions = new Map<string, number>();
    let enemiesNearBase: { entity: number; x: number; z: number }[] = [];
    let knownEnemyBuildings: { entity: number; x: number; z: number; type: BuildingType }[] = [];
    let knownEnemyUnits: { entity: number; x: number; z: number }[] = [];

    // Count our units
    const units = world.query(UNIT_TYPE, TEAM, POSITION, HEALTH);
    for (const e of units) {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      const unitType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      if (team.team === this.team) {
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
        // Enemy unit - only track if visible in fog of war
        if (this.fogState.isVisible(this.team, pos.x, pos.z)) {
          knownEnemyUnits.push({ entity: e, x: pos.x, z: pos.z });

          // Check if near our base
          const dx = pos.x - this.baseX;
          const dz = pos.z - this.baseZ;
          if (dx * dx + dz * dz < BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS) {
            enemiesNearBase.push({ entity: e, x: pos.x, z: pos.z });
          }
        }
      }
    }

    // Count our buildings
    const buildings = world.query(BUILDING, TEAM, POSITION, HEALTH);
    for (const e of buildings) {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      if (team.team === this.team) {
        if (!myBuildings.has(building.buildingType)) {
          myBuildings.set(building.buildingType, []);
        }
        myBuildings.get(building.buildingType)!.push(e);
      } else {
        // Enemy building - only track if visible
        if (this.fogState.isVisible(this.team, pos.x, pos.z)) {
          knownEnemyBuildings.push({ entity: e, x: pos.x, z: pos.z, type: building.buildingType });
        }
      }
    }

    // Count in-progress constructions
    const constructions = world.query(CONSTRUCTION, TEAM);
    for (const e of constructions) {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.team) continue;
      const construction = world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
      const current = myConstructions.get(construction.buildingType) ?? 0;
      myConstructions.set(construction.buildingType, current + 1);
    }

    // Depot/supply state — only count actual SupplyDepots (HQ has no MATTER_STORAGE)
    const depotEntities = (myBuildings.get(BuildingType.SupplyDepot) ?? []).filter(
      d => !world.hasComponent(d, CONSTRUCTION) && world.hasComponent(d, MATTER_STORAGE)
    );
    const depotCount = depotEntities.length;
    const totalMatter = this.resources.get(this.team).matter;

    // Total army: combat units + aerial (minus 2 scouts)
    const totalArmySize = myCombat.length + Math.max(0, myAerial.length - 2);

    return {
      myWorkers,
      myCombat,
      myAerial,
      myBuildings,
      myConstructions,
      enemiesNearBase,
      knownEnemyBuildings,
      knownEnemyUnits,
      depotCount,
      depotEntities,
      totalMatter,
      totalArmySize,
    };
  }

  private determinePhase(state: AIWorldState): AIPhase {
    const factoryCount = this.getBuildingCount(state, BuildingType.DroneFactory);
    const combatCount = state.myCombat.length;
    // 10 minutes = 1200 ticks at our 0.5s tick rate
    const tenMinutesPassed = this.totalTicks >= 1200;

    if (factoryCount === 0) return 'early';
    if (combatCount < 5) return 'buildup';
    if (combatCount < 12 && !tenMinutesPassed) return 'midgame';
    return 'lategame';
  }

  // --- Build Order Execution ---

  private executeBuildOrder(world: World, state: AIWorldState, phase: AIPhase): void {
    // Find idle workers (not currently building or ferrying)
    const idleWorkers = state.myWorkers.filter(e => !world.hasComponent(e, BUILD_COMMAND) && !world.hasComponent(e, SUPPLY_ROUTE));
    if (idleWorkers.length === 0) return;

    const buildOrders = phase === 'lategame'
      ? [...EARLY_BUILD_ORDER, ...LATE_EXPANSION]
      : EARLY_BUILD_ORDER;

    for (const order of buildOrders) {
      const currentCount = this.getBuildingCount(state, order.type);
      const inProgress = state.myConstructions.get(order.type) ?? 0;

      if (currentCount + inProgress >= order.maxCount) continue;

      const def = BUILDING_DEFS[order.type];
      if (!def) continue;

      // Check energy affordability globally
      if (!this.resources.canAfford(this.team, def.energyCost)) continue;

      // Check global matter pool
      if (!this.resources.canAffordMatter(this.team, def.matterCost)) continue;

      // Find a valid build location
      const location = this.findBuildLocation(world, order.type);
      if (!location) continue;

      // Pick an idle worker
      const worker = idleWorkers[0];

      // Spend energy globally
      this.resources.spend(this.team, def.energyCost);

      // Deduct matter from global pool
      if (def.matterCost > 0) {
        this.resources.spendMatter(this.team, def.matterCost);
      }

      // Create construction site
      this.createConstructionSite(world, order.type, location.x, location.z, worker);

      // Only one build order per tick
      return;
    }
  }

  private findBuildLocation(world: World, type: BuildingType): { x: number; z: number } | null {
    if (type === BuildingType.EnergyExtractor) {
      return this.findEnergyNodeLocation(world);
    }

    if (type === BuildingType.SupplyDepot) {
      return this.findDepotLocation(world);
    }

    // For other buildings, find a spot near base
    return this.findLocationNear(this.baseX, this.baseZ);
  }

  private findDepotLocation(world: World): { x: number; z: number } | null {
    // Count existing + under-construction Supply Depots
    const existing = world.query(BUILDING, TEAM).filter(e => {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.team) return false;
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
      return bldg.buildingType === BuildingType.SupplyDepot;
    });

    const underConstruction = world.query(CONSTRUCTION, TEAM).filter(e => {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.team) return false;
      const con = world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
      return con.buildingType === BuildingType.SupplyDepot;
    });

    const depotIndex = existing.length + underConstruction.length;

    // First depot: place near HQ
    if (depotIndex === 0) {
      return this.findLocationNear(this.baseX, this.baseZ);
    }

    // Additional depots: place midway toward estimated enemy position
    const enemy = this.estimateEnemyPosition(world);
    const midX = (this.baseX + enemy.x) / 2;
    const midZ = (this.baseZ + enemy.z) / 2;

    // Spread multiple forward depots perpendicular to the base->enemy axis
    let targetX = midX;
    let targetZ = midZ;

    if (depotIndex >= 2) {
      const axisX = enemy.x - this.baseX;
      const axisZ = enemy.z - this.baseZ;
      const len = Math.sqrt(axisX * axisX + axisZ * axisZ) || 1;
      // Perpendicular direction (rotate 90 degrees)
      const perpX = -axisZ / len;
      const perpZ = axisX / len;
      // Alternate sides: depot 2 goes +10, depot 3 goes -10, etc.
      const side = (depotIndex % 2 === 0) ? 1 : -1;
      const spread = 10 * Math.ceil((depotIndex - 1) / 2);
      targetX = midX + perpX * spread * side;
      targetZ = midZ + perpZ * spread * side;
    }

    return this.findLocationNear(targetX, targetZ);
  }

  private estimateEnemyPosition(world: World): { x: number; z: number } {
    // Use known visible enemy buildings if available
    const enemyBuildings: { x: number; z: number }[] = [];
    const buildings = world.query(BUILDING, TEAM, POSITION, HEALTH);
    for (const e of buildings) {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team === this.team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      if (this.fogState.isVisible(this.team, pos.x, pos.z)) {
        enemyBuildings.push({ x: pos.x, z: pos.z });
      }
    }

    if (enemyBuildings.length > 0) {
      const avgX = enemyBuildings.reduce((s, b) => s + b.x, 0) / enemyBuildings.length;
      const avgZ = enemyBuildings.reduce((s, b) => s + b.z, 0) / enemyBuildings.length;
      return { x: avgX, z: avgZ };
    }

    // Fallback: assumed player base location
    return { x: 64, z: 64 };
  }

  private findLocationNear(centerX: number, centerZ: number): { x: number; z: number } | null {
    // Search in expanding rings around the target point
    const radii = [0, 4, 8, 12, 16, 20];
    const directions = [
      { dx: 0, dz: 0 },   // center (only for radius 0)
      { dx: 1, dz: 0 },   { dx: -1, dz: 0 },
      { dx: 0, dz: 1 },   { dx: 0, dz: -1 },
      { dx: 1, dz: 1 },   { dx: -1, dz: 1 },
      { dx: 1, dz: -1 },  { dx: -1, dz: -1 },
    ];

    for (const radius of radii) {
      const dirs = radius === 0 ? [directions[0]] : directions.slice(1);
      for (const dir of dirs) {
        const x = Math.round(centerX + dir.dx * radius);
        const z = Math.round(centerZ + dir.dz * radius);

        if (x < 4 || x > 252 || z < 4 || z > 252) continue;
        if (!this.terrainData.isPassable(x, z)) continue;
        if (this.terrainData.getSlope(x, z) >= 1.0) continue;

        // Check a 5x5 area around the build site for overlap
        let blocked = false;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (this.occupancy.isBlocked(x + dx, z + dz)) {
              blocked = true;
              break;
            }
          }
          if (blocked) break;
        }
        if (blocked) continue;

        return { x, z };
      }
    }

    return null;
  }

  private findEnergyNodeLocation(world: World): { x: number; z: number } | null {
    // Find unclaimed energy nodes
    const claimedNodes = new Set<string>();

    const buildings = world.query(BUILDING, POSITION);
    for (const e of buildings) {
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType === BuildingType.EnergyExtractor) {
        const pos = world.getComponent<PositionComponent>(e, POSITION)!;
        // Mark nodes within snap distance as claimed
        for (const node of this.energyNodes) {
          const dx = node.x - pos.x;
          const dz = node.z - pos.z;
          if (dx * dx + dz * dz < 25) { // 5-unit snap range
            claimedNodes.add(`${node.x},${node.z}`);
          }
        }
      }
    }

    // Also check construction sites
    const constructions = world.query(CONSTRUCTION, POSITION);
    for (const e of constructions) {
      const construction = world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
      if (construction.buildingType === BuildingType.EnergyExtractor) {
        const pos = world.getComponent<PositionComponent>(e, POSITION)!;
        for (const node of this.energyNodes) {
          const dx = node.x - pos.x;
          const dz = node.z - pos.z;
          if (dx * dx + dz * dz < 25) {
            claimedNodes.add(`${node.x},${node.z}`);
          }
        }
      }
    }

    // Find nearest unclaimed node
    let bestNode: EnergyNode | null = null;
    let bestDistSq = Infinity;

    for (const node of this.energyNodes) {
      if (claimedNodes.has(`${node.x},${node.z}`)) continue;

      const dx = node.x - this.baseX;
      const dz = node.z - this.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestNode = node;
      }
    }

    if (bestNode) {
      return { x: Math.round(bestNode.x), z: Math.round(bestNode.z) };
    }

    return null;
  }

  private createConstructionSite(world: World, type: BuildingType, x: number, z: number, workerEntity: number): void {
    const def = BUILDING_DEFS[type];
    if (!def) return;

    const site = world.createEntity();
    const siteY = this.terrainData.getHeight(x, z);

    world.addComponent<PositionComponent>(site, POSITION, {
      x, y: siteY + 0.25, z,
      prevX: x, prevY: siteY + 0.25, prevZ: z,
      rotation: 0,
    });

    world.addComponent<RenderableComponent>(site, RENDERABLE, {
      meshType: 'construction_site',
      color: TEAM_COLORS[this.team],
      scale: 1.0,
    });

    world.addComponent<TeamComponent>(site, TEAM, { team: this.team });

    world.addComponent<BuildingComponent>(site, BUILDING, {
      buildingType: type,
    });

    world.addComponent<HealthComponent>(site, HEALTH, {
      current: 50,
      max: def.hp,
      dead: false,
    });

    world.addComponent<ConstructionComponent>(site, CONSTRUCTION, {
      buildingType: type,
      progress: 0,
      buildTime: def.buildTime,
      builderEntity: workerEntity,
    });

    world.addComponent<SelectableComponent>(site, SELECTABLE, { selected: false });

    // Issue move + build commands to worker
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
      siteEntity: site,
    });
  }

  // --- Production ---

  private executeProduction(world: World, state: AIWorldState, phase: AIPhase): void {
    // Train workers if needed — more aggressive targets
    const targetWorkers = phase === 'early' ? 4 : 5;
    if (state.myWorkers.length < targetWorkers) {
      this.trainFromHQ(world, UnitCategory.WorkerDrone);
    }

    const threatsNearBase = state.enemiesNearBase.length > 0;

    // Train combat units from factories
    const factories = state.myBuildings.get(BuildingType.DroneFactory) ?? [];
    for (const factory of factories) {
      const pq = world.getComponent<ProductionQueueComponent>(factory, PRODUCTION_QUEUE);
      if (!pq) continue;
      if (pq.queue.length >= MAX_QUEUE_DEPTH) continue;

      // Decide what to produce
      let unitType: UnitCategory;

      // First aerial drone after ~90s (180 ticks at 0.5s each)
      if (state.myAerial.length === 0 && this.totalTicks > 180) {
        unitType = UnitCategory.AerialDrone;
      } else if (state.myAerial.length < 2 && this.totalTicks > 180) {
        // Second aerial drone for dual scouting
        unitType = UnitCategory.AerialDrone;
      } else if (threatsNearBase) {
        // Under attack: prioritize combat drones (fast train time)
        unitType = UnitCategory.CombatDrone;
      } else if (this.unitsProduced % 4 === 3) {
        // Every 4th unit is an assault platform
        unitType = UnitCategory.AssaultPlatform;
      } else {
        unitType = UnitCategory.CombatDrone;
      }

      const def = UNIT_DEFS[unitType];
      if (!def) continue;

      // Check energy globally
      if (!this.resources.canAfford(this.team, def.energyCost)) continue;

      // Check global matter pool
      if (!this.resources.canAffordMatter(this.team, def.matterCost)) continue;

      // Spend energy globally
      this.resources.spend(this.team, def.energyCost);

      // Deduct matter from global pool
      if (def.matterCost > 0) {
        this.resources.spendMatter(this.team, def.matterCost);
      }

      pq.queue.push({
        unitType,
        timeRemaining: def.trainTime,
        totalTime: def.trainTime,
      });

      // Rally new units to staging point during attack, else base rally
      if (this.attackPhase === 'staging' && this.stagingX >= 0) {
        pq.rallyX = this.stagingX;
        pq.rallyZ = this.stagingZ;
      } else if (this.attackPhase === 'attacking' && this.stagingX >= 0) {
        pq.rallyX = this.stagingX;
        pq.rallyZ = this.stagingZ;
      } else {
        pq.rallyX = this.rallyX;
        pq.rallyZ = this.rallyZ;
      }

      this.unitsProduced++;
    }
  }

  private trainFromHQ(world: World, unitType: UnitCategory): void {
    const def = UNIT_DEFS[unitType];
    if (!def) return;

    // Check energy globally
    if (!this.resources.canAfford(this.team, def.energyCost)) return;

    // Find our HQ
    const hq = this.findHQ(world);
    if (!hq) return;

    const pq = world.getComponent<ProductionQueueComponent>(hq, PRODUCTION_QUEUE);
    if (!pq) return;
    if (pq.queue.length >= MAX_QUEUE_DEPTH) return;

    // Check global matter pool
    if (!this.resources.canAffordMatter(this.team, def.matterCost)) return;

    // Spend energy
    this.resources.spend(this.team, def.energyCost);

    // Deduct matter from global pool
    if (def.matterCost > 0) {
      this.resources.spendMatter(this.team, def.matterCost);
    }

    pq.queue.push({
      unitType,
      timeRemaining: def.trainTime,
      totalTime: def.trainTime,
    });
  }

  // --- Ferry Assignment ---

  private executeFerry(world: World, state: AIWorldState): void {
    const hq = this.findHQ(world);
    if (!hq) return;

    const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;

    // Find completed depots with MATTER_STORAGE
    const depots = state.myBuildings.get(BuildingType.SupplyDepot) ?? [];
    const completedDepots = depots.filter(d =>
      !world.hasComponent(d, CONSTRUCTION) && world.hasComponent(d, MATTER_STORAGE)
    );
    if (completedDepots.length === 0) return;

    // Count workers already ferrying per depot
    const ferryCountByDepot = new Map<number, number>();
    for (const w of state.myWorkers) {
      if (!world.hasComponent(w, SUPPLY_ROUTE)) continue;
      const route = world.getComponent<SupplyRouteComponent>(w, SUPPLY_ROUTE)!;
      const count = ferryCountByDepot.get(route.destEntity) ?? 0;
      ferryCountByDepot.set(route.destEntity, count + 1);
    }

    // Find idle workers (no BUILD_COMMAND, no SUPPLY_ROUTE)
    const idleWorkers = state.myWorkers.filter(e =>
      !world.hasComponent(e, BUILD_COMMAND) && !world.hasComponent(e, SUPPLY_ROUTE)
    );

    // Keep at least 1 worker free for building
    const maxFerryAssignments = Math.max(0, idleWorkers.length - 1);
    let assigned = 0;

    // Assign 2 ferry workers per depot
    for (const depot of completedDepots) {
      if (assigned >= maxFerryAssignments) break;
      
      const depotPos = world.getComponent<PositionComponent>(depot, POSITION)!;
      const dx = depotPos.x - hqPos.x;
      const dz = depotPos.z - hqPos.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      
      // Calculate how many ferries we need (1 worker per 40 units of distance, max 4)
      const requiredFerries = Math.max(1, Math.min(4, Math.ceil(distance / 40)));
      const currentFerries = ferryCountByDepot.get(depot) ?? 0;

      if (currentFerries >= requiredFerries) continue;

      const worker = idleWorkers[assigned];
      if (!worker) break;

      world.addComponent<SupplyRouteComponent>(worker, SUPPLY_ROUTE, {
        sourceEntity: hq,
        destEntity: depot,
        state: 'to_source',
        timer: 0,
        carried: 0,
        carryCapacity: 10,
      });

      if (world.hasComponent(worker, MOVE_COMMAND)) world.removeComponent(worker, MOVE_COMMAND);
      
      world.addComponent<MoveCommandComponent>(worker, MOVE_COMMAND, {
        path: [],
        currentWaypoint: 0,
        destX: hqPos.x,
        destZ: hqPos.z,
      });

      assigned++;
    }
  }

  // --- Army Control ---

  private executeArmyControl(world: World, state: AIWorldState): void {
    const armyAerial = state.myAerial.slice(2);

    if (this.reattackTimer > 0) this.reattackTimer--;

    // Priority 1: Defend base
    if (state.enemiesNearBase.length > 0) {
      this.attackPhase = 'idle'; // Instantly abort attacks to defend
      const avgX = state.enemiesNearBase.reduce((s, e) => s + e.x, 0) / state.enemiesNearBase.length;
      const avgZ = state.enemiesNearBase.reduce((s, e) => s + e.z, 0) / state.enemiesNearBase.length;

      this.sendArmyTo(world, state, avgX, avgZ, armyAerial);
      return;
    }

    // THE TRICKLE FIX: If our army has been decimated, abort the attack and rebuild
    if (this.attackPhase !== 'idle' && state.totalArmySize < 5) {
      this.attackPhase = 'idle';
      this.reattackTimer = REATTACK_COOLDOWN_TICKS;
      // Survivors will naturally be caught by Priority 5 and rally back to base
    }

    // Priority 2: Staging phase
    if (this.attackPhase === 'staging' && state.totalArmySize > 0) {
      this.stagingTimer++;

      const allArmyUnits = [...state.myCombat, ...armyAerial];
      let nearStaging = 0;
      let totalActive = 0;
      
      for (const unitId of allArmyUnits) {
        if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
        totalActive++;
        const pos = world.getComponent<PositionComponent>(unitId, POSITION);
        if (!pos) continue;
        const dx = pos.x - this.stagingX;
        const dz = pos.z - this.stagingZ;
        if (dx * dx + dz * dz < STAGING_RADIUS * STAGING_RADIUS) nearStaging++;
      }

      const readyFraction = totalActive > 0 ? nearStaging / totalActive : 0;
      
      // Increased MAX_STAGING_TICKS from 20 to 60 (30 seconds) to allow large armies to gather
      if (readyFraction >= STAGING_READY_FRACTION || this.stagingTimer >= 60) {
        this.attackPhase = 'attacking';
        this.sendArmyTo(world, state, this.attackTargetX, this.attackTargetZ, armyAerial);
        this.retreatWounded(world, state);
        return;
      }

      this.sendArmyTo(world, state, this.stagingX, this.stagingZ, armyAerial);
      return;
    }

    // Priority 3: Continue attack
    if (this.attackPhase === 'attacking' && state.totalArmySize > 0) {
      if (this.attackTargetX >= 0) {
        const hasVisibleTargets = state.knownEnemyBuildings.length > 0 || state.knownEnemyUnits.length > 0;
        if (hasVisibleTargets) {
          const target = this.pickAttackTarget(state);
          if (target) {
            this.attackTargetX = target.x;
            this.attackTargetZ = target.z;
          }
        }
      }

      this.sendArmyTo(world, state, this.attackTargetX, this.attackTargetZ, armyAerial);
      this.retreatWounded(world, state);
      return;
    }

    let effectiveThreshold = this.reattackTimer === 0 ? REATTACK_THRESHOLD : ATTACK_THRESHOLD;
    const forceAttack = this.forceAttackTimer >= FORCE_ATTACK_TICKS && state.totalArmySize > 0;

    // Priority 4: Launch attack
    if (state.totalArmySize >= effectiveThreshold || forceAttack) {
      const target = this.pickAttackTarget(state);
      const targetX = target ? target.x : 64;
      const targetZ = target ? target.z : 64;

      this.attackTargetX = targetX;
      this.attackTargetZ = targetZ;
      this.reattackTimer = -1;
      this.forceAttackTimer = 0;

      this.stagingX = this.rallyX + (targetX - this.rallyX) * STAGING_DISTANCE_FRACTION;
      this.stagingZ = this.rallyZ + (targetZ - this.rallyZ) * STAGING_DISTANCE_FRACTION;
      this.stagingTimer = 0;
      this.attackPhase = 'staging';

      this.sendArmyTo(world, state, this.stagingX, this.stagingZ, armyAerial);
      return;
    }

    // Priority 5: Rally idle units near base
    for (const unitId of [...state.myCombat, ...armyAerial]) {
      if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
      if (world.hasComponent(unitId, MOVE_COMMAND)) continue;
      
      const pos = world.getComponent<PositionComponent>(unitId, POSITION);
      if (!pos) continue;

      const dx = pos.x - this.rallyX;
      const dz = pos.z - this.rallyZ;
      if (dx * dx + dz * dz > 100) {
        this.issueMove(world, unitId, this.rallyX, this.rallyZ);
      }
    }
  }

 private pickAttackTarget(state: AIWorldState): { x: number; z: number } | null {
    let bestTarget: { x: number; z: number } | null = null;
    let bestDistSq = Infinity;

    if (state.totalArmySize >= OVERWHELMING_ARMY) {
      for (const bldg of state.knownEnemyBuildings) {
        if (bldg.type === BuildingType.HQ) return { x: bldg.x, z: bldg.z };
      }
    }

    // 1. TOP PRIORITY: Hunt Forward Supply Depots (Cut off ammo)
    for (const bldg of state.knownEnemyBuildings) {
      if (bldg.type === BuildingType.SupplyDepot) {
        const dx = bldg.x - this.baseX;
        const dz = bldg.z - this.baseZ;
        const distSq = dx * dx + dz * dz;
        // Target the depot closest to the AI's base (the player's forward operating base)
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestTarget = { x: bldg.x, z: bldg.z };
        }
      }
    }
    if (bestTarget) return bestTarget;

    // 2. HIGH PRIORITY: Disrupt Worker Ferries
    for (const unit of state.knownEnemyUnits) {
       // Assuming you have a way to identify enemy workers, otherwise target any unit near the front
       const dx = unit.x - this.baseX;
       const dz = unit.z - this.baseZ;
       const distSq = dx * dx + dz * dz;
       if (distSq < bestDistSq) {
         bestDistSq = distSq;
         bestTarget = { x: unit.x, z: unit.z };
       }
    }
    if (bestTarget) return bestTarget;

    // 3. Economy (Extractors / Matter Plants)
    bestDistSq = Infinity;
    for (const bldg of state.knownEnemyBuildings) {
      if (bldg.type === BuildingType.EnergyExtractor || bldg.type === BuildingType.MatterPlant) {
        const dx = bldg.x - this.baseX;
        const dz = bldg.z - this.baseZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestTarget = { x: bldg.x, z: bldg.z };
        }
      }
    }
    if (bestTarget) return bestTarget;

    // 4. Drone Factories
    for (const bldg of state.knownEnemyBuildings) {
      if (bldg.type === BuildingType.DroneFactory) return { x: bldg.x, z: bldg.z };
    }

    return null;
  }

  private sendArmyTo(world: World, state: AIWorldState, x: number, z: number, armyAerial: number[] = []): void {
    const allArmyUnits = [...state.myCombat, ...armyAerial];
    for (const unitId of allArmyUnits) {
      if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;

      const existing = world.getComponent<MoveCommandComponent>(unitId, MOVE_COMMAND);
      if (existing) {
        const dx = existing.destX - x;
        const dz = existing.destZ - z;
        if (dx * dx + dz * dz < 25) continue;
      }
      this.issueMove(world, unitId, x, z);
    }
  }

  private retreatWounded(world: World, state: AIWorldState): void {
    for (const unitId of state.myCombat) {
      if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
      const health = world.getComponent<HealthComponent>(unitId, HEALTH);
      if (!health) continue;
      if (health.current / health.max < RETREAT_HP_FRACTION) {
        // Retreat toward nearest depot with matter for repair/resupply
        if (state.depotEntities.length > 0) {
          const pos = world.getComponent<PositionComponent>(unitId, POSITION);
          if (!pos) continue;
          let bestDepot = state.depotEntities[0];
          let bestDistSq = Infinity;
          for (const depot of state.depotEntities) {
            const depotPos = world.getComponent<PositionComponent>(depot, POSITION);
            if (!depotPos) continue;
            const dx = depotPos.x - pos.x;
            const dz = depotPos.z - pos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestDepot = depot;
            }
          }
          const depotPos = world.getComponent<PositionComponent>(bestDepot, POSITION);
          if (depotPos) {
            this.issueMove(world, unitId, depotPos.x, depotPos.z);
            continue;
          }
        }
        // Fallback to base if no depots
        this.issueMove(world, unitId, this.baseX, this.baseZ);
      }
    }
  }

  // --- Scouting ---

  private executeScouting(world: World, state: AIWorldState): void {
    // First aerial drone: scout 1
    if (state.myAerial.length >= 1) {
      const scout1 = state.myAerial[0];
      if (!world.hasComponent(scout1, MOVE_COMMAND)) {
        const target = this.getNextScoutTarget(world, this.scoutWaypointIndex);
        this.issueMove(world, scout1, target.x, target.z);
        this.scoutWaypointIndex = (this.scoutWaypointIndex + 1) % SCOUT_WAYPOINTS.length;
      }
    }

    // Second aerial drone: scout 2 (offset waypoint index, opposite side of map)
    if (state.myAerial.length >= 2) {
      const scout2 = state.myAerial[1];
      if (!world.hasComponent(scout2, MOVE_COMMAND)) {
        const target = this.getNextScoutTarget(world, this.scoutWaypointIndex2);
        this.issueMove(world, scout2, target.x, target.z);
        this.scoutWaypointIndex2 = (this.scoutWaypointIndex2 + 1) % SCOUT_WAYPOINTS.length;
      }
    }
  }

  private getNextScoutTarget(_world: World, waypointIndex: number): { x: number; z: number } {
    // Priority: scout toward unclaimed energy nodes not currently visible to AI
    const claimedNodes = new Set<string>();
    // Re-use the energy node logic to find claimed ones
    // (lightweight check - just look at what's visible and built)
    for (const node of this.energyNodes) {
      if (this.fogState.isVisible(this.team, node.x, node.z)) {
        // If visible, it's either claimed or we know about it already
        // Don't prioritize visible nodes - we can already decide to build there
        claimedNodes.add(`${node.x},${node.z}`);
      }
    }

    // Find unclaimed nodes that are NOT visible (unexplored territory)
    let farthestNode: { x: number; z: number } | null = null;
    let farthestDistSq = 0;
    for (const node of this.energyNodes) {
      const key = `${node.x},${node.z}`;
      if (claimedNodes.has(key)) continue;
      // This node is in fog — scout toward it
      const dx = node.x - this.baseX;
      const dz = node.z - this.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > farthestDistSq) {
        farthestDistSq = distSq;
        farthestNode = { x: node.x, z: node.z };
      }
    }

    if (farthestNode) {
      return farthestNode;
    }

    // Fallback: cycle through grid waypoints
    return SCOUT_WAYPOINTS[waypointIndex % SCOUT_WAYPOINTS.length];
  }

  // --- Helpers ---

  private findHQ(world: World): number | null {
    const buildings = world.query(BUILDING, TEAM, HEALTH);
    for (const e of buildings) {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.team) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      return e;
    }
    return null;
  }

  private getBuildingCount(state: AIWorldState, type: BuildingType): number {
    return (state.myBuildings.get(type) ?? []).length;
  }

  private issueMove(world: World, entity: number, x: number, z: number): void {
    // Clamp to map bounds
    x = Math.max(4, Math.min(252, x));
    z = Math.max(4, Math.min(252, z));

    if (world.hasComponent(entity, MOVE_COMMAND)) {
      world.removeComponent(entity, MOVE_COMMAND);
    }

    world.addComponent<MoveCommandComponent>(entity, MOVE_COMMAND, {
      path: [],
      currentWaypoint: 0,
      destX: x,
      destZ: z,
    });
  }
}

interface AIWorldState {
  myWorkers: number[];
  myCombat: number[];
  myAerial: number[];
  myBuildings: Map<BuildingType, number[]>;
  myConstructions: Map<string, number>;
  enemiesNearBase: { entity: number; x: number; z: number }[];
  knownEnemyBuildings: { entity: number; x: number; z: number; type: BuildingType }[];
  knownEnemyUnits: { entity: number; x: number; z: number }[];
  depotCount: number;
  depotEntities: number[];
  totalMatter: number;
  totalArmySize: number;
}
