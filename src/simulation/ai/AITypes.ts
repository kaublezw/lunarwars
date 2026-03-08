import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { BuildingType } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';

// --- Constants ---

export const TEAM_COLORS = [0x4488ff, 0xff4444];
export const TICK_INTERVAL = 10;
export const BASE_DEFENSE_RADIUS = 30;
export const RALLY_OFFSET = 15;
export const ATTACK_THRESHOLD = 5;
export const RETREAT_HP_FRACTION = 0.3;
export const MAX_QUEUE_DEPTH = 3;
export const FORCE_ATTACK_TICKS = 600;
export const REATTACK_COOLDOWN_TICKS = 120;
export const OVERWHELMING_ARMY = 8;
export const REATTACK_THRESHOLD = 3;
export const STAGING_RADIUS = 15;
export const STAGING_READY_FRACTION = 0.6;
export const STAGING_TIMEOUT_TICKS = 60;

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

// Wall Building
export const WALL_SEGMENT_COST = 12;
export const MAX_AI_WALLS = 24;
export const WALL_NEARBY_RADIUS_SQ = 64; // 8wu squared

// Dynamic Economy
export const WORKER_SCALING_BASE = 3;

// Generate spiral scout waypoints expanding outward from a team's base position.
// Spacing 24wu ensures full coverage with aerial vision radius ~16wu.
export function generateSpiralWaypoints(baseX: number, baseZ: number): { x: number; z: number }[] {
  const SPACING = 24;
  const MIN = 10;
  const MAX = 246;
  const result: { x: number; z: number }[] = [];
  const seen = new Set<string>();

  // Start at base
  const clampedBase = {
    x: Math.max(MIN, Math.min(MAX, Math.round(baseX))),
    z: Math.max(MIN, Math.min(MAX, Math.round(baseZ))),
  };
  const key0 = `${clampedBase.x},${clampedBase.z}`;
  seen.add(key0);
  result.push(clampedBase);

  // Walk concentric square rings outward
  // Ring r has side length 2r, perimeter = 8r points
  // Direction order: right, down, left, up (clockwise spiral)
  const maxRing = Math.ceil(256 / SPACING);
  for (let r = 1; r <= maxRing; r++) {
    // Top-left corner of this ring relative to base (in grid units)
    let gx = -r;
    let gz = -r;
    // Walk 4 sides: top (right), right (down), bottom (left), left (up)
    const moves: [number, number, number][] = [
      [1, 0, 2 * r],   // top edge: move right
      [0, 1, 2 * r],   // right edge: move down
      [-1, 0, 2 * r],  // bottom edge: move left
      [0, -1, 2 * r],  // left edge: move up
    ];
    for (const [dx, dz, steps] of moves) {
      for (let s = 0; s < steps; s++) {
        const wx = Math.round(baseX + gx * SPACING);
        const wz = Math.round(baseZ + gz * SPACING);
        const cx = Math.max(MIN, Math.min(MAX, wx));
        const cz = Math.max(MIN, Math.min(MAX, wz));
        const key = `${cx},${cz}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ x: cx, z: cz });
        }
        gx += dx;
        gz += dz;
      }
    }
  }
  return result;
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

export interface WallSegmentPlan {
  x: number;
  z: number;
  meshType: 'wall_x' | 'wall_z' | 'wall_corner';
}

export interface AIContext {
  world: World;
  team: number;
  resources: ResourceState;
  terrain: TerrainData;
  fog: FogOfWarState;
  energyNodes: EnergyNode[];
  oreDeposits: OreDeposit[];
  occupancy: BuildingOccupancy;
  baseX: number;
  baseZ: number;
  rallyX: number;
  rallyZ: number;
  hqEntity: number;
  totalTicks: number;
}

export interface IntelligenceReport {
  state: AIWorldState;
  phase: AIPhase;
  influenceGrid: Float32Array;
  enemyMemory: Map<number, EnemyMemoryEntry>;
}

export interface AISerializedState {
  totalTicks?: number;
  intel: Record<string, unknown>;
  economy: Record<string, unknown>;
  military: Record<string, unknown>;
}
