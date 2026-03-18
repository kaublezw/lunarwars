import * as THREE from 'three';
import { SceneManager } from '@render/SceneManager';
import { IsometricCamera } from '@render/IsometricCamera';
import { TerrainVoxelRenderer } from '@render/terrain/TerrainVoxelRenderer';
import { SelectionRenderer } from '@render/SelectionRenderer';
import { XRayRenderer } from '@render/XRayRenderer';
import { WaypointRenderer } from '@render/WaypointRenderer';
import { BoxSelectRenderer } from '@render/BoxSelectRenderer';
import { FogRenderer } from '@render/FogRenderer';
import { GhostBuildingRenderer } from '@render/GhostBuildingRenderer';
import { InputManager } from '@input/InputManager';
import { CameraController } from '@input/CameraController';
import { SelectionController } from '@input/SelectionController';
import { PlacementController } from '@input/PlacementController';
import { World } from '@core/ECS';
import { GameLoop } from '@core/GameLoop';
import { EventBus } from '@core/EventBus';
import { RenderSync } from '@render/RenderSync';
import { EnergyNodeRenderer } from '@render/EnergyNodeRenderer';
import { GarageExitSystem } from '@sim/systems/GarageExitSystem';
import { PathfindingSystem } from '@sim/systems/PathfindingSystem';
import { CollisionAvoidanceSystem } from '@sim/systems/CollisionAvoidanceSystem';
import { MovementSystem } from '@sim/systems/MovementSystem';
import { FogOfWarSystem } from '@sim/systems/FogOfWarSystem';
import { TurretSystem } from '@sim/systems/TurretSystem';
import { VoxelDamageSystem } from '@sim/systems/VoxelDamageSystem';
import { ProjectileSystem } from '@sim/systems/ProjectileSystem';
import { ResupplySystem } from '@sim/systems/ResupplySystem';
import { RepairSystem } from '@sim/systems/RepairSystem';
import { GameOverSystem } from '@sim/systems/GameOverSystem';
import { HealthSystem } from '@sim/systems/HealthSystem';
import { EconomySystem } from '@sim/systems/EconomySystem';
import { SiloSystem } from '@sim/systems/SiloSystem';
import { EnergyPacketSystem } from '@sim/systems/EnergyPacketSystem';
import { BuildSystem } from '@sim/systems/BuildSystem';
import { ProductionSystem } from '@sim/systems/ProductionSystem';
import { AISystem } from '@sim/systems/AIBrain';
import { RLAISystem } from '@sim/systems/RLAISystem';
import { FogOfWarState } from '@sim/fog/FogOfWarState';
import { ResourceState } from '@sim/economy/ResourceState';
import { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { TerrainData } from '@sim/terrain/TerrainData';
import { generateEnergyNodes, generateOreDeposits } from '@sim/terrain/MapFeatures';
import type { OreDeposit } from '@sim/terrain/MapFeatures';
import { OreDepositRenderer } from '@render/OreDepositRenderer';
import { MatterPacketSystem } from '@sim/systems/MatterPacketSystem';
import { Minimap } from '@ui/Minimap';
import { UnitInfoPanel } from '@ui/UnitInfoPanel';
import { ActionBar } from '@ui/ActionBar';
import { ResourceDisplay } from '@ui/ResourceDisplay';
import { GameOverOverlay } from '@ui/GameOverOverlay';
import { PauseOverlay } from '@ui/PauseOverlay';
import { SandboxPanel } from '@ui/SandboxPanel';
import { PerfPanel } from '@ui/PerfPanel';
import { SpectatorPanel } from '@ui/SpectatorPanel';
import type { FogMode } from '@ui/SpectatorPanel';
import { ParticleRenderer } from '@render/effects/ParticleRenderer';
import { BuildingEffectsRenderer } from '@render/effects/BuildingEffectsRenderer';
import { GarageDoorRenderer } from '@render/effects/GarageDoorRenderer';
import { DebrisRenderer } from '@render/effects/DebrisRenderer';
import { VoxelMeshManager } from '@render/VoxelMeshManager';
import { DepotRangeRenderer } from '@render/DepotRangeRenderer';
import { SupplySystem } from '@sim/systems/SupplySystem';
import { SeededRandom } from '@sim/utils/SeededRandom';
import { POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, TEAM, BUILDING, VISION, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND, PRODUCTION_QUEUE, VOXEL_STATE, TURRET, MATTER_STORAGE, DEPOT_RADIUS } from '@sim/components/ComponentTypes';
import { BuildingType } from '@sim/components/Building';
import type { BuildingComponent } from '@sim/components/Building';
import { UnitCategory } from '@sim/components/UnitType';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { SteeringComponent } from '@sim/components/Steering';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { VisionComponent } from '@sim/components/Vision';
import type { TurretComponent } from '@sim/components/Turret';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import * as GameCommands from '@sim/commands/GameCommands';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { DepotRadiusComponent } from '@sim/components/DepotRadius';

// --- Renderer ---
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.localClippingEnabled = true;
app.appendChild(renderer.domElement);

// --- Replay Mode (URL param: ?replay=<seed>) ---
const replaySeedParam = new URLSearchParams(window.location.search).get('replay');
const replayMode = replaySeedParam !== null;

// --- RL Model Mode (URL param: ?rl) — trained model vs built-in AI spectator ---
const rlMode = new URLSearchParams(window.location.search).has('rl');

// --- Spectator Mode ---
const SPECTATOR_KEY = 'lunarwars_spectator';
const spectatorMode = replayMode || rlMode || sessionStorage.getItem(SPECTATOR_KEY) === 'true';

// --- Scenario Mode (URL param or sessionStorage) ---
const SANDBOX_KEY = 'lunarwars_sandbox';
const scenarioMode = new URLSearchParams(window.location.search).get('scenario')
  || (sessionStorage.getItem(SANDBOX_KEY) === 'true' ? 'sandbox' : null);

// --- Scene ---
const sceneManager = new SceneManager();
const isoCamera = new IsometricCamera(window.innerWidth, window.innerHeight);
isoCamera.setCanvas(renderer.domElement);


// --- Save/Load Detection ---
const SAVE_KEY = 'lunarwars_save';
const savedRaw = sessionStorage.getItem(SAVE_KEY);
let saveData: {
  version: number;
  seed: number;
  world: ReturnType<World['serialize']>;
  resources: ReturnType<ResourceState['serialize']>;
  fogExplored: number[][];
  spectator?: boolean;
} | null = null;

if (savedRaw && !replayMode) {
  try {
    const parsed = JSON.parse(savedRaw);
    // Reject old saves or saves from mismatched mode
    if (parsed.version >= 14 && !!parsed.spectator === spectatorMode) {
      saveData = parsed;
    } else {
      sessionStorage.removeItem(SAVE_KEY);
    }
  } catch {
    sessionStorage.removeItem(SAVE_KEY);
  }
}

const seed = replayMode
  ? (parseInt(replaySeedParam!, 10) || 1)
  : saveData ? saveData.seed : Math.floor(Math.random() * 2147483647);

// --- Terrain ---
const terrainData = new TerrainData({ seed });
const terrainVoxelRenderer = new TerrainVoxelRenderer(terrainData);
terrainVoxelRenderer.addTo(sceneManager.scene);

// --- Energy Nodes ---
const energyNodes = generateEnergyNodes(terrainData, seed);
const energyNodeRenderer = new EnergyNodeRenderer(energyNodes, terrainData);
energyNodeRenderer.addTo(sceneManager.scene);

// --- Ore Deposits ---
const oreDeposits = generateOreDeposits(terrainData, seed, energyNodes);
const oreDepositRenderer = new OreDepositRenderer(oreDeposits, terrainData);
oreDepositRenderer.addTo(sceneManager.scene);

// --- Minimap ---
const minimap = new Minimap(terrainData, energyNodes, oreDeposits);
minimap.mount(app);

// --- Unit Info Panel ---
const unitInfoPanel = new UnitInfoPanel();
unitInfoPanel.mount(app);

// --- UI: Action Bar & Resource Display ---
const resourceState = new ResourceState(2);
let actionBar: ActionBar | null = null;
let resourceDisplay: ResourceDisplay | null = null;
let spectatorPanel: SpectatorPanel | null = null;

if (spectatorMode) {
  spectatorPanel = new SpectatorPanel();
  spectatorPanel.mount(app);
} else if (!scenarioMode) {
  actionBar = new ActionBar();
  actionBar.mount(app);
  resourceDisplay = new ResourceDisplay();
  resourceDisplay.mount(app);
}

const perfPanel = new PerfPanel();
perfPanel.mount(app);

const gameOverOverlay = new GameOverOverlay(() => {
  sessionStorage.removeItem(SAVE_KEY);
  location.reload();
});
gameOverOverlay.mount(app);
const pauseOverlay = new PauseOverlay();
pauseOverlay.mount(app);

// --- EventBus ---
const eventBus = new EventBus();

// --- Input ---
const inputManager = new InputManager(renderer.domElement);
const cameraController = new CameraController(inputManager, isoCamera);

// --- ECS World ---
const world = new World();

// --- Fog of War ---
const fogState = new FogOfWarState(276, 276, 2, 25);

// --- Building Occupancy ---
const buildingOccupancy = new BuildingOccupancy(276, 276);

// Team colors: team 0 = blue, team 1 = red
const TEAM_COLORS = [0x4488ff, 0xff4444];
const PLAYER_TEAM = 0;
const AI_TEAM = 1;

// --- Seeded RNG for deterministic simulation ---
const simRng = new SeededRandom(seed * 9973);

// System order: pathfinding -> collision avoidance -> movement -> fog -> turret -> projectile -> voxelDamage -> resupply -> repair -> gameOver -> health -> energyPacket -> economy -> supply -> build -> production -> AI
const pathfindingSystem = new PathfindingSystem(terrainData);
pathfindingSystem.setOccupancy(buildingOccupancy);
const movementSystem = new MovementSystem(terrainData);
movementSystem.setOccupancy(buildingOccupancy);

let gameOver = false;
const gameOverSystem = new GameOverSystem();
if (scenarioMode === 'sandbox') {
  // No game over in sandbox
} else {
gameOverSystem.setCallback((losingTeam: number) => {
  gameOver = true;
  pauseOverlay.hide();
  gameLoop.stop();
  if (spectatorMode) {
    gameOverOverlay.showSpectator(losingTeam);
  } else {
    const playerWon = losingTeam !== PLAYER_TEAM;
    gameOverOverlay.show(playerWon);
  }
  sessionStorage.removeItem(SAVE_KEY);
});
}

world.addSystem(new GarageExitSystem());
world.addSystem(pathfindingSystem);
world.addSystem(new CollisionAvoidanceSystem(simRng));
world.addSystem(movementSystem);
world.addSystem(new FogOfWarSystem(fogState));
world.addSystem(new TurretSystem(simRng));
world.addSystem(new ProjectileSystem());
world.addSystem(new VoxelDamageSystem(simRng));
world.addSystem(new ResupplySystem());
world.addSystem(new RepairSystem(resourceState, 2));
world.addSystem(gameOverSystem);
world.addSystem(new HealthSystem());
world.addSystem(new EnergyPacketSystem(resourceState));
world.addSystem(new MatterPacketSystem(resourceState));
const siloSystem = new SiloSystem(resourceState, terrainData);
world.addSystem(siloSystem);
const economySystem = new EconomySystem(resourceState, 2, terrainData);
economySystem.setSiloSystem(siloSystem);
world.addSystem(economySystem);
world.addSystem(new SupplySystem(terrainData, resourceState));
world.addSystem(new BuildSystem());
world.addSystem(new ProductionSystem(resourceState, terrainData));
if (rlMode) {
  // RL mode: built-in AI for team 0 (PLAYER_TEAM), trained model for team 1 (AI_TEAM)
  world.addSystem(new AISystem(PLAYER_TEAM, resourceState, terrainData, fogState, energyNodes, oreDeposits, buildingOccupancy));
  world.addSystem(new RLAISystem(AI_TEAM, resourceState, terrainData, fogState, energyNodes, oreDeposits, buildingOccupancy));
} else {
  world.addSystem(new AISystem(AI_TEAM, resourceState, terrainData, fogState, energyNodes, oreDeposits, buildingOccupancy));
  if (spectatorMode) {
    world.addSystem(new AISystem(PLAYER_TEAM, resourceState, terrainData, fogState, energyNodes, oreDeposits, buildingOccupancy));
  }
}


// --- Scenario Helper: Spawn a combat unit ---
function spawnCombatUnit(x: number, z: number, team: number, category: UnitCategory): number {
  const def = UNIT_DEFS[category];
  if (!def) return -1;
  const y = terrainData.getHeight(x, z) + 0.02;
  const e = world.createEntity();
  world.addComponent<PositionComponent>(e, POSITION, {
    x, y, z, prevX: x, prevY: y, prevZ: z, rotation: 0,
  });
  world.addComponent<VelocityComponent>(e, VELOCITY, { x: 0, z: 0, speed: def.speed });
  world.addComponent<RenderableComponent>(e, RENDERABLE, {
    meshType: def.meshType, color: TEAM_COLORS[team] ?? 0xffffff, scale: 1.0,
  });
  world.addComponent<UnitTypeComponent>(e, UNIT_TYPE, { category: def.category, radius: def.radius });
  world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
  world.addComponent<SteeringComponent>(e, STEERING, { forceX: 0, forceZ: 0 });
  world.addComponent<HealthComponent>(e, HEALTH, { current: def.hp, max: def.hp, dead: false });
  world.addComponent<TeamComponent>(e, TEAM, { team });
  world.addComponent<VisionComponent>(e, VISION, { range: def.visionRange });
  const voxelModel = VOXEL_MODELS[def.meshType];
  if (voxelModel) {
    world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
      modelId: def.meshType,
      totalVoxels: voxelModel.totalSolid,
      destroyedCount: 0,
      destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }
  if (def.range != null) {
    world.addComponent<TurretComponent>(e, TURRET, {
      range: def.range,
      fireRate: def.fireRate ?? 1,
      cooldown: 0,
      targetEntity: -1,
      targetX: 0,
      targetZ: 0,
      firedThisFrame: false,
      damage: def.damage ?? 10,
      ammo: def.ammo ?? 50,
      maxAmmo: def.maxAmmo ?? def.ammo ?? 50,
      muzzleOffset: def.muzzleOffset ?? 0.5,
      muzzleHeight: def.muzzleHeight ?? 0.6,
      rotateBodyToTarget: false,
      turretRotation: 0,
      turretPitch: 0,
    });
  }
  return e;
}

// --- Scenario Helper: Spawn a fully-formed building ---
function spawnBuilding(x: number, z: number, team: number, type: BuildingType): number {
  const e = world.createEntity();
  const y = terrainData.getHeight(x, z);

  world.addComponent<PositionComponent>(e, POSITION, {
    x, y, z, prevX: x, prevY: y, prevZ: z, rotation: 0,
  });

  // HQ is special-cased; everything else uses BUILDING_DEFS
  const isHQ = type === BuildingType.HQ;
  const def = isHQ ? null : BUILDING_DEFS[type];
  const hp = isHQ ? 2000 : (def ? def.hp : 500);
  const meshType = isHQ ? 'hq' : (def ? def.meshType : type);
  const visionRange = isHQ ? 25 : (def ? def.visionRange : 10);

  world.addComponent<RenderableComponent>(e, RENDERABLE, {
    meshType, color: TEAM_COLORS[team] ?? 0xffffff, scale: 1.0,
  });
  world.addComponent<HealthComponent>(e, HEALTH, { current: hp, max: hp, dead: false });
  world.addComponent<TeamComponent>(e, TEAM, { team });
  world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
  world.addComponent<BuildingComponent>(e, BUILDING, { buildingType: type });
  world.addComponent<VisionComponent>(e, VISION, { range: visionRange });

  // Production queue for HQ, Drone Factory, and Supply Depot
  if (type === BuildingType.HQ || type === BuildingType.DroneFactory || type === BuildingType.SupplyDepot) {
    const isHQBuilding = type === BuildingType.HQ;
    world.addComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE, {
      queue: [],
      rallyX: isHQBuilding ? x : x + 5,
      rallyZ: isHQBuilding ? z + 5 : z + 5,
    });
  }

  // Matter storage for Supply Depot
  if (type === BuildingType.SupplyDepot) {
    world.addComponent<MatterStorageComponent>(e, MATTER_STORAGE, {
      stored: 100,
      capacity: 200,
    });
  }

  // HQ acts as fallback resupply point
  if (type === BuildingType.HQ) {
    world.addComponent<MatterStorageComponent>(e, MATTER_STORAGE, {
      stored: 0,
      capacity: 100,
    });
    world.addComponent<DepotRadiusComponent>(e, DEPOT_RADIUS, { radius: 8 });
  }

  // Voxel state
  const voxelModel = VOXEL_MODELS[meshType];
  if (voxelModel) {
    world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
      modelId: meshType,
      totalVoxels: voxelModel.totalSolid,
      destroyedCount: 0,
      destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }

  return e;
}

// --- Restore or Fresh Start ---
if (saveData) {
  try {
    world.deserialize(saveData.world);
    resourceState.deserialize(saveData.resources);
    fogState.deserializeExplored(saveData.fogExplored);
  } catch (err) {
    console.error('Save restore failed, starting fresh:', err);
    sessionStorage.removeItem(SAVE_KEY);
    location.reload();
  }
} else if (scenarioMode === 'sandbox') {
  // No entities spawned -- user places them via editor
} else if (scenarioMode === 'tanks') {
  // --- Scenario: 5v5 assault platforms ---
  for (let i = 0; i < 5; i++) {
    spawnCombatUnit(120, 124 + i * 2, 0, UnitCategory.AssaultPlatform);
    spawnCombatUnit(136, 124 + i * 2, 1, UnitCategory.AssaultPlatform);
  }
} else {
  // --- HQ Spawning ---
  const hqSpawns = [
    { x: 64, z: 64, team: 0 },
    { x: 192, z: 192, team: 1 },
  ];

  for (const hq of hqSpawns) {
    const e = world.createEntity();
    const y = terrainData.getHeight(hq.x, hq.z);

    world.addComponent<PositionComponent>(e, POSITION, {
      x: hq.x, y: y, z: hq.z,
      prevX: hq.x, prevY: y, prevZ: hq.z,
      rotation: 0,
    });

    world.addComponent<RenderableComponent>(e, RENDERABLE, {
      meshType: 'hq',
      color: TEAM_COLORS[hq.team],
      scale: 1.0,
    });

    world.addComponent<HealthComponent>(e, HEALTH, {
      current: 2000,
      max: 2000,
      dead: false,
    });

    world.addComponent<TeamComponent>(e, TEAM, { team: hq.team });

    world.addComponent<SelectableComponent>(e, SELECTABLE, {
      selected: false,
    });

    world.addComponent<BuildingComponent>(e, BUILDING, {
      buildingType: BuildingType.HQ,
    });

    world.addComponent<VisionComponent>(e, VISION, { range: 25 });

    // HQ has a production queue
    world.addComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE, {
      queue: [],
      rallyX: hq.x,
      rallyZ: hq.z + 5,
    });

    // Voxel state for voxel rendering
    const hqVoxelModel = VOXEL_MODELS['hq'];
    if (hqVoxelModel) {
      world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
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

  // --- Worker Drone Spawning (1 per team, near HQ) ---
  for (const hq of hqSpawns) {
    const e = world.createEntity();
    const wx = hq.x + 4;
    const wz = hq.z + 4;
    const wy = terrainData.getHeight(wx, wz) + 0.1;

    world.addComponent<PositionComponent>(e, POSITION, {
      x: wx, y: wy, z: wz,
      prevX: wx, prevY: wy, prevZ: wz,
      rotation: 0,
    });

    world.addComponent<VelocityComponent>(e, VELOCITY, {
      x: 0, z: 0, speed: 2,
    });

    world.addComponent<RenderableComponent>(e, RENDERABLE, {
      meshType: 'worker_drone',
      color: TEAM_COLORS[hq.team],
      scale: 1.0,
    });

    world.addComponent<UnitTypeComponent>(e, UNIT_TYPE, {
      category: UnitCategory.WorkerDrone,
      radius: 0.35,
    });

    world.addComponent<SelectableComponent>(e, SELECTABLE, {
      selected: false,
    });

    world.addComponent<SteeringComponent>(e, STEERING, {
      forceX: 0, forceZ: 0,
    });

    world.addComponent<HealthComponent>(e, HEALTH, {
      current: 80, max: 80, dead: false,
    });

    world.addComponent<TeamComponent>(e, TEAM, { team: hq.team });

    world.addComponent<VisionComponent>(e, VISION, { range: 12 });

    // Voxel state for voxel rendering
    const workerVoxelModel = VOXEL_MODELS['worker_drone'];
    if (workerVoxelModel) {
      world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
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

// Extra starting resources (on top of constructor's 100e/100m)
if (!saveData) {
  resourceState.addEnergy(0, 100);
  resourceState.addMatter(0, 100);
  resourceState.addEnergy(1, 100);
  resourceState.addMatter(1, 100);
}

// --- Player Input (disabled in spectator mode) ---
let selectionController: SelectionController | null = null;
let placementController: PlacementController | null = null;

if (!spectatorMode && scenarioMode !== 'sandbox') {
  selectionController = new SelectionController(inputManager, isoCamera, world, eventBus);
  selectionController.setFogState(fogState, PLAYER_TEAM);

  placementController = new PlacementController(inputManager, isoCamera, terrainData, world, energyNodes, oreDeposits, PLAYER_TEAM);
  selectionController.setPlacementCheck(() => placementController!.isActive());

  minimap.onRightClick = (worldX, worldZ) => {
    selectionController!.issueMoveTo(worldX, worldZ);
  };
  minimap.onLeftClick = (worldX, worldZ) => {
    isoCamera.setTarget(worldX, 0, worldZ);
  };
}

// --- Renderers ---
const initialFogTeam = (spectatorMode || scenarioMode) ? -1 : PLAYER_TEAM;
const renderSync = new RenderSync(sceneManager.scene);
renderSync.setFogState(fogState, initialFogTeam);
const particleRenderer = new ParticleRenderer(sceneManager.scene);
const selectionRenderer = new SelectionRenderer(sceneManager.scene);
selectionRenderer.setFogState(fogState, initialFogTeam);
selectionRenderer.setObjectGetter((e) => renderSync.getObject(e));
const xrayRenderer = new XRayRenderer(sceneManager.scene);
xrayRenderer.setFogState(fogState, initialFogTeam);
xrayRenderer.setObjectGetter((e) => renderSync.getObject(e));
xrayRenderer.setRenderer(renderer, isoCamera.getCamera());
const waypointRenderer = new WaypointRenderer(sceneManager.scene, eventBus, terrainData);
const boxSelectRenderer = new BoxSelectRenderer(app);
const fogRenderer = new FogRenderer(terrainData, fogState, PLAYER_TEAM);
fogRenderer.addTo(sceneManager.scene);
if (spectatorMode || scenarioMode) {
  fogRenderer.setVisible(false);
}
const ghostRenderer = new GhostBuildingRenderer(sceneManager.scene, terrainData);
const debrisRenderer = new DebrisRenderer(sceneManager.scene, terrainData);
const buildingEffectsRenderer = new BuildingEffectsRenderer(sceneManager.scene, particleRenderer, debrisRenderer);
buildingEffectsRenderer.setFogState(fogState, initialFogTeam);
const garageDoorRenderer = new GarageDoorRenderer(sceneManager.scene, debrisRenderer);
garageDoorRenderer.setFogState(fogState, initialFogTeam);
const voxelMeshManager = new VoxelMeshManager(sceneManager.scene);
voxelMeshManager.setFogState(fogState, initialFogTeam);
voxelMeshManager.setDebrisRenderer(debrisRenderer);
selectionRenderer.setVoxelMeshManager(voxelMeshManager);
xrayRenderer.setVoxelMeshManager(voxelMeshManager);
const depotRangeRenderer = new DepotRangeRenderer(sceneManager.scene);
depotRangeRenderer.setPlayerTeam(initialFogTeam);

// Wire box select callbacks (only if player input active)
if (selectionController) {
  selectionController.onBoxSelectUpdate = (x0, y0, x1, y1) => boxSelectRenderer.show(x0, y0, x1, y1);
  selectionController.onBoxSelectEnd = () => boxSelectRenderer.hide();
}

// --- Wire Action Bar + Placement ---
let wallWorkerEntity = -1; // captured when Wall button is clicked so it survives deselection during drag

function wireActionBarAndPlacement(ab: ActionBar, pc: PlacementController): void {
  const cmdCtx: GameCommands.GameCommandContext = {
    world,
    resources: resourceState,
    terrain: terrainData,
    energyNodes,
    oreDeposits,
  };

  ab.onBuildRequest((type) => {
    // Find a selected worker belonging to the player
    const selectables = world.query(SELECTABLE, UNIT_TYPE, TEAM);
    let workerEntity = -1;
    for (const e of selectables) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== PLAYER_TEAM) continue;
      const unit = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      if (unit.category === UnitCategory.WorkerDrone) {
        // Skip workers already building something
        if (world.hasComponent(e, BUILD_COMMAND)) continue;
        workerEntity = e;
        break;
      }
    }
    if (workerEntity === -1) return;

    // Check energy cost
    const def = BUILDING_DEFS[type];
    if (!def) return;
    if (!resourceState.canAfford(PLAYER_TEAM, def.energyCost)) return;

    if (type === BuildingType.Wall) {
      wallWorkerEntity = workerEntity;
      pc.enterWallPlacementMode();
    } else {
      pc.enterPlacementMode(type);
    }
  });

  pc.setWallMaxSegments(() => {
    const def = BUILDING_DEFS[BuildingType.Wall];
    if (!def || def.matterCost === 0) return Infinity;
    const matter = resourceState.get(PLAYER_TEAM).matter;
    return Math.floor(matter / def.matterCost);
  });

  ab.onTrainRequest((unitType) => {
    // Determine which building type trains this unit
    const targetBuildingType = unitType === UnitCategory.WorkerDrone
      ? BuildingType.HQ
      : unitType === UnitCategory.FerryDrone
        ? BuildingType.SupplyDepot
        : BuildingType.DroneFactory;

    // Find selected building of the right type
    const selectables = world.query(SELECTABLE, BUILDING, TEAM, PRODUCTION_QUEUE, POSITION);
    for (const e of selectables) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== PLAYER_TEAM) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== targetBuildingType) continue;

      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      GameCommands.trainUnit(cmdCtx, PLAYER_TEAM, e, unitType as UnitCategory, pos.x, pos.z + 5);
      break;
    }
  });

  ab.onDemolishRequest((entity) => {
    // Verify entity is a valid non-HQ building belonging to player
    const building = world.getComponent<BuildingComponent>(entity, BUILDING);
    if (!building || building.buildingType === BuildingType.HQ) return;
    const team = world.getComponent<TeamComponent>(entity, TEAM);
    if (!team || team.team !== PLAYER_TEAM) return;
    // Don't demolish buildings still under construction
    if (world.hasComponent(entity, CONSTRUCTION)) return;

    // Refund 70% of matter cost
    const def = BUILDING_DEFS[building.buildingType];
    if (def) {
      const refund = Math.floor(def.matterCost * 0.7);
      resourceState.get(PLAYER_TEAM).matter += refund;
    }

    world.destroyEntity(entity);
  });

  pc.onPlacementConfirmed((type, x, z) => {
    // Find a selected idle worker for this team
    const selectables = world.query(SELECTABLE, UNIT_TYPE, TEAM);
    let workerEntity = -1;
    for (const e of selectables) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== PLAYER_TEAM) continue;
      const unit = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      if (unit.category === UnitCategory.WorkerDrone && !world.hasComponent(e, BUILD_COMMAND)) {
        workerEntity = e;
        break;
      }
    }
    if (workerEntity === -1) return;

    GameCommands.buildStructure(cmdCtx, PLAYER_TEAM, type as BuildingType, x, z, workerEntity);
    ghostRenderer.hide();
  });

  pc.onPlacementCancelled(() => {
    ghostRenderer.hide();
  });

  pc.onPlacementUpdate((x, z, valid) => {
    ghostRenderer.update(
      pc.isActive(),
      pc.getBuildingType(),
      x, z, valid,
    );
  });

  // --- Wall placement callbacks ---

  pc.onWallPlacementConfirmed((segments) => {
    // Use the worker captured when Wall button was clicked (survives deselection during drag)
    const workerEntity = wallWorkerEntity;
    wallWorkerEntity = -1;
    if (workerEntity === -1) return;
    // Verify the worker is still alive
    if (!world.getComponent<PositionComponent>(workerEntity, POSITION)) return;

    GameCommands.buildWallSegments(cmdCtx, PLAYER_TEAM, segments as GameCommands.WallSegment[], workerEntity);
    ghostRenderer.hideWall();
  });

  pc.onWallPlacementUpdate((segments) => {
    ghostRenderer.updateWall(segments);
  });

  pc.onWallPlacementCancelled(() => {
    ghostRenderer.hideWall();
  });
}

// Call for normal game mode
if (actionBar && placementController) {
  wireActionBarAndPlacement(actionBar, placementController);
}

// --- Wire Spectator Panel ---
let currentFogTeam = initialFogTeam;

function setFogPerspective(team: number): void {
  currentFogTeam = team;
  renderSync.setPlayerTeam(team);
  voxelMeshManager.setPlayerTeam(team);
  selectionRenderer.setPlayerTeam(team);
  xrayRenderer.setPlayerTeam(team);
  buildingEffectsRenderer.setPlayerTeam(team);
  garageDoorRenderer.setPlayerTeam(team);
  depotRangeRenderer.setPlayerTeam(team);
  if (team < 0) {
    fogRenderer.setVisible(false);
  } else {
    fogRenderer.setPlayerTeam(team);
    fogRenderer.setVisible(true);
  }
}

if (spectatorPanel) {
  spectatorPanel.onSpeedChange = (scale: number) => {
    gameLoop.setTimeScale(scale);
  };

  spectatorPanel.onFogChange = (mode: FogMode) => {
    switch (mode) {
      case 'none': setFogPerspective(-1); break;
      case 'team0': setFogPerspective(0); break;
      case 'team1': setFogPerspective(1); break;
    }
  };
}

// --- Frame Timing ---
let lastFrameTime = performance.now();

// --- Game Loop ---
const gameLoop = new GameLoop(
  (dt: number) => {
    buildingOccupancy.update(world);
    world.update(dt);
  },
  (alpha: number) => {
    cameraController.update(1 / 60);
    voxelMeshManager.sync(world, alpha);
    renderSync.sync(world, alpha);
    selectionRenderer.sync(world, alpha);
    xrayRenderer.sync(world, alpha);
    waypointRenderer.update(1 / 60);
    particleRenderer.update(1 / 60);
    debrisRenderer.update(1 / 60);
    buildingEffectsRenderer.update(world, 1 / 60);
    garageDoorRenderer.update(world, 1 / 60);
    depotRangeRenderer.sync(world);
    fogRenderer.update();
    energyNodeRenderer.update(fogState, currentFogTeam);
    oreDepositRenderer.update(fogState, currentFogTeam);
    minimap.update(fogState, currentFogTeam, world);
    unitInfoPanel.update(world);
    if (spectatorPanel) {
      spectatorPanel.update(resourceState);
    }
    if (actionBar) {
      actionBar.update(world, resourceState, PLAYER_TEAM);
    }
    if (resourceDisplay) {
      resourceDisplay.update(resourceState, PLAYER_TEAM, gameLoop.getTickCount());
    }
    if (sandboxPanel) {
      sandboxPanel.update();
      if (sandboxPanel.getMode() === 'play') {
        for (let t = 0; t < 2; t++) {
          const res = resourceState.get(t);
          if (res.energy < 100000) res.energy += 100000;
          if (res.matter < 100000) res.matter += 100000;
        }
      }
    }
    if (tickLabel) {
      tickLabel.textContent = `Tick: ${gameLoop.getTickCount()}`;
    }
    renderer.render(sceneManager.scene, isoCamera.getCamera());


    const now = performance.now();
    const frameDelta = now - lastFrameTime;
    lastFrameTime = now;
    const fps = frameDelta > 0 ? 1000 / frameDelta : 60;
    perfPanel.update(fps, renderer.info, world.getEntities().length, debrisRenderer.getActiveCount());
  }
);

// --- Pause Toggle (P key) ---
inputManager.onKeyDown((key: string) => {
  if (key === 'f3') {
    perfPanel.toggle();
  }
  if (key === 'p' && !gameOver) {
    gameLoop.togglePause();
    if (gameLoop.isPaused()) {
      pauseOverlay.show();
    } else {
      pauseOverlay.hide();
    }
  }
  // Toggle fog of war visibility (player mode only)
  if (key === 'f' && !spectatorMode && !scenarioMode) {
    if (currentFogTeam >= 0) {
      setFogPerspective(-1);
    } else {
      setFogPerspective(PLAYER_TEAM);
    }
  }
});

// --- Wire Sandbox Panel ---
let sandboxPanel: SandboxPanel | null = null;
if (scenarioMode === 'sandbox') {
  sandboxPanel = new SandboxPanel(
    world, terrainData, isoCamera, inputManager,
    spawnCombatUnit, spawnBuilding, ghostRenderer,
    sceneManager.scene, sceneManager.dirLight, sceneManager.ambientLight,
  );
  sandboxPanel.mount(app);

  sandboxPanel.onSpawnWallSegments = (segments, team) => {
    for (const seg of segments) {
      const e = spawnBuilding(seg.x, seg.z, team, BuildingType.Wall);
      // Fix meshType to match the segment orientation (spawnBuilding defaults to wall_x)
      if (seg.meshType !== 'wall_x') {
        const renderable = world.getComponent<RenderableComponent>(e, RENDERABLE);
        if (renderable) {
          renderable.meshType = seg.meshType;
        }
        const vs = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
        if (vs) {
          vs.modelId = seg.meshType;
          const voxelModel = VOXEL_MODELS[seg.meshType];
          if (voxelModel) {
            vs.totalVoxels = voxelModel.totalSolid;
            vs.destroyed = new Uint8Array(Math.ceil(voxelModel.totalSolid / 8));
            vs.destroyedCount = 0;
            vs.dirty = true;
          }
        }
      }
    }
  };

  // Snapshot for revert (captured before play starts)
  let sandboxSnapshot: { world: ReturnType<typeof world.serialize>; resources: ReturnType<typeof resourceState.serialize> } | null = null;

  sandboxPanel.onPlay = () => {
    // Deep-copy current state so Revert can restore it
    sandboxSnapshot = structuredClone({
      world: world.serialize(),
      resources: resourceState.serialize(),
    });

    // Create SelectionController for play mode (no fog check, all entities pickable)
    selectionController = new SelectionController(inputManager, isoCamera, world, eventBus);
    selectionController.onBoxSelectUpdate = (x0, y0, x1, y1) => boxSelectRenderer.show(x0, y0, x1, y1);
    selectionController.onBoxSelectEnd = () => boxSelectRenderer.hide();
    minimap.onRightClick = (worldX, worldZ) => {
      selectionController!.issueMoveTo(worldX, worldZ);
    };
    minimap.onLeftClick = (worldX, worldZ) => {
      isoCamera.setTarget(worldX, 0, worldZ);
    };

    // Create PlacementController + ActionBar for sandbox play mode
    placementController = new PlacementController(inputManager, isoCamera, terrainData, world, energyNodes, oreDeposits, PLAYER_TEAM);
    selectionController.setPlacementCheck(() => placementController!.isActive());

    if (!actionBar) {
      actionBar = new ActionBar();
      actionBar.mount(app);
    }
    if (!resourceDisplay) {
      resourceDisplay = new ResourceDisplay();
      resourceDisplay.mount(app);
    }

    // Grant effectively infinite resources for sandbox
    for (let t = 0; t < 2; t++) {
      const res = resourceState.get(t);
      res.energy += 999999;
      res.matter += 999999;
    }

    // Auto-spawn a worker if player team has none
    const units = world.query(UNIT_TYPE, TEAM);
    let hasWorker = false;
    for (const e of units) {
      const unit = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team === PLAYER_TEAM && unit.category === UnitCategory.WorkerDrone) {
        hasWorker = true;
        break;
      }
    }
    if (!hasWorker) {
      spawnCombatUnit(128, 128, PLAYER_TEAM, UnitCategory.WorkerDrone);
    }

    // Wire all action bar + placement callbacks (shared with normal game mode)
    wireActionBarAndPlacement(actionBar, placementController);

    gameLoop.togglePause(); // unpause
    pauseOverlay.hide();
  };

  sandboxPanel.onPause = () => {
    gameLoop.togglePause();
    if (gameLoop.isPaused()) {
      pauseOverlay.show();
    } else {
      pauseOverlay.hide();
    }
  };

  sandboxPanel.onSpeedChange = (scale: number) => {
    gameLoop.setTimeScale(scale);
  };

  sandboxPanel.onSelectAll = () => {
    const selectables = world.query(SELECTABLE);
    for (const e of selectables) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      sel.selected = true;
    }
  };

  sandboxPanel.onClearAll = () => {
    const allEntities = world.getEntities();
    for (const e of allEntities) {
      world.destroyEntity(e);
    }
  };

  sandboxPanel.onGiveResources = () => {
    for (let t = 0; t < 2; t++) {
      resourceState.addEnergy(t, 1000);
      resourceState.addMatter(t, 1000);
    }
  };

  sandboxPanel.onRevert = () => {
    if (!sandboxSnapshot) return;

    // Clear all renderer caches so they rebuild from fresh ECS state
    voxelMeshManager.clearAll();
    renderSync.clearAll();
    garageDoorRenderer.clearAll();
    buildingEffectsRenderer.clearAll();

    // Restore world and resources to pre-play state
    world.deserialize(sandboxSnapshot.world);
    resourceState.deserialize(sandboxSnapshot.resources);
    sandboxSnapshot = null;

    // Mark all voxel states dirty so renderers rebuild geometry
    const voxelEntities = world.query(VOXEL_STATE);
    for (const e of voxelEntities) {
      const vs = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
      if (vs) vs.dirty = true;
    }

    // Pause and switch back to editor mode
    if (!gameLoop.isPaused()) {
      gameLoop.togglePause();
    }
    gameLoop.setTimeScale(1);
    pauseOverlay.show();
    sandboxPanel!.enterEditorMode();
  };

  sandboxPanel.onReset = () => {
    location.reload();
  };
}

// --- Resize ---
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  isoCamera.resize(w, h);
  xrayRenderer.resize();
});

// --- Restart Button ---
const restartBtn = document.createElement('button');
restartBtn.textContent = 'Restart';
restartBtn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:1000;padding:6px 16px;background:#333;color:#eee;border:1px solid #666;border-radius:4px;cursor:pointer;font-family:monospace;font-size:14px;';
restartBtn.addEventListener('mouseenter', () => { restartBtn.style.background = '#555'; });
restartBtn.addEventListener('mouseleave', () => { restartBtn.style.background = '#333'; });
restartBtn.addEventListener('click', () => {
  sessionStorage.removeItem(SAVE_KEY);
  location.reload();
});
document.body.appendChild(restartBtn);

// --- AI vs AI Toggle Button ---
const modeBtn = document.createElement('button');
modeBtn.textContent = spectatorMode ? 'Play Normal' : 'Watch AI vs AI';
modeBtn.style.cssText = 'position:fixed;top:10px;right:100px;z-index:1000;padding:6px 16px;background:#2a3a5a;color:#aaccff;border:1px solid #4466aa;border-radius:4px;cursor:pointer;font-family:monospace;font-size:14px;';
modeBtn.addEventListener('mouseenter', () => { modeBtn.style.background = '#3a4a6a'; });
modeBtn.addEventListener('mouseleave', () => { modeBtn.style.background = '#2a3a5a'; });
modeBtn.addEventListener('click', () => {
  sessionStorage.removeItem(SAVE_KEY);
  if (spectatorMode) {
    sessionStorage.removeItem(SPECTATOR_KEY);
  } else {
    sessionStorage.setItem(SPECTATOR_KEY, 'true');
  }
  location.reload();
});
document.body.appendChild(modeBtn);

// --- Sandbox Toggle Button ---
const sandboxBtn = document.createElement('button');
sandboxBtn.textContent = scenarioMode === 'sandbox' ? 'Exit Sandbox' : 'Sandbox';
sandboxBtn.style.cssText = 'position:fixed;top:10px;right:250px;z-index:1000;padding:6px 16px;background:#3a2a1a;color:#ffcc88;border:1px solid #aa7744;border-radius:4px;cursor:pointer;font-family:monospace;font-size:14px;';
sandboxBtn.addEventListener('mouseenter', () => { sandboxBtn.style.background = '#4a3a2a'; });
sandboxBtn.addEventListener('mouseleave', () => { sandboxBtn.style.background = '#3a2a1a'; });
sandboxBtn.addEventListener('click', () => {
  sessionStorage.removeItem(SAVE_KEY);
  if (scenarioMode === 'sandbox') {
    sessionStorage.removeItem(SANDBOX_KEY);
  } else {
    sessionStorage.setItem(SANDBOX_KEY, 'true');
    sessionStorage.removeItem(SPECTATOR_KEY);
  }
  location.reload();
});
document.body.appendChild(sandboxBtn);

// --- Seed Display ---
const seedLabel = document.createElement('span');
seedLabel.textContent = `Seed: ${seed}`;
seedLabel.style.cssText = 'position:fixed;top:14px;right:370px;z-index:1000;color:#888;font-family:monospace;font-size:12px;';
document.body.appendChild(seedLabel);

// --- Tick Counter (replay mode only) ---
let tickLabel: HTMLSpanElement | null = null;
if (replayMode || rlMode) {
  tickLabel = document.createElement('span');
  tickLabel.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:1000;color:#fff;font-family:monospace;font-size:14px;';
  document.body.appendChild(tickLabel);
}

// --- Auto-Save (every 5 seconds, skip for sandbox) ---
if (scenarioMode !== 'sandbox') {
  setInterval(() => {
    try {
      const data: Record<string, unknown> = {
        version: 14,
        seed,
        spectator: spectatorMode,
        world: world.serialize(),
        resources: resourceState.serialize(),
        fogExplored: fogState.serializeExplored(),
      };
      sessionStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      // sessionStorage full or serialization error — silently skip
    }
  }, 5000);
}

// --- Scenario camera setup ---
if (scenarioMode) {
  isoCamera.setTarget(128, 0, 128);
  isoCamera.setZoom(15);
}

// --- Start ---
renderSync.preload().catch((err) => {
  console.error('Model preload failed, starting anyway:', err);
}).finally(() => {
  gameLoop.start();
  // Sandbox starts paused (editor mode)
  if (scenarioMode === 'sandbox') {
    gameLoop.togglePause();
  }
});
