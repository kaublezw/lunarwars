import type { System, World } from '@core/ECS';
import {
  HEALTH, TEAM, TRAIN_LINK, TRACK_FOLLOWER, CARGO_STORAGE, PLANT_STORAGE, POSITION,
  VOXEL_STATE, BUILDING,
} from '@sim/components/ComponentTypes';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import type { CargoStorageComponent } from '@sim/components/CargoStorage';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { PlantStorageComponent } from '@sim/components/PlantStorage';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TrackState } from '@sim/logistics/TrackState';
import { VOXEL_MODELS, PAL_ORANGE } from '@sim/data/VoxelModels';

/**
 * Handles the train's loading/unloading logic.
 *
 * When the engine reaches a waypoint:
 * - Plant waypoint (entityId != null): transfer PlantStorage -> CargoStorage
 * - HQ waypoint (entityId == null): dump cargo -> ResourceState
 *
 * Transfers are instant (same tick as arrival). The train does not halt.
 */
export class TrainLogisticsSystem implements System {
  readonly name = 'TrainLogisticsSystem';

  /** Track last processed waypoint index per engine to detect arrivals. */
  private lastWaypointIndex = new Map<number, number>();
  /** Cached cargo voxel indices (sorted bottom-to-top) per modelId. */
  private cargoVoxelCache = new Map<string, number[]>();
  /** Last synced cargo amount per entity for change detection. */
  private lastCargoAmount = new Map<number, number>();

  constructor(
    private resources: ResourceState,
    private trackState: TrackState,
    private teamCount: number,
  ) {}

  update(world: World, _dt: number): void {
    const engines = world.query(TRACK_FOLLOWER, TRAIN_LINK, POSITION);
    for (const engine of engines) {
      const link = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!;
      if (!link.isEngine) continue;
      const health = world.getComponent<HealthComponent>(engine, HEALTH);
      if (health && health.dead) continue;

      const follower = world.getComponent<TrackFollowerComponent>(engine, TRACK_FOLLOWER)!;
      if (follower.path.length < 2) continue;

      const team = world.getComponent<TeamComponent>(engine, TEAM);
      if (!team) continue;

      this.processEngine(world, engine, follower, team.team);
    }

    this.syncAllCargoFill(world);
  }

  private processEngine(
    world: World,
    engine: number,
    follower: TrackFollowerComponent,
    team: number,
  ): void {
    const wpIdx = follower.currentWaypointIndex;
    const lastIdx = this.lastWaypointIndex.get(engine) ?? -1;

    // Only trigger on waypoint change (engine just crossed into a new segment)
    if (wpIdx === lastIdx) return;
    this.lastWaypointIndex.set(engine, wpIdx);

    // The waypoint we just arrived at is the START of the current segment.
    // Check it for a stop.
    const waypoint = follower.path[wpIdx];
    if (!waypoint) return;

    if (waypoint.entityId != null) {
      const building = world.getComponent<BuildingComponent>(waypoint.entityId, BUILDING);
      if (building && building.buildingType === BuildingType.SupplyDepot) {
        // Depot stop: unload cargo to global pool
        this.unloadCargo(world, engine, team);
      } else {
        // Plant stop: load from plant storage
        this.loadAtPlant(world, engine, waypoint.entityId);
      }
      follower.halted = false;
    } else if (waypoint.isHQ) {
      this.unloadCargo(world, engine, team);
      follower.halted = false;
    }
    // Intermediate path waypoints (entityId=null, isHQ=false) are ignored
  }

  /** Transfer resources from a plant's PlantStorage into the train's cargo cars. */
  private loadAtPlant(
    world: World,
    engine: number,
    plantEntity: number,
  ): void {
    const plantStorage = world.getComponent<PlantStorageComponent>(plantEntity, PLANT_STORAGE);
    if (!plantStorage || plantStorage.amount <= 0) return;

    const plantHealth = world.getComponent<HealthComponent>(plantEntity, HEALTH);
    if (plantHealth && plantHealth.dead) return;

    // Walk the cargo car chain and fill all compatible cars
    let current: number | null = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!.nextEntity;

    while (current != null && plantStorage.amount > 0) {
      const carHealth = world.getComponent<HealthComponent>(current, HEALTH);
      if (carHealth && carHealth.dead) {
        const nextLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
        current = nextLink ? nextLink.nextEntity : null;
        continue;
      }

      const cargo = world.getComponent<CargoStorageComponent>(current, CARGO_STORAGE);
      if (cargo) {
        if (cargo.committedType === null || cargo.committedType === plantStorage.resourceType) {
          const space = cargo.capacity - cargo.current;
          if (space > 0) {
            const transfer = Math.min(space, plantStorage.amount);
            cargo.current += transfer;
            cargo.committedType = plantStorage.resourceType;
            plantStorage.amount -= transfer;
          }
        }
      }

      const nextLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      current = nextLink ? nextLink.nextEntity : null;
    }
  }

  /** Dump all cargo into the team's global resource pool. */
  private unloadCargo(
    world: World,
    engine: number,
    team: number,
  ): void {
    let current: number | null = world.getComponent<TrainLinkComponent>(engine, TRAIN_LINK)!.nextEntity;

    while (current != null) {
      const carHealth = world.getComponent<HealthComponent>(current, HEALTH);
      if (carHealth && carHealth.dead) {
        const nextLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
        current = nextLink ? nextLink.nextEntity : null;
        continue;
      }

      const cargo = world.getComponent<CargoStorageComponent>(current, CARGO_STORAGE);
      if (cargo && cargo.current > 0 && cargo.committedType) {
        this.resources.addMatter(team, cargo.current);
        cargo.current = 0;
        cargo.committedType = null;
      }

      const nextLink = world.getComponent<TrainLinkComponent>(current, TRAIN_LINK);
      current = nextLink ? nextLink.nextEntity : null;
    }
  }

  /** Get cargo voxel solid indices for a model, sorted bottom-to-top by Y. */
  private getCargoIndices(modelId: string): number[] {
    let cached = this.cargoVoxelCache.get(modelId);
    if (cached) return cached;

    const model = VOXEL_MODELS[modelId];
    if (!model) { cached = []; this.cargoVoxelCache.set(modelId, cached); return cached; }

    const entries: { si: number; y: number }[] = [];
    for (let si = 0; si < model.solidVoxels.length; si++) {
      const [gi, palIdx] = model.solidVoxels[si];
      if (palIdx === PAL_ORANGE) {
        const y = Math.floor(gi / (model.sizeX * model.sizeZ));
        entries.push({ si, y });
      }
    }
    entries.sort((a, b) => a.y - b.y);
    cached = entries.map(e => e.si);
    this.cargoVoxelCache.set(modelId, cached);
    return cached;
  }

  /** Sync cargo fill level to voxel visibility for all cargo cars. */
  private syncAllCargoFill(world: World): void {
    const cargoCars = world.query(CARGO_STORAGE, VOXEL_STATE);

    for (const car of cargoCars) {
      const cargo = world.getComponent<CargoStorageComponent>(car, CARGO_STORAGE)!;
      const lastAmount = this.lastCargoAmount.get(car) ?? -1;
      if (cargo.current === lastAmount) continue;

      this.lastCargoAmount.set(car, cargo.current);
      const voxel = world.getComponent<VoxelStateComponent>(car, VOXEL_STATE)!;
      const cargoIndices = this.getCargoIndices(voxel.modelId);
      if (cargoIndices.length === 0) continue;

      const fillFraction = cargo.current / cargo.capacity;
      const visibleCount = Math.round(cargoIndices.length * fillFraction);
      let changed = false;

      for (let i = 0; i < cargoIndices.length; i++) {
        const si = cargoIndices[i];
        const byteIdx = si >> 3;
        const bitMask = 1 << (si & 7);
        const isDestroyed = (voxel.destroyed[byteIdx] & bitMask) !== 0;

        if (i < visibleCount) {
          // Should be visible (cargo present)
          if (isDestroyed) { voxel.destroyed[byteIdx] &= ~bitMask; changed = true; }
        } else {
          // Should be hidden (no cargo)
          if (!isDestroyed) { voxel.destroyed[byteIdx] |= bitMask; changed = true; }
        }
      }

      if (changed) {
        let count = 0;
        for (let si = 0; si < voxel.totalVoxels; si++) {
          if (voxel.destroyed[si >> 3] & (1 << (si & 7))) count++;
        }
        voxel.destroyedCount = count;
        voxel.dirty = true;
      }
    }
  }
}
