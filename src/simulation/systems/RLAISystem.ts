/**
 * AI system that uses a trained PPO model for decision-making.
 * Builds the same normalized observations as the Python training env,
 * runs inference through a 3-layer MLP, and applies the resulting actions.
 */

import type { System, World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import {
  POSITION, TEAM, UNIT_TYPE, HEALTH, BUILDING, TURRET, CONSTRUCTION, BUILD_COMMAND,
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
import type { AIContext } from '@sim/ai/AITypes';
import { issueMove } from '@sim/ai/AIActions';
import { RLInference } from '@sim/ai/RLInference';
import type { ModelWeights } from '@sim/ai/RLInference';
import {
  buildStructure, trainUnit,
  type GameCommandContext,
} from '@sim/commands/GameCommands';

// Must match Python training env exactly
const MAX_UNITS = 100;
const MAX_BUILDINGS = 100;
const UNIT_FEATURES = 9;
const BUILDING_FEATURES = 8;
const MAP_GRID_SIZE = 32;
const RESOURCE_FEATURES = 4;
const GAME_STATE_FEATURES = 12;
const ACTION_MASK_SIZE = MAP_GRID_SIZE * MAP_GRID_SIZE; // 1024
const MAX_ACTIONS_PER_STEP = 4;
const OBS_SIZE = RESOURCE_FEATURES + MAP_GRID_SIZE * MAP_GRID_SIZE * 3 + UNIT_FEATURES * MAX_UNITS + BUILDING_FEATURES * MAX_BUILDINGS + GAME_STATE_FEATURES + ACTION_MASK_SIZE + 1;
const DECISION_INTERVAL = 30; // ticks between decisions (matches training ticks_per_step=30)
const MAX_TICKS = 18000; // for tick normalization (matches training default)
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

const UNIT_CATEGORIES_BY_INDEX: UnitCategory[] = [
  UnitCategory.WorkerDrone,
  UnitCategory.CombatDrone,
  UnitCategory.AssaultPlatform,
  UnitCategory.AerialDrone,
  UnitCategory.FerryDrone,
];

const BUILDING_TYPES_BY_INDEX: (BuildingType | null)[] = [
  null,
  BuildingType.EnergyExtractor,
  BuildingType.MatterPlant,
  BuildingType.SupplyDepot,
  BuildingType.DroneFactory,
  BuildingType.Wall,
];

export class RLAISystem implements System {
  readonly name = 'RLAISystem';
  private inference = new RLInference();
  private tickCount = 0;
  private cachedMapGrid: Float32Array | null = null;
  private cachedEnergyGrid: Float32Array | null = null;
  private cachedOreGrid: Float32Array | null = null;

  constructor(
    private team: number,
    private resourceState: ResourceState,
    private terrainData: TerrainData,
    private fogState: FogOfWarState,
    private energyNodes: EnergyNode[],
    private oreDeposits: OreDeposit[],
    private buildingOccupancy: BuildingOccupancy,
  ) {
    this.loadWeights();
  }

  private async loadWeights(): Promise<void> {
    try {
      const resp = await fetch('/rl_model_weights.json');
      if (!resp.ok) {
        console.warn('RL model weights not found at /rl_model_weights.json');
        return;
      }
      const data: ModelWeights = await resp.json();
      this.inference.loadWeights(data);
      console.log('RL model weights loaded successfully');
    } catch (e) {
      console.warn('Failed to load RL model weights:', e);
    }
  }

  update(world: World, _dt: number): void {
    this.tickCount++;

    if (this.tickCount % DECISION_INTERVAL !== 0) return;
    if (!this.inference.isReady()) return;

    // Build observation
    const obs = this.buildObservation(world);

    // Run inference (returns 24 values: 4 sub-actions of stride 6)
    const actionValues = this.inference.predict(obs);

    // Apply all sub-actions
    for (let i = 0; i < MAX_ACTIONS_PER_STEP; i++) {
      const base = i * 6;
      const actionType = actionValues[base];
      const srcGridX = actionValues[base + 1];
      const srcGridZ = actionValues[base + 2];
      const tgtGridX = actionValues[base + 3];
      const tgtGridZ = actionValues[base + 4];
      const param = actionValues[base + 5];
      this.applySpatialAction(world, actionType, srcGridX, srcGridZ, tgtGridX, tgtGridZ, param);
    }
  }

  private buildObservation(world: World): Float32Array {
    const obs = new Float32Array(OBS_SIZE);

    // --- Gather all data first (some fields have cross-dependencies) ---

    const res = this.resourceState.get(this.team);
    const cellSize = 256 / MAP_GRID_SIZE;

    // Cache static grids
    if (!this.cachedMapGrid) {
      this.cachedMapGrid = new Float32Array(MAP_GRID_SIZE * MAP_GRID_SIZE);
      for (let gz = 0; gz < MAP_GRID_SIZE; gz++) {
        for (let gx = 0; gx < MAP_GRID_SIZE; gx++) {
          const wx = (gx + 0.5) * cellSize;
          const wz = (gz + 0.5) * cellSize;
          this.cachedMapGrid[gz * MAP_GRID_SIZE + gx] = this.terrainData.isPassable(wx, wz) ? 0 : 1;
        }
      }
    }
    if (!this.cachedEnergyGrid) {
      this.cachedEnergyGrid = new Float32Array(MAP_GRID_SIZE * MAP_GRID_SIZE);
      for (const node of this.energyNodes) {
        const gx = Math.floor(node.x / cellSize);
        const gz = Math.floor(node.z / cellSize);
        if (gx >= 0 && gx < MAP_GRID_SIZE && gz >= 0 && gz < MAP_GRID_SIZE) {
          this.cachedEnergyGrid[gz * MAP_GRID_SIZE + gx] = 1;
        }
      }
    }
    if (!this.cachedOreGrid) {
      this.cachedOreGrid = new Float32Array(MAP_GRID_SIZE * MAP_GRID_SIZE);
      for (const deposit of this.oreDeposits) {
        const gx = Math.floor(deposit.x / cellSize);
        const gz = Math.floor(deposit.z / cellSize);
        if (gx >= 0 && gx < MAP_GRID_SIZE && gz >= 0 && gz < MAP_GRID_SIZE) {
          this.cachedOreGrid[gz * MAP_GRID_SIZE + gx] = 1;
        }
      }
    }

    // Gather units (needed by unitData + gameState.hasWorkers)
    let hasWorkers = false;
    const ownUnits: number[][] = [];
    const enemyUnits: number[][] = [];
    const units = world.query(POSITION, TEAM, UNIT_TYPE, HEALTH);
    for (const e of units) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      if (t.team !== this.team && !this.fogState.isVisible(this.team, pos.x, pos.z)) continue;
      const ut = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      const catIdx = UNIT_CATEGORY_INDEX[ut.category] ?? 0;
      let ammo = -1;
      let maxAmmo = -1;
      const turret = world.getComponent<TurretComponent>(e, TURRET);
      if (turret) { ammo = turret.ammo; maxAmmo = turret.maxAmmo; }
      const data = [e, t.team, catIdx, pos.x, pos.z, health.current, health.max, ammo, maxAmmo];
      if (t.team === this.team) {
        ownUnits.push(data);
        if (catIdx === 0) hasWorkers = true;
      } else {
        enemyUnits.push(data);
      }
    }
    const allUnits = [...ownUnits, ...enemyUnits];

    // Gather buildings (needed by buildingData + gameState.hasProductionBuilding + actionMask)
    const ownBuildings: number[][] = [];
    const enemyBuildings: number[][] = [];
    const buildings = world.query(POSITION, TEAM, BUILDING, HEALTH);
    for (const e of buildings) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      if (t.team !== this.team && !this.fogState.isVisible(this.team, pos.x, pos.z)) continue;
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const typeIdx = BUILDING_TYPE_INDEX[bldg.buildingType] ?? 0;
      let progress = 1.0;
      const construction = world.getComponent<ConstructionComponent>(e, CONSTRUCTION);
      if (construction) progress = construction.progress;
      const data = [e, t.team, typeIdx, pos.x, pos.z, health.current, health.max, progress];
      if (t.team === this.team) {
        ownBuildings.push(data);
      } else {
        enemyBuildings.push(data);
      }
    }
    const allBuildings = [...ownBuildings, ...enemyBuildings];

    // Compute action mask into temp buffer
    const actionMaskBuf = new Float32Array(ACTION_MASK_SIZE);
    {
      for (const node of this.energyNodes) {
        if (!this.isUnclaimed(world, node.x, node.z)) continue;
        const gx = Math.floor(node.x / cellSize);
        const gz = Math.floor(node.z / cellSize);
        if (gx >= 0 && gx < MAP_GRID_SIZE && gz >= 0 && gz < MAP_GRID_SIZE) {
          actionMaskBuf[gz * MAP_GRID_SIZE + gx] = 1;
        }
      }
      for (const deposit of this.oreDeposits) {
        if (!this.isUnclaimed(world, deposit.x, deposit.z)) continue;
        const gx = Math.floor(deposit.x / cellSize);
        const gz = Math.floor(deposit.z / cellSize);
        if (gx >= 0 && gx < MAP_GRID_SIZE && gz >= 0 && gz < MAP_GRID_SIZE) {
          actionMaskBuf[gz * MAP_GRID_SIZE + gx] = 2;
        }
      }
    }

    // Compute game state (needs hasWorkers + allBuildings)
    const gameStateBuf = new Float32Array(GAME_STATE_FEATURES);
    {
      const energy = res.energy;
      const matter = res.matter;
      const canAfford = (eCost: number, mCost: number) => (energy >= eCost && matter >= mCost) ? 1 : 0;
      const extDef = BUILDING_DEFS[BuildingType.EnergyExtractor];
      const plantDef = BUILDING_DEFS[BuildingType.MatterPlant];
      const depotDef = BUILDING_DEFS[BuildingType.SupplyDepot];
      const factoryDef = BUILDING_DEFS[BuildingType.DroneFactory];
      const wallDef = BUILDING_DEFS[BuildingType.Wall];
      const workerDef = UNIT_DEFS[UnitCategory.WorkerDrone];
      const combatDef = UNIT_DEFS[UnitCategory.CombatDrone];
      const assaultDef = UNIT_DEFS[UnitCategory.AssaultPlatform];
      const aerialDef = UNIT_DEFS[UnitCategory.AerialDrone];
      const ferryDef = UNIT_DEFS[UnitCategory.FerryDrone];
      gameStateBuf[0] = canAfford(extDef.energyCost, extDef.matterCost);
      gameStateBuf[1] = canAfford(plantDef.energyCost, plantDef.matterCost);
      gameStateBuf[2] = canAfford(depotDef.energyCost, depotDef.matterCost);
      gameStateBuf[3] = canAfford(factoryDef.energyCost, factoryDef.matterCost);
      gameStateBuf[4] = canAfford(wallDef.energyCost, wallDef.matterCost);
      gameStateBuf[5] = canAfford(workerDef.energyCost, workerDef.matterCost);
      gameStateBuf[6] = canAfford(combatDef.energyCost, combatDef.matterCost);
      gameStateBuf[7] = canAfford(assaultDef.energyCost, assaultDef.matterCost);
      gameStateBuf[8] = canAfford(aerialDef.energyCost, aerialDef.matterCost);
      gameStateBuf[9] = canAfford(ferryDef.energyCost, ferryDef.matterCost);
      gameStateBuf[10] = hasWorkers ? 1 : 0;
      let hasProd = 0;
      for (const bdata of allBuildings) {
        if (bdata[1] === this.team) {
          const tIdx = bdata[2];
          if (tIdx === 0 || tIdx === 4 || tIdx === 3) { hasProd = 1; break; }
        }
      }
      gameStateBuf[11] = hasProd;
    }

    // --- Write into Float32Array matching Python _parse_observation order ---
    // resources, mapGrid, energyGrid, oreGrid, unitData, buildingData, gameState, actionMask, tick
    let idx = 0;

    // 1. resources (4)
    obs[idx++] = res.energy / 1000;
    obs[idx++] = res.matter / 1000;
    obs[idx++] = res.energyRate / 1000;
    obs[idx++] = res.matterRate / 1000;

    // 2. mapGrid (1024)
    obs.set(this.cachedMapGrid, idx);
    idx += MAP_GRID_SIZE * MAP_GRID_SIZE;

    // 3. energyGrid (1024)
    obs.set(this.cachedEnergyGrid, idx);
    idx += MAP_GRID_SIZE * MAP_GRID_SIZE;

    // 4. oreGrid (1024)
    obs.set(this.cachedOreGrid, idx);
    idx += MAP_GRID_SIZE * MAP_GRID_SIZE;

    // 5. unitData (900)
    for (let i = 0; i < Math.min(allUnits.length, MAX_UNITS); i++) {
      const [entityId, team, catIdx, px, pz, hp, maxHp, ammo, maxAmmo] = allUnits[i];
      const base = idx + i * UNIT_FEATURES;
      obs[base + 0] = entityId / 1000;
      obs[base + 1] = team === this.team ? 1.0 : 0.0;
      obs[base + 2] = catIdx / 4;
      obs[base + 3] = px / 256;
      obs[base + 4] = pz / 256;
      obs[base + 5] = maxHp > 0 ? hp / maxHp : 0;
      obs[base + 6] = maxHp / 2000;
      obs[base + 7] = maxAmmo > 0 && ammo >= 0 ? ammo / maxAmmo : 0;
      obs[base + 8] = maxAmmo > 0 ? maxAmmo / 50 : 0;
    }
    idx += MAX_UNITS * UNIT_FEATURES;

    // 6. buildingData (800)
    for (let i = 0; i < Math.min(allBuildings.length, MAX_BUILDINGS); i++) {
      const [entityId, team, typeIdx, px, pz, hp, maxHp, progress] = allBuildings[i];
      const base = idx + i * BUILDING_FEATURES;
      obs[base + 0] = entityId / 1000;
      obs[base + 1] = team === this.team ? 1.0 : 0.0;
      obs[base + 2] = typeIdx / 5;
      obs[base + 3] = px / 256;
      obs[base + 4] = pz / 256;
      obs[base + 5] = maxHp > 0 ? hp / maxHp : 0;
      obs[base + 6] = maxHp / 2000;
      obs[base + 7] = progress;
    }
    idx += MAX_BUILDINGS * BUILDING_FEATURES;

    // 7. gameState (12)
    obs.set(gameStateBuf, idx);
    idx += GAME_STATE_FEATURES;

    // 8. actionMask (1024, normalized by /2.0)
    for (let i = 0; i < ACTION_MASK_SIZE; i++) {
      obs[idx + i] = actionMaskBuf[i] / 2.0;
    }
    idx += ACTION_MASK_SIZE;

    // 9. tick (1)
    obs[idx] = this.tickCount / MAX_TICKS;

    return obs;
  }

  private applySpatialAction(
    world: World,
    actionType: number,
    srcGridX: number,
    srcGridZ: number,
    tgtGridX: number,
    tgtGridZ: number,
    param: number,
  ): void {
    if (actionType === 0) return; // NoOp

    const cellSize = 256 / MAP_GRID_SIZE;
    const srcWorldX = (srcGridX + 0.5) * cellSize;
    const srcWorldZ = (srcGridZ + 0.5) * cellSize;
    const tgtWorldX = (tgtGridX + 0.5) * cellSize;
    const tgtWorldZ = (tgtGridZ + 0.5) * cellSize;

    const ctx = this.buildAIContext(world);

    const cmdCtx: GameCommandContext = {
      world,
      resources: this.resourceState,
      terrain: this.terrainData,
      energyNodes: this.energyNodes,
      oreDeposits: this.oreDeposits,
    };

    if (actionType === 1 || actionType === 2) {
      // MoveUnit / AttackMove
      const entity = this.findNearestUnit(world, srcWorldX, srcWorldZ);
      if (entity === null) return;
      // Don't interrupt workers that are building
      if (world.getComponent(entity, BUILD_COMMAND)) return;
      issueMove(ctx, entity, tgtWorldX, tgtWorldZ);
    } else if (actionType === 3) {
      // TrainUnit
      const catIdx = Math.min(param, 4);
      const unitCategory = UNIT_CATEGORIES_BY_INDEX[catIdx];
      const entity = this.findNearestProductionBuilding(world, srcWorldX, srcWorldZ, unitCategory);
      if (entity === null) return;

      const pos = world.getComponent<PositionComponent>(entity, POSITION);
      const rallyX = pos ? pos.x : ctx.baseX;
      const rallyZ = pos ? pos.z + 5 : ctx.baseZ;
      trainUnit(cmdCtx, this.team, entity, unitCategory, rallyX, rallyZ);
    } else if (actionType === 4) {
      // BuildStructure
      const typeIdx = Math.floor(param);
      if (typeIdx < 1 || typeIdx >= BUILDING_TYPES_BY_INDEX.length) return;
      const buildingType = BUILDING_TYPES_BY_INDEX[typeIdx];
      if (!buildingType) return;

      let buildX = tgtWorldX;
      let buildZ = tgtWorldZ;

      if (buildingType === BuildingType.EnergyExtractor) {
        const node = this.findNearestUnclaimedNode(world, this.energyNodes);
        if (!node) return;
        buildX = node.x;
        buildZ = node.z;
      } else if (buildingType === BuildingType.MatterPlant) {
        const deposit = this.findNearestUnclaimedNode(world, this.oreDeposits);
        if (!deposit) return;
        buildX = deposit.x;
        buildZ = deposit.z;
      }

      // Find nearest worker to the build site
      const entity = this.findNearestWorker(world, buildX, buildZ);
      if (entity === null) return;

      buildStructure(cmdCtx, this.team, buildingType, buildX, buildZ, entity);
    }
  }

  private findNearestUnit(world: World, x: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    const entities = world.query(POSITION, TEAM, UNIT_TYPE, HEALTH);
    for (const e of entities) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  private findNearestProductionBuilding(world: World, x: number, z: number, unitCategory: UnitCategory): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    const entities = world.query(POSITION, TEAM, BUILDING, HEALTH);
    for (const e of entities) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      if (world.getComponent(e, CONSTRUCTION)) continue;
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType !== BuildingType.HQ &&
          bldg.buildingType !== BuildingType.DroneFactory) continue;
      // Enforce production rules: HQ only trains workers, DroneFactory cannot train workers
      if (bldg.buildingType === BuildingType.HQ && unitCategory !== UnitCategory.WorkerDrone) continue;
      if (bldg.buildingType === BuildingType.DroneFactory && unitCategory === UnitCategory.WorkerDrone) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  private isUnclaimed(world: World, x: number, z: number): boolean {
    const buildings = world.query(POSITION, BUILDING, HEALTH);
    for (const e of buildings) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      if (dx * dx + dz * dz < BUILDING_MIN_SPACING_SQ) return false;
    }
    const constructions = world.query(POSITION, CONSTRUCTION);
    for (const e of constructions) {
      if (world.getComponent(e, BUILDING)) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      if (dx * dx + dz * dz < BUILDING_MIN_SPACING_SQ) return false;
    }
    return true;
  }

  private findNearestUnclaimedNode(world: World, nodes: Array<{ x: number; z: number }>): { x: number; z: number } | null {
    let baseX = this.team === 0 ? 64 : 192;
    let baseZ = this.team === 0 ? 64 : 192;
    const buildings = world.query(BUILDING, TEAM, POSITION);
    for (const e of buildings) {
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType !== BuildingType.HQ) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.team) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      baseX = pos.x;
      baseZ = pos.z;
      break;
    }
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const node of nodes) {
      if (!this.isUnclaimed(world, node.x, node.z)) continue;
      const dx = node.x - baseX;
      const dz = node.z - baseZ;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    return best;
  }

  private findNearestWorker(world: World, x: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    const entities = world.query(POSITION, TEAM, UNIT_TYPE, HEALTH);
    for (const e of entities) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const ut = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      if (ut.category !== UnitCategory.WorkerDrone) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  private buildAIContext(world: World): AIContext {
    let hqEntity = -1;
    let baseX = this.team === 0 ? 64 : 192;
    let baseZ = this.team === 0 ? 64 : 192;

    const buildings = world.query(BUILDING, TEAM, POSITION);
    for (const e of buildings) {
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType !== BuildingType.HQ) continue;
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.team) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      hqEntity = e;
      baseX = pos.x;
      baseZ = pos.z;
      break;
    }

    return {
      world,
      team: this.team,
      resources: this.resourceState,
      terrain: this.terrainData,
      fog: this.fogState,
      energyNodes: this.energyNodes,
      oreDeposits: this.oreDeposits,
      occupancy: this.buildingOccupancy,
      baseX,
      baseZ,
      rallyX: baseX,
      rallyZ: baseZ + 15,
      hqEntity,
      totalTicks: this.tickCount,
    };
  }
}
