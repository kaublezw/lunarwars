import type { System, World } from '@core/ECS';
import { BUILD_COMMAND, CONSTRUCTION, POSITION, MOVE_COMMAND, RENDERABLE, BUILDING, HEALTH, VISION, SELECTABLE, PRODUCTION_QUEUE, DEPOT_RADIUS, SUPPLY_ROUTE, VOXEL_STATE, WALL_BUILD_QUEUE, FERRY_DOCK } from '@sim/components/ComponentTypes';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VisionComponent } from '@sim/components/Vision';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { DepotRadiusComponent } from '@sim/components/DepotRadius';
import type { WallBuildQueueComponent } from '@sim/components/WallBuildQueue';
import type { BeamUpgradeComponent } from '@sim/components/BeamUpgrade';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { BEAM_UPGRADE } from '@sim/components/ComponentTypes';
const DEPOT_VISUAL_RADIUS = 38;

const BUILD_RANGE = 4; // max distance worker can be from site to build

export class BuildSystem implements System {
  readonly name = 'BuildSystem';

  update(world: World, dt: number): void {
    const builders = world.query(BUILD_COMMAND, POSITION);

    for (const e of builders) {
      const cmd = world.getComponent<BuildCommandComponent>(e, BUILD_COMMAND)!;
      const workerPos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Cancel ferry if worker is building
      if (world.hasComponent(e, SUPPLY_ROUTE)) {
        world.removeComponent(e, SUPPLY_ROUTE);
      }

      if (cmd.state === 'moving') {
        // Wait for MOVE_COMMAND to be removed (unit arrived)
        if (!world.hasComponent(e, MOVE_COMMAND)) {
          // Check if we're too close to a docked ferry at this site
          const reroute = this.findAlternateSpot(world, e, cmd);
          if (reroute) {
            world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
              path: [], currentWaypoint: 0,
              destX: reroute.x, destZ: reroute.z,
            });
          } else {
            cmd.state = 'building';
          }
        }
        continue;
      }

      // state === 'building'
      const site = cmd.siteEntity;
      const sitePos = world.getComponent<PositionComponent>(site, POSITION);
      const construction = world.getComponent<ConstructionComponent>(site, CONSTRUCTION);

      if (!sitePos || !construction) {
        // Site was destroyed or invalid
        world.removeComponent(e, BUILD_COMMAND);
        continue;
      }

      // Check distance - pause if worker is too far
      const dx = workerPos.x - sitePos.x;
      const dz = workerPos.z - sitePos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > BUILD_RANGE * BUILD_RANGE) continue;

      // Increment progress
      construction.progress += dt / construction.buildTime;

      // Progressive voxel reveal during construction
      const voxelState = world.getComponent<VoxelStateComponent>(site, VOXEL_STATE);
      if (voxelState) {
        const model = VOXEL_MODELS[voxelState.modelId];
        if (model && model.buildOrder) {
          const clampedProgress = Math.min(construction.progress, 1);
          const targetRevealed = Math.floor(model.totalSolid * clampedProgress);
          const currentRevealed = model.totalSolid - voxelState.destroyedCount;
          if (targetRevealed > currentRevealed) {
            for (let i = currentRevealed; i < targetRevealed; i++) {
              const solidIdx = model.buildOrder[i];
              const byteIdx = solidIdx >> 3;
              const bitIdx = solidIdx & 7;
              voxelState.destroyed[byteIdx] &= ~(1 << bitIdx);
              voxelState.destroyedCount--;
            }
            voxelState.dirty = true;
          }
        }
      }

      if (construction.progress >= 1) {
        // Building complete - swap to final building
        const def = BUILDING_DEFS[construction.buildingType];
        if (def) {
          const renderable = world.getComponent<RenderableComponent>(site, RENDERABLE);

          // For walls, meshType is already correct per-segment (wall_x or wall_z)
          const isWall = construction.buildingType === BuildingType.Wall;
          const finalMeshType = isWall ? (renderable?.meshType ?? def.meshType) : def.meshType;

          if (renderable && !isWall) {
            renderable.meshType = def.meshType;
          }

          // Update health to full
          const health = world.getComponent<HealthComponent>(site, HEALTH);
          if (health) {
            health.current = def.hp;
            health.max = def.hp;
          }

          // Add vision
          if (!world.hasComponent(site, VISION)) {
            world.addComponent<VisionComponent>(site, VISION, { range: def.visionRange });
          }

          // Add selectable
          if (!world.hasComponent(site, SELECTABLE)) {
            world.addComponent<SelectableComponent>(site, SELECTABLE, { selected: false });
          }

          // Update voxel state for the final building model
          const finalVoxelModel = VOXEL_MODELS[finalMeshType];
          if (finalVoxelModel) {
            world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
              modelId: finalMeshType,
              totalVoxels: finalVoxelModel.totalSolid,
              destroyedCount: 0,
              destroyed: new Uint8Array(Math.ceil(finalVoxelModel.totalSolid / 8)),
              dirty: true,
              pendingDebris: [],
              pendingScorch: [],
            });
          }

          // DroneFactory gets a production queue
          if (construction.buildingType === BuildingType.DroneFactory && !world.hasComponent(site, PRODUCTION_QUEUE)) {
            const sitePos2 = world.getComponent<PositionComponent>(site, POSITION)!;
            world.addComponent<ProductionQueueComponent>(site, PRODUCTION_QUEUE, {
              queue: [],
              rallyX: sitePos2.x + 5,
              rallyZ: sitePos2.z + 5,
            });
          }

          // SupplyDepot gets matter storage, visual radius, production queue, and beam upgrade
          if (construction.buildingType === BuildingType.SupplyDepot) {
            if (!world.hasComponent(site, PRODUCTION_QUEUE)) {
              const sitePos3 = world.getComponent<PositionComponent>(site, POSITION)!;
              world.addComponent<ProductionQueueComponent>(site, PRODUCTION_QUEUE, {
                queue: [],
                rallyX: sitePos3.x + 3,
                rallyZ: sitePos3.z + 3,
              });
            }
            if (!world.hasComponent(site, DEPOT_RADIUS)) {
              world.addComponent<DepotRadiusComponent>(site, DEPOT_RADIUS, {
                radius: DEPOT_VISUAL_RADIUS,
              });
            }
            if (!world.hasComponent(site, BEAM_UPGRADE)) {
              world.addComponent<BeamUpgradeComponent>(site, BEAM_UPGRADE, {
                level: 0,
              });
            }
          }
        }

        // Remove construction component (building is done)
        world.removeComponent(site, CONSTRUCTION);

        // Remove build command from worker
        world.removeComponent(e, BUILD_COMMAND);

        // Check for wall build queue continuation
        const wallQueue = world.getComponent<WallBuildQueueComponent>(e, WALL_BUILD_QUEUE);
        if (wallQueue) {
          wallQueue.currentIndex++;
          // Skip destroyed or already-completed segments
          let foundNext = false;
          while (wallQueue.currentIndex < wallQueue.siteEntities.length) {
            const nextSite = wallQueue.siteEntities[wallQueue.currentIndex];
            const nextPos = world.getComponent<PositionComponent>(nextSite, POSITION);
            const nextCon = world.getComponent<ConstructionComponent>(nextSite, CONSTRUCTION);
            if (nextPos && nextCon) {
              nextCon.builderEntity = e;
              world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
                path: [], currentWaypoint: 0,
                destX: nextPos.x, destZ: nextPos.z,
              });
              world.addComponent<BuildCommandComponent>(e, BUILD_COMMAND, {
                buildingType: nextCon.buildingType,
                targetX: nextPos.x, targetZ: nextPos.z,
                state: 'moving', siteEntity: nextSite,
              });
              foundNext = true;
              break;
            }
            wallQueue.currentIndex++;
          }
          if (!foundNext) {
            world.removeComponent(e, WALL_BUILD_QUEUE);
          }
        }
      }
    }
  }

  /** Check if the worker's current position is too close to a docked ferry
   *  at the same construction site. If so, return an alternate offset spot. */
  private findAlternateSpot(
    world: World,
    workerEntity: number,
    cmd: BuildCommandComponent,
  ): { x: number; z: number } | null {
    const workerPos = world.getComponent<PositionComponent>(workerEntity, POSITION)!;
    const sitePos = world.getComponent<PositionComponent>(cmd.siteEntity, POSITION);
    if (!sitePos) return null;

    // Find docked ferries at this site
    const ferries = world.query(FERRY_DOCK, POSITION);
    let ferryNearby = false;
    for (const f of ferries) {
      const fPos = world.getComponent<PositionComponent>(f, POSITION)!;
      const fdx = fPos.x - workerPos.x;
      const fdz = fPos.z - workerPos.z;
      if (fdx * fdx + fdz * fdz < 4) { // within 2 wu
        ferryNearby = true;
        break;
      }
    }

    if (!ferryNearby) return null;

    // Try cardinal offsets to find a spot away from the ferry
    const OFFSET = 3;
    const offsets: [number, number][] = [
      [0, -OFFSET], [-OFFSET, 0], [OFFSET, 0], [0, OFFSET],
    ];

    for (const [ox, oz] of offsets) {
      const cx = sitePos.x + ox;
      const cz = sitePos.z + oz;
      // Check that this spot isn't near a ferry
      let clear = true;
      for (const f of ferries) {
        const fPos = world.getComponent<PositionComponent>(f, POSITION)!;
        const fdx = fPos.x - cx;
        const fdz = fPos.z - cz;
        if (fdx * fdx + fdz * fdz < 4) {
          clear = false;
          break;
        }
      }
      if (clear) return { x: cx, z: cz };
    }

    return null; // All spots blocked — proceed anyway
  }
}
