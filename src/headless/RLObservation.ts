import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import {
  POSITION, TEAM, UNIT_TYPE, HEALTH, BUILDING, TURRET, CONSTRUCTION,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import type { TurretComponent } from '@sim/components/Turret';
import type { ConstructionComponent } from '@sim/components/Construction';
import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import type { ObservationData } from './RLTypes';

export const MAX_UNITS = 100;
export const MAX_BUILDINGS = 100;
export const UNIT_FEATURES = 9;
export const BUILDING_FEATURES = 8;

const BUILDING_MIN_SPACING_SQ = 25; // 5 world units squared

const UNIT_CATEGORY_INDEX: Record<string, number> = {
  [UnitCategory.WorkerDrone]: 0,
  [UnitCategory.CombatDrone]: 1,
  [UnitCategory.AssaultPlatform]: 2,
  [UnitCategory.AerialDrone]: 3,
  [UnitCategory.FerryDrone]: 4,
};

const BUILDING_TYPE_INDEX: Record<string, number> = {
  [BuildingType.HQ]: 0,
  [BuildingType.EnergyExtractor]: 1,
  [BuildingType.MatterPlant]: 2,
  [BuildingType.SupplyDepot]: 3,
  [BuildingType.DroneFactory]: 4,
  [BuildingType.Wall]: 5,
};

let cachedMapGrid: number[] | null = null;
let cachedGridSize = 0;

export function clearMapGridCache(): void {
  cachedMapGrid = null;
}

function buildMapGrid(terrainData: TerrainData, gridSize: number): number[] {
  if (cachedMapGrid && cachedGridSize === gridSize) return cachedMapGrid;

  const cellSize = 256 / gridSize;
  const grid: number[] = new Array(gridSize * gridSize);

  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      // Sample center of each cell
      const wx = (gx + 0.5) * cellSize;
      const wz = (gz + 0.5) * cellSize;
      grid[gz * gridSize + gx] = terrainData.isPassable(wx, wz) ? 0 : 1;
    }
  }

  cachedMapGrid = grid;
  cachedGridSize = gridSize;
  return grid;
}

function buildEnergyGrid(energyNodes: EnergyNode[], gridSize: number, fogState: FogOfWarState, team: number): number[] {
  const cellSize = 256 / gridSize;
  const grid: number[] = new Array(gridSize * gridSize).fill(0);

  for (const node of energyNodes) {
    if (!fogState.isExplored(team, node.x, node.z)) continue;
    const gx = Math.floor(node.x / cellSize);
    const gz = Math.floor(node.z / cellSize);
    if (gx >= 0 && gx < gridSize && gz >= 0 && gz < gridSize) {
      grid[gz * gridSize + gx] = 1;
    }
  }

  return grid;
}

function buildOreGrid(oreDeposits: OreDeposit[], gridSize: number, fogState: FogOfWarState, team: number): number[] {
  const cellSize = 256 / gridSize;
  const grid: number[] = new Array(gridSize * gridSize).fill(0);

  for (const deposit of oreDeposits) {
    if (!fogState.isExplored(team, deposit.x, deposit.z)) continue;
    const gx = Math.floor(deposit.x / cellSize);
    const gz = Math.floor(deposit.z / cellSize);
    if (gx >= 0 && gx < gridSize && gz >= 0 && gz < gridSize) {
      grid[gz * gridSize + gx] = 1;
    }
  }

  return grid;
}

function buildActionMask(
  world: World,
  energyNodes: EnergyNode[],
  oreDeposits: OreDeposit[],
  gridSize: number,
  fogState: FogOfWarState,
  team: number,
): number[] {
  const cellSize = 256 / gridSize;
  const mask = new Array(gridSize * gridSize).fill(0);

  // Collect all building + construction site positions
  const buildingPositions: Array<{ x: number; z: number }> = [];
  const buildings = world.query(POSITION, BUILDING, HEALTH);
  for (const e of buildings) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    buildingPositions.push({ x: pos.x, z: pos.z });
  }
  // Also include construction sites
  const constructions = world.query(POSITION, CONSTRUCTION);
  for (const e of constructions) {
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    // Avoid duplicates (buildings with CONSTRUCTION also have BUILDING)
    if (world.getComponent(e, BUILDING)) continue;
    buildingPositions.push({ x: pos.x, z: pos.z });
  }

  const isUnclaimed = (nx: number, nz: number): boolean => {
    for (const bp of buildingPositions) {
      const dx = bp.x - nx;
      const dz = bp.z - nz;
      if (dx * dx + dz * dz < BUILDING_MIN_SPACING_SQ) return false;
    }
    return true;
  };

  // Mark unclaimed energy nodes (only if explored)
  for (const node of energyNodes) {
    if (!fogState.isExplored(team, node.x, node.z)) continue;
    if (!isUnclaimed(node.x, node.z)) continue;
    const gx = Math.floor(node.x / cellSize);
    const gz = Math.floor(node.z / cellSize);
    if (gx >= 0 && gx < gridSize && gz >= 0 && gz < gridSize) {
      mask[gz * gridSize + gx] = 1;
    }
  }

  // Mark unclaimed ore deposits (only if explored)
  for (const deposit of oreDeposits) {
    if (!fogState.isExplored(team, deposit.x, deposit.z)) continue;
    if (!isUnclaimed(deposit.x, deposit.z)) continue;
    const gx = Math.floor(deposit.x / cellSize);
    const gz = Math.floor(deposit.z / cellSize);
    if (gx >= 0 && gx < gridSize && gz >= 0 && gz < gridSize) {
      mask[gz * gridSize + gx] = 2;
    }
  }

  return mask;
}

function buildGameState(world: World, resourceState: ResourceState, team: number): number[] {
  const res = resourceState.get(team);
  const energy = res.energy;
  const matter = res.matter;

  // Building affordability
  const extDef = BUILDING_DEFS[BuildingType.EnergyExtractor];
  const plantDef = BUILDING_DEFS[BuildingType.MatterPlant];
  const depotDef = BUILDING_DEFS[BuildingType.SupplyDepot];
  const factoryDef = BUILDING_DEFS[BuildingType.DroneFactory];
  const wallDef = BUILDING_DEFS[BuildingType.Wall];

  // Unit affordability
  const workerDef = UNIT_DEFS[UnitCategory.WorkerDrone];
  const combatDef = UNIT_DEFS[UnitCategory.CombatDrone];
  const assaultDef = UNIT_DEFS[UnitCategory.AssaultPlatform];
  const aerialDef = UNIT_DEFS[UnitCategory.AerialDrone];
  const ferryDef = UNIT_DEFS[UnitCategory.FerryDrone];

  const canAfford = (eCost: number, mCost: number) =>
    (energy >= eCost && matter >= mCost) ? 1 : 0;

  // Check if team has workers
  let hasWorkers = 0;
  let hasProductionBuilding = 0;

  const units = world.query(TEAM, UNIT_TYPE, HEALTH);
  for (const e of units) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const ut = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
    if (ut.category === UnitCategory.WorkerDrone) { hasWorkers = 1; break; }
  }

  const buildings = world.query(TEAM, BUILDING, HEALTH);
  for (const e of buildings) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
    if (bldg.buildingType === BuildingType.DroneFactory ||
        bldg.buildingType === BuildingType.HQ ||
        bldg.buildingType === BuildingType.SupplyDepot) {
      hasProductionBuilding = 1;
      break;
    }
  }

  return [
    canAfford(extDef.energyCost, extDef.matterCost),
    canAfford(plantDef.energyCost, plantDef.matterCost),
    canAfford(depotDef.energyCost, depotDef.matterCost),
    canAfford(factoryDef.energyCost, factoryDef.matterCost),
    canAfford(wallDef.energyCost, wallDef.matterCost),
    canAfford(workerDef.energyCost, workerDef.matterCost),
    canAfford(combatDef.energyCost, combatDef.matterCost),
    canAfford(assaultDef.energyCost, assaultDef.matterCost),
    canAfford(aerialDef.energyCost, aerialDef.matterCost),
    canAfford(ferryDef.energyCost, ferryDef.matterCost),
    hasWorkers,
    hasProductionBuilding,
  ];
}

export function extractObservation(
  world: World,
  resourceState: ResourceState,
  fogState: FogOfWarState,
  terrainData: TerrainData,
  tick: number,
  team: number,
  gridSize: number,
  energyNodes: EnergyNode[],
  oreDeposits: OreDeposit[],
): ObservationData {
  // Resources
  const res = resourceState.get(team);
  const resources = [res.energy, res.matter, res.energyRate, res.matterRate];

  // Map grid (cached since terrain is static)
  const mapGrid = buildMapGrid(terrainData, gridSize);

  // Resource deposit grids (fog-filtered — only explored nodes visible)
  const energyGrid = buildEnergyGrid(energyNodes, gridSize, fogState, team);
  const oreGrid = buildOreGrid(oreDeposits, gridSize, fogState, team);

  // Units: collect own and enemy separately
  const ownUnits: number[][] = [];
  const enemyUnits: number[][] = [];

  const units = world.query(POSITION, TEAM, UNIT_TYPE, HEALTH);
  for (const e of units) {
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;

    if (health.dead) continue;

    // Fog filter: own units always visible, enemies only if in fog-of-war vision
    if (t.team !== team && !fogState.isVisible(team, pos.x, pos.z)) continue;

    const ut = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
    const categoryIdx = UNIT_CATEGORY_INDEX[ut.category] ?? 0;

    let ammo = -1;
    let maxAmmo = -1;
    const turret = world.getComponent<TurretComponent>(e, TURRET);
    if (turret) {
      ammo = turret.ammo;
      maxAmmo = turret.maxAmmo;
    }

    const data = [e, t.team, categoryIdx, pos.x, pos.z, health.current, health.max, ammo, maxAmmo];
    if (t.team === team) {
      ownUnits.push(data);
    } else {
      enemyUnits.push(data);
    }
  }

  // Fixed-length unitData: own first, then enemies, zero-padded to MAX_UNITS * UNIT_FEATURES
  const unitData = new Array(MAX_UNITS * UNIT_FEATURES).fill(0);
  const allUnits = [...ownUnits, ...enemyUnits];
  const unitCount = Math.min(allUnits.length, MAX_UNITS);
  for (let i = 0; i < unitCount; i++) {
    const base = i * UNIT_FEATURES;
    for (let j = 0; j < UNIT_FEATURES; j++) {
      unitData[base + j] = allUnits[i][j];
    }
  }

  // Buildings: collect own and enemy separately
  const ownBuildings: number[][] = [];
  const enemyBuildings: number[][] = [];

  const buildings = world.query(POSITION, TEAM, BUILDING, HEALTH);
  for (const e of buildings) {
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;

    if (health.dead) continue;

    if (t.team !== team && !fogState.isVisible(team, pos.x, pos.z)) continue;

    const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
    const typeIdx = BUILDING_TYPE_INDEX[bldg.buildingType] ?? 0;

    let progress = 1.0;
    const construction = world.getComponent<ConstructionComponent>(e, CONSTRUCTION);
    if (construction) {
      progress = construction.progress;
    }

    const data = [e, t.team, typeIdx, pos.x, pos.z, health.current, health.max, progress];
    if (t.team === team) {
      ownBuildings.push(data);
    } else {
      enemyBuildings.push(data);
    }
  }

  // Fixed-length buildingData: own first, then enemies, zero-padded to MAX_BUILDINGS * BUILDING_FEATURES
  const buildingData = new Array(MAX_BUILDINGS * BUILDING_FEATURES).fill(0);
  const allBuildings = [...ownBuildings, ...enemyBuildings];
  const buildingCount = Math.min(allBuildings.length, MAX_BUILDINGS);
  for (let i = 0; i < buildingCount; i++) {
    const base = i * BUILDING_FEATURES;
    for (let j = 0; j < BUILDING_FEATURES; j++) {
      buildingData[base + j] = allBuildings[i][j];
    }
  }

  // Game state (affordability + capability flags)
  const gameState = buildGameState(world, resourceState, team);

  // Action mask (not cached — building positions and fog change)
  const actionMask = buildActionMask(world, energyNodes, oreDeposits, gridSize, fogState, team);

  return { resources, mapGrid, energyGrid, oreGrid, unitData, buildingData, gameState, actionMask, tick };
}
