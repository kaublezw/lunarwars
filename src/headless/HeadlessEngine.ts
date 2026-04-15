import { World } from '@core/ECS';
import { SeededRandom } from '@sim/utils/SeededRandom';
import { TerrainData } from '@sim/terrain/TerrainData';
import { generateEnergyNodes, generateOreDeposits } from '@sim/terrain/MapFeatures';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import { ResourceState } from '@sim/economy/ResourceState';
import { FogOfWarState } from '@sim/fog/FogOfWarState';
import { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { GarageExitSystem } from '@sim/systems/GarageExitSystem';
import { RoofExitSystem } from '@sim/systems/RoofExitSystem';
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
import { EconomySystem } from '@sim/systems/EconomySystem';
import { SupplySystem } from '@sim/systems/SupplySystem';
import { BuildSystem } from '@sim/systems/BuildSystem';
import { ProductionSystem } from '@sim/systems/ProductionSystem';
import { FogOfWarSystem } from '@sim/systems/FogOfWarSystem';
import { AISystem } from '@sim/systems/AIBrain';
import { POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, TEAM, BUILDING, VISION, PRODUCTION_QUEUE, VOXEL_STATE, MATTER_STORAGE, DEPOT_RADIUS, POWER_NODE } from '@sim/components/ComponentTypes';
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
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { DepotRadiusComponent } from '@sim/components/DepotRadius';
import type { PowerNodeComponent } from '@sim/components/PowerNode';

import { TEAM_COLORS } from '@sim/ai/AITypes';
import { spawnTrainSet } from '@sim/logistics/TrainSpawner';
import { TrainMovementSystem } from '@sim/systems/TrainMovementSystem';
import { TrainLogisticsSystem } from '@sim/systems/TrainLogisticsSystem';
import { TrackManagerSystem } from '@sim/systems/TrackManagerSystem';
import { TrackState } from '@sim/logistics/TrackState';
import { PowerGridState } from '@sim/economy/PowerGridState';
import { PowerGridSystem } from '@sim/systems/PowerGridSystem';

import type { HeadlessConfig, GameResult } from './types';

export class HeadlessEngine {
  private world!: World;
  private resourceState!: ResourceState;
  private terrainData!: TerrainData;
  private fogState!: FogOfWarState;
  private buildingOccupancy!: BuildingOccupancy;
  private energyNodes!: EnergyNode[];
  private oreDeposits!: OreDeposit[];
  private powerGridState!: PowerGridState;
  private gameOverTeam: number | null = null;
  private tickCount = 0;

  seed: number;
  private readonly maxTicks: number;

  constructor(private readonly config: HeadlessConfig = {}) {
    this.seed = config.seed ?? Math.floor(Math.random() * 2147483647);
    this.maxTicks = config.maxTicks ?? 72000;

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
    const trackState = new TrackState(2);
    this.powerGridState = new PowerGridState(2);
    const powerGridState = this.powerGridState;

    // Fog of war
    this.fogState = new FogOfWarState(276, 276, 2, 25);

    // Building occupancy
    this.buildingOccupancy = new BuildingOccupancy(276, 276);

    // ECS world
    this.world = new World();

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
    this.world.addSystem(new RoofExitSystem());
    this.world.addSystem(pathfindingSystem);
    this.world.addSystem(new CollisionAvoidanceSystem(simRng));
    this.world.addSystem(movementSystem);
    this.world.addSystem(new TrainMovementSystem());
    this.world.addSystem(new TrainLogisticsSystem(this.resourceState, trackState, 2));
    this.world.addSystem(new FogOfWarSystem(this.fogState));
    this.world.addSystem(new TurretSystem(simRng));
    this.world.addSystem(new ProjectileSystem());
    this.world.addSystem(new VoxelDamageSystem(simRng, true));
    this.world.addSystem(new ResupplySystem());
    this.world.addSystem(new RepairSystem(this.resourceState, 2));
    this.world.addSystem(gameOverSystem);
    this.world.addSystem(new HealthSystem());
    this.world.addSystem(new PowerGridSystem(powerGridState, 2));
    this.world.addSystem(new EconomySystem(this.resourceState, 2, this.terrainData));
    this.world.addSystem(new SupplySystem(this.terrainData, this.resourceState));
    this.world.addSystem(new BuildSystem(undefined, powerGridState, this.terrainData, this.buildingOccupancy));
    this.world.addSystem(new ProductionSystem(this.resourceState, this.terrainData));
    this.world.addSystem(new TrackManagerSystem(trackState, this.terrainData, 2));

    // Both teams controlled by AI
    this.world.addSystem(new AISystem(1, this.resourceState, this.terrainData, this.fogState, this.energyNodes, this.oreDeposits, this.buildingOccupancy, this.powerGridState));
    this.world.addSystem(new AISystem(0, this.resourceState, this.terrainData, this.fogState, this.energyNodes, this.oreDeposits, this.buildingOccupancy, this.powerGridState));

    // Spawn HQs + workers
    this.spawnInitialEntities();

    // Extra starting resources (on top of constructor's 100e/100m)
    this.resourceState.addEnergy(0, 100);
    this.resourceState.addMatter(0, 100);
    this.resourceState.addEnergy(1, 100);
    this.resourceState.addMatter(1, 100);
  }

  run(): GameResult {
    while (this.gameOverTeam === null && this.tickCount < this.maxTicks) {
      this.tick();
    }
    return { seed: this.seed, totalTicks: this.tickCount, winner: this.gameOverTeam };
  }

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

      // HQ acts as resupply point (ammo + repair) like a Supply Depot
      this.world.addComponent<MatterStorageComponent>(e, MATTER_STORAGE, {
        stored: 0,
        capacity: 100,
      });
      this.world.addComponent<DepotRadiusComponent>(e, DEPOT_RADIUS, { radius: 8 });

      // HQ is the root of the power grid — always powered
      this.world.addComponent<PowerNodeComponent>(e, POWER_NODE, {
        powered: true,
        nodeId: this.powerGridState.allocateNodeId(),
      });
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

    // Train set (1 engine + 2 cargo cars per team, free)
    for (const hq of hqSpawns) {
      const trainY = this.terrainData.getHeight(hq.x, hq.z) + 0.1;
      spawnTrainSet(this.world, hq.team, hq.x, trainY, hq.z, 2);
    }
  }
}
