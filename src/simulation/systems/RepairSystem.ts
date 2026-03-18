import type { System, World } from '@core/ECS';
import {
  REPAIR_COMMAND, POSITION, HEALTH, TEAM, BUILDING,
  CONSTRUCTION, DEPOT_RADIUS, MOVE_COMMAND,
  VOXEL_STATE,
} from '@sim/components/ComponentTypes';
import type { RepairCommandComponent } from '@sim/components/RepairCommand';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ResourceState } from '@sim/economy/ResourceState';
import { REPAIR_RATE, REPAIR_MATTER_COST } from '@sim/economy/DepotUtils';
import { getBuildingSiloTotal, deductFromBuildingSilos } from '@sim/economy/SiloUtils';

const REPAIR_RANGE = 4;
const REPAIR_RANGE_SQ = REPAIR_RANGE * REPAIR_RANGE;

export class RepairSystem implements System {
  readonly name = 'RepairSystem';

  private resources: ResourceState;
  private teamCount: number;

  constructor(resources: ResourceState, teamCount: number) {
    this.resources = resources;
    this.teamCount = teamCount;
  }

  update(world: World, dt: number): void {
    this.depotSelfRepair(world, dt);
    this.workerRepair(world, dt);
  }

  /** Completed depots with nearby matter silos auto-repair themselves. */
  private depotSelfRepair(world: World, dt: number): void {
    const depots = world.query(DEPOT_RADIUS, HEALTH, BUILDING);

    for (const d of depots) {
      if (world.hasComponent(d, CONSTRUCTION)) continue;
      const health = world.getComponent<HealthComponent>(d, HEALTH)!;
      if (health.dead) continue;
      if (health.current >= health.max) continue;

      const available = getBuildingSiloTotal(world, d, 'matter');
      if (available <= 0) continue;

      const hpToRepair = Math.min(REPAIR_RATE * dt, health.max - health.current);
      const repairCost = hpToRepair * REPAIR_MATTER_COST;
      const affordable = Math.min(repairCost, available);
      const actualRepair = affordable / REPAIR_MATTER_COST;

      if (actualRepair > 0) {
        health.current = Math.min(health.current + actualRepair, health.max);
        deductFromBuildingSilos(world, d, 'matter', affordable);
      }

      this.restoreVoxels(world, d, health);
    }
  }

  /** Workers with REPAIR_COMMAND move to building and gradually restore HP. */
  private workerRepair(world: World, dt: number): void {
    const workers = world.query(REPAIR_COMMAND, POSITION);

    for (const e of workers) {
      const repair = world.getComponent<RepairCommandComponent>(e, REPAIR_COMMAND)!;
      const workerPos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Check target is still valid
      const targetHealth = world.getComponent<HealthComponent>(repair.targetEntity, HEALTH);
      if (!targetHealth || targetHealth.dead) {
        world.removeComponent(e, REPAIR_COMMAND);
        continue;
      }

      // If fully repaired, done
      if (targetHealth.current >= targetHealth.max) {
        world.removeComponent(e, REPAIR_COMMAND);
        continue;
      }

      if (repair.state === 'moving') {
        // Wait for MOVE_COMMAND to be removed (arrived)
        if (!world.hasComponent(e, MOVE_COMMAND)) {
          repair.state = 'repairing';
        }
        continue;
      }

      // state === 'repairing'
      const targetPos = world.getComponent<PositionComponent>(repair.targetEntity, POSITION);
      if (!targetPos) {
        world.removeComponent(e, REPAIR_COMMAND);
        continue;
      }

      // Check distance
      const dx = workerPos.x - targetPos.x;
      const dz = workerPos.z - targetPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > REPAIR_RANGE_SQ) {
        // Re-issue move command
        world.addComponent(e, MOVE_COMMAND, {
          path: [],
          currentWaypoint: 0,
          destX: targetPos.x,
          destZ: targetPos.z,
        });
        repair.state = 'moving';
        continue;
      }

      // Determine team for global pool deduction
      const team = world.getComponent<TeamComponent>(e, TEAM);
      if (!team) {
        world.removeComponent(e, REPAIR_COMMAND);
        continue;
      }

      const hpToRepair = Math.min(REPAIR_RATE * dt, targetHealth.max - targetHealth.current);
      const repairCost = hpToRepair * REPAIR_MATTER_COST;

      // Deduct from global matter pool
      const teamMatter = this.resources.get(team.team).matter;
      const affordable = Math.min(repairCost, teamMatter);
      const actualRepair = affordable / REPAIR_MATTER_COST;

      if (actualRepair > 0) {
        targetHealth.current = Math.min(targetHealth.current + actualRepair, targetHealth.max);
        this.resources.spendMatter(team.team, affordable);
      }

      this.restoreVoxels(world, repair.targetEntity, targetHealth);

      // Check if fully repaired
      if (targetHealth.current >= targetHealth.max) {
        world.removeComponent(e, REPAIR_COMMAND);
      }
    }
  }

  /** Restore voxels proportionally to HP (same pattern as ResupplySystem). */
  private restoreVoxels(world: World, entity: number, health: HealthComponent): void {
    const voxelState = world.getComponent<VoxelStateComponent>(entity, VOXEL_STATE);
    if (!voxelState || voxelState.destroyedCount <= 0) return;

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
}
