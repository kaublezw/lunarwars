import type { System, World } from '@core/ECS';
import {
  HEALTH, TEAM, TRAIN_LINK, TRACK_FOLLOWER, CARGO_STORAGE, PLANT_STORAGE, POSITION,
} from '@sim/components/ComponentTypes';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import type { CargoStorageComponent } from '@sim/components/CargoStorage';
import type { PlantStorageComponent } from '@sim/components/PlantStorage';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TrackState } from '@sim/logistics/TrackState';

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
      this.loadAtPlant(world, engine, waypoint.entityId);
      follower.halted = false; // Resume after loading
    } else if (waypoint.isHQ) {
      this.unloadAtHQ(world, engine, team);
      follower.halted = false; // Resume after unloading
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
  private unloadAtHQ(
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
}
