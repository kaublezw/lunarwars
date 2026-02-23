import * as THREE from 'three';
import { SceneManager } from '@render/SceneManager';
import { IsometricCamera } from '@render/IsometricCamera';
import { TerrainRenderer } from '@render/terrain/TerrainRenderer';
import { StarfieldBackground } from '@render/terrain/StarfieldBackground';
import { SelectionRenderer } from '@render/SelectionRenderer';
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
import { ResupplySystem } from '@sim/systems/ResupplySystem';
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
import { ParticleRenderer } from '@render/effects/ParticleRenderer';
import { BuildingEffectsRenderer } from '@render/effects/BuildingEffectsRenderer';
import { SupplySystem } from '@sim/systems/SupplySystem';
import { POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, TEAM, BUILDING, VISION, BUILD_COMMAND, CONSTRUCTION, MOVE_COMMAND, PRODUCTION_QUEUE, SUPPLY_ROUTE } from '@sim/components/ComponentTypes';
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
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';

// --- Renderer ---
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

// --- Scene ---
const sceneManager = new SceneManager();
const isoCamera = new IsometricCamera(window.innerWidth, window.innerHeight);

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
} | null = null;

if (savedRaw) {
  try {
    const parsed = JSON.parse(savedRaw);
    // Reject saves from before the depot overhaul (version < 2)
    if (parsed.version >= 6) {
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
const terrainRenderer = new TerrainRenderer(terrainData);
terrainRenderer.addTo(sceneManager.scene);

// --- Starfield ---
const starfield = new StarfieldBackground();
starfield.addTo(sceneManager.scene);

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
const actionBar = new ActionBar();
actionBar.mount(app);
const resourceDisplay = new ResourceDisplay();
resourceDisplay.mount(app);
const gameOverOverlay = new GameOverOverlay(() => {
  sessionStorage.removeItem(SAVE_KEY);
  location.reload();
});
gameOverOverlay.mount(app);

// --- EventBus ---
const eventBus = new EventBus();

// --- Input ---
const inputManager = new InputManager(renderer.domElement);
const cameraController = new CameraController(inputManager, isoCamera);

// --- ECS World ---
const world = new World();

// --- Fog of War ---
const fogState = new FogOfWarState(256, 256, 2);

// --- Building Occupancy ---
const buildingOccupancy = new BuildingOccupancy(256, 256);

// Team colors: team 0 = blue, team 1 = red
const TEAM_COLORS = [0x4488ff, 0xff4444];
const PLAYER_TEAM = 0;
const AI_TEAM = 1;

// System order: pathfinding -> collision avoidance -> movement -> fog -> turret -> resupply -> gameOver -> health -> economy -> supply -> build -> production -> AI
const pathfindingSystem = new PathfindingSystem(terrainData);
pathfindingSystem.setOccupancy(buildingOccupancy);
const movementSystem = new MovementSystem(terrainData);
movementSystem.setOccupancy(buildingOccupancy);

const gameOverSystem = new GameOverSystem();
gameOverSystem.setCallback((losingTeam: number) => {
  gameLoop.stop();
  const playerWon = losingTeam !== PLAYER_TEAM;
  gameOverOverlay.show(playerWon);
  sessionStorage.removeItem(SAVE_KEY);
});

world.addSystem(pathfindingSystem);
world.addSystem(new CollisionAvoidanceSystem());
world.addSystem(movementSystem);
world.addSystem(new FogOfWarSystem(fogState));
world.addSystem(new TurretSystem());
world.addSystem(new ResupplySystem());
world.addSystem(gameOverSystem);
world.addSystem(new HealthSystem());
world.addSystem(new EconomySystem(resourceState, 2));
world.addSystem(new SupplySystem(terrainData, resourceState));
world.addSystem(new BuildSystem());
world.addSystem(new ProductionSystem(resourceState, terrainData));

// --- AI System (registered before potential restore) ---
const aiSystem = new AISystem(AI_TEAM, resourceState, terrainData, fogState, energyNodes, buildingOccupancy);
world.addSystem(aiSystem);

// --- Restore or Fresh Start ---
if (saveData) {
  try {
    world.deserialize(saveData.world);
    resourceState.deserialize(saveData.resources);
    fogState.deserializeExplored(saveData.fogExplored);
    aiSystem.deserialize(saveData.aiState);
  } catch (err) {
    console.error('Save restore failed, starting fresh:', err);
    sessionStorage.removeItem(SAVE_KEY);
    location.reload();
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

    // HQ no longer acts as a depot — global matter pool handles building/training costs
  }

  // --- Worker Drone Spawning (1 per team, near HQ) ---
  for (const hq of hqSpawns) {
    const e = world.createEntity();
    const wx = hq.x + 4;
    const wz = hq.z + 4;
    const wy = terrainData.getHeight(wx, wz) + 0.5;

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
  }
}

// --- Selection ---
const selectionController = new SelectionController(inputManager, isoCamera, world, eventBus);
selectionController.setFogState(fogState, PLAYER_TEAM);

// --- Placement Controller ---
const placementController = new PlacementController(inputManager, isoCamera, terrainData, world, energyNodes, PLAYER_TEAM);
selectionController.setPlacementCheck(() => placementController.isActive());

// --- Renderers ---
const renderSync = new RenderSync(sceneManager.scene);
renderSync.setFogState(fogState, PLAYER_TEAM);
const particleRenderer = new ParticleRenderer(sceneManager.scene);
renderSync.setParticleRenderer(particleRenderer);
const selectionRenderer = new SelectionRenderer(sceneManager.scene);
selectionRenderer.setFogState(fogState, PLAYER_TEAM);
const waypointRenderer = new WaypointRenderer(sceneManager.scene, eventBus, terrainData);
const boxSelectRenderer = new BoxSelectRenderer(app);
const fogRenderer = new FogRenderer(terrainData, fogState, PLAYER_TEAM);
fogRenderer.addTo(sceneManager.scene);
const ghostRenderer = new GhostBuildingRenderer(sceneManager.scene, terrainData);
const buildingEffectsRenderer = new BuildingEffectsRenderer(sceneManager.scene, particleRenderer);
buildingEffectsRenderer.setFogState(fogState, PLAYER_TEAM);
// Wire box select callbacks
selectionController.onBoxSelectUpdate = (x0, y0, x1, y1) => boxSelectRenderer.show(x0, y0, x1, y1);
selectionController.onBoxSelectEnd = () => boxSelectRenderer.hide();

// --- Wire Action Bar ---
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

  placementController.enterPlacementMode(type);
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

// --- Wire Placement Confirm ---
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
    x, y: siteY + 0.25, z,
    prevX: x, prevY: siteY + 0.25, prevZ: z,
    rotation: 0,
  });

  world.addComponent<RenderableComponent>(site, RENDERABLE, {
    meshType: 'construction_site',
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
    placementController.isActive(),
    placementController.getBuildingType(),
    x, z, valid,
  );
});

// --- Game Loop ---
const gameLoop = new GameLoop(
  (dt: number) => {
    buildingOccupancy.update(world);
    world.update(dt);
  },
  (alpha: number) => {
    cameraController.update(1 / 60);
    renderSync.sync(world, alpha);
    selectionRenderer.sync(world, alpha);
waypointRenderer.update(1 / 60);
    particleRenderer.update(1 / 60);
    buildingEffectsRenderer.update(world, 1 / 60);
    fogRenderer.update();
    energyNodeRenderer.update(fogState, PLAYER_TEAM);
    minimap.update(fogState, PLAYER_TEAM, world);
    unitInfoPanel.update(world);
    actionBar.update(world, resourceState, PLAYER_TEAM);
    resourceDisplay.update(resourceState, PLAYER_TEAM);
    renderer.render(sceneManager.scene, isoCamera.getCamera());
  }
);

// --- Resize ---
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  isoCamera.resize(w, h);
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

// --- Auto-Save (every 5 seconds) ---
setInterval(() => {
  try {
    const data = {
      version: 6,
      seed,
      world: world.serialize(),
      resources: resourceState.serialize(),
      fogExplored: fogState.serializeExplored(),
      aiState: aiSystem.serialize(),
    };
    sessionStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // sessionStorage full or serialization error — silently skip
  }
}, 5000);

// --- Start ---
renderSync.preload().catch((err) => {
  console.error('Model preload failed, starting anyway:', err);
}).finally(() => {
  gameLoop.start();
});
