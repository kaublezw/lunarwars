import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { EnergyNode } from '@sim/terrain/MapFeatures';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { BuildingType } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';

// --- Constants ---

export const TEAM_COLORS = [0x4488ff, 0xff4444];
export const TICK_INTERVAL = 30;
export const BASE_DEFENSE_RADIUS = 30;
export const RALLY_OFFSET = 15;
export const ATTACK_THRESHOLD = 10;
export const RETREAT_HP_FRACTION = 0.3;
export const MAX_QUEUE_DEPTH = 3;
export const FORCE_ATTACK_TICKS = 900;
export const REATTACK_COOLDOWN_TICKS = 120;
export const OVERWHELMING_ARMY = 12;
export const REATTACK_THRESHOLD = 6;
export const STAGING_RADIUS = 15;
export const STAGING_READY_FRACTION = 0.75;

// Enemy Memory
export const MEMORY_DECAY_TICKS = 600;
export const MEMORY_MAX_ENTRIES = 200;

// Influence Map
export const INFLUENCE_GRID = 16;
export const INFLUENCE_CELL = 16;
export const THREAT_WEIGHT = 8.0;
export const THREAT_DECAY_PER_TICK = 0.05;

// Squad System
export const HARASS_SQUAD_SIZE = 3;
export const DEFENSE_SQUAD_SIZE = 4;
export const MIN_MAIN_ARMY_FOR_HARASS = 8;
export const DEFENSE_RADIUS = 35;
export const EXTRACTOR_DEFENSE_RADIUS = 20;

// Dynamic Economy
export const WORKER_SCALING_BASE = 3;

// Scout waypoints: 5x5 grid covering the 256x256 map at 48-unit spacing
export const SCOUT_WAYPOINTS: { x: number; z: number }[] = [];
for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 5; col++) {
    SCOUT_WAYPOINTS.push({ x: 32 + col * 48, z: 32 + row * 48 });
  }
}

// --- Types ---

export type AIPhase = 'early' | 'buildup' | 'midgame' | 'lategame';

export type SquadMission = 'idle' | 'attack' | 'defend' | 'harass' | 'rally';

// --- Interfaces ---

export interface EnemyMemoryEntry {
  entityId: number;
  x: number;
  z: number;
  type: 'unit' | 'building';
  unitCategory: UnitCategory | null;
  buildingType: BuildingType | null;
  lastSeenTick: number;
  isAlive: boolean;
}

export interface Squad {
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

export interface AttackState {
  attackTargetX: number;
  attackTargetZ: number;
  attackPhase: 'idle' | 'staging' | 'attacking';
  stagingX: number;
  stagingZ: number;
  stagingTimer: number;
  reattackTimer: number;
  forceAttackTimer: number;
}

export interface AIWorldState {
  myWorkers: number[];
  myCombat: number[];
  myAerial: number[];
  myBuildings: Map<BuildingType, number[]>;
  myConstructions: Map<string, number>;
  enemiesNearBase: { entity: number; x: number; z: number }[];
  enemiesNearExtractors: { entity: number; x: number; z: number; extractorX: number; extractorZ: number }[];
  knownEnemyBuildings: { entity: number; x: number; z: number; type: BuildingType }[];
  knownEnemyUnits: { entity: number; x: number; z: number; category: UnitCategory }[];
  depotCount: number;
  depotEntities: number[];
  totalMatter: number;
  totalArmySize: number;
  rememberedEnemyBuildings: EnemyMemoryEntry[];
  rememberedEnemyUnits: EnemyMemoryEntry[];
}

export interface AIContext {
  world: World;
  team: number;
  resources: ResourceState;
  terrain: TerrainData;
  fog: FogOfWarState;
  energyNodes: EnergyNode[];
  occupancy: BuildingOccupancy;
  baseX: number;
  baseZ: number;
  rallyX: number;
  rallyZ: number;
  totalTicks: number;
}
