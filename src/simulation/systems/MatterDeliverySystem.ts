import type { System, World } from '@core/ECS';
import { MATTER_DELIVERY, POSITION, HEALTH, MOVE_COMMAND, CONSTRUCTION, VOXEL_STATE, RESOURCE_SILO, BUILDING, FERRY_DOCK } from '@sim/components/ComponentTypes';
import type { MatterDeliveryComponent } from '@sim/components/MatterDelivery';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { FerryDockComponent } from '@sim/components/FerryDock';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

const ARRIVAL_DIST_SQ = 25.0; // 5 wu arrival threshold (matches SupplySystem)

export class MatterDeliverySystem implements System {
  readonly name = 'MatterDeliverySystem';

  update(world: World, _dt: number): void {
    const entities = world.query(MATTER_DELIVERY, POSITION);

    for (const e of entities) {
      // Skip ferries that are already docked
      if (world.hasComponent(e, FERRY_DOCK)) continue;

      const delivery = world.getComponent<MatterDeliveryComponent>(e, MATTER_DELIVERY)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Check if destination is still alive
      const destHealth = world.getComponent<HealthComponent>(delivery.destEntity, HEALTH);
      if (destHealth && destHealth.dead) {
        world.destroyEntity(e);
        continue;
      }

      // Movement is handled by PathfindingSystem + MovementSystem via MOVE_COMMAND.
      // Check if we've arrived (MOVE_COMMAND removed by PathfindingSystem on arrival).
      if (!world.hasComponent(e, MOVE_COMMAND)) {
        const dx = delivery.destX - pos.x;
        const dz = delivery.destZ - pos.z;
        const distSq = dx * dx + dz * dz;

        if (distSq <= ARRIVAL_DIST_SQ) {
          // Check if destination is a construction site — dock instead of disappearing
          const construction = world.getComponent<ConstructionComponent>(delivery.destEntity, CONSTRUCTION);
          if (construction) {
            this.dockAtSite(world, e, delivery, construction);
          } else {
            // Not a construction site — disappear as before
            world.destroyEntity(e);
          }
        } else {
          // Re-issue move command (path may have been cleared without arriving)
          world.addComponent(e, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: delivery.destX, destZ: delivery.destZ,
          });
        }
      }
    }
  }

  private dockAtSite(
    world: World,
    ferryEntity: number,
    delivery: MatterDeliveryComponent,
    construction: ConstructionComponent,
  ): void {
    // Find the HQ this ferry came from (check RESOURCE_SILO parentBuilding chain)
    let homeHQ = -1;
    const silos = world.query(RESOURCE_SILO, BUILDING);
    // Simple approach: find the team's HQ
    const ferryTeam = world.getComponent<{ team: number }>(ferryEntity, 'Team');
    if (ferryTeam) {
      const buildings = world.query(BUILDING, POSITION);
      for (const b of buildings) {
        const bldg = world.getComponent<BuildingComponent>(b, BUILDING)!;
        if (bldg.buildingType !== BuildingType.HQ) continue;
        const bTeam = world.getComponent<{ team: number }>(b, 'Team');
        if (bTeam && bTeam.team === ferryTeam.team) {
          homeHQ = b;
          break;
        }
      }
    }

    // Calculate consumable voxels (all except the first/bottom layer "supports")
    const ferryModel = VOXEL_MODELS['ferry_drone'];
    let consumableVoxels = 0;
    if (ferryModel) {
      consumableVoxels = ferryModel.totalSolid - (ferryModel.firstLayerCount ?? 0);
    }

    world.addComponent<FerryDockComponent>(ferryEntity, FERRY_DOCK, {
      siteEntity: delivery.destEntity,
      homeHQ,
      voxelsConsumed: 0,
      consumableVoxels,
      lastProgress: construction.progress,
      returning: false,
    });
  }
}
