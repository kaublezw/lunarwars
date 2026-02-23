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

  constructor(width: number, height: number, teamCount: number) {
    this.width = width;
    this.height = height;
    this.teamCount = teamCount;
    this.grids = [];
    for (let i = 0; i < teamCount; i++) {
      this.grids.push(new Uint8Array(width * height));
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

    const rangeSq = range * range;
    const minX = Math.max(0, Math.floor(cx - range));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + range));
    const minZ = Math.max(0, Math.floor(cz - range));
    const maxZ = Math.min(this.height - 1, Math.ceil(cz + range));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz <= rangeSq) {
          grid[z * this.width + x] = FOG_VISIBLE;
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
    const ix = Math.floor(Math.max(0, Math.min(this.width - 1, x)));
    const iz = Math.floor(Math.max(0, Math.min(this.height - 1, z)));
    return grid[iz * this.width + ix];
  }

  serializeExplored(): number[][] {
    const result: number[][] = [];
    for (let t = 0; t < this.teamCount; t++) {
      const grid = this.grids[t];
      const indices: number[] = [];
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] >= FOG_EXPLORED) {
          indices.push(i);
        }
      }
      result.push(indices);
    }
    return result;
  }

  deserializeExplored(data: number[][]): void {
    for (let t = 0; t < Math.min(data.length, this.teamCount); t++) {
      const grid = this.grids[t];
      for (const idx of data[t]) {
        if (idx >= 0 && idx < grid.length) {
          grid[idx] = FOG_EXPLORED;
        }
      }
    }
  }

  getGrid(team: number): Uint8Array {
    return this.grids[team];
  }
}
