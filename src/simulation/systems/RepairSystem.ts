import type { System, World } from '@core/ECS';
import {
  REPAIR_COMMAND, POSITION, HEALTH, TEAM,
  CONSTRUCTION, MOVE_COMMAND,
  VOXEL_STATE,
} from '@sim/components/ComponentTypes';
import type { RepairCommandComponent } from '@sim/components/RepairCommand';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ResourceState } from '@sim/economy/ResourceState';
import { REPAIR_RATE, REPAIR_MATTER_COST } from '@sim/economy/DepotUtils';
import type { EventBus } from '@core/EventBus';

const REPAIR_RANGE = 6; // must exceed largest building footprint radius + pathfinding margin
const REPAIR_RANGE_SQ = REPAIR_RANGE * REPAIR_RANGE;

export class RepairSystem implements System {
  readonly name = 'RepairSystem';

  private resources: ResourceState;
  private teamCount: number;
  private eventBus?: EventBus;

  constructor(resources: ResourceState, teamCount: number, eventBus?: EventBus) {
    this.resources = resources;
    this.teamCount = teamCount;
    this.eventBus = eventBus;
  }

  update(world: World, dt: number): void {
    this.workerRepair(world, dt);
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
        if (this.eventBus) {
          this.eventBus.emit('construction:active', workerPos.x, workerPos.z);
        }
      }

      this.restoreVoxels(world, repair.targetEntity, targetHealth, actualRepair);

      // Check if fully repaired
      if (targetHealth.current >= targetHealth.max) {
        world.removeComponent(e, REPAIR_COMMAND);
      }
    }
  }

  /** Restore voxels proportionally to HP repaired this tick. */
  private restoreVoxels(world: World, entity: number, health: HealthComponent, hpRepaired: number): void {
    const voxelState = world.getComponent<VoxelStateComponent>(entity, VOXEL_STATE);
    if (!voxelState || voxelState.destroyedCount <= 0) return;
    if (hpRepaired <= 0 && health.current < health.max) return;

    let toRestore: number;
    if (health.current >= health.max) {
      // Fully healed: restore all remaining
      toRestore = voxelState.destroyedCount;
    } else {
      // Restore voxels proportionally: destroyed remaining * (hpRepaired / hpStillNeeded)
      const hpStillMissing = health.max - health.current;
      toRestore = Math.max(1, Math.round(voxelState.destroyedCount * hpRepaired / (hpStillMissing + hpRepaired)));
    }

    let restored = 0;
    for (let byteIdx = 0; byteIdx < voxelState.destroyed.length && restored < toRestore; byteIdx++) {
      if (voxelState.destroyed[byteIdx] === 0) continue;
      for (let bitIdx = 0; bitIdx < 8 && restored < toRestore; bitIdx++) {
        if (voxelState.destroyed[byteIdx] & (1 << bitIdx)) {
          voxelState.destroyed[byteIdx] &= ~(1 << bitIdx);
          voxelState.destroyedCount--;
          restored++;
        }
      }
    }
    if (restored > 0) voxelState.dirty = true;
  }
}
