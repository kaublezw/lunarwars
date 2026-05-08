import type { AIContext, EnemyMemoryEntry, IntelligenceReport } from '@sim/ai/AITypes';
import {
  INFLUENCE_GRID, INFLUENCE_CELL,
  CASUALTY_DECAY_PER_TICK, CASUALTY_BLEED, CASUALTY_DEATH_WEIGHT, CASUALTY_CELL_CAP,
  generateSpiralWaypoints,
} from '@sim/ai/AITypes';
import { assessWorldState, determinePhase, findIsolatedTarget, getNextScoutTarget } from '@sim/ai/AIQueries';
import { updateInfluenceGrid } from '@sim/ai/AIInfluence';
import { issueMove } from '@sim/ai/AIActions';
import { MOVE_COMMAND, POSITION, TEAM, UNIT_TYPE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';

export class IntelligenceManager {
  private enemyMemory: Map<number, EnemyMemoryEntry> = new Map();
  private influenceGrid: Float32Array = new Float32Array(INFLUENCE_GRID * INFLUENCE_GRID * 3);
  private casualtyGrid: Float32Array = new Float32Array(INFLUENCE_GRID * INFLUENCE_GRID);
  private previousUnitPositions: Map<number, { x: number; z: number }> = new Map();
  private scoutWaypoints: { x: number; z: number }[] | null = null;
  private scoutWaypointIndex = 0;
  private scoutWaypointIndex2 = -1;

  update(ctx: AIContext): IntelligenceReport {
    const state = assessWorldState(ctx, this.enemyMemory);
    const phase = determinePhase(state);
    updateInfluenceGrid(this.influenceGrid, ctx, state);
    this.updateCasualtyGrid(ctx);
    this.executeScouting(ctx, state);

    return {
      state,
      phase,
      influenceGrid: this.influenceGrid,
      casualtyGrid: this.casualtyGrid,
      enemyMemory: this.enemyMemory,
    };
  }

  private updateCasualtyGrid(ctx: AIContext): void {
    const G = INFLUENCE_GRID;
    const C = INFLUENCE_CELL;

    // Snapshot current AI-team unit positions
    const currentPositions = new Map<number, { x: number; z: number }>();
    const units = ctx.world.query(POSITION, UNIT_TYPE, TEAM);
    for (const e of units) {
      const team = ctx.world.getComponent<TeamComponent>(e, TEAM);
      if (!team || team.team !== ctx.team) continue;
      const pos = ctx.world.getComponent<PositionComponent>(e, POSITION);
      if (!pos) continue;
      currentPositions.set(e, { x: pos.x, z: pos.z });
    }

    // Detect deaths: previous IDs not in current set are casualties
    for (const [id, prevPos] of this.previousUnitPositions) {
      if (currentPositions.has(id)) continue;
      const cx = Math.min(G - 1, Math.max(0, Math.floor(prevPos.x / C)));
      const cz = Math.min(G - 1, Math.max(0, Math.floor(prevPos.z / C)));
      this.casualtyGrid[cz * G + cx] += CASUALTY_DEATH_WEIGHT;
      // Bleed to 8 neighbors
      const bleed = CASUALTY_DEATH_WEIGHT * CASUALTY_BLEED;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= G || nz < 0 || nz >= G) continue;
          this.casualtyGrid[nz * G + nx] += bleed;
        }
      }
    }

    // Decay all cells (per-AI-tick exponential decay) and cap to avoid runaway accumulation
    for (let i = 0; i < this.casualtyGrid.length; i++) {
      const v = this.casualtyGrid[i] * CASUALTY_DECAY_PER_TICK;
      this.casualtyGrid[i] = v > CASUALTY_CELL_CAP ? CASUALTY_CELL_CAP : v;
    }

    this.previousUnitPositions = currentPositions;
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
      casualtyGrid: Array.from(this.casualtyGrid),
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
    if (Array.isArray(data.casualtyGrid)) {
      const arr = data.casualtyGrid as number[];
      const N = INFLUENCE_GRID * INFLUENCE_GRID;
      this.casualtyGrid = new Float32Array(N);
      for (let i = 0; i < Math.min(arr.length, N); i++) {
        this.casualtyGrid[i] = arr[i];
      }
    } else {
      this.casualtyGrid = new Float32Array(INFLUENCE_GRID * INFLUENCE_GRID);
    }
    this.previousUnitPositions = new Map();
  }
}
