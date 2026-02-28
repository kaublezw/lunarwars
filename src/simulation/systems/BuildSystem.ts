import type { System, World } from '@core/ECS';
import { BUILD_COMMAND, CONSTRUCTION, POSITION, MOVE_COMMAND, RENDERABLE, BUILDING, HEALTH, VISION, SELECTABLE, PRODUCTION_QUEUE, MATTER_STORAGE, DEPOT_RADIUS, SUPPLY_ROUTE, VOXEL_STATE } from '@sim/components/ComponentTypes';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VisionComponent } from '@sim/components/Vision';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { DepotRadiusComponent } from '@sim/components/DepotRadius';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
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
          cmd.state = 'building';
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

      if (construction.progress >= 1) {
        // Building complete - swap to final building
        const def = BUILDING_DEFS[construction.buildingType];
        if (def) {
          const renderable = world.getComponent<RenderableComponent>(site, RENDERABLE);
          if (renderable) {
            renderable.meshType = def.meshType;
          }

          // Reset Y position for compound building groups (they expect y=0 as ground)
          const bldgPos = world.getComponent<PositionComponent>(site, POSITION);
          if (bldgPos) {
            const groundY = bldgPos.y - 0.25; // undo construction site offset
            bldgPos.y = groundY;
            bldgPos.prevY = groundY;
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
          const finalVoxelModel = VOXEL_MODELS[def.meshType];
          if (finalVoxelModel) {
            world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
              modelId: def.meshType,
              totalVoxels: finalVoxelModel.totalSolid,
              destroyedCount: 0,
              destroyed: new Uint8Array(Math.ceil(finalVoxelModel.totalSolid / 8)),
              dirty: true,
              pendingDebris: [],
            });
          }

          // DroneFactory gets a production queue
          if (construction.buildingType === BuildingType.DroneFactory && !world.hasComponent(site, PRODUCTION_QUEUE)) {
            const sitePos = world.getComponent<PositionComponent>(site, POSITION)!;
            world.addComponent<ProductionQueueComponent>(site, PRODUCTION_QUEUE, {
              queue: [],
              rallyX: sitePos.x + 5,
              rallyZ: sitePos.z + 5,
            });
          }

          // SupplyDepot gets matter storage and visual radius
          if (construction.buildingType === BuildingType.SupplyDepot) {
            if (!world.hasComponent(site, MATTER_STORAGE)) {
              world.addComponent<MatterStorageComponent>(site, MATTER_STORAGE, {
                stored: 0,
                capacity: Infinity,
              });
            }
            if (!world.hasComponent(site, DEPOT_RADIUS)) {
              world.addComponent<DepotRadiusComponent>(site, DEPOT_RADIUS, {
                radius: DEPOT_VISUAL_RADIUS,
              });
            }
          }
        }

        // Remove construction component (building is done)
        world.removeComponent(site, CONSTRUCTION);

        // Remove build command from worker
        world.removeComponent(e, BUILD_COMMAND);
      }
    }
  }
}
