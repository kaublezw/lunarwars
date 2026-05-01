import type { World } from '@core/ECS';
import {
  POSITION, RENDERABLE, UNIT_TYPE, SELECTABLE, HEALTH, TEAM, VISION,
  VOXEL_STATE, TRAIN_LINK, TRACK_FOLLOWER, CARGO_STORAGE, MACRO_GRID_SIZE,
  PENDING_CAR_ATTACH, MOVE_COMMAND,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { UnitCategory } from '@sim/components/UnitType';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { VisionComponent } from '@sim/components/Vision';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import type { CargoStorageComponent } from '@sim/components/CargoStorage';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const CAR_SPACING = 2.0; // world units between each linked entity (matches TrainMovementSystem)

/** Grid cells behind the engine (covers cargo cars trailing behind). */
export const STUB_BEHIND_CELLS = 2;
/** Grid cells ahead of the engine (runway before entering A* circuit). */
export const STUB_AHEAD_CELLS = 1;

/** Direction deltas: 0=North(-Z), 1=East(+X), 2=South(+Z), 3=West(-X) */
export const DIR_DX = [0, 1, 0, -1];
export const DIR_DZ = [-1, 0, 1, 0];

/**
 * Spawn a train set (1 engine + N cargo cars) at the given position.
 * All entities are linked via TrainLink. The engine gets a TrackFollower.
 * If stubDirection is provided, engine faces that direction, cars trail opposite,
 * and the follower starts halted (for the initial HQ stub track).
 * Returns [engineEntity, ...carEntities].
 */
export function spawnTrainSet(
  world: World,
  team: number,
  x: number,
  y: number,
  z: number,
  carCount: number,
  stubDirection?: number,
): number[] {
  const engineDef = UNIT_DEFS[UnitCategory.TrainEngine];
  const carDef = UNIT_DEFS[UnitCategory.CargoCar];
  const color = TEAM_COLORS[team] ?? 0xffffff;

  // Spawn engine
  const engine = world.createEntity();
  const engineRotation = stubDirection != null
    ? Math.atan2(DIR_DX[stubDirection], DIR_DZ[stubDirection])
    : 0;
  world.addComponent<PositionComponent>(engine, POSITION, {
    x, y, z, prevX: x, prevY: y, prevZ: z, rotation: engineRotation,
  });
  world.addComponent<RenderableComponent>(engine, RENDERABLE, {
    meshType: engineDef.meshType, color, scale: 1.0,
  });
  world.addComponent<UnitTypeComponent>(engine, UNIT_TYPE, {
    category: UnitCategory.TrainEngine, radius: engineDef.radius,
  });
  world.addComponent<SelectableComponent>(engine, SELECTABLE, { selected: false });
  world.addComponent<HealthComponent>(engine, HEALTH, {
    current: engineDef.hp, max: engineDef.hp, dead: false,
  });
  world.addComponent<TeamComponent>(engine, TEAM, { team });
  world.addComponent<VisionComponent>(engine, VISION, { range: engineDef.visionRange });

  const engineVoxel = VOXEL_MODELS[engineDef.meshType];
  if (engineVoxel) {
    world.addComponent<VoxelStateComponent>(engine, VOXEL_STATE, {
      modelId: engineDef.meshType,
      totalVoxels: engineVoxel.totalSolid,
      destroyedCount: 0,
      destroyed: new Uint8Array(Math.ceil(engineVoxel.totalSolid / 8)),
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }

  // TrackFollower on the engine (empty path until TrackManagerSystem fills it,
  // or halted on the stub track if stubDirection is provided)
  world.addComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER, {
    path: [],
    currentWaypointIndex: 0,
    distanceAlongSegment: 0,
    direction: 1,
    reconnectTarget: -1,
    halted: stubDirection != null,
    currentSpeed: 0,
  });

  // TrainLink for the engine (head of the chain)
  world.addComponent<TrainLinkComponent>(engine, TRAIN_LINK, {
    nextEntity: null,
    prevEntity: null,
    isEngine: true,
  });

  const entities: number[] = [engine];
  let prevEntity = engine;

  // Spawn cargo cars (trail behind engine opposite to stub direction, or along +Z by default)
  for (let i = 0; i < carCount; i++) {
    const offset = CAR_SPACING * (i + 1);
    const carX = stubDirection != null ? x - DIR_DX[stubDirection] * offset : x;
    const carZ = stubDirection != null ? z - DIR_DZ[stubDirection] * offset : z + offset;

    const car = world.createEntity();
    world.addComponent<PositionComponent>(car, POSITION, {
      x: carX, y, z: carZ, prevX: carX, prevY: y, prevZ: carZ, rotation: 0,
    });
    world.addComponent<RenderableComponent>(car, RENDERABLE, {
      meshType: carDef.meshType, color, scale: 1.0,
    });
    world.addComponent<UnitTypeComponent>(car, UNIT_TYPE, {
      category: UnitCategory.CargoCar, radius: carDef.radius,
    });
    world.addComponent<SelectableComponent>(car, SELECTABLE, { selected: false });
    world.addComponent<HealthComponent>(car, HEALTH, {
      current: carDef.hp, max: carDef.hp, dead: false,
    });
    world.addComponent<TeamComponent>(car, TEAM, { team });
    world.addComponent<VisionComponent>(car, VISION, { range: carDef.visionRange });

    const carVoxel = VOXEL_MODELS[carDef.meshType];
    if (carVoxel) {
      world.addComponent<VoxelStateComponent>(car, VOXEL_STATE, {
        modelId: carDef.meshType,
        totalVoxels: carVoxel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(carVoxel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    world.addComponent<CargoStorageComponent>(car, CARGO_STORAGE, {
      current: 0,
      capacity: 200,
      committedType: null,
    });

    // TrainLink: link to previous entity
    world.addComponent<TrainLinkComponent>(car, TRAIN_LINK, {
      nextEntity: null,
      prevEntity: prevEntity,
      isEngine: false,
    });

    // Update previous entity's next pointer
    const prevLink = world.getComponent<TrainLinkComponent>(prevEntity, TRAIN_LINK)!;
    prevLink.nextEntity = car;

    entities.push(car);
    prevEntity = car;
  }

  return entities;
}

/**
 * Append a cargo car entity to the tail of an existing train chain.
 * The car must already have TrainLink and CargoStorage components.
 */
export function appendCarToTrain(world: World, engineEntity: number, carEntity: number): void {
  // Walk to the tail of the chain
  let tail = engineEntity;
  while (true) {
    const link = world.getComponent<TrainLinkComponent>(tail, TRAIN_LINK);
    if (!link || link.nextEntity == null) break;
    tail = link.nextEntity;
  }

  const tailLink = world.getComponent<TrainLinkComponent>(tail, TRAIN_LINK);
  if (tailLink) tailLink.nextEntity = carEntity;

  const carLink = world.getComponent<TrainLinkComponent>(carEntity, TRAIN_LINK);
  if (carLink) {
    carLink.prevEntity = tail;
    carLink.nextEntity = null;
  }
}

/**
 * Gather every alive cargo car on the team that is not already linked to this
 * engine, teleport each to a chained slot behind the engine on the stub, and
 * append them to the engine's TrainLink chain. Used right after a new engine
 * is spawned so orphans (cars whose old engine died) and PENDING_CAR_ATTACH
 * cars are immediately reunited with the new engine.
 *
 * Iterates entities in id-sorted order for determinism (multiplayer lockstep,
 * replays).
 */
export function attachOrphansAndPendingToEngine(
  world: World,
  team: number,
  engine: number,
  terrainHeightAt: (x: number, z: number) => number,
  stubDirection: number,
): void {
  const enginePos = world.getComponent<PositionComponent>(engine, POSITION);
  if (!enginePos) return;

  const candidates: number[] = [];
  const all = world.query(TRAIN_LINK, TEAM, HEALTH, POSITION);
  for (const e of all) {
    if (e === engine) continue;
    const link = world.getComponent<TrainLinkComponent>(e, TRAIN_LINK)!;
    if (link.isEngine) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const h = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (h.dead) continue;
    candidates.push(e);
  }
  candidates.sort((a, b) => a - b);

  const dx = DIR_DX[stubDirection] ?? 0;
  const dz = DIR_DZ[stubDirection] ?? 1;

  for (let i = 0; i < candidates.length; i++) {
    const car = candidates[i];
    const offset = CAR_SPACING * (i + 1);
    const x = enginePos.x - dx * offset;
    const z = enginePos.z - dz * offset;
    const y = terrainHeightAt(x, z) + 0.1;

    const carPos = world.getComponent<PositionComponent>(car, POSITION)!;
    carPos.x = x;
    carPos.z = z;
    carPos.y = y;
    carPos.prevX = x;
    carPos.prevZ = z;
    carPos.prevY = y;
    carPos.rotation = enginePos.rotation;

    if (world.hasComponent(car, MOVE_COMMAND)) {
      world.removeComponent(car, MOVE_COMMAND);
    }
    if (world.hasComponent(car, PENDING_CAR_ATTACH)) {
      world.removeComponent(car, PENDING_CAR_ATTACH);
    }

    appendCarToTrain(world, engine, car);
  }
}

/**
 * Check if a team already has a living TrainEngine.
 */
export function teamHasEngine(world: World, team: number): boolean {
  const entities = world.query(TRAIN_LINK, TEAM);
  for (const e of entities) {
    const link = world.getComponent<TrainLinkComponent>(e, TRAIN_LINK)!;
    if (!link.isEngine) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const h = world.getComponent<HealthComponent>(e, HEALTH);
    if (h && h.dead) continue;
    return true;
  }
  return false;
}

/**
 * Check if a TrainEngine is queued in any production building for this team.
 */
export function engineInProduction(world: World, team: number): boolean {
  const producers = world.query(PRODUCTION_QUEUE, TEAM);
  for (const e of producers) {
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const pq = world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE)!;
    for (const item of pq.queue) {
      if (item.unitType === UnitCategory.TrainEngine) return true;
    }
  }
  return false;
}

/**
 * Deterministic HQ stub track cell: +X (East) from HQ grid center,
 * with the track running South (+Z) — parallel to the side of HQ.
 * Used at game start to position the train and later by computeCircuit to
 * ensure the HQ stop cell matches where the train is sitting.
 */
export function getHQStubCell(hqX: number, hqZ: number): {
  gx: number; gz: number;
  worldX: number; worldZ: number;
  direction: number; // 2 = South (+Z), parallel to HQ side
} {
  const bgx = Math.round(hqX / MACRO_GRID_SIZE);
  const bgz = Math.round(hqZ / MACRO_GRID_SIZE);
  const gx = bgx + 1; // +X adjacent cell
  const gz = bgz;
  return {
    gx, gz,
    worldX: gx * MACRO_GRID_SIZE,
    worldZ: gz * MACRO_GRID_SIZE,
    direction: 2, // South — runs parallel to HQ's east side
  };
}

/**
 * Create a long stub track at the HQ and store it as the active route.
 * The stub extends behind the engine (for cargo cars) and ahead (runway).
 * The train sits halted on this stub until a full circuit is computed.
 */
export function initHQStubTrack(
  trackState: TrackState,
  terrainData: { getHeight(x: number, z: number): number; isPassable(x: number, z: number): boolean },
  team: number,
  hqX: number,
  hqZ: number,
): void {
  const stub = getHQStubCell(hqX, hqZ);

  // Store the predetermined cell for computeCircuit
  trackState.setHQStubCell(team, stub.gx, stub.gz, stub.direction);

  // Build stub waypoints: behind the engine (-STUB_BEHIND) through ahead (+STUB_AHEAD)
  // All cells go in the stub direction (straight track)
  const stubRoute: TrackWaypoint[] = [];
  const trackCells = new Set<string>();

  for (let i = -STUB_BEHIND_CELLS; i <= STUB_AHEAD_CELLS; i++) {
    const gx = stub.gx + DIR_DX[stub.direction] * i;
    const gz = stub.gz + DIR_DZ[stub.direction] * i;
    const wx = gx * MACRO_GRID_SIZE;
    const wz = gz * MACRO_GRID_SIZE;
    if (wx < 4 || wx > 252 || wz < 4 || wz > 252) continue;
    if (!terrainData.isPassable(wx, wz)) continue;
    stubRoute.push({ x: wx, y: terrainData.getHeight(wx, wz), z: wz, entityId: null, isHQ: false });
    trackCells.add(`${gx},${gz}`);
  }

  // Fallback: at minimum include the stub cell and one cell ahead
  if (stubRoute.length < 2) {
    const wx = stub.worldX;
    const wz = stub.worldZ;
    const w1x = wx + DIR_DX[stub.direction] * MACRO_GRID_SIZE;
    const w1z = wz + DIR_DZ[stub.direction] * MACRO_GRID_SIZE;
    stubRoute.length = 0;
    trackCells.clear();
    stubRoute.push({ x: wx, y: terrainData.getHeight(wx, wz), z: wz, entityId: null, isHQ: false });
    stubRoute.push({ x: w1x, y: terrainData.getHeight(w1x, w1z), z: w1z, entityId: null, isHQ: false });
    trackCells.add(`${stub.gx},${stub.gz}`);
    trackCells.add(`${stub.gx + DIR_DX[stub.direction]},${stub.gz + DIR_DZ[stub.direction]}`);
  }

  trackState.setActiveRoute(team, stubRoute, [], trackCells);
}

// Need to import these for engineInProduction and initHQStubTrack
import { PRODUCTION_QUEUE } from '@sim/components/ComponentTypes';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { TrackState, TrackWaypoint } from '@sim/logistics/TrackState';
