import type { System, World } from '@core/ECS';
import {
  TURRET, TEAM, POSITION, HEALTH, MOVE_COMMAND, RESUPPLY_SEEK,
  BUILDING, CONSTRUCTION, DEPOT_RADIUS, VOXEL_STATE, RESOURCE_SILO, UNIT_TYPE,
} from '@sim/components/ComponentTypes';
import type { TurretComponent } from '@sim/components/Turret';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ResupplySeekComponent } from '@sim/components/ResupplySeek';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { findNearestDepot, RESUPPLY_RANGE, AMMO_MATTER_COST, REPAIR_MATTER_COST, REPAIR_RATE } from '@sim/economy/DepotUtils';
import { getBuildingSiloTotal, deductFromBuildingSilos } from '@sim/economy/SiloUtils';

const RESUPPLY_RANGE_SQ = RESUPPLY_RANGE * RESUPPLY_RANGE;

export class ResupplySystem implements System {
  readonly name = 'ResupplySystem';

  update(world: World, dt: number): void {
    this.passiveAura(world, dt);
    this.detectEmpty(world);
    this.processResupply(world, dt);
  }

  /** Passive aura: any combat unit near a depot with matter silos gets ammo + repair. */
  private passiveAura(world: World, dt: number): void {
    // Collect all active depots
    const depots = world.query(DEPOT_RADIUS, BUILDING, TEAM, POSITION, HEALTH);
    const activeDepots: { entity: number; team: number; x: number; z: number }[] = [];

    for (const d of depots) {
      if (world.hasComponent(d, CONSTRUCTION)) continue;
      const health = world.getComponent<HealthComponent>(d, HEALTH)!;
      if (health.dead) continue;
      // Check if depot has matter silos with resources
      const matterTotal = getBuildingSiloTotal(world, d, 'matter');
      if (matterTotal <= 0) continue;
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

      for (const depot of activeDepots) {
        if (depot.team !== team.team) continue;
        const dx = pos.x - depot.x;
        const dz = pos.z - depot.z;
        if (dx * dx + dz * dz > RESUPPLY_RANGE_SQ) continue;

        const available = getBuildingSiloTotal(world, depot.entity, 'matter');
        if (available <= 0) continue;

        // Refill ammo instantly from depot silos
        if (turret.ammo < turret.maxAmmo) {
          const ammoNeeded = turret.maxAmmo - turret.ammo;
          const matterNeeded = ammoNeeded * AMMO_MATTER_COST;
          const matterAvailable = Math.min(matterNeeded, available);
          const ammoRefilled = Math.floor(matterAvailable / AMMO_MATTER_COST);
          if (ammoRefilled > 0) {
            turret.ammo += ammoRefilled;
            deductFromBuildingSilos(world, depot.entity, 'matter', ammoRefilled * AMMO_MATTER_COST);
          }
        }

        // Repair gradually from depot silos
        const remainingMatter = getBuildingSiloTotal(world, depot.entity, 'matter');
        if (health.current < health.max && remainingMatter > 0) {
          const hpToRepair = Math.min(REPAIR_RATE * dt, health.max - health.current);
          const repairCost = hpToRepair * REPAIR_MATTER_COST;
          const affordable = Math.min(repairCost, remainingMatter);
          const actualRepair = affordable / REPAIR_MATTER_COST;
          if (actualRepair > 0) {
            health.current = Math.min(health.current + actualRepair, health.max);
            deductFromBuildingSilos(world, depot.entity, 'matter', affordable);
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

        if (world.hasComponent(e, RESUPPLY_SEEK)) {
          world.removeComponent(e, RESUPPLY_SEEK);
        }

        break;
      }
    }
  }

  private detectEmpty(world: World): void {
    const units = world.query(TURRET, TEAM, POSITION, HEALTH);
    for (const e of units) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const turret = world.getComponent<TurretComponent>(e, TURRET)!;
      if (turret.ammo > 0) continue;
      if (world.hasComponent(e, RESUPPLY_SEEK)) continue;
      world.addComponent<ResupplySeekComponent>(e, RESUPPLY_SEEK, {
        state: 'seeking',
        targetDepot: -1,
      });
    }
  }

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
          if (depot === null) break;
          seek.targetDepot = depot;
          seek.state = 'moving';
          const depotPos = world.getComponent<PositionComponent>(depot, POSITION)!;
          if (world.hasComponent(e, MOVE_COMMAND)) {
            world.removeComponent(e, MOVE_COMMAND);
          }
          world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: depotPos.x, destZ: depotPos.z,
          });
          break;
        }
        case 'moving': {
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
          const dx = pos.x - depotPos.x;
          const dz = pos.z - depotPos.z;
          if (dx * dx + dz * dz <= RESUPPLY_RANGE_SQ) {
            if (world.hasComponent(e, MOVE_COMMAND)) {
              world.removeComponent(e, MOVE_COMMAND);
            }
          } else if (!world.hasComponent(e, MOVE_COMMAND)) {
            world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
              path: [], currentWaypoint: 0,
              destX: depotPos.x, destZ: depotPos.z,
            });
          }
          break;
        }
        case 'resupplying': {
          world.removeComponent(e, RESUPPLY_SEEK);
          break;
        }
      }
    }
  }
}
