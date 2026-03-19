import type { System, World } from '@core/ECS';
import {
  FERRY_DOCK, POSITION, CONSTRUCTION, VOXEL_STATE, MOVE_COMMAND,
  VELOCITY, MATTER_DELIVERY, GARAGE_ENTER, HEALTH, STEERING,
} from '@sim/components/ComponentTypes';
import type { FerryDockComponent } from '@sim/components/FerryDock';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { PositionComponent } from '@sim/components/Position';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { GarageEnterComponent } from '@sim/components/GarageEnter';
import type { SteeringComponent } from '@sim/components/Steering';
import type { HealthComponent } from '@sim/components/Health';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

// Ferry voxels are consumed in reverse build order (top-to-bottom),
// skipping the first layer (supports/skids) which remain until the ferry departs.

export class FerryDockSystem implements System {
  readonly name = 'FerryDockSystem';

  update(world: World, _dt: number): void {
    const dockedFerries = world.query(FERRY_DOCK, POSITION, VOXEL_STATE);

    for (const e of dockedFerries) {
      const dock = world.getComponent<FerryDockComponent>(e, FERRY_DOCK)!;

      if (dock.returning) {
        this.handleReturn(world, e, dock);
        continue;
      }

      // Check if construction site still exists
      const construction = world.getComponent<ConstructionComponent>(dock.siteEntity, CONSTRUCTION);
      if (!construction) {
        // Construction completed or site destroyed — start returning
        this.startReturn(world, e, dock);
        continue;
      }

      // Check if site was destroyed
      const siteHealth = world.getComponent<HealthComponent>(dock.siteEntity, HEALTH);
      if (siteHealth && siteHealth.dead) {
        world.destroyEntity(e);
        continue;
      }

      // Detect construction progress change
      const progressDelta = construction.progress - dock.lastProgress;
      if (progressDelta <= 0) continue;
      dock.lastProgress = construction.progress;

      // Calculate how many ferry voxels to consume based on progress
      const clampedProgress = Math.min(construction.progress, 1);
      const targetConsumed = Math.floor(dock.consumableVoxels * clampedProgress);
      const toConsume = targetConsumed - dock.voxelsConsumed;
      if (toConsume <= 0) continue;

      // Destroy ferry voxels (top-to-bottom using reverse buildOrder)
      const ferryVoxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE)!;
      const ferryModel = VOXEL_MODELS[ferryVoxelState.modelId];
      if (!ferryModel || !ferryModel.buildOrder) continue;

      // Get construction site position for debris direction
      const sitePos = world.getComponent<PositionComponent>(dock.siteEntity, POSITION);
      const ferryPos = world.getComponent<PositionComponent>(e, POSITION)!;

      let consumed = 0;
      // Consume from top of buildOrder (skip firstLayerCount at the bottom)
      const firstLayer = ferryModel.firstLayerCount ?? 0;
      for (let i = ferryModel.totalSolid - 1 - dock.voxelsConsumed; i >= firstLayer && consumed < toConsume; i--) {
        const solidIdx = ferryModel.buildOrder[i];
        const byteIdx = solidIdx >> 3;
        const bitIdx = solidIdx & 7;
        const alreadyDestroyed = (ferryVoxelState.destroyed[byteIdx] & (1 << bitIdx)) !== 0;
        if (alreadyDestroyed) continue;

        // Mark voxel as destroyed
        ferryVoxelState.destroyed[byteIdx] |= (1 << bitIdx);
        ferryVoxelState.destroyedCount++;

        // Add pendingDebris entry — direction points toward construction site
        if (sitePos) {
          const dx = sitePos.x - ferryPos.x;
          const dy = 1.0; // upward arc
          const dz = sitePos.z - ferryPos.z;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          ferryVoxelState.pendingDebris.push({
            solidIndex: solidIdx,
            dirX: dx / len,
            dirY: dy / len,
            dirZ: dz / len,
          });
        }

        consumed++;
      }

      dock.voxelsConsumed += consumed;
      if (consumed > 0) {
        ferryVoxelState.dirty = true;
      }
    }
  }

  private startReturn(world: World, ferry: number, dock: FerryDockComponent): void {
    dock.returning = true;

    // Remove matter delivery (no longer needed)
    if (world.hasComponent(ferry, MATTER_DELIVERY)) {
      world.removeComponent(ferry, MATTER_DELIVERY);
    }

    if (dock.homeHQ >= 0) {
      const hqPos = world.getComponent<PositionComponent>(dock.homeHQ, POSITION);
      if (hqPos) {
        // Navigate back to HQ
        world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
          path: [], currentWaypoint: 0,
          destX: hqPos.x, destZ: hqPos.z,
        });
        return;
      }
    }

    // No HQ to return to — just destroy
    world.destroyEntity(ferry);
  }

  private handleReturn(world: World, ferry: number, dock: FerryDockComponent): void {
    // Already entering garage — let GarageEnterSystem handle it
    if (world.hasComponent(ferry, GARAGE_ENTER)) return;

    // Wait for movement to finish
    if (world.hasComponent(ferry, MOVE_COMMAND)) return;

    const ferryPos = world.getComponent<PositionComponent>(ferry, POSITION)!;

    if (dock.homeHQ >= 0) {
      const hqPos = world.getComponent<PositionComponent>(dock.homeHQ, POSITION);
      if (hqPos) {
        const dx = hqPos.x - ferryPos.x;
        const dz = hqPos.z - ferryPos.z;
        const distSq = dx * dx + dz * dz;

        if (distSq <= 25) {
          // Close enough to HQ — position at garage entrance and drive in
          ferryPos.x = hqPos.x;
          ferryPos.z = hqPos.z + 2.5; // In front of the garage door

          // Remove FERRY_DOCK so this entity is fully managed by GarageEnterSystem
          world.removeComponent(ferry, FERRY_DOCK);

          world.addComponent<GarageEnterComponent>(ferry, GARAGE_ENTER, {
            enterZ: hqPos.z + 0.5, // Interior position to reach
            hqX: hqPos.x,
          });
          return;
        }

        // Re-issue move command
        world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
          path: [], currentWaypoint: 0,
          destX: hqPos.x, destZ: hqPos.z + 3, // Aim just in front of garage
        });
        return;
      }
    }

    // Fallback: destroy
    world.destroyEntity(ferry);
  }
}
