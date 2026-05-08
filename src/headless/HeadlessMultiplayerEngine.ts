import WebSocket from 'ws';
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
import { BuildSystem } from '@sim/systems/BuildSystem';
import { ProductionSystem } from '@sim/systems/ProductionSystem';
import { FogOfWarSystem } from '@sim/systems/FogOfWarSystem';
import { AISystem } from '@sim/systems/AIBrain';
import { POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, TEAM, BUILDING, VISION, PRODUCTION_QUEUE, VOXEL_STATE, DEPOT_RADIUS, POWER_NODE } from '@sim/components/ComponentTypes';
import { BuildingType } from '@sim/components/Building';
import type { BuildingComponent } from '@sim/components/Building';
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
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { DepotRadiusComponent } from '@sim/components/DepotRadius';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import { TEAM_COLORS } from '@sim/ai/AITypes';
import { spawnTrainSet, getHQStubCell, initHQStubTrack } from '@sim/logistics/TrainSpawner';
import { TrainMovementSystem } from '@sim/systems/TrainMovementSystem';
import { TrainLogisticsSystem } from '@sim/systems/TrainLogisticsSystem';
import { TrackManagerSystem } from '@sim/systems/TrackManagerSystem';
import { TrackState } from '@sim/logistics/TrackState';
import { PowerGridState } from '@sim/economy/PowerGridState';
import { PowerGridSystem } from '@sim/systems/PowerGridSystem';
import { CommandBuffer } from '@network/CommandBuffer';
import { DesyncDetector } from '@network/DesyncDetector';
import { executeCommand } from '@network/CommandExecutor';
import type { GameCommandContext } from '@sim/commands/GameCommands';
import type { ServerToClientMessage, GameCommandPayload, TickTaggedCommand } from '@network/Protocol';
import type { MultiplayerGameResult } from './types';

export class HeadlessMultiplayerEngine {
  private world!: World;
  private resourceState!: ResourceState;
  private terrainData!: TerrainData;
  private fogState!: FogOfWarState;
  private buildingOccupancy!: BuildingOccupancy;
  private energyNodes!: EnergyNode[];
  private oreDeposits!: OreDeposit[];
  private powerGridState!: PowerGridState;
  private trackState!: TrackState;
  private gameOverTeam: number | null = null;
  private tickCount = 0;

  private ws: WebSocket | null = null;
  private commandBuffer!: CommandBuffer;
  private desyncDetector!: DesyncDetector;
  private cmdCtx!: GameCommandContext;

  private team = -1;
  private inputDelay = 6;
  seed = 0;
  private readonly maxTicks: number;

  // Desync tracking
  desyncCount = 0;
  checksumsPassed = 0;

  // Async tick resolution
  private tickReadyResolvers = new Map<number, () => void>();

  // Label for logging
  readonly label: string;

  constructor(label: string, maxTicks?: number) {
    this.label = label;
    this.maxTicks = maxTicks ?? 72000;
  }

  // --- Network ---

  connect(serverUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(serverUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));
      this.ws.on('message', (data: Buffer) => {
        let msg: ServerToClientMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.handleMessage(msg);
      });
    });
  }

  createRoom(): Promise<string> {
    return new Promise((resolve) => {
      this._onRoomCreated = resolve;
      this.send({ type: 'create_room' });
    });
  }

  joinRoom(code: string): Promise<void> {
    return new Promise((resolve) => {
      this._onJoinedRoom = resolve;
      this.send({ type: 'join_room', code });
    });
  }

  waitForGameStart(): Promise<{ seed: number; team: number; inputDelay: number }> {
    return new Promise((resolve) => {
      this._onGameStart = resolve;
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // --- Lobby callbacks (set by promise wrappers above) ---
  private _onRoomCreated: ((code: string) => void) | null = null;
  private _onJoinedRoom: (() => void) | null = null;
  private _onGameStart: ((cfg: { seed: number; team: number; inputDelay: number }) => void) | null = null;

  private handleMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case 'room_created':
        this._onRoomCreated?.(msg.code);
        this._onRoomCreated = null;
        break;
      case 'joined_room':
        this._onJoinedRoom?.();
        this._onJoinedRoom = null;
        break;
      case 'game_start':
        this._onGameStart?.({ seed: msg.seed, team: msg.yourTeam, inputDelay: msg.inputDelay });
        this._onGameStart = null;
        break;
      case 'game_command':
        this.commandBuffer?.addRemoteCommand({ tick: msg.tick, playerId: msg.playerId, payload: msg.payload });
        this.checkTickReady();
        break;
      case 'tick_confirm':
        this.commandBuffer?.addTickConfirm(msg.playerId, msg.tick);
        this.checkTickReady();
        break;
      case 'desync_alert':
        this.desyncDetector?.addRemoteChecksum(msg.tick, msg.checksum);
        break;
      case 'player_disconnected':
        console.log(`[${this.label}] Opponent disconnected`);
        break;
    }
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // --- World Init (mirrors HeadlessEngine.initWorld) ---

  initWorld(seed: number, team: number, inputDelay: number): void {
    this.seed = seed;
    this.team = team;
    this.inputDelay = inputDelay;
    this.gameOverTeam = null;
    this.tickCount = 0;
    this.desyncCount = 0;
    this.checksumsPassed = 0;

    // Terrain + map features
    this.terrainData = new TerrainData({ seed: this.seed });
    this.energyNodes = generateEnergyNodes(this.terrainData, this.seed);
    this.oreDeposits = generateOreDeposits(this.terrainData, this.seed, this.energyNodes);

    // Economy
    this.resourceState = new ResourceState(2);
    this.trackState = new TrackState(2);
    this.powerGridState = new PowerGridState(2);

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

    // Register systems in exact same order as main.ts and HeadlessEngine
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
    this.world.addSystem(new TrainLogisticsSystem(this.resourceState, this.trackState, 2));
    this.world.addSystem(new FogOfWarSystem(this.fogState));
    this.world.addSystem(new TurretSystem(simRng));
    this.world.addSystem(new ProjectileSystem());
    this.world.addSystem(new VoxelDamageSystem(simRng, true));
    this.world.addSystem(new ResupplySystem(this.resourceState));
    this.world.addSystem(new RepairSystem(this.resourceState, 2));
    this.world.addSystem(gameOverSystem);
    this.world.addSystem(new HealthSystem());
    this.world.addSystem(new PowerGridSystem(this.powerGridState, 2, this.terrainData, this.buildingOccupancy, this.trackState));
    this.world.addSystem(new EconomySystem(this.resourceState, 2, this.terrainData));
    this.world.addSystem(new BuildSystem(undefined, this.powerGridState, this.terrainData, this.buildingOccupancy, this.trackState));
    this.world.addSystem(new ProductionSystem(this.resourceState, this.terrainData));
    this.world.addSystem(new TrackManagerSystem(this.trackState, this.terrainData, 2, this.buildingOccupancy));

    // Both teams controlled by AI (same as HeadlessEngine)
    this.world.addSystem(new AISystem(1, this.resourceState, this.terrainData, this.fogState, this.energyNodes, this.oreDeposits, this.buildingOccupancy, this.powerGridState, this.trackState, this.seed));
    this.world.addSystem(new AISystem(0, this.resourceState, this.terrainData, this.fogState, this.energyNodes, this.oreDeposits, this.buildingOccupancy, this.powerGridState, this.trackState, this.seed));

    // Spawn HQs + workers + trains
    this.spawnInitialEntities();

    // Extra starting resources
    this.resourceState.addEnergy(0, 100);
    this.resourceState.addMatter(0, 100);
    this.resourceState.addEnergy(1, 100);
    this.resourceState.addMatter(1, 100);

    // Command buffer + desync detector
    this.commandBuffer = new CommandBuffer(this.team, this.inputDelay);
    this.commandBuffer.initializeForGameStart(0);

    this.desyncDetector = new DesyncDetector();
    this.desyncDetector.setSendFn((tick, checksum) => {
      this.send({ type: 'desync_alert', tick, checksum });
    });
    this.desyncDetector.onDesyncDetected = (tick, local, remote) => {
      this.desyncCount++;
      console.error(`[${this.label}] DESYNC at tick ${tick}: local=${local}, remote=${remote}`);
    };

    // Command context for executeCommand
    this.cmdCtx = {
      world: this.world,
      resources: this.resourceState,
      terrain: this.terrainData,
      energyNodes: this.energyNodes,
      oreDeposits: this.oreDeposits,
      powerGrid: this.powerGridState,
      trackState: this.trackState,
    };
  }

  // --- Main Loop ---

  async run(): Promise<MultiplayerGameResult> {
    while (this.gameOverTeam === null && this.tickCount < this.maxTicks) {
      await this.tick();
    }

    return {
      seed: this.seed,
      totalTicks: this.tickCount,
      winner: this.gameOverTeam,
      desyncCount: this.desyncCount,
      checksumsPassed: this.checksumsPassed,
    };
  }

  private async tick(): Promise<void> {
    // Confirm the future tick so the other side can advance
    const futureTick = this.tickCount + this.inputDelay;
    this.commandBuffer.confirmLocalTick(futureTick);
    this.send({ type: 'tick_confirm', tick: futureTick, playerId: this.team });

    // Wait until both sides have confirmed this tick
    await this.waitForTickReady(this.tickCount);

    // Execute any buffered commands for this tick
    const commands = this.commandBuffer.getCommandsForTick(this.tickCount);
    if (commands) {
      for (const cmd of commands) {
        executeCommand(cmd, this.cmdCtx, this.world);
      }
    }

    // Advance simulation
    this.buildingOccupancy.update(this.world);
    this.world.update(1 / 60);

    // Clean up voxel debris (no renderer)
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

    // Desync check
    const prevDesyncCount = this.desyncCount;
    this.desyncDetector.update(this.tickCount, this.world, this.resourceState);
    // If desync check ran this tick and no new desync was detected, count it as passed
    if (this.tickCount > 0 && this.tickCount % 300 === 0 && this.desyncCount === prevDesyncCount) {
      this.checksumsPassed++;
    }

    this.tickCount++;
  }

  private waitForTickReady(tick: number): Promise<void> {
    if (this.commandBuffer.canAdvanceTick(tick)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.tickReadyResolvers.set(tick, resolve);
    });
  }

  private checkTickReady(): void {
    for (const [tick, resolve] of this.tickReadyResolvers) {
      if (this.commandBuffer.canAdvanceTick(tick)) {
        resolve();
        this.tickReadyResolvers.delete(tick);
      }
    }
  }

  // --- Entity Spawning (identical to HeadlessEngine) ---

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

      this.world.addComponent<DepotRadiusComponent>(e, DEPOT_RADIUS, { radius: 8 });
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

    // Train set (1 engine + 2 cargo cars per team)
    for (const hq of hqSpawns) {
      const stub = getHQStubCell(hq.x, hq.z);
      const stubY = this.terrainData.getHeight(stub.worldX, stub.worldZ) + 0.1;
      spawnTrainSet(this.world, hq.team, stub.worldX, stubY, stub.worldZ, 2, stub.direction);
      initHQStubTrack(this.trackState, this.terrainData, hq.team, hq.x, hq.z);
    }
  }
}
