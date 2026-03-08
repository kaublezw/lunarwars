import type { AIContext, EnemyMemoryEntry, IntelligenceReport } from '@sim/ai/AITypes';
import { INFLUENCE_GRID, generateSpiralWaypoints } from '@sim/ai/AITypes';
import { assessWorldState, determinePhase, findIsolatedTarget, getNextScoutTarget } from '@sim/ai/AIQueries';
import { updateInfluenceGrid } from '@sim/ai/AIInfluence';
import { issueMove } from '@sim/ai/AIActions';
import { MOVE_COMMAND } from '@sim/components/ComponentTypes';

export class IntelligenceManager {
  private enemyMemory: Map<number, EnemyMemoryEntry> = new Map();
  private influenceGrid: Float32Array = new Float32Array(INFLUENCE_GRID * INFLUENCE_GRID * 3);
  private scoutWaypoints: { x: number; z: number }[] | null = null;
  private scoutWaypointIndex = 0;
  private scoutWaypointIndex2 = -1;

  update(ctx: AIContext): IntelligenceReport {
    const state = assessWorldState(ctx, this.enemyMemory);
    const phase = determinePhase(state);
    updateInfluenceGrid(this.influenceGrid, ctx, state);
    this.executeScouting(ctx, state);

    return { state, phase, influenceGrid: this.influenceGrid, enemyMemory: this.enemyMemory };
  }

  private executeScouting(ctx: AIContext, state: { myAerial: number[] }): void {
    if (!this.scoutWaypoints) {
      this.scoutWaypoints = generateSpiralWaypoints(ctx.baseX, ctx.baseZ);
      if (this.scoutWaypointIndex2 < 0) {
        this.scoutWaypointIndex2 = Math.floor(this.scoutWaypoints.length / 2);
      }
    }

    const scouts = state.myAerial.slice(0, 2);
    const raidTarget = findIsolatedTarget(state as ReturnType<typeof assessWorldState>);

    for (let i = 0; i < scouts.length; i++) {
      const scout = scouts[i];
      if (ctx.world.hasComponent(scout, MOVE_COMMAND)) continue;

      if (i === 0 && raidTarget) {
        issueMove(ctx, scout, raidTarget.x, raidTarget.z);
      } else {
        const waypointIndex = i === 0 ? this.scoutWaypointIndex : this.scoutWaypointIndex2;
        const target = getNextScoutTarget(ctx, waypointIndex, this.scoutWaypoints);
        issueMove(ctx, scout, target.x, target.z);

        if (i === 0) {
          this.scoutWaypointIndex = (this.scoutWaypointIndex + 1) % this.scoutWaypoints.length;
        } else {
          this.scoutWaypointIndex2 = (this.scoutWaypointIndex2 + 1) % this.scoutWaypoints.length;
        }
      }
    }
  }

  serialize(): Record<string, unknown> {
    return {
      scoutWaypointIndex: this.scoutWaypointIndex,
      scoutWaypointIndex2: this.scoutWaypointIndex2,
      enemyMemory: [...this.enemyMemory.values()],
    };
  }

  deserialize(data: Record<string, unknown>): void {
    this.scoutWaypointIndex = (data.scoutWaypointIndex as number) ?? 0;
    this.scoutWaypointIndex2 = (data.scoutWaypointIndex2 as number) ?? -1;
    this.enemyMemory = new Map();
    if (Array.isArray(data.enemyMemory)) {
      for (const entry of data.enemyMemory as EnemyMemoryEntry[]) {
        this.enemyMemory.set(entry.entityId, entry);
      }
    }
  }
}
