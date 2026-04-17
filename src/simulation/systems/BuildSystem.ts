import type { System, World } from '@core/ECS';
import { BUILD_COMMAND, CONSTRUCTION, POSITION, MOVE_COMMAND, RENDERABLE, BUILDING, HEALTH, VISION, SELECTABLE, PRODUCTION_QUEUE, MATTER_STORAGE, DEPOT_RADIUS, SUPPLY_ROUTE, VOXEL_STATE, WALL_BUILD_QUEUE, POWER_NODE, POWER_POLE, TEAM, MACRO_GRID_SIZE } from '@sim/components/ComponentTypes';
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
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { DepotRadiusComponent } from '@sim/components/DepotRadius';
import type { WallBuildQueueComponent } from '@sim/components/WallBuildQueue';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { TeamComponent } from '@sim/components/Team';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { PowerPoleComponent } from '@sim/components/PowerPole';
import type { EventBus } from '@core/EventBus';
import type { PowerGridState } from '@sim/economy/PowerGridState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import { routePowerConnection, findNodeAtGrid } from '@sim/economy/PowerGridRouter';
const DEPOT_VISUAL_RADIUS = 38;

const BUILD_RANGE = 6; // max distance worker can be from site to build (must exceed largest footprint radius + pathfinding margin)

export class BuildSystem implements System {
  readonly name = 'BuildSystem';
  private eventBus?: EventBus;
  private powerGrid?: PowerGridState;
  private terrainData?: TerrainData;
  private occupancy?: BuildingOccupancy;

  constructor(
    eventBus?: EventBus,
    powerGrid?: PowerGridState,
    terrainData?: TerrainData,
    occupancy?: BuildingOccupancy,
  ) {
    this.eventBus = eventBus;
    this.powerGrid = powerGrid;
    this.terrainData = terrainData;
    this.occupancy = occupancy;
  }

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

      // Check distance - re-issue move if worker is too far
      const dx = workerPos.x - sitePos.x;
      const dz = workerPos.z - sitePos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > BUILD_RANGE * BUILD_RANGE) {
        if (!world.hasComponent(e, MOVE_COMMAND)) {
          world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: sitePos.x, destZ: sitePos.z,
          });
          cmd.state = 'moving';
        }
        continue;
      }

      // Increment progress
      construction.progress += dt / construction.buildTime;
      if (this.eventBus) {
        this.eventBus.emit('construction:active', workerPos.x, workerPos.z);
      }

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

          // SupplyDepot gets matter storage, visual radius, and production queue
          if (construction.buildingType === BuildingType.SupplyDepot) {
            if (!world.hasComponent(site, PRODUCTION_QUEUE)) {
              const sitePos3 = world.getComponent<PositionComponent>(site, POSITION)!;
              world.addComponent<ProductionQueueComponent>(site, PRODUCTION_QUEUE, {
                queue: [],
                rallyX: sitePos3.x + 3,
                rallyZ: sitePos3.z + 3,
              });
            }
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

        // Add power grid node for non-wall buildings and route connection
        if (construction.buildingType !== BuildingType.Wall && this.powerGrid) {
          const teamComp = world.getComponent<TeamComponent>(site, TEAM);
          if (teamComp) {
            world.addComponent<PowerNodeComponent>(site, POWER_NODE, {
              powered: false,
              nodeId: this.powerGrid.allocateNodeId(),
            });

            // PowerPoles get the POWER_POLE marker
            if (construction.buildingType === BuildingType.PowerPole) {
              const polePos = world.getComponent<PositionComponent>(site, POSITION)!;
              world.addComponent<PowerPoleComponent>(site, POWER_POLE, {
                gridX: Math.round(polePos.x / MACRO_GRID_SIZE),
                gridZ: Math.round(polePos.z / MACRO_GRID_SIZE),
              });
            }

            if (this.terrainData && this.occupancy) {
              routePowerConnection(
                world, teamComp.team, site,
                this.powerGrid, this.terrainData, this.occupancy,
              );
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

    // Auto-construct: advance construction for entities that build without a worker
    const autoSites = world.query(CONSTRUCTION, POSITION);
    const completedPoles: { entity: number; team: number; poleNeighbors: [number, number][] }[] = [];

    for (const site of autoSites) {
      const construction = world.getComponent<ConstructionComponent>(site, CONSTRUCTION)!;
      if (!construction.autoConstruct) continue;

      construction.progress += dt / construction.buildTime;

      // Progressive voxel reveal
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
        const def = BUILDING_DEFS[construction.buildingType];
        if (def) {
          const health = world.getComponent<HealthComponent>(site, HEALTH);
          if (health) {
            health.current = def.hp;
            health.max = def.hp;
          }

          if (!world.hasComponent(site, VISION)) {
            world.addComponent<VisionComponent>(site, VISION, { range: def.visionRange });
          }

          const finalVoxelModel = VOXEL_MODELS[def.meshType];
          if (finalVoxelModel) {
            world.addComponent<VoxelStateComponent>(site, VOXEL_STATE, {
              modelId: def.meshType,
              totalVoxels: finalVoxelModel.totalSolid,
              destroyedCount: 0,
              destroyed: new Uint8Array(Math.ceil(finalVoxelModel.totalSolid / 8)),
              dirty: true,
              pendingDebris: [],
              pendingScorch: [],
            });
          }

          // Pass 1: Add POWER_NODE + POWER_POLE to all completing poles before any edge restoration
          if (this.powerGrid && construction.buildingType === BuildingType.PowerPole) {
            const teamComp = world.getComponent<TeamComponent>(site, TEAM);
            if (teamComp) {
              world.addComponent<PowerNodeComponent>(site, POWER_NODE, {
                powered: false,
                nodeId: this.powerGrid.allocateNodeId(),
              });
              const polePos = world.getComponent<PositionComponent>(site, POSITION)!;
              world.addComponent<PowerPoleComponent>(site, POWER_POLE, {
                gridX: Math.round(polePos.x / MACRO_GRID_SIZE),
                gridZ: Math.round(polePos.z / MACRO_GRID_SIZE),
              });

              completedPoles.push({
                entity: site,
                team: teamComp.team,
                poleNeighbors: construction.poleNeighbors ?? [],
              });
            }
          }
        }

        world.removeComponent(site, CONSTRUCTION);
      }
    }

    // Pass 2: Restore edges now that all completing poles have POWER_NODE
    if (completedPoles.length > 0 && this.powerGrid) {
      const dirtyTeams = new Set<number>();

      for (const cp of completedPoles) {
        let edgesRestored = 0;
        for (const [ngx, ngz] of cp.poleNeighbors) {
          const neighbor = findNodeAtGrid(world, cp.team, ngx, ngz);
          if (neighbor !== null && neighbor !== cp.entity) {
            this.powerGrid.addEdge(cp.team, cp.entity, neighbor);
            edgesRestored++;
          }
        }

        if (edgesRestored === 0 && this.terrainData && this.occupancy) {
          routePowerConnection(world, cp.team, cp.entity, this.powerGrid, this.terrainData, this.occupancy);
        }

        dirtyTeams.add(cp.team);
      }

      for (const team of dirtyTeams) {
        this.powerGrid.markDirty(team);
      }
    }
  }
}
