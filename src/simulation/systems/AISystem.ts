import type { System, World } from '@core/ECS';
import {
  POSITION, RENDERABLE, UNIT_TYPE, SELECTABLE,
  HEALTH, TEAM, BUILDING, BUILD_COMMAND, CONSTRUCTION,
  MOVE_COMMAND, PRODUCTION_QUEUE, RESUPPLY_SEEK, MATTER_STORAGE,
  SUPPLY_ROUTE, VOXEL_STATE,
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
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { EnergyNode } from '@sim/terrain/MapFeatures';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';

// --- Existing Constants ---
const TEAM_COLORS = [0x4488ff, 0xff4444];
const TICK_INTERVAL = 30;
const BASE_DEFENSE_RADIUS = 30;
const RALLY_OFFSET = 15;
const ATTACK_THRESHOLD = 10;
const RETREAT_HP_FRACTION = 0.3;
const MAX_QUEUE_DEPTH = 3;
const FORCE_ATTACK_TICKS = 900;
const REATTACK_COOLDOWN_TICKS = 120;
const OVERWHELMING_ARMY = 12;
const REATTACK_THRESHOLD = 6;
const STAGING_RADIUS = 15;
const STAGING_READY_FRACTION = 0.75;

// Phase A: Enemy Memory
const MEMORY_DECAY_TICKS = 600; // 5 min at 0.5s/tick
const MEMORY_MAX_ENTRIES = 200;

// Phase B: Influence Map
const INFLUENCE_GRID = 16;
const INFLUENCE_CELL = 16; // 256 / 16 = 16 world units per cell
const THREAT_WEIGHT = 8.0;
const THREAT_DECAY_PER_TICK = 0.05;

// Phase C: Squad System
const HARASS_SQUAD_SIZE = 3;
const DEFENSE_SQUAD_SIZE = 4;
const MIN_MAIN_ARMY_FOR_HARASS = 8;
const DEFENSE_RADIUS = 35;

// Phase D: Dynamic Economy
const MATTER_FLOAT_THRESHOLD = 300;
const WORKER_SCALING_BASE = 3;

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

// Scout waypoints: 5x5 grid covering the 256x256 map at 48-unit spacing
const SCOUT_WAYPOINTS: { x: number; z: number }[] = [];
for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 5; col++) {
    SCOUT_WAYPOINTS.push({ x: 32 + col * 48, z: 32 + row * 48 });
  }
}

// Phase A: Enemy Memory Types
interface EnemyMemoryEntry {
  entityId: number;
  x: number;
  z: number;
  type: 'unit' | 'building';
  unitCategory: UnitCategory | null;
  buildingType: BuildingType | null;
  lastSeenTick: number;
  isAlive: boolean;
}

// Phase C: Squad Types
type SquadMission = 'idle' | 'attack' | 'defend' | 'harass' | 'rally';

interface Squad {
  id: number;
  type: 'main' | 'harass' | 'defense';
  mission: SquadMission;
  unitIds: number[];
  targetX: number;
  targetZ: number;
  state: 'idle' | 'staging' | 'moving' | 'engaged';
  stagingTimer: number;
  waypoints: { x: number; z: number }[];
  waypointIdx: number;
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
  private scoutWaypointIndex2 = 12;
  private unitsProduced = 0;
  private attackTargetX = -1;
  private attackTargetZ = -1;
  private attackPhase: 'idle' | 'staging' | 'attacking' = 'idle';
  private stagingX = -1;
  private stagingZ = -1;
  private stagingTimer = 0;
  private reattackTimer = -1;
  private forceAttackTimer = 0;

  // Phase A: Enemy Memory
  private enemyMemory: Map<number, EnemyMemoryEntry> = new Map();

  // Phase B: Influence Map (interleaved [threat, value, ownPresence] per cell, NOT serialized)
  private influenceGrid: Float32Array = new Float32Array(INFLUENCE_GRID * INFLUENCE_GRID * 3);

  // Phase C: Squad System
  private squads: Squad[] = [];
  private nextSquadId = 0;

  // Phase D: Dynamic Economy
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
      attackPhase: this.attackPhase,
      attackTargetX: this.attackTargetX,
      attackTargetZ: this.attackTargetZ,
      stagingX: this.stagingX,
      stagingZ: this.stagingZ,
      stagingTimer: this.stagingTimer,
      reattackTimer: this.reattackTimer,
      forceAttackTimer: this.forceAttackTimer,
      // Phase A
      enemyMemory: [...this.enemyMemory.values()],
      // Phase C
      squads: this.squads,
      nextSquadId: this.nextSquadId,
      // Phase D
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

    // Phase A
    this.enemyMemory = new Map();
    if (Array.isArray(data.enemyMemory)) {
      for (const entry of data.enemyMemory as EnemyMemoryEntry[]) {
        this.enemyMemory.set(entry.entityId, entry);
      }
    }

    // Phase C
    this.squads = (data.squads as Squad[]) ?? [];
    this.nextSquadId = (data.nextSquadId as number) ?? 0;

    // Phase D
    this.lastMatterSnapshot = (data.lastMatterSnapshot as number) ?? 0;
    this.estimatedMatterRate = (data.estimatedMatterRate as number) ?? 0;
  }

  update(world: World, _dt: number): void {
    this.tickCounter++;

    if (this.tickCounter < TICK_INTERVAL) return;
    this.tickCounter = 0;

    this.totalTicks++;

    const hq = this.findHQ(world);
    if (hq === null) return;

    const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;
    this.baseX = hqPos.x;
    this.baseZ = hqPos.z;
    const dir = this.team === 0 ? 1 : -1;
    this.rallyX = this.baseX + RALLY_OFFSET * dir;
    this.rallyZ = this.baseZ + RALLY_OFFSET * dir;

    this.forceAttackTimer++;

    // Phase D: Track matter rate
    const currentMatter = this.resources.get(this.team).matter;
    this.estimatedMatterRate = (currentMatter - this.lastMatterSnapshot) / (TICK_INTERVAL / 60);
    this.lastMatterSnapshot = currentMatter;

    const state = this.assessWorldState(world);
    const phase = this.determinePhase(state);

    // Phase B: Update influence map
    this.updateInfluenceMap(world, state);

    this.executeBuildOrder(world, state, phase);
    this.executeProduction(world, state, phase);
    this.executeFerry(world, state);
    this.executeArmyControl(world, state);
    this.executeScouting(world, state);
  }

  // --- World State Assessment (Phase A: Memory integrated) ---

  private assessWorldState(world: World): AIWorldState {
    const myWorkers: number[] = [];
    const myCombat: number[] = [];
    const myAerial: number[] = [];
    const myBuildings = new Map<BuildingType, number[]>();
    const myConstructions = new Map<string, number>();
    const enemiesNearBase: { entity: number; x: number; z: number }[] = [];
    const knownEnemyBuildings: { entity: number; x: number; z: number; type: BuildingType }[] = [];
    const knownEnemyUnits: { entity: number; x: number; z: number; category: UnitCategory }[] = [];

    // Track visible enemy IDs for memory pruning
    const visibleEnemyIds = new Set<number>();

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
        if (this.fogState.isVisible(this.team, pos.x, pos.z)) {
          visibleEnemyIds.add(e);
          knownEnemyUnits.push({ entity: e, x: pos.x, z: pos.z, category: unitType.category });

          // Phase A: Upsert into memory
          this.enemyMemory.set(e, {
            entityId: e, x: pos.x, z: pos.z,
            type: 'unit', unitCategory: unitType.category, buildingType: null,
            lastSeenTick: this.totalTicks, isAlive: true,
          });

          const dx = pos.x - this.baseX;
          const dz = pos.z - this.baseZ;
          if (dx * dx + dz * dz < BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS) {
            enemiesNearBase.push({ entity: e, x: pos.x, z: pos.z });
          }
        }
      }
    }

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
        if (this.fogState.isVisible(this.team, pos.x, pos.z)) {
          visibleEnemyIds.add(e);
          knownEnemyBuildings.push({ entity: e, x: pos.x, z: pos.z, type: building.buildingType });

          // Phase A: Upsert into memory
          this.enemyMemory.set(e, {
            entityId: e, x: pos.x, z: pos.z,
            type: 'building', unitCategory: null, buildingType: building.buildingType,
            lastSeenTick: this.totalTicks, isAlive: true,
          });
        }
      }
    }

    // Phase A: Mark entries as dead if their location is visible but entity is gone
    for (const [id, entry] of this.enemyMemory) {
      if (visibleEnemyIds.has(id)) continue;
      if (this.fogState.isVisible(this.team, entry.x, entry.z)) {
        entry.isAlive = false;
      }
    }

    // Phase A: Prune dead/expired entries
    for (const [id, entry] of this.enemyMemory) {
      if (!entry.isAlive || this.totalTicks - entry.lastSeenTick > MEMORY_DECAY_TICKS) {
        this.enemyMemory.delete(id);
      }
    }

    // Phase A: Cap memory size
    if (this.enemyMemory.size > MEMORY_MAX_ENTRIES) {
      const sorted = [...this.enemyMemory.entries()].sort((a, b) => a[1].lastSeenTick - b[1].lastSeenTick);
      while (this.enemyMemory.size > MEMORY_MAX_ENTRIES) {
        this.enemyMemory.delete(sorted.shift()![0]);
      }
    }

    // Phase A: Build remembered enemy lists (not currently visible)
    const rememberedEnemyBuildings: EnemyMemoryEntry[] = [];
    const rememberedEnemyUnits: EnemyMemoryEntry[] = [];
    for (const [id, entry] of this.enemyMemory) {
      if (visibleEnemyIds.has(id)) continue;
      if (entry.type === 'building') rememberedEnemyBuildings.push(entry);
      else rememberedEnemyUnits.push(entry);
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

    const depotEntities = (myBuildings.get(BuildingType.SupplyDepot) ?? []).filter(
      d => !world.hasComponent(d, CONSTRUCTION) && world.hasComponent(d, MATTER_STORAGE)
    );
    const totalMatter = this.resources.get(this.team).matter;
    const totalArmySize = myCombat.length + Math.max(0, myAerial.length - 2);

    return {
      myWorkers, myCombat, myAerial, myBuildings, myConstructions,
      enemiesNearBase, knownEnemyBuildings, knownEnemyUnits,
      depotCount: depotEntities.length, depotEntities, totalMatter, totalArmySize,
      rememberedEnemyBuildings, rememberedEnemyUnits,
    };
  }

  private determinePhase(state: AIWorldState): AIPhase {
    const factoryCount = this.getBuildingCount(state, BuildingType.DroneFactory);
    const combatCount = state.myCombat.length;
    const tenMinutesPassed = this.totalTicks >= 1200;

    if (factoryCount === 0) return 'early';
    if (combatCount < 5) return 'buildup';
    if (combatCount < 12 && !tenMinutesPassed) return 'midgame';
    return 'lategame';
  }

  // --- Phase B: Influence Map ---

  private updateInfluenceMap(world: World, state: AIWorldState): void {
    this.influenceGrid.fill(0);
    const G = INFLUENCE_GRID;
    const C = INFLUENCE_CELL;

    const toCell = (wx: number, wz: number): [number, number] => [
      Math.min(G - 1, Math.max(0, Math.floor(wx / C))),
      Math.min(G - 1, Math.max(0, Math.floor(wz / C))),
    ];

    const unitThreatWeight = (cat: UnitCategory | null): number => {
      switch (cat) {
        case UnitCategory.CombatDrone: return 1;
        case UnitCategory.AssaultPlatform: return 3;
        case UnitCategory.AerialDrone: return 0.5;
        default: return 0;
      }
    };

    const buildingValueWeight = (bt: BuildingType | null): number => {
      switch (bt) {
        case BuildingType.HQ: return 5;
        case BuildingType.DroneFactory: return 3;
        case BuildingType.SupplyDepot: return 2.5;
        case BuildingType.MatterPlant: return 2;
        case BuildingType.EnergyExtractor: return 1.5;
        default: return 0;
      }
    };

    // Visible enemy units -> threat
    for (const unit of state.knownEnemyUnits) {
      const [cx, cz] = toCell(unit.x, unit.z);
      this.influenceGrid[(cz * G + cx) * 3] += unitThreatWeight(unit.category);
    }

    // Visible enemy buildings -> value
    for (const bldg of state.knownEnemyBuildings) {
      const [cx, cz] = toCell(bldg.x, bldg.z);
      this.influenceGrid[(cz * G + cx) * 3 + 1] += buildingValueWeight(bldg.type);
    }

    // Remembered enemy units -> decayed threat
    for (const entry of state.rememberedEnemyUnits) {
      const [cx, cz] = toCell(entry.x, entry.z);
      const decay = Math.max(0, 1 - (this.totalTicks - entry.lastSeenTick) * THREAT_DECAY_PER_TICK);
      this.influenceGrid[(cz * G + cx) * 3] += unitThreatWeight(entry.unitCategory) * decay;
    }

    // Remembered enemy buildings -> decayed value
    for (const entry of state.rememberedEnemyBuildings) {
      const [cx, cz] = toCell(entry.x, entry.z);
      const decay = Math.max(0, 1 - (this.totalTicks - entry.lastSeenTick) * THREAT_DECAY_PER_TICK);
      this.influenceGrid[(cz * G + cx) * 3 + 1] += buildingValueWeight(entry.buildingType) * decay;
    }

    // Own units -> ownPresence
    for (const unitId of [...state.myCombat, ...state.myAerial]) {
      const pos = world.getComponent<PositionComponent>(unitId, POSITION);
      if (!pos) continue;
      const [cx, cz] = toCell(pos.x, pos.z);
      const ut = world.getComponent<UnitTypeComponent>(unitId, UNIT_TYPE);
      this.influenceGrid[(cz * G + cx) * 3 + 2] += ut ? unitThreatWeight(ut.category) : 1;
    }

    // Bleed threat to 8 neighbors at 50%
    const threatCopy = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) {
      threatCopy[i] = this.influenceGrid[i * 3];
    }
    for (let z = 0; z < G; z++) {
      for (let x = 0; x < G; x++) {
        const t = threatCopy[z * G + x];
        if (t <= 0) continue;
        const bleed = t * 0.5;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nx >= G || nz < 0 || nz >= G) continue;
            this.influenceGrid[(nz * G + nx) * 3] += bleed;
          }
        }
      }
    }
  }

  private findInfluenceAwarePath(fromX: number, fromZ: number, toX: number, toZ: number): { x: number; z: number }[] {
    const G = INFLUENCE_GRID;
    const C = INFLUENCE_CELL;
    const SQRT2 = 1.414;

    const sc = Math.min(G - 1, Math.max(0, Math.floor(fromX / C)));
    const sr = Math.min(G - 1, Math.max(0, Math.floor(fromZ / C)));
    const ec = Math.min(G - 1, Math.max(0, Math.floor(toX / C)));
    const er = Math.min(G - 1, Math.max(0, Math.floor(toZ / C)));

    if (sc === ec && sr === er) return [{ x: toX, z: toZ }];

    const dirs = [
      { dx: 1, dz: 0, c: 1 }, { dx: -1, dz: 0, c: 1 },
      { dx: 0, dz: 1, c: 1 }, { dx: 0, dz: -1, c: 1 },
      { dx: 1, dz: 1, c: SQRT2 }, { dx: -1, dz: 1, c: SQRT2 },
      { dx: 1, dz: -1, c: SQRT2 }, { dx: -1, dz: -1, c: SQRT2 },
    ];

    const N = G * G;
    const gScore = new Float32Array(N).fill(Infinity);
    const fScore = new Float32Array(N).fill(Infinity);
    const cameFrom = new Int16Array(N).fill(-1);
    const closed = new Uint8Array(N);

    const sIdx = sr * G + sc;
    const eIdx = er * G + ec;

    gScore[sIdx] = 0;
    const h = (col: number, row: number) => {
      const dx = Math.abs(col - ec);
      const dz = Math.abs(row - er);
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
    };
    fScore[sIdx] = h(sc, sr);

    const open = new Set<number>();
    open.add(sIdx);

    while (open.size > 0) {
      let cur = -1;
      let bestF = Infinity;
      for (const idx of open) {
        if (fScore[idx] < bestF) { bestF = fScore[idx]; cur = idx; }
      }

      if (cur === eIdx) {
        const path: { x: number; z: number }[] = [];
        let n = cur;
        while (n !== sIdx) {
          const r = Math.floor(n / G);
          const c = n % G;
          path.unshift({ x: c * C + C / 2, z: r * C + C / 2 });
          n = cameFrom[n];
          if (n < 0) break;
        }
        if (path.length > 0) path[path.length - 1] = { x: toX, z: toZ };
        else path.push({ x: toX, z: toZ });
        return path;
      }

      open.delete(cur);
      closed[cur] = 1;
      const cr = Math.floor(cur / G);
      const cc = cur % G;

      for (const d of dirs) {
        const nx = cc + d.dx;
        const nz = cr + d.dz;
        if (nx < 0 || nx >= G || nz < 0 || nz >= G) continue;
        const nIdx = nz * G + nx;
        if (closed[nIdx]) continue;
        const threat = this.influenceGrid[nIdx * 3];
        const tentG = gScore[cur] + d.c + threat * THREAT_WEIGHT;
        if (tentG < gScore[nIdx]) {
          cameFrom[nIdx] = cur;
          gScore[nIdx] = tentG;
          fScore[nIdx] = tentG + h(nx, nz);
          open.add(nIdx);
        }
      }
    }

    return [{ x: toX, z: toZ }];
  }

  private getInfluenceThreat(x: number, z: number): number {
    const G = INFLUENCE_GRID;
    const C = INFLUENCE_CELL;
    const cx = Math.min(G - 1, Math.max(0, Math.floor(x / C)));
    const cz = Math.min(G - 1, Math.max(0, Math.floor(z / C)));
    return this.influenceGrid[(cz * G + cx) * 3];
  }

  private getInfluenceValue(x: number, z: number): number {
    const G = INFLUENCE_GRID;
    const C = INFLUENCE_CELL;
    const cx = Math.min(G - 1, Math.max(0, Math.floor(x / C)));
    const cz = Math.min(G - 1, Math.max(0, Math.floor(z / C)));
    return this.influenceGrid[(cz * G + cx) * 3 + 1];
  }

  // --- Phase C: Squad System ---

  private updateSquads(world: World, state: AIWorldState): void {
    // 1. Prune dead units from squads
    for (const squad of this.squads) {
      squad.unitIds = squad.unitIds.filter(id => {
        const hp = world.getComponent<HealthComponent>(id, HEALTH);
        return hp && !hp.dead;
      });
    }

    // 2. Remove empty squads (keep main even if empty)
    this.squads = this.squads.filter(s => s.unitIds.length > 0 || s.type === 'main');

    // Build set of units already in squads
    const assigned = new Set<number>();
    for (const squad of this.squads) {
      for (const id of squad.unitIds) assigned.add(id);
    }

    // Aerial units beyond the 2 scouts are army-eligible
    const armyAerial = state.myAerial.slice(2);

    // 3. Ensure defense squad exists (if total army >= 6)
    let defenseSquad = this.squads.find(s => s.type === 'defense');
    if (state.totalArmySize >= 6 && !defenseSquad) {
      defenseSquad = {
        id: this.nextSquadId++, type: 'defense', mission: 'defend',
        unitIds: [], targetX: this.baseX, targetZ: this.baseZ,
        state: 'idle', stagingTimer: 0, waypoints: [], waypointIdx: 0,
      };
      this.squads.push(defenseSquad);
    }

    // Fill defense squad up to DEFENSE_SQUAD_SIZE with combat drones close to base
    if (defenseSquad && defenseSquad.unitIds.length < DEFENSE_SQUAD_SIZE) {
      const candidates = state.myCombat
        .filter(id => !assigned.has(id) && !world.hasComponent(id, RESUPPLY_SEEK))
        .filter(id => {
          const ut = world.getComponent<UnitTypeComponent>(id, UNIT_TYPE);
          return ut && ut.category === UnitCategory.CombatDrone;
        })
        .map(id => {
          const pos = world.getComponent<PositionComponent>(id, POSITION);
          const dx = pos ? pos.x - this.baseX : 999;
          const dz = pos ? pos.z - this.baseZ : 999;
          return { id, dist: dx * dx + dz * dz };
        })
        .sort((a, b) => a.dist - b.dist);

      const needed = DEFENSE_SQUAD_SIZE - defenseSquad.unitIds.length;
      for (let i = 0; i < Math.min(needed, candidates.length); i++) {
        defenseSquad.unitIds.push(candidates[i].id);
        assigned.add(candidates[i].id);
      }
    }

    // Dissolve defense squad if army shrinks below 6
    if (defenseSquad && state.totalArmySize < 6) {
      this.squads = this.squads.filter(s => s !== defenseSquad);
      defenseSquad = undefined;
    }

    // 4. Ensure harass squad (if army >= MIN_MAIN_ARMY_FOR_HARASS)
    let harassSquad = this.squads.find(s => s.type === 'harass');
    if (state.totalArmySize >= MIN_MAIN_ARMY_FOR_HARASS && !harassSquad) {
      harassSquad = {
        id: this.nextSquadId++, type: 'harass', mission: 'harass',
        unitIds: [], targetX: -1, targetZ: -1,
        state: 'idle', stagingTimer: 0, waypoints: [], waypointIdx: 0,
      };
      this.squads.push(harassSquad);
    }

    // Fill harass squad: prefer aerial drones, then combat drones
    if (harassSquad && harassSquad.unitIds.length < HARASS_SQUAD_SIZE) {
      const aerials = armyAerial.filter(id => !assigned.has(id) && !world.hasComponent(id, RESUPPLY_SEEK));
      const combats = state.myCombat.filter(id => !assigned.has(id) && !world.hasComponent(id, RESUPPLY_SEEK));
      const pool = [...aerials, ...combats];

      const needed = HARASS_SQUAD_SIZE - harassSquad.unitIds.length;
      for (let i = 0; i < Math.min(needed, pool.length); i++) {
        harassSquad.unitIds.push(pool[i]);
        assigned.add(pool[i]);
      }
    }

    // Dissolve harass squad if too small
    if (harassSquad && harassSquad.unitIds.length < 2) {
      this.squads = this.squads.filter(s => s !== harassSquad);
      harassSquad = undefined;
    }

    // 5. Main army: ensure exists, assign all remaining
    let mainSquad = this.squads.find(s => s.type === 'main');
    if (!mainSquad) {
      mainSquad = {
        id: this.nextSquadId++, type: 'main', mission: 'idle',
        unitIds: [], targetX: this.rallyX, targetZ: this.rallyZ,
        state: 'idle', stagingTimer: 0, waypoints: [], waypointIdx: 0,
      };
      this.squads.push(mainSquad);
    }

    // Collect IDs in other squads
    const otherSquadUnits = new Set<number>();
    for (const s of this.squads) {
      if (s === mainSquad) continue;
      for (const id of s.unitIds) otherSquadUnits.add(id);
    }

    // Add unassigned combat/aerial to main
    const remaining = [...state.myCombat, ...armyAerial].filter(
      id => !assigned.has(id) && !otherSquadUnits.has(id) && !world.hasComponent(id, RESUPPLY_SEEK)
    );
    for (const id of remaining) {
      if (!mainSquad.unitIds.includes(id)) {
        mainSquad.unitIds.push(id);
      }
    }

    // Prune main squad: remove units claimed by other squads or dead
    mainSquad.unitIds = mainSquad.unitIds.filter(id => {
      if (otherSquadUnits.has(id)) return false;
      const hp = world.getComponent<HealthComponent>(id, HEALTH);
      return hp && !hp.dead;
    });
  }

  private executeSquadOrders(world: World, state: AIWorldState): void {
    for (const squad of this.squads) {
      switch (squad.type) {
        case 'defense': this.executeDefenseOrders(world, state, squad); break;
        case 'harass': this.executeHarassOrders(world, state, squad); break;
        case 'main': this.executeMainOrders(world, state, squad); break;
      }
    }
  }

  private executeDefenseOrders(world: World, state: AIWorldState, squad: Squad): void {
    if (state.enemiesNearBase.length > 0) {
      const avgX = state.enemiesNearBase.reduce((s, e) => s + e.x, 0) / state.enemiesNearBase.length;
      const avgZ = state.enemiesNearBase.reduce((s, e) => s + e.z, 0) / state.enemiesNearBase.length;
      squad.state = 'engaged';
      this.sendSquadTo(world, squad, avgX, avgZ);
    } else {
      squad.state = 'idle';
      for (const unitId of squad.unitIds) {
        if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
        if (world.hasComponent(unitId, MOVE_COMMAND)) continue;
        const pos = world.getComponent<PositionComponent>(unitId, POSITION);
        if (!pos) continue;
        const dx = pos.x - this.rallyX;
        const dz = pos.z - this.rallyZ;
        if (dx * dx + dz * dz > DEFENSE_RADIUS * DEFENSE_RADIUS) {
          this.issueMove(world, unitId, this.rallyX, this.rallyZ);
        }
      }
    }
  }

  private executeHarassOrders(world: World, state: AIWorldState, squad: Squad): void {
    // Find or update target
    if (squad.targetX < 0 || squad.state === 'idle') {
      const target = this.findHarassTarget(state);
      if (target) {
        squad.targetX = target.x;
        squad.targetZ = target.z;
        squad.state = 'moving';
        const centroid = this.getSquadCentroid(world, squad);
        squad.waypoints = this.findInfluenceAwarePath(centroid.x, centroid.z, target.x, target.z);
        squad.waypointIdx = 0;
      } else {
        // No target — idle near base
        for (const unitId of squad.unitIds) {
          if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
          if (world.hasComponent(unitId, MOVE_COMMAND)) continue;
          this.issueMove(world, unitId, this.rallyX, this.rallyZ);
        }
        return;
      }
    }

    // Advance through waypoints
    if (squad.waypoints.length > 0 && squad.waypointIdx < squad.waypoints.length) {
      const centroid = this.getSquadCentroid(world, squad);
      const wp = squad.waypoints[squad.waypointIdx];
      const dx = centroid.x - wp.x;
      const dz = centroid.z - wp.z;
      if (dx * dx + dz * dz < 100) {
        squad.waypointIdx++;
      }
      if (squad.waypointIdx < squad.waypoints.length) {
        this.sendSquadTo(world, squad, squad.waypoints[squad.waypointIdx].x, squad.waypoints[squad.waypointIdx].z);
      } else {
        squad.state = 'engaged';
        this.sendSquadTo(world, squad, squad.targetX, squad.targetZ);
      }
    } else {
      this.sendSquadTo(world, squad, squad.targetX, squad.targetZ);
    }

    // After reaching target, reset to find new one
    if (squad.state === 'engaged') {
      const centroid = this.getSquadCentroid(world, squad);
      const dx = centroid.x - squad.targetX;
      const dz = centroid.z - squad.targetZ;
      if (dx * dx + dz * dz < 100) {
        squad.state = 'idle';
        squad.targetX = -1;
        squad.targetZ = -1;
      }
    }
  }

  private findHarassTarget(state: AIWorldState): { x: number; z: number } | null {
    // Combine visible + remembered buildings
    const allTargets: { x: number; z: number; type: BuildingType }[] = [];
    for (const b of state.knownEnemyBuildings) {
      allTargets.push({ x: b.x, z: b.z, type: b.type });
    }
    for (const entry of state.rememberedEnemyBuildings) {
      if (entry.buildingType) {
        allTargets.push({ x: entry.x, z: entry.z, type: entry.buildingType });
      }
    }
    if (allTargets.length === 0) return null;

    let bestTarget: { x: number; z: number } | null = null;
    let bestScore = -Infinity;

    for (const t of allTargets) {
      if (t.type !== BuildingType.EnergyExtractor && t.type !== BuildingType.MatterPlant) continue;
      const value = this.getInfluenceValue(t.x, t.z);
      const threat = this.getInfluenceThreat(t.x, t.z);
      const score = value - threat * 2;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = { x: t.x, z: t.z };
      }
    }

    return bestTarget;
  }

  private getSquadCentroid(world: World, squad: Squad): { x: number; z: number } {
    let sx = 0, sz = 0, count = 0;
    for (const id of squad.unitIds) {
      const pos = world.getComponent<PositionComponent>(id, POSITION);
      if (!pos) continue;
      sx += pos.x;
      sz += pos.z;
      count++;
    }
    if (count === 0) return { x: this.baseX, z: this.baseZ };
    return { x: sx / count, z: sz / count };
  }

  private executeMainOrders(world: World, state: AIWorldState, squad: Squad): void {
    if (this.reattackTimer > 0) this.reattackTimer--;

    // If defense squad exists, main army does NOT abort for base defense
    const defenseSquad = this.squads.find(s => s.type === 'defense');
    if (!defenseSquad && state.enemiesNearBase.length > 0) {
      this.attackPhase = 'idle';
      const avgX = state.enemiesNearBase.reduce((s, e) => s + e.x, 0) / state.enemiesNearBase.length;
      const avgZ = state.enemiesNearBase.reduce((s, e) => s + e.z, 0) / state.enemiesNearBase.length;
      this.sendSquadTo(world, squad, avgX, avgZ);
      return;
    }

    // Trickle fix: abort attack if army decimated
    const armySize = squad.unitIds.length;
    if (this.attackPhase !== 'idle' && armySize < 5) {
      this.attackPhase = 'idle';
      this.reattackTimer = REATTACK_COOLDOWN_TICKS;
    }

    // Staging phase
    if (this.attackPhase === 'staging' && armySize > 0) {
      this.stagingTimer++;
      let nearStaging = 0;
      let totalActive = 0;

      for (const unitId of squad.unitIds) {
        if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
        totalActive++;
        const pos = world.getComponent<PositionComponent>(unitId, POSITION);
        if (!pos) continue;
        const dx = pos.x - this.stagingX;
        const dz = pos.z - this.stagingZ;
        if (dx * dx + dz * dz < STAGING_RADIUS * STAGING_RADIUS) nearStaging++;
      }

      const readyFraction = totalActive > 0 ? nearStaging / totalActive : 0;
      if (readyFraction >= STAGING_READY_FRACTION || this.stagingTimer >= 60) {
        this.attackPhase = 'attacking';
        // Compute influence-aware path to target
        const centroid = this.getSquadCentroid(world, squad);
        squad.waypoints = this.findInfluenceAwarePath(centroid.x, centroid.z, this.attackTargetX, this.attackTargetZ);
        squad.waypointIdx = 0;
        this.retreatWounded(world, squad);
        return;
      }

      this.sendSquadTo(world, squad, this.stagingX, this.stagingZ);
      return;
    }

    // Continue attack
    if (this.attackPhase === 'attacking' && armySize > 0) {
      // Re-evaluate target from visible or remembered enemies
      const hasVisibleTargets = state.knownEnemyBuildings.length > 0 || state.knownEnemyUnits.length > 0;
      if (hasVisibleTargets) {
        const target = this.pickAttackTarget(state);
        if (target) {
          this.attackTargetX = target.x;
          this.attackTargetZ = target.z;
        }
      }

      // Advance through influence-aware waypoints
      if (squad.waypoints.length > 0 && squad.waypointIdx < squad.waypoints.length) {
        const centroid = this.getSquadCentroid(world, squad);
        const wp = squad.waypoints[squad.waypointIdx];
        const dx = centroid.x - wp.x;
        const dz = centroid.z - wp.z;
        if (dx * dx + dz * dz < 225) {
          squad.waypointIdx++;
        }
        if (squad.waypointIdx < squad.waypoints.length) {
          this.sendSquadTo(world, squad, squad.waypoints[squad.waypointIdx].x, squad.waypoints[squad.waypointIdx].z);
        } else {
          this.sendSquadTo(world, squad, this.attackTargetX, this.attackTargetZ);
        }
      } else {
        this.sendSquadTo(world, squad, this.attackTargetX, this.attackTargetZ);
      }

      this.retreatWounded(world, squad);
      return;
    }

    // Launch attack
    const effectiveThreshold = this.reattackTimer === 0 ? REATTACK_THRESHOLD : ATTACK_THRESHOLD;
    const forceAttack = this.forceAttackTimer >= FORCE_ATTACK_TICKS && armySize > 0;

    if (armySize >= effectiveThreshold || forceAttack) {
      const target = this.pickAttackTarget(state);
      const fallback = this.team === 0 ? 192 : 64;
      const targetX = target ? target.x : fallback;
      const targetZ = target ? target.z : fallback;

      this.attackTargetX = targetX;
      this.attackTargetZ = targetZ;
      this.reattackTimer = -1;
      this.forceAttackTimer = 0;

      // Staging point: 70% of the way from centroid to target
      const centroid = this.getSquadCentroid(world, squad);
      const dx = targetX - centroid.x;
      const dz = targetZ - centroid.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const angle = Math.atan2(dz, dx);
      const stagingDist = dist * 0.7;

      let proposedX = centroid.x + Math.cos(angle) * stagingDist;
      let proposedZ = centroid.z + Math.sin(angle) * stagingDist;
      proposedX = Math.max(20, Math.min(236, proposedX));
      proposedZ = Math.max(20, Math.min(236, proposedZ));

      if (!this.terrainData.isPassable(Math.round(proposedX), Math.round(proposedZ))) {
        proposedX -= Math.cos(angle) * 15;
        proposedZ -= Math.sin(angle) * 15;
      }

      this.stagingX = proposedX;
      this.stagingZ = proposedZ;
      this.stagingTimer = 0;
      this.attackPhase = 'staging';

      this.sendSquadTo(world, squad, this.stagingX, this.stagingZ);
      return;
    }

    // Rally idle units near base
    for (const unitId of squad.unitIds) {
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

  private sendSquadTo(world: World, squad: Squad, x: number, z: number): void {
    for (const unitId of squad.unitIds) {
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

  // --- Army Control (Phase C: Squad-based) ---

  private executeArmyControl(world: World, state: AIWorldState): void {
    this.updateSquads(world, state);
    this.executeSquadOrders(world, state);
  }

  // --- Build Order (Phase D: Dynamic Economy) ---

  private executeBuildOrder(world: World, state: AIWorldState, phase: AIPhase): void {
    const idleWorkers = state.myWorkers.filter(
      e => !world.hasComponent(e, BUILD_COMMAND) && !world.hasComponent(e, SUPPLY_ROUTE)
    );
    if (idleWorkers.length === 0) return;

    // Phase D: Use opener for first ~180 ticks, then switch to dynamic scaling
    if (this.totalTicks < 180) {
      this.executeOpenerBuildOrder(world, state, idleWorkers);
      return;
    }

    const extractors = this.getBuildingCount(state, BuildingType.EnergyExtractor) + (state.myConstructions.get(BuildingType.EnergyExtractor) ?? 0);
    const plants = this.getBuildingCount(state, BuildingType.MatterPlant) + (state.myConstructions.get(BuildingType.MatterPlant) ?? 0);
    const factories = this.getBuildingCount(state, BuildingType.DroneFactory) + (state.myConstructions.get(BuildingType.DroneFactory) ?? 0);
    const depots = this.getBuildingCount(state, BuildingType.SupplyDepot) + (state.myConstructions.get(BuildingType.SupplyDepot) ?? 0);

    const energyIncome = extractors * 5;
    const energyDrain = plants * 2;
    const netEnergy = energyIncome - energyDrain;
    const targetMatterIncome = Math.max(2, factories * 1.5);
    const currentMatterIncome = plants * 2;

    let targetType: BuildingType | null = null;

    // PRIORITY 1: Prevent Energy Stall
    if (netEnergy <= 2) {
      targetType = BuildingType.EnergyExtractor;
    }
    // PRIORITY 2: Scale Matter if factories are starving
    else if (currentMatterIncome < targetMatterIncome && netEnergy >= 2) {
      targetType = BuildingType.MatterPlant;
    }
    // PRIORITY 3: More production (dynamic cap)
    else if (state.totalMatter > MATTER_FLOAT_THRESHOLD && factories < 8) {
      targetType = BuildingType.DroneFactory;
    }
    // PRIORITY 4: Logistics scaling
    else if (depots < 1 + Math.floor(factories / 2)) {
      targetType = BuildingType.SupplyDepot;
    }
    // PRIORITY 5: Energy infrastructure to support more plants
    else if (extractors < Math.ceil((plants * 2 + factories) / 5) + 2) {
      targetType = BuildingType.EnergyExtractor;
    }
    // PRIORITY 6: Matter scaling if rate insufficient
    else if (currentMatterIncome < factories * 1.5 && netEnergy >= 2) {
      targetType = BuildingType.MatterPlant;
    }
    // PRIORITY 7: Late-game overflow — more factories if floating matter
    else if (state.totalMatter > MATTER_FLOAT_THRESHOLD * 1.5 && factories < 8 && (phase === 'midgame' || phase === 'lategame')) {
      targetType = BuildingType.DroneFactory;
    }

    if (!targetType) return;

    const def = BUILDING_DEFS[targetType];
    if (!def) return;
    if (!this.resources.canAfford(this.team, def.energyCost)) return;
    if (!this.resources.canAffordMatter(this.team, def.matterCost)) return;

    const location = this.findBuildLocation(world, targetType);
    if (!location) return;

    const worker = idleWorkers[0];
    this.resources.spend(this.team, def.energyCost);
    if (def.matterCost > 0) {
      this.resources.spendMatter(this.team, def.matterCost);
    }

    this.createConstructionSite(world, targetType, location.x, location.z, worker);
  }

  private executeOpenerBuildOrder(world: World, state: AIWorldState, idleWorkers: number[]): void {
    for (const order of EARLY_BUILD_ORDER) {
      const currentCount = this.getBuildingCount(state, order.type) + (state.myConstructions.get(order.type) ?? 0);
      if (currentCount >= order.maxCount) continue;

      const def = BUILDING_DEFS[order.type];
      if (!def) continue;
      if (!this.resources.canAfford(this.team, def.energyCost)) return;
      if (!this.resources.canAffordMatter(this.team, def.matterCost)) return;

      const location = this.findBuildLocation(world, order.type);
      if (!location) continue;

      const worker = idleWorkers[0];
      this.resources.spend(this.team, def.energyCost);
      if (def.matterCost > 0) {
        this.resources.spendMatter(this.team, def.matterCost);
      }

      this.createConstructionSite(world, order.type, location.x, location.z, worker);
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

    return this.findLocationNear(this.baseX, this.baseZ);
  }

  private findDepotLocation(world: World): { x: number; z: number } | null {
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

    if (depotIndex === 0) {
      return this.findLocationNear(this.baseX, this.baseZ);
    }

    const enemy = this.estimateEnemyPosition(world);
    const midX = (this.baseX + enemy.x) / 2;
    const midZ = (this.baseZ + enemy.z) / 2;

    let targetX = midX;
    let targetZ = midZ;

    if (depotIndex >= 2) {
      const axisX = enemy.x - this.baseX;
      const axisZ = enemy.z - this.baseZ;
      const len = Math.sqrt(axisX * axisX + axisZ * axisZ) || 1;
      const perpX = -axisZ / len;
      const perpZ = axisX / len;
      const side = (depotIndex % 2 === 0) ? 1 : -1;
      const spread = 10 * Math.ceil((depotIndex - 1) / 2);
      targetX = midX + perpX * spread * side;
      targetZ = midZ + perpZ * spread * side;
    }

    return this.findLocationNear(targetX, targetZ);
  }

  // Phase A: estimateEnemyPosition now uses memory as fallback
  private estimateEnemyPosition(world: World): { x: number; z: number } {
    // Use known visible enemy buildings first
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

    // Phase A: Fall back to remembered building positions
    const remembered: { x: number; z: number }[] = [];
    for (const [, entry] of this.enemyMemory) {
      if (entry.type === 'building') {
        remembered.push({ x: entry.x, z: entry.z });
      }
    }
    if (remembered.length > 0) {
      const avgX = remembered.reduce((s, b) => s + b.x, 0) / remembered.length;
      const avgZ = remembered.reduce((s, b) => s + b.z, 0) / remembered.length;
      return { x: avgX, z: avgZ };
    }

    // Fallback: assumed enemy base location (opposite corner)
    return this.team === 0 ? { x: 192, z: 192 } : { x: 64, z: 64 };
  }

  private findLocationNear(centerX: number, centerZ: number): { x: number; z: number } | null {
    const radii = [0, 4, 8, 12, 16, 20];
    const directions = [
      { dx: 0, dz: 0 },
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
    const claimedNodes = new Set<string>();

    const buildings = world.query(BUILDING, POSITION);
    for (const e of buildings) {
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType === BuildingType.EnergyExtractor) {
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

    let bestNode: EnergyNode | null = null;
    let bestDistSq = Infinity;

    for (const node of this.energyNodes) {
      if (claimedNodes.has(`${node.x},${node.z}`)) continue;
      if (!this.fogState.isExplored(this.team, node.x, node.z)) continue;

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

    // Voxel state for construction site
    const siteVoxelModel = VOXEL_MODELS['construction_site'];
    if (siteVoxelModel) {
      world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
        modelId: 'construction_site',
        totalVoxels: siteVoxelModel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(siteVoxelModel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
      });
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
      siteEntity: site,
    });
  }

  // --- Production (Phase D: Dynamic worker scaling) ---

  private executeProduction(world: World, state: AIWorldState, _phase: AIPhase): void {
    // Phase D: Dynamic worker target
    const targetWorkers = Math.min(8, WORKER_SCALING_BASE + state.depotCount);

    // Don't over-train workers during opener — save energy for buildings
    const currentEnergy = this.resources.get(this.team).energy;
    const isEstablishingEconomy = this.totalTicks < 180 && currentEnergy < 100;

    if (state.myWorkers.length < targetWorkers && !isEstablishingEconomy) {
      this.trainFromHQ(world, UnitCategory.WorkerDrone);
    }

    const threatsNearBase = state.enemiesNearBase.length > 0;

    const factories = state.myBuildings.get(BuildingType.DroneFactory) ?? [];
    for (const factory of factories) {
      const pq = world.getComponent<ProductionQueueComponent>(factory, PRODUCTION_QUEUE);
      if (!pq) continue;
      if (pq.queue.length >= MAX_QUEUE_DEPTH) continue;

      let unitType: UnitCategory;

      if (state.myAerial.length === 0 && this.totalTicks > 180) {
        unitType = UnitCategory.AerialDrone;
      } else if (state.myAerial.length < 2 && this.totalTicks > 180) {
        unitType = UnitCategory.AerialDrone;
      } else if (threatsNearBase) {
        unitType = UnitCategory.CombatDrone;
      } else if (this.unitsProduced % 4 === 3) {
        unitType = UnitCategory.AssaultPlatform;
      } else {
        unitType = UnitCategory.CombatDrone;
      }

      const def = UNIT_DEFS[unitType];
      if (!def) continue;
      if (!this.resources.canAfford(this.team, def.energyCost)) continue;
      if (!this.resources.canAffordMatter(this.team, def.matterCost)) continue;

      this.resources.spend(this.team, def.energyCost);
      if (def.matterCost > 0) {
        this.resources.spendMatter(this.team, def.matterCost);
      }

      pq.queue.push({
        unitType,
        timeRemaining: def.trainTime,
        totalTime: def.trainTime,
      });

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
    if (!this.resources.canAfford(this.team, def.energyCost)) return;

    const hq = this.findHQ(world);
    if (hq === null) return;

    const pq = world.getComponent<ProductionQueueComponent>(hq, PRODUCTION_QUEUE);
    if (!pq) return;
    if (pq.queue.length >= MAX_QUEUE_DEPTH) return;
    if (!this.resources.canAffordMatter(this.team, def.matterCost)) return;

    this.resources.spend(this.team, def.energyCost);
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
    if (hq === null) return;

    const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;

    const depots = state.myBuildings.get(BuildingType.SupplyDepot) ?? [];
    const completedDepots = depots.filter(d =>
      !world.hasComponent(d, CONSTRUCTION) && world.hasComponent(d, MATTER_STORAGE)
    );

    // Rally idle workers near HQ even before any depots exist
    if (completedDepots.length === 0) {
      const allIdle = state.myWorkers.filter(e =>
        !world.hasComponent(e, BUILD_COMMAND) && !world.hasComponent(e, SUPPLY_ROUTE)
      );
      for (const worker of allIdle) {
        if (world.hasComponent(worker, MOVE_COMMAND)) continue;
        const pos = world.getComponent<PositionComponent>(worker, POSITION);
        if (pos && Math.abs(pos.x - hqPos.x) < 5 && Math.abs(pos.z - hqPos.z) < 5) {
          this.issueMove(world, worker, this.rallyX, this.rallyZ);
        }
      }
      return;
    }

    const ferryCountByDepot = new Map<number, number>();
    for (const w of state.myWorkers) {
      if (!world.hasComponent(w, SUPPLY_ROUTE)) continue;
      const route = world.getComponent<SupplyRouteComponent>(w, SUPPLY_ROUTE)!;
      const count = ferryCountByDepot.get(route.destEntity) ?? 0;
      ferryCountByDepot.set(route.destEntity, count + 1);
    }

    const idleWorkers = state.myWorkers.filter(e =>
      !world.hasComponent(e, BUILD_COMMAND) && !world.hasComponent(e, SUPPLY_ROUTE)
    );

    const maxFerryAssignments = Math.max(0, idleWorkers.length - 1);
    let assigned = 0;

    for (const depot of completedDepots) {
      if (assigned >= maxFerryAssignments) break;

      const depotPos = world.getComponent<PositionComponent>(depot, POSITION)!;
      const dx = depotPos.x - hqPos.x;
      const dz = depotPos.z - hqPos.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

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

    // Rally idle workers away from HQ spawn so they don't clump
    for (let i = assigned; i < idleWorkers.length; i++) {
      const worker = idleWorkers[i];
      if (world.hasComponent(worker, MOVE_COMMAND)) continue;
      const pos = world.getComponent<PositionComponent>(worker, POSITION);
      if (pos && Math.abs(pos.x - hqPos.x) < 5 && Math.abs(pos.z - hqPos.z) < 5) {
        this.issueMove(world, worker, this.rallyX, this.rallyZ);
      }
    }
  }

  // --- Attack Targeting (Phase A: Memory-augmented) ---

  private pickAttackTarget(state: AIWorldState): { x: number; z: number } | null {
    let bestTarget: { x: number; z: number } | null = null;
    let bestDistSq = Infinity;

    if (state.totalArmySize >= OVERWHELMING_ARMY) {
      for (const bldg of state.knownEnemyBuildings) {
        if (bldg.type === BuildingType.HQ) return { x: bldg.x, z: bldg.z };
      }
    }

    // 1. TOP PRIORITY: Hunt Forward Supply Depots
    for (const bldg of state.knownEnemyBuildings) {
      if (bldg.type === BuildingType.SupplyDepot) {
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

    // 2. HIGH PRIORITY: Disrupt Worker Ferries
    for (const unit of state.knownEnemyUnits) {
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

    // Phase A: Fall back to remembered buildings scored by typeScore * freshness
    if (state.rememberedEnemyBuildings.length > 0) {
      let bestMemTarget: { x: number; z: number } | null = null;
      let bestMemScore = -Infinity;

      const typeScore = (bt: BuildingType | null): number => {
        switch (bt) {
          case BuildingType.HQ: return 5;
          case BuildingType.SupplyDepot: return 4;
          case BuildingType.DroneFactory: return 3;
          case BuildingType.MatterPlant: return 2;
          case BuildingType.EnergyExtractor: return 1;
          default: return 0;
        }
      };

      for (const entry of state.rememberedEnemyBuildings) {
        const freshness = Math.max(0, 1 - (this.totalTicks - entry.lastSeenTick) / MEMORY_DECAY_TICKS);
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

  private retreatWounded(world: World, squad: Squad): void {
    const depotEntities: number[] = [];

    // Gather depot entities from buildings
    const buildings = world.query(BUILDING, TEAM, POSITION, HEALTH, MATTER_STORAGE);
    for (const e of buildings) {
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType === BuildingType.SupplyDepot) {
        depotEntities.push(e);
      }
    }

    for (const unitId of squad.unitIds) {
      if (world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
      const health = world.getComponent<HealthComponent>(unitId, HEALTH);
      if (!health) continue;
      if (health.current / health.max < RETREAT_HP_FRACTION) {
        if (depotEntities.length > 0) {
          const pos = world.getComponent<PositionComponent>(unitId, POSITION);
          if (!pos) continue;
          let bestDepot = depotEntities[0];
          let bestDistSq = Infinity;
          for (const depot of depotEntities) {
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
        this.issueMove(world, unitId, this.baseX, this.baseZ);
      }
    }
  }

  // --- Scouting ---

  private executeScouting(world: World, state: AIWorldState): void {
    const scouts = state.myAerial.slice(0, 2);

    // Phase A: findIsolatedTarget now uses visible + remembered
    const raidTarget = this.findIsolatedTarget(state);

    for (let i = 0; i < scouts.length; i++) {
      const scout = scouts[i];
      if (world.hasComponent(scout, MOVE_COMMAND)) continue;

      if (raidTarget) {
        this.issueMove(world, scout, raidTarget.x, raidTarget.z);
      } else {
        const waypointIndex = i === 0 ? this.scoutWaypointIndex : this.scoutWaypointIndex2;
        const target = this.getNextScoutTarget(world, waypointIndex);
        this.issueMove(world, scout, target.x, target.z);

        if (i === 0) {
          this.scoutWaypointIndex = (this.scoutWaypointIndex + 1) % SCOUT_WAYPOINTS.length;
        } else {
          this.scoutWaypointIndex2 = (this.scoutWaypointIndex2 + 1) % SCOUT_WAYPOINTS.length;
        }
      }
    }
  }

  // Phase A: findIsolatedTarget uses visible + remembered buildings
  private findIsolatedTarget(state: AIWorldState): { x: number; z: number } | null {
    // Combine visible + remembered enemy buildings
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
        const distSq = (b.x - cx) ** 2 + (b.z - cz) ** 2;
        if (distSq > 900 && distSq > maxDistSq) {
          maxDistSq = distSq;
          bestTarget = { x: b.x, z: b.z };
        }
      }
    }
    return bestTarget;
  }

  private getNextScoutTarget(_world: World, waypointIndex: number): { x: number; z: number } {
    for (let i = 0; i < SCOUT_WAYPOINTS.length; i++) {
      const idx = (waypointIndex + i) % SCOUT_WAYPOINTS.length;
      const wp = SCOUT_WAYPOINTS[idx];
      if (!this.fogState.isExplored(this.team, wp.x, wp.z)) {
        return wp;
      }
    }

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
  knownEnemyUnits: { entity: number; x: number; z: number; category: UnitCategory }[];
  depotCount: number;
  depotEntities: number[];
  totalMatter: number;
  totalArmySize: number;
  // Phase A
  rememberedEnemyBuildings: EnemyMemoryEntry[];
  rememberedEnemyUnits: EnemyMemoryEntry[];
}
