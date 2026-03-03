import type { System, World } from '@core/ECS';
import {
  TURRET, TEAM, POSITION, HEALTH, MOVE_COMMAND, RESUPPLY_SEEK, MATTER_STORAGE, UNIT_TYPE,
  BUILDING, CONSTRUCTION, DEPOT_RADIUS, VOXEL_STATE,
} from '@sim/components/ComponentTypes';
import type { TurretComponent } from '@sim/components/Turret';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ResupplySeekComponent } from '@sim/components/ResupplySeek';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { findNearestDepot, RESUPPLY_RANGE, AMMO_MATTER_COST, REPAIR_MATTER_COST, REPAIR_RATE } from '@sim/economy/DepotUtils';

const RESUPPLY_RANGE_SQ = RESUPPLY_RANGE * RESUPPLY_RANGE;

export class ResupplySystem implements System {
  readonly name = 'ResupplySystem';

  update(world: World, dt: number): void {
    this.passiveAura(world, dt);
    this.detectEmpty(world);
    this.processResupply(world, dt);
  }

  /** Passive aura: any combat unit near a depot with matter gets ammo topped off + HP repaired. */
  private passiveAura(world: World, dt: number): void {
    // Collect all active depots with matter
    const depots = world.query(DEPOT_RADIUS, BUILDING, TEAM, POSITION, HEALTH, MATTER_STORAGE);
    const activeDepots: { entity: number; team: number; x: number; z: number }[] = [];

    for (const d of depots) {
      if (world.hasComponent(d, CONSTRUCTION)) continue;
      const health = world.getComponent<HealthComponent>(d, HEALTH)!;
      if (health.dead) continue;
      const storage = world.getComponent<MatterStorageComponent>(d, MATTER_STORAGE)!;
      if (storage.stored <= 0) continue;
      const team = world.getComponent<TeamComponent>(d, TEAM)!;
      const pos = world.getComponent<PositionComponent>(d, POSITION)!;
      activeDepots.push({ entity: d, team: team.team, x: pos.x, z: pos.z });
    }

    if (activeDepots.length === 0) return;

    // Check all combat units
    const units = world.query(TURRET, TEAM, POSITION, HEALTH);
    for (const e of units) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const turret = world.getComponent<TurretComponent>(e, TURRET)!;

      const needsAmmo = turret.ammo < turret.maxAmmo;
      const needsRepair = health.current < health.max;
      if (!needsAmmo && !needsRepair) continue;

      // Find nearest depot in range for this unit's team
      for (const depot of activeDepots) {
        if (depot.team !== team.team) continue;
        const dx = pos.x - depot.x;
        const dz = pos.z - depot.z;
        if (dx * dx + dz * dz > RESUPPLY_RANGE_SQ) continue;

        const storage = world.getComponent<MatterStorageComponent>(depot.entity, MATTER_STORAGE)!;
        if (storage.stored <= 0) continue;

        // Refill ammo instantly
        if (turret.ammo < turret.maxAmmo) {
          const ammoNeeded = turret.maxAmmo - turret.ammo;
          const matterNeeded = ammoNeeded * AMMO_MATTER_COST;
          const matterAvailable = Math.min(matterNeeded, storage.stored);
          const ammoRefilled = Math.floor(matterAvailable / AMMO_MATTER_COST);
          if (ammoRefilled > 0) {
            turret.ammo += ammoRefilled;
            storage.stored -= ammoRefilled * AMMO_MATTER_COST;
          }
        }

        // Repair gradually
        if (health.current < health.max && storage.stored > 0) {
          const hpToRepair = Math.min(REPAIR_RATE * dt, health.max - health.current);
          const repairCost = hpToRepair * REPAIR_MATTER_COST;
          const affordable = Math.min(repairCost, storage.stored);
          const actualRepair = affordable / REPAIR_MATTER_COST;
          if (actualRepair > 0) {
            health.current = Math.min(health.current + actualRepair, health.max);
            storage.stored -= affordable;
          }
        }

        // Restore voxels proportionally to HP
        const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
        if (voxelState && voxelState.destroyedCount > 0) {
          const hpFraction = health.current / health.max;
          const targetDestroyed = Math.floor(voxelState.totalVoxels * (1 - hpFraction));
          if (voxelState.destroyedCount > targetDestroyed) {
            let toRestore = voxelState.destroyedCount - targetDestroyed;
            for (let byteIdx = 0; byteIdx < voxelState.destroyed.length && toRestore > 0; byteIdx++) {
              if (voxelState.destroyed[byteIdx] === 0) continue;
              for (let bitIdx = 0; bitIdx < 8 && toRestore > 0; bitIdx++) {
                if (voxelState.destroyed[byteIdx] & (1 << bitIdx)) {
                  voxelState.destroyed[byteIdx] &= ~(1 << bitIdx);
                  voxelState.destroyedCount--;
                  toRestore--;
                }
              }
            }
            voxelState.dirty = true;
          }
        }

        // Cancel any active RESUPPLY_SEEK since we're being passively served
        if (world.hasComponent(e, RESUPPLY_SEEK)) {
          world.removeComponent(e, RESUPPLY_SEEK);
        }

        break; // Only resupply from one depot per tick
      }
    }
  }

  /** Scan combat units with empty ammo not near a depot; add RESUPPLY_SEEK to move them. */
  private detectEmpty(world: World): void {
    const units = world.query(TURRET, TEAM, POSITION, HEALTH);

    for (const e of units) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      const turret = world.getComponent<TurretComponent>(e, TURRET)!;
      if (turret.ammo > 0) continue;

      // Already seeking resupply
      if (world.hasComponent(e, RESUPPLY_SEEK)) continue;

      world.addComponent<ResupplySeekComponent>(e, RESUPPLY_SEEK, {
        state: 'seeking',
        targetDepot: -1,
      });
    }
  }

  /** Process units in resupply states (for units far from depots that need to walk there). */
  private processResupply(world: World, dt: number): void {
    const units = world.query(RESUPPLY_SEEK, POSITION, HEALTH, TEAM);

    for (const e of units) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) {
        world.removeComponent(e, RESUPPLY_SEEK);
        continue;
      }

      const seek = world.getComponent<ResupplySeekComponent>(e, RESUPPLY_SEEK)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      switch (seek.state) {
        case 'seeking': {
          const depot = findNearestDepot(world, team.team, pos.x, pos.z);
          if (depot === null) {
            // No depot available -- stay in seeking state (idle)
            break;
          }
          seek.targetDepot = depot;
          seek.state = 'moving';

          // Issue move command toward depot
          const depotPos = world.getComponent<PositionComponent>(depot, POSITION)!;
          if (world.hasComponent(e, MOVE_COMMAND)) {
            world.removeComponent(e, MOVE_COMMAND);
          }
          world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
            path: [],
            currentWaypoint: 0,
            destX: depotPos.x,
            destZ: depotPos.z,
          });
          break;
        }

        case 'moving': {
          // Check if depot is still alive
          const depotHealth = world.getComponent<HealthComponent>(seek.targetDepot, HEALTH);
          if (!depotHealth || depotHealth.dead) {
            seek.state = 'seeking';
            seek.targetDepot = -1;
            break;
          }

          const depotPos = world.getComponent<PositionComponent>(seek.targetDepot, POSITION);
          if (!depotPos) {
            seek.state = 'seeking';
            seek.targetDepot = -1;
            break;
          }

          // Check if arrived within resupply range (passive aura will handle the actual resupply)
          const dx = pos.x - depotPos.x;
          const dz = pos.z - depotPos.z;
          const distSq = dx * dx + dz * dz;

          if (distSq <= RESUPPLY_RANGE_SQ) {
            // In range -- passive aura will handle resupply and remove RESUPPLY_SEEK
            if (world.hasComponent(e, MOVE_COMMAND)) {
              world.removeComponent(e, MOVE_COMMAND);
            }
          } else if (!world.hasComponent(e, MOVE_COMMAND)) {
            // Re-issue move command if pathfinding stopped early
            world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
              path: [],
              currentWaypoint: 0,
              destX: depotPos.x,
              destZ: depotPos.z,
            });
          }
          break;
        }

        case 'resupplying': {
          // Legacy state -- passive aura now handles this. Clean up.
          world.removeComponent(e, RESUPPLY_SEEK);
          break;
        }
      }
    }
  }
}
