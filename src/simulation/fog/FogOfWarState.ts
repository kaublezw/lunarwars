import type { World } from '@core/ECS';
import { POSITION, TEAM, VISION } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { VisionComponent } from '@sim/components/Vision';

export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1;
export const FOG_VISIBLE = 2;

export class FogOfWarState {
  private grids: Uint8Array[];
  readonly width: number;
  readonly height: number;
  readonly teamCount: number;
  readonly padding: number;
  readonly gridWidth: number;
  readonly gridHeight: number;

  constructor(width: number, height: number, teamCount: number, padding: number = 0) {
    this.width = width;
    this.height = height;
    this.teamCount = teamCount;
    this.padding = padding;
    this.gridWidth = width + 2 * padding;
    this.gridHeight = height + 2 * padding;
    this.grids = [];
    for (let i = 0; i < teamCount; i++) {
      this.grids.push(new Uint8Array(this.gridWidth * this.gridHeight));
    }
  }

  update(world: World): void {
    // Demote VISIBLE -> EXPLORED for all teams
    for (let t = 0; t < this.teamCount; t++) {
      const grid = this.grids[t];
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === FOG_VISIBLE) {
          grid[i] = FOG_EXPLORED;
        }
      }
    }

    // Reveal circles for all entities with position + vision + team
    const entities = world.query(POSITION, VISION, TEAM);
    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vision = world.getComponent<VisionComponent>(e, VISION)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      this.revealCircle(team.team, pos.x, pos.z, vision.range);
    }
  }

  revealCircle(team: number, cx: number, cz: number, range: number): void {
    const grid = this.grids[team];
    if (!grid) return;

    // Offset world coords to grid coords
    const gcx = cx + this.padding;
    const gcz = cz + this.padding;
    const rangeSq = range * range;
    const minX = Math.max(0, Math.floor(gcx - range));
    const maxX = Math.min(this.gridWidth - 1, Math.ceil(gcx + range));
    const minZ = Math.max(0, Math.floor(gcz - range));
    const maxZ = Math.min(this.gridHeight - 1, Math.ceil(gcz + range));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - gcx;
        const dz = z - gcz;
        if (dx * dx + dz * dz <= rangeSq) {
          grid[z * this.gridWidth + x] = FOG_VISIBLE;
        }
      }
    }
  }

  isVisible(team: number, x: number, z: number): boolean {
    return this.getState(team, x, z) === FOG_VISIBLE;
  }

  isExplored(team: number, x: number, z: number): boolean {
    return this.getState(team, x, z) >= FOG_EXPLORED;
  }

  getState(team: number, x: number, z: number): number {
    const grid = this.grids[team];
    if (!grid) return FOG_UNEXPLORED;
    const gx = Math.floor(Math.max(0, Math.min(this.gridWidth - 1, x + this.padding)));
    const gz = Math.floor(Math.max(0, Math.min(this.gridHeight - 1, z + this.padding)));
    return grid[gz * this.gridWidth + gx];
  }

  serializeExplored(): number[][] {
    const result: number[][] = [];
    const p = this.padding;
    for (let t = 0; t < this.teamCount; t++) {
      const grid = this.grids[t];
      const indices: number[] = [];
      // Only serialize the inner width x height region (playable area)
      for (let z = 0; z < this.height; z++) {
        for (let x = 0; x < this.width; x++) {
          const gi = (z + p) * this.gridWidth + (x + p);
          if (grid[gi] >= FOG_EXPLORED) {
            indices.push(z * this.width + x);
          }
        }
      }
      result.push(indices);
    }
    return result;
  }

  deserializeExplored(data: number[][]): void {
    const p = this.padding;
    for (let t = 0; t < Math.min(data.length, this.teamCount); t++) {
      const grid = this.grids[t];
      for (const idx of data[t]) {
        // Convert inner index to grid index
        const ix = idx % this.width;
        const iz = Math.floor(idx / this.width);
        if (ix >= 0 && ix < this.width && iz >= 0 && iz < this.height) {
          grid[(iz + p) * this.gridWidth + (ix + p)] = FOG_EXPLORED;
        }
      }
    }
  }

  getGrid(team: number): Uint8Array {
    return this.grids[team];
  }
}
