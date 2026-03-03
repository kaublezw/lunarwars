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
import { BuildSystem } from '@sim/systems/BuildSystem';
import { ProductionSystem } from '@sim/systems/ProductionSystem';
import { AISystem } from '@sim/systems/AISystem';
import { FogOfWarState } from '@sim/fog/FogOfWarState';
import { ResourceState } from '@sim/economy/ResourceState';
import { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { TerrainData } from '@sim/terrain/TerrainData';
import { generateEnergyNodes } from '@sim/terrain/MapFeatures';
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
import { DebrisRenderer } from '@render/effects/DebrisRenderer';
import { VoxelMeshManager } from '@render/VoxelMeshManager';
import { DepotRangeRenderer } from '@render/DepotRangeRenderer';
import { SupplySystem } from '@sim/systems/SupplySystem';
import { POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, TEAM, BUILDING, VISION, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND, PRODUCTION_QUEUE, SUPPLY_ROUTE, VOXEL_STATE, TURRET, MATTER_STORAGE } from '@sim/components/ComponentTypes';
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
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';

// --- Renderer ---
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

// --- Spectator Mode ---
const SPECTATOR_KEY = 'lunarwars_spectator';
const spectatorMode = sessionStorage.getItem(SPECTATOR_KEY) === 'true';

// --- Scenario Mode (URL param: ?scenario=tanks) ---
const scenarioMode = new URLSearchParams(window.location.search).get('scenario');

// --- Scene ---
const sceneManager = new SceneManager();
const isoCamera = new IsometricCamera(window.innerWidth, window.innerHeight);

// Zoom slider: slider value 10–200, mapping zoom = 210 - value
// (slider max at top = value 200 = zoom 10 = zoomed in; slider min at bottom = zoom out)
const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement | null;
if (zoomSlider) {
  zoomSlider.addEventListener('input', () => {
    isoCamera.setZoom(210 - Number(zoomSlider.value));
  });
}

// --- Save/Load Detection ---
const SAVE_KEY = 'lunarwars_save';
const savedRaw = sessionStorage.getItem(SAVE_KEY);
let saveData: {
  version: number;
  seed: number;
  world: ReturnType<World['serialize']>;
  resources: ReturnType<ResourceState['serialize']>;
  fogExplored: number[][];
  aiState: Record<string, unknown>;
  spectator?: boolean;
  aiState0?: Record<string, unknown>;
} | null = null;

if (savedRaw) {
  try {
    const parsed = JSON.parse(savedRaw);
    // Reject old saves or saves from mismatched mode
    if (parsed.version >= 12 && !!parsed.spectator === spectatorMode) {
      saveData = parsed;
    } else {
      sessionStorage.removeItem(SAVE_KEY);
    }
  } catch {
    sessionStorage.removeItem(SAVE_KEY);
  }
}

const seed = saveData ? saveData.seed : Math.floor(Math.random() * 2147483647);

// --- Terrain ---
const terrainData = new TerrainData({ seed });
const terrainVoxelRenderer = new TerrainVoxelRenderer(terrainData);
terrainVoxelRenderer.addTo(sceneManager.scene);

// --- Energy Nodes ---
const energyNodes = generateEnergyNodes(terrainData, seed);
const energyNodeRenderer = new EnergyNodeRenderer(energyNodes, terrainData);
energyNodeRenderer.addTo(sceneManager.scene);

// --- Minimap ---
const minimap = new Minimap(terrainData, energyNodes);
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

// System order: pathfinding -> collision avoidance -> movement -> fog -> turret -> resupply -> repair -> gameOver -> health -> economy -> supply -> build -> production -> AI
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

world.addSystem(pathfindingSystem);
world.addSystem(new CollisionAvoidanceSystem());
world.addSystem(movementSystem);
world.addSystem(new FogOfWarSystem(fogState));
world.addSystem(new TurretSystem());
world.addSystem(new ProjectileSystem());
world.addSystem(new VoxelDamageSystem());
world.addSystem(new ResupplySystem());
world.addSystem(new RepairSystem(resourceState, 2));
world.addSystem(gameOverSystem);
world.addSystem(new HealthSystem());
world.addSystem(new EconomySystem(resourceState, 2));
world.addSystem(new SupplySystem(terrainData, resourceState));
world.addSystem(new BuildSystem());
world.addSystem(new ProductionSystem(resourceState, terrainData));

// --- AI Systems (registered before potential restore, skip for sandbox) ---
let aiSystem0: AISystem | null = null;
let aiSystem: AISystem | null = null;
if (scenarioMode !== 'sandbox') {
  if (spectatorMode) {
    aiSystem0 = new AISystem(PLAYER_TEAM, resourceState, terrainData, fogState, energyNodes, buildingOccupancy);
    world.addSystem(aiSystem0);
  }
  aiSystem = new AISystem(AI_TEAM, resourceState, terrainData, fogState, energyNodes, buildingOccupancy);
  world.addSystem(aiSystem);
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

  // Production queue for HQ and Drone Factory
  if (type === BuildingType.HQ || type === BuildingType.DroneFactory) {
    world.addComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE, {
      queue: [],
      rallyX: x + 5,
      rallyZ: z + 5,
    });
  }

  // Matter storage for Supply Depot
  if (type === BuildingType.SupplyDepot) {
    world.addComponent<MatterStorageComponent>(e, MATTER_STORAGE, {
      stored: 100,
      capacity: 200,
    });
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
    if (aiSystem) aiSystem.deserialize(saveData.aiState);
    if (aiSystem0 && saveData.aiState0) {
      aiSystem0.deserialize(saveData.aiState0);
    }
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
      rallyX: hq.x + 5,
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

// --- Player Input (disabled in spectator mode) ---
let selectionController: SelectionController | null = null;
let placementController: PlacementController | null = null;

if (!spectatorMode && scenarioMode !== 'sandbox') {
  selectionController = new SelectionController(inputManager, isoCamera, world, eventBus);
  selectionController.setFogState(fogState, PLAYER_TEAM);

  placementController = new PlacementController(inputManager, isoCamera, terrainData, world, energyNodes, PLAYER_TEAM);
  selectionController.setPlacementCheck(() => placementController!.isActive());

  minimap.onRightClick = (worldX, worldZ) => {
    selectionController!.issueMoveTo(worldX, worldZ);
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
const buildingEffectsRenderer = new BuildingEffectsRenderer(sceneManager.scene, particleRenderer);
buildingEffectsRenderer.setFogState(fogState, initialFogTeam);
const debrisRenderer = new DebrisRenderer(sceneManager.scene, terrainData);
const voxelMeshManager = new VoxelMeshManager(sceneManager.scene);
voxelMeshManager.setFogState(fogState, initialFogTeam);
voxelMeshManager.setDebrisRenderer(debrisRenderer);
selectionRenderer.setVoxelMeshManager(voxelMeshManager);
const depotRangeRenderer = new DepotRangeRenderer(sceneManager.scene);
depotRangeRenderer.setPlayerTeam(initialFogTeam);

// Wire box select callbacks (only if player input active)
if (selectionController) {
  selectionController.onBoxSelectUpdate = (x0, y0, x1, y1) => boxSelectRenderer.show(x0, y0, x1, y1);
  selectionController.onBoxSelectEnd = () => boxSelectRenderer.hide();
}

// --- Wire Action Bar + Placement (player mode only) ---
if (actionBar && placementController) {
  actionBar.onBuildRequest((type) => {
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

    placementController!.enterPlacementMode(type);
  });

  actionBar.onTrainRequest((unitType) => {
    const def = UNIT_DEFS[unitType];
    if (!def) return;
    if (!resourceState.canAfford(PLAYER_TEAM, def.energyCost)) return;

    // Determine which building type trains this unit
    const targetBuildingType = unitType === UnitCategory.WorkerDrone
      ? BuildingType.HQ
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

      // Check and deduct matter from global pool
      if (def.matterCost > 0) {
        if (!resourceState.canAffordMatter(PLAYER_TEAM, def.matterCost)) continue;
        resourceState.spendMatter(PLAYER_TEAM, def.matterCost);
      }

      // Spend energy globally
      resourceState.spend(PLAYER_TEAM, def.energyCost);

      const pq = world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE)!;
      pq.queue.push({
        unitType,
        timeRemaining: def.trainTime,
        totalTime: def.trainTime,
      });
      break;
    }
  });

  placementController.onPlacementConfirmed((type, x, z) => {
    const def = BUILDING_DEFS[type];
    if (!def) return;
    if (!resourceState.canAfford(PLAYER_TEAM, def.energyCost)) return;

    // Find a selected worker for this team
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

    // Check and deduct matter from global pool
    if (def.matterCost > 0) {
      if (!resourceState.canAffordMatter(PLAYER_TEAM, def.matterCost)) return;
      resourceState.spendMatter(PLAYER_TEAM, def.matterCost);
    }

    // Deduct energy globally
    resourceState.spend(PLAYER_TEAM, def.energyCost);

    // Create construction site entity
    const site = world.createEntity();
    const siteY = terrainData.getHeight(x, z);

    world.addComponent<PositionComponent>(site, POSITION, {
      x, y: siteY, z,
      prevX: x, prevY: siteY, prevZ: z,
      rotation: 0,
    });

    world.addComponent<RenderableComponent>(site, RENDERABLE, {
      meshType: def.meshType,
      color: TEAM_COLORS[PLAYER_TEAM],
      scale: 1.0,
    });

    world.addComponent<TeamComponent>(site, TEAM, { team: PLAYER_TEAM });

    world.addComponent<BuildingComponent>(site, BUILDING, {
      buildingType: type as BuildingType,
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

    // Voxel state: start with first layer visible, rest destroyed — BuildSystem reveals progressively
    const finalModel = VOXEL_MODELS[def.meshType];
    if (finalModel) {
      const destroyedMask = new Uint8Array(Math.ceil(finalModel.totalSolid / 8));
      destroyedMask.fill(255);
      // Reveal the first Y layer immediately
      for (let i = 0; i < finalModel.firstLayerCount; i++) {
        const solidIdx = finalModel.buildOrder[i];
        destroyedMask[solidIdx >> 3] &= ~(1 << (solidIdx & 7));
      }
      world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
        modelId: def.meshType,
        totalVoxels: finalModel.totalSolid,
        destroyedCount: finalModel.totalSolid - finalModel.firstLayerCount,
        destroyed: destroyedMask,
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    // Cancel ferry if worker was ferrying
    if (world.hasComponent(workerEntity, SUPPLY_ROUTE)) {
      world.removeComponent(workerEntity, SUPPLY_ROUTE);
    }

    // Issue move command to worker
    world.addComponent<MoveCommandComponent>(workerEntity, MOVE_COMMAND, {
      path: [],
      currentWaypoint: 0,
      destX: x,
      destZ: z,
    });

    // Issue build command to worker
    world.addComponent<BuildCommandComponent>(workerEntity, BUILD_COMMAND, {
      buildingType: type,
      targetX: x,
      targetZ: z,
      state: 'moving',
      siteEntity: site,
    });

    ghostRenderer.hide();
  });

  placementController.onPlacementCancelled(() => {
    ghostRenderer.hide();
  });

  placementController.onPlacementUpdate((x, z, valid) => {
    ghostRenderer.update(
      placementController!.isActive(),
      placementController!.getBuildingType(),
      x, z, valid,
    );
  });
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
    depotRangeRenderer.sync(world);
    fogRenderer.update();
    energyNodeRenderer.update(fogState, currentFogTeam);
    minimap.update(fogState, currentFogTeam, world);
    unitInfoPanel.update(world);
    if (spectatorPanel) {
      spectatorPanel.update(resourceState);
    }
    if (actionBar) {
      actionBar.update(world, resourceState, PLAYER_TEAM);
    }
    if (resourceDisplay) {
      resourceDisplay.update(resourceState, PLAYER_TEAM);
    }
    if (sandboxPanel) {
      sandboxPanel.update();
    }
    renderer.render(sceneManager.scene, isoCamera.getCamera());

    if (zoomSlider) zoomSlider.value = String(Math.round(210 - isoCamera.getZoom()));

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
});

// --- Wire Sandbox Panel ---
let sandboxPanel: SandboxPanel | null = null;
if (scenarioMode === 'sandbox') {
  sandboxPanel = new SandboxPanel(
    world, terrainData, isoCamera, inputManager,
    spawnCombatUnit, spawnBuilding,
    sceneManager.scene, sceneManager.dirLight, sceneManager.ambientLight,
  );
  sandboxPanel.mount(app);

  sandboxPanel.onPlay = () => {
    // Create SelectionController for play mode (no fog check, all entities pickable)
    selectionController = new SelectionController(inputManager, isoCamera, world, eventBus);
    // Don't set fogState -- null fogState skips fog visibility checks
    selectionController.onBoxSelectUpdate = (x0, y0, x1, y1) => boxSelectRenderer.show(x0, y0, x1, y1);
    selectionController.onBoxSelectEnd = () => boxSelectRenderer.hide();
    minimap.onRightClick = (worldX, worldZ) => {
      selectionController!.issueMoveTo(worldX, worldZ);
    };

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

// --- Auto-Save (every 5 seconds, skip for sandbox) ---
if (scenarioMode !== 'sandbox') {
  setInterval(() => {
    try {
      const data: Record<string, unknown> = {
        version: 12,
        seed,
        spectator: spectatorMode,
        world: world.serialize(),
        resources: resourceState.serialize(),
        fogExplored: fogState.serializeExplored(),
        aiState: aiSystem ? aiSystem.serialize() : {},
      };
      if (aiSystem0) {
        data.aiState0 = aiSystem0.serialize();
      }
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
