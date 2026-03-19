import { World } from '@core/ECS';
import { SeededRandom } from '@sim/utils/SeededRandom';
import { TerrainData } from '@sim/terrain/TerrainData';
import { generateEnergyNodes, generateOreDeposits } from '@sim/terrain/MapFeatures';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import { ResourceState } from '@sim/economy/ResourceState';
import { FogOfWarState } from '@sim/fog/FogOfWarState';
import { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { GarageExitSystem } from '@sim/systems/GarageExitSystem';
import { GarageEnterSystem } from '@sim/systems/GarageEnterSystem';
import { PathfindingSystem } from '@sim/systems/PathfindingSystem';
import { CollisionAvoidanceSystem } from '@sim/systems/CollisionAvoidanceSystem';
import { MovementSystem } from '@sim/systems/MovementSystem';
import { TurretSystem } from '@sim/systems/TurretSystem';
import { ProjectileSystem } from '@sim/systems/ProjectileSystem';
import { VoxelDamageSystem } from '@sim/systems/VoxelDamageSystem';
import { ResupplySystem } from '@sim/systems/ResupplySystem';
import { RepairSystem } from '@sim/systems/RepairSystem';
import { GameOverSystem } from '@sim/systems/GameOverSystem';
import { HealthSystem } from '@sim/systems/HealthSystem';
import { EnergyPacketSystem } from '@sim/systems/EnergyPacketSystem';
import { MatterPacketSystem } from '@sim/systems/MatterPacketSystem';
import { MatterDeliverySystem } from '@sim/systems/MatterDeliverySystem';
import { FerryDockSystem } from '@sim/systems/FerryDockSystem';
import { EconomySystem } from '@sim/systems/EconomySystem';
import { SiloSystem } from '@sim/systems/SiloSystem';
import { SupplySystem } from '@sim/systems/SupplySystem';
import { BuildSystem } from '@sim/systems/BuildSystem';
import { ProductionSystem } from '@sim/systems/ProductionSystem';
import { FogOfWarSystem } from '@sim/systems/FogOfWarSystem';
import { AISystem } from '@sim/systems/AIBrain';
import { POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, TEAM, BUILDING, VISION, PRODUCTION_QUEUE, VOXEL_STATE, CONSTRUCTION, RESOURCE_SILO } from '@sim/components/ComponentTypes';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import { BuildingType } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { SteeringComponent } from '@sim/components/Steering';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { VisionComponent } from '@sim/components/Vision';
import type { BuildingComponent } from '@sim/components/Building';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { VoxelStateComponent } from '@sim/components/VoxelState';

import type { AIContext } from '@sim/ai/AITypes';
import { TEAM_COLORS } from '@sim/ai/AITypes';
import { issueMove } from '@sim/ai/AIActions';
import {
  buildStructure, trainUnit,
  type GameCommandContext,
} from '@sim/commands/GameCommands';

import type { HeadlessConfig, GameResult } from './types';
import type { AIAction, StepResult } from './RLTypes';
import { RLActionType } from './RLTypes';
import { extractObservation, clearMapGridCache } from './RLObservation';
import { captureRewardState, calculateReward } from './RLReward';

const UNIT_CATEGORIES_BY_INDEX: UnitCategory[] = [
  UnitCategory.WorkerDrone,
  UnitCategory.CombatDrone,
  UnitCategory.AssaultPlatform,
  UnitCategory.AerialDrone,
  UnitCategory.FerryDrone,
];

const BUILDING_TYPES_BY_INDEX: (BuildingType | null)[] = [
  null, // 0 = unused (HQ can't be built)
  BuildingType.EnergyExtractor,
  BuildingType.MatterPlant,
  BuildingType.SupplyDepot,
  BuildingType.DroneFactory,
  BuildingType.Wall,
];

export class HeadlessEngine {
  private world!: World;
  private resourceState!: ResourceState;
  private terrainData!: TerrainData;
  private fogState!: FogOfWarState;
  private buildingOccupancy!: BuildingOccupancy;
  private energyNodes!: EnergyNode[];
  private oreDeposits!: OreDeposit[];
  private siloSystem!: SiloSystem;
  private gameOverTeam: number | null = null;
  private tickCount = 0;

  seed: number;
  private readonly maxTicks: number;

  // RL mode config
  private readonly rlMode: boolean;
  private readonly rlTeam: number;
  private readonly ticksPerStep: number;
  private readonly observationGridSize: number;

  constructor(private readonly config: HeadlessConfig = {}) {
    this.seed = config.seed ?? Math.floor(Math.random() * 2147483647);
    this.maxTicks = config.maxTicks ?? (config.rlMode ? 3000 : 72000);
    this.rlMode = config.rlMode ?? false;
    this.rlTeam = config.rlTeam ?? 1;
    this.ticksPerStep = config.ticksPerStep ?? 30;
    this.observationGridSize = config.observationGridSize ?? 32;

    this.initWorld();
  }

  private initWorld(): void {
    this.gameOverTeam = null;
    this.tickCount = 0;

    // Terrain + map features
    this.terrainData = new TerrainData({ seed: this.seed });
    this.energyNodes = generateEnergyNodes(this.terrainData, this.seed);
    this.oreDeposits = generateOreDeposits(this.terrainData, this.seed, this.energyNodes);

    // Economy
    this.resourceState = new ResourceState(2);

    // Fog of war
    this.fogState = new FogOfWarState(276, 276, 2, 25);

    // Building occupancy
    this.buildingOccupancy = new BuildingOccupancy(276, 276);

    // ECS world
    this.world = new World();
    this.resourceState.setWorld(this.world);

    // Seeded RNG
    const simRng = new SeededRandom(this.seed * 9973);

    // Game over detection
    const gameOverSystem = new GameOverSystem();
    gameOverSystem.setCallback((losingTeam: number) => {
      this.gameOverTeam = losingTeam;
    });

    // Register systems in exact same order as main.ts
    const pathfindingSystem = new PathfindingSystem(this.terrainData);
    pathfindingSystem.setOccupancy(this.buildingOccupancy);
    const movementSystem = new MovementSystem(this.terrainData);
    movementSystem.setOccupancy(this.buildingOccupancy);

    this.world.addSystem(new GarageExitSystem());
    this.world.addSystem(new GarageEnterSystem());
    this.world.addSystem(pathfindingSystem);
    this.world.addSystem(new CollisionAvoidanceSystem(simRng));
    this.world.addSystem(movementSystem);
    this.world.addSystem(new FogOfWarSystem(this.fogState));
    this.world.addSystem(new TurretSystem(simRng));
    this.world.addSystem(new ProjectileSystem());
    this.world.addSystem(new VoxelDamageSystem(simRng, true));
    this.world.addSystem(new ResupplySystem());
    this.world.addSystem(new RepairSystem(this.resourceState, 2));
    this.world.addSystem(gameOverSystem);
    this.world.addSystem(new HealthSystem());
    this.world.addSystem(new EnergyPacketSystem(this.resourceState));
    this.world.addSystem(new MatterPacketSystem(this.resourceState));
    this.world.addSystem(new MatterDeliverySystem());
    this.world.addSystem(new FerryDockSystem());
    this.siloSystem = new SiloSystem(this.terrainData);
    this.world.addSystem(this.siloSystem);
    const economySystem = new EconomySystem(this.resourceState, 2);
    economySystem.setSiloSystem(this.siloSystem);
    this.world.addSystem(economySystem);
    const supplySystem = new SupplySystem(this.terrainData);
    supplySystem.setSiloSystem(this.siloSystem);
    this.world.addSystem(supplySystem);
    this.world.addSystem(new BuildSystem());
    this.world.addSystem(new ProductionSystem(this.resourceState, this.terrainData));

    if (this.rlMode) {
      // Only the non-RL team gets AI; RL team is externally controlled
      const aiTeam = this.rlTeam === 1 ? 0 : 1;
      this.world.addSystem(new AISystem(
        aiTeam, this.resourceState, this.terrainData, this.fogState,
        this.energyNodes, this.oreDeposits, this.buildingOccupancy,
      ));
    } else {
      // Both teams controlled by AI (team 1 first to match main.ts spectator order)
      this.world.addSystem(new AISystem(1, this.resourceState, this.terrainData, this.fogState, this.energyNodes, this.oreDeposits, this.buildingOccupancy));
      this.world.addSystem(new AISystem(0, this.resourceState, this.terrainData, this.fogState, this.energyNodes, this.oreDeposits, this.buildingOccupancy));
    }

    // Spawn HQs + workers
    this.spawnInitialEntities();

    // Spawn initial resource silos near each HQ
    this.spawnInitialSilos();
  }

  // --- AI vs AI mode ---

  run(): GameResult {
    while (this.gameOverTeam === null && this.tickCount < this.maxTicks) {
      this.tick();
    }
    return { seed: this.seed, totalTicks: this.tickCount, winner: this.gameOverTeam };
  }

  // --- RL mode ---

  reset(): StepResult {
    this.seed = Math.floor(Math.random() * 2147483647);
    clearMapGridCache();
    this.initWorld();

    // Initial fog update
    this.fogState.update(this.world);

    const observation = extractObservation(
      this.world, this.resourceState, this.fogState,
      this.terrainData, this.tickCount, this.rlTeam, this.observationGridSize,
      this.energyNodes, this.oreDeposits,
    );

    return {
      observation,
      reward: 0,
      done: false,
      truncated: false,
      info: { seed: this.seed },
    };
  }

  step(actions: AIAction[]): StepResult {
    const prevState = captureRewardState(this.world, this.resourceState, this.rlTeam);

    // Apply all RL agent actions before ticking
    for (const action of actions) {
      this.applyAction(action);
    }

    // Advance simulation
    for (let i = 0; i < this.ticksPerStep; i++) {
      this.tick();
      if (this.gameOverTeam !== null) break;
    }

    const currState = captureRewardState(this.world, this.resourceState, this.rlTeam);

    const done = this.gameOverTeam !== null;
    const truncated = !done && this.tickCount >= this.maxTicks;
    // gameOverTeam is the LOSING team, so winner is the OTHER team
    const winner = this.gameOverTeam !== null ? (this.gameOverTeam === this.rlTeam ? 1 - this.rlTeam : this.rlTeam) : null;
    const reward = calculateReward(prevState, currState, done, winner, this.rlTeam);

    const observation = extractObservation(
      this.world, this.resourceState, this.fogState,
      this.terrainData, this.tickCount, this.rlTeam, this.observationGridSize,
      this.energyNodes, this.oreDeposits,
    );

    const info: Record<string, unknown> = {};
    if (done) {
      info.winner = winner;
      info.losingTeam = this.gameOverTeam;
    }
    if (truncated) {
      info.truncated_reason = 'max_ticks';
    }

    return { observation, reward, done: done || truncated, truncated, info };
  }

  // --- Internal ---

  private tick(): void {
    this.buildingOccupancy.update(this.world);
    this.world.update(1 / 60);

    // Clean up voxel state debris/scorch in headless mode (no renderer to consume them)
    if (this.tickCount % 60 === 0) {
      const voxelEntities = this.world.query(VOXEL_STATE);
      for (const e of voxelEntities) {
        const vs = this.world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
        if (vs) {
          vs.pendingDebris.length = 0;
          vs.pendingScorch.length = 0;
        }
      }
    }

    this.tickCount++;
  }

  private buildCmdCtx(): GameCommandContext {
    return {
      world: this.world,
      resources: this.resourceState,
      terrain: this.terrainData,
      energyNodes: this.energyNodes,
      oreDeposits: this.oreDeposits,
    };
  }

  private applyAction(action: AIAction): void {
    if (action.actionType === RLActionType.NoOp) return;

    const ctx = this.buildAIContext();

    switch (action.actionType) {
      case RLActionType.MoveUnit:
      case RLActionType.AttackMove: {
        const entity = this.findNearestUnit(action.sourceX, action.sourceZ);
        if (entity === null) break;
        issueMove(ctx, entity, action.targetX, action.targetZ);
        break;
      }

      case RLActionType.TrainUnit: {
        const entity = this.findNearestProductionBuilding(action.sourceX, action.sourceZ);
        if (entity === null) break;

        const catIndex = Math.floor(action.param);
        if (catIndex < 0 || catIndex >= UNIT_CATEGORIES_BY_INDEX.length) break;
        const unitCategory = UNIT_CATEGORIES_BY_INDEX[catIndex];

        const pos = this.world.getComponent<PositionComponent>(entity, POSITION);
        const rallyX = pos ? pos.x : ctx.baseX;
        const rallyZ = pos ? pos.z + 5 : ctx.baseZ;
        trainUnit(this.buildCmdCtx(), this.rlTeam, entity, unitCategory, rallyX, rallyZ);
        break;
      }

      case RLActionType.BuildStructure: {
        const entity = this.findNearestWorker(action.sourceX, action.sourceZ);
        if (entity === null) break;

        const typeIndex = Math.floor(action.param);
        if (typeIndex < 1 || typeIndex >= BUILDING_TYPES_BY_INDEX.length) break;
        const buildingType = BUILDING_TYPES_BY_INDEX[typeIndex];
        if (!buildingType) break;

        buildStructure(this.buildCmdCtx(), this.rlTeam, buildingType, action.targetX, action.targetZ, entity);
        break;
      }
    }
  }

  private findNearestUnit(x: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    const entities = this.world.query(POSITION, TEAM, UNIT_TYPE, HEALTH);
    for (const e of entities) {
      const t = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.rlTeam) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
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

  private findNearestProductionBuilding(x: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    const entities = this.world.query(POSITION, TEAM, BUILDING, HEALTH);
    for (const e of entities) {
      const t = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.rlTeam) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      // Skip buildings under construction
      if (this.world.getComponent(e, CONSTRUCTION)) continue;
      const bldg = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType !== BuildingType.HQ &&
          bldg.buildingType !== BuildingType.DroneFactory &&
          bldg.buildingType !== BuildingType.SupplyDepot) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
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

  private findNearestWorker(x: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    const entities = this.world.query(POSITION, TEAM, UNIT_TYPE, HEALTH);
    for (const e of entities) {
      const t = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.rlTeam) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const ut = this.world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      if (ut.category !== UnitCategory.WorkerDrone) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
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

  private buildAIContext(): AIContext {
    let hqEntity = -1;
    let baseX = this.rlTeam === 0 ? 64 : 192;
    let baseZ = this.rlTeam === 0 ? 64 : 192;
    const buildings = this.world.query(BUILDING, TEAM, POSITION);
    for (const e of buildings) {
      const bldg = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (bldg.buildingType !== BuildingType.HQ) continue;
      const t = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.rlTeam) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      hqEntity = e;
      baseX = pos.x;
      baseZ = pos.z;
      break;
    }

    return {
      world: this.world,
      team: this.rlTeam,
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

  private spawnInitialSilos(): void {
    const hqEntities = this.world.query(BUILDING, TEAM, POSITION);
    for (const e of hqEntities) {
      const b = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (b.buildingType !== BuildingType.HQ) continue;
      const t = this.world.getComponent<TeamComponent>(e, TEAM)!;

      // Spawn energy silo with 200 energy near HQ
      const eSilo = this.siloSystem.findOrSpawnSilo(this.world, e, 'energy', t.team);
      if (eSilo !== null) {
        const sc = this.world.getComponent<ResourceSiloComponent>(eSilo, RESOURCE_SILO)!;
        sc.stored = 200;
      }

      // Spawn matter silo with 200 matter near HQ
      const mSilo = this.siloSystem.findOrSpawnSilo(this.world, e, 'matter', t.team);
      if (mSilo !== null) {
        const sc = this.world.getComponent<ResourceSiloComponent>(mSilo, RESOURCE_SILO)!;
        sc.stored = 200;
      }
    }
  }

  private spawnInitialEntities(): void {
    const hqSpawns = [
      { x: 64, z: 64, team: 0 },
      { x: 192, z: 192, team: 1 },
    ];

    for (const hq of hqSpawns) {
      const e = this.world.createEntity();
      const y = this.terrainData.getHeight(hq.x, hq.z);

      this.world.addComponent<PositionComponent>(e, POSITION, {
        x: hq.x, y, z: hq.z, prevX: hq.x, prevY: y, prevZ: hq.z, rotation: 0,
      });
      this.world.addComponent<RenderableComponent>(e, RENDERABLE, {
        meshType: 'hq', color: TEAM_COLORS[hq.team], scale: 1.0,
      });
      this.world.addComponent<HealthComponent>(e, HEALTH, {
        current: 2000, max: 2000, dead: false,
      });
      this.world.addComponent<TeamComponent>(e, TEAM, { team: hq.team });
      this.world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
      this.world.addComponent<BuildingComponent>(e, BUILDING, { buildingType: BuildingType.HQ });
      this.world.addComponent<VisionComponent>(e, VISION, { range: 25 });
      this.world.addComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE, {
        queue: [], rallyX: hq.x, rallyZ: hq.z + 5,
      });

      const hqVoxelModel = VOXEL_MODELS['hq'];
      if (hqVoxelModel) {
        this.world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
          modelId: 'hq',
          totalVoxels: hqVoxelModel.totalSolid,
          destroyedCount: 0,
          destroyed: new Uint8Array(Math.ceil(hqVoxelModel.totalSolid / 8)),
          dirty: true,
          pendingDebris: [],
          pendingScorch: [],
        });
      }
    }

    // Workers
    for (const hq of hqSpawns) {
      const e = this.world.createEntity();
      const wx = hq.x + 4;
      const wz = hq.z + 4;
      const wy = this.terrainData.getHeight(wx, wz) + 0.1;

      this.world.addComponent<PositionComponent>(e, POSITION, {
        x: wx, y: wy, z: wz, prevX: wx, prevY: wy, prevZ: wz, rotation: 0,
      });
      this.world.addComponent<VelocityComponent>(e, VELOCITY, { x: 0, z: 0, speed: 2 });
      this.world.addComponent<RenderableComponent>(e, RENDERABLE, {
        meshType: 'worker_drone', color: TEAM_COLORS[hq.team], scale: 1.0,
      });
      this.world.addComponent<UnitTypeComponent>(e, UNIT_TYPE, {
        category: UnitCategory.WorkerDrone, radius: 0.35,
      });
      this.world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
      this.world.addComponent<SteeringComponent>(e, STEERING, { forceX: 0, forceZ: 0 });
      this.world.addComponent<HealthComponent>(e, HEALTH, { current: 80, max: 80, dead: false });
      this.world.addComponent<TeamComponent>(e, TEAM, { team: hq.team });
      this.world.addComponent<VisionComponent>(e, VISION, { range: 12 });

      const workerVoxelModel = VOXEL_MODELS['worker_drone'];
      if (workerVoxelModel) {
        this.world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
          modelId: 'worker_drone',
          totalVoxels: workerVoxelModel.totalSolid,
          destroyedCount: 0,
          destroyed: new Uint8Array(Math.ceil(workerVoxelModel.totalSolid / 8)),
          dirty: true,
          pendingDebris: [],
          pendingScorch: [],
        });
      }
    }
  }
}
