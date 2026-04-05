import type { World } from '@core/ECS';
import {
  POSITION, RENDERABLE, UNIT_TYPE, SELECTABLE, HEALTH, TEAM, VISION,
  VOXEL_STATE, TRAIN_LINK, TRACK_FOLLOWER, CARGO_STORAGE,
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
const CAR_SPACING = 2.5; // world units between each linked entity

/**
 * Spawn a train set (1 engine + N cargo cars) at the given position.
 * All entities are linked via TrainLink. The engine gets a TrackFollower.
 * Returns [engineEntity, ...carEntities].
 */
export function spawnTrainSet(
  world: World,
  team: number,
  x: number,
  y: number,
  z: number,
  carCount: number,
): number[] {
  const engineDef = UNIT_DEFS[UnitCategory.TrainEngine];
  const carDef = UNIT_DEFS[UnitCategory.CargoCar];
  const color = TEAM_COLORS[team] ?? 0xffffff;

  // Spawn engine
  const engine = world.createEntity();
  world.addComponent<PositionComponent>(engine, POSITION, {
    x, y, z, prevX: x, prevY: y, prevZ: z, rotation: 0,
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

  // TrackFollower on the engine (empty path until TrackManagerSystem fills it)
  world.addComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER, {
    path: [],
    currentWaypointIndex: 0,
    distanceAlongSegment: 0,
    direction: 1,
    reconnectTarget: -1,
    halted: false,
  });

  // TrainLink for the engine (head of the chain)
  world.addComponent<TrainLinkComponent>(engine, TRAIN_LINK, {
    nextEntity: null,
    prevEntity: null,
    isEngine: true,
  });

  const entities: number[] = [engine];
  let prevEntity = engine;

  // Spawn cargo cars
  for (let i = 0; i < carCount; i++) {
    const carX = x;
    const carZ = z + CAR_SPACING * (i + 1); // stagger behind engine along +Z

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

// Need to import these for engineInProduction
import { PRODUCTION_QUEUE } from '@sim/components/ComponentTypes';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
