import type { World } from '@core/ECS';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { EnergyNode } from '@sim/terrain/MapFeatures';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import { POSITION, TEAM } from '@sim/components/ComponentTypes';
import { FOG_UNEXPLORED, FOG_EXPLORED } from '@sim/fog/FogOfWarState';

// Height range for grayscale mapping (world units)
const MIN_H = -3.0;
const MAX_H = 4.5;
const H_RANGE = MAX_H - MIN_H;

const TEAM_COLORS: [number, number, number][] = [
  [68, 136, 255],  // team 0 = blue
  [255, 68, 68],   // team 1 = red
];

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private baseImage: ImageData;
  private frameImage: ImageData;
  private energyNodes: EnergyNode[];
  private terrainWidth: number;
  private terrainHeight: number;

  constructor(terrain: TerrainData, energyNodes: EnergyNode[]) {
    this.energyNodes = energyNodes;
    this.terrainWidth = terrain.width;
    this.terrainHeight = terrain.height;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 280;
    this.canvas.height = 280;
    this.canvas.style.cssText =
      'position:absolute;bottom:24px;right:24px;border:1px solid #444;pointer-events:none;transform:rotate(45deg) scale(0.71);';

    this.ctx = this.canvas.getContext('2d')!;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Pre-render base heightmap image
    this.baseImage = this.ctx.createImageData(w, h);
    this.frameImage = this.ctx.createImageData(w, h);

    const scaleX = terrain.width / w;
    const scaleZ = terrain.height / h;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = x * scaleX;
        const tz = y * scaleZ;
        const height = terrain.getHeight(tx, tz);
        const normalized = (height - MIN_H) / H_RANGE;
        const v = Math.floor(normalized * 180 + 40);
        const idx = (y * w + x) * 4;
        this.baseImage.data[idx + 0] = v;
        this.baseImage.data[idx + 1] = v;
        this.baseImage.data[idx + 2] = v;
        this.baseImage.data[idx + 3] = 255;
      }
    }
  }

  update(fogState: FogOfWarState, playerTeam: number, world: World): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const scaleX = this.terrainWidth / w;
    const scaleZ = this.terrainHeight / h;

    // Copy base image to frame
    this.frameImage.data.set(this.baseImage.data);

    // Apply fog overlay per pixel
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = Math.floor(x * scaleX);
        const tz = Math.floor(y * scaleZ);
        const state = fogState.getState(playerTeam, tx, tz);
        const idx = (y * w + x) * 4;

        if (state === FOG_UNEXPLORED) {
          // Near-black
          this.frameImage.data[idx + 0] = 10;
          this.frameImage.data[idx + 1] = 10;
          this.frameImage.data[idx + 2] = 12;
        } else if (state === FOG_EXPLORED) {
          // Darken 55%
          this.frameImage.data[idx + 0] = Math.floor(this.frameImage.data[idx + 0] * 0.45);
          this.frameImage.data[idx + 1] = Math.floor(this.frameImage.data[idx + 1] * 0.45);
          this.frameImage.data[idx + 2] = Math.floor(this.frameImage.data[idx + 2] * 0.45);
        }
        // VISIBLE: leave unchanged
      }
    }

    // Draw energy nodes (only if explored)
    for (const node of this.energyNodes) {
      if (!fogState.isExplored(playerTeam, node.x, node.z)) continue;
      const mx = Math.floor((node.x / this.terrainWidth) * w);
      const mz = Math.floor((node.z / this.terrainHeight) * h);
      this.drawDot(mx, mz, 2, 0, 255, 255);
    }

    // Draw unit dots
    const entities = world.query(POSITION, TEAM);
    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      // Own units always visible; enemies only if in visible cells
      if (team.team !== playerTeam && !fogState.isVisible(playerTeam, pos.x, pos.z)) continue;

      const mx = Math.floor((pos.x / this.terrainWidth) * w);
      const mz = Math.floor((pos.z / this.terrainHeight) * h);
      const color = TEAM_COLORS[team.team] ?? [255, 255, 255];
      this.drawDot(mx, mz, 2, color[0], color[1], color[2]);
    }

    this.ctx.putImageData(this.frameImage, 0, 0);
  }

  private drawDot(cx: number, cy: number, radius: number, r: number, g: number, b: number): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const idx = (py * w + px) * 4;
        this.frameImage.data[idx + 0] = r;
        this.frameImage.data[idx + 1] = g;
        this.frameImage.data[idx + 2] = b;
        this.frameImage.data[idx + 3] = 255;
      }
    }
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.canvas);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
