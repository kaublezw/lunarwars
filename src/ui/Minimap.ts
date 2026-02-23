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

// Border margin: border wall extends ~9 tiles from each edge of the 276x276 grid.
// Show only the inner playable area on the minimap.
const BORDER_MARGIN = 10;

const CLICK_THRESHOLD = 5;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private baseImage: ImageData;
  private frameImage: ImageData;
  private energyNodes: EnergyNode[];
  private playableStart: number;
  private playableSize: number;
  private rightDownPos: { x: number; y: number } | null = null;

  onRightClick?: (worldX: number, worldZ: number) => void;

  constructor(terrain: TerrainData, energyNodes: EnergyNode[]) {
    this.energyNodes = energyNodes;
    this.playableStart = BORDER_MARGIN;
    this.playableSize = terrain.width - 2 * BORDER_MARGIN;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 280;
    this.canvas.height = 280;
    this.canvas.style.cssText =
      'position:absolute;bottom:24px;right:24px;border:1px solid #444;pointer-events:auto;transform:rotate(45deg) scale(0.71);cursor:default;';

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        this.rightDownPos = { x: e.clientX, y: e.clientY };
      }
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button === 2 && this.rightDownPos) {
        const dx = e.clientX - this.rightDownPos.x;
        const dy = e.clientY - this.rightDownPos.y;
        if (Math.sqrt(dx * dx + dy * dy) <= CLICK_THRESHOLD) {
          const world = this.screenToWorld(e.clientX, e.clientY);
          if (world && this.onRightClick) {
            this.onRightClick(world.x, world.z);
          }
        }
        this.rightDownPos = null;
      }
    });

    this.ctx = this.canvas.getContext('2d')!;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Pre-render base heightmap image (only the playable interior)
    this.baseImage = this.ctx.createImageData(w, h);
    this.frameImage = this.ctx.createImageData(w, h);

    const scaleX = this.playableSize / w;
    const scaleZ = this.playableSize / h;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = this.playableStart + x * scaleX;
        const tz = this.playableStart + y * scaleZ;
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
    const scaleX = this.playableSize / w;
    const scaleZ = this.playableSize / h;

    // Copy base image to frame
    this.frameImage.data.set(this.baseImage.data);

    // Apply fog overlay per pixel (mapped to playable interior)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = Math.floor(this.playableStart + x * scaleX);
        const tz = Math.floor(this.playableStart + y * scaleZ);
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
      const mx = Math.floor(((node.x - this.playableStart) / this.playableSize) * w);
      const mz = Math.floor(((node.z - this.playableStart) / this.playableSize) * h);
      this.drawDot(mx, mz, 2, 0, 255, 255);
    }

    // Draw unit dots
    const entities = world.query(POSITION, TEAM);
    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      // Own units always visible; enemies only if in visible cells
      if (team.team !== playerTeam && !fogState.isVisible(playerTeam, pos.x, pos.z)) continue;

      const mx = Math.floor(((pos.x - this.playableStart) / this.playableSize) * w);
      const mz = Math.floor(((pos.z - this.playableStart) / this.playableSize) * h);
      const color = TEAM_COLORS[team.team] ?? [255, 255, 255];
      this.drawDot(mx, mz, 2, color[0], color[1], color[2]);
    }

    this.ctx.putImageData(this.frameImage, 0, 0);
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const centerScreenX = rect.left + rect.width / 2;
    const centerScreenY = rect.top + rect.height / 2;

    const dx = clientX - centerScreenX;
    const dy = clientY - centerScreenY;

    // Inverse CSS transform: undo rotate(45deg) then undo scale(0.71)
    const cos = Math.cos(-Math.PI / 4);
    const sin = Math.sin(-Math.PI / 4);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;

    const invScale = 1 / 0.71;
    const localX = rx * invScale;
    const localY = ry * invScale;

    const canvasX = localX + this.canvas.width / 2;
    const canvasY = localY + this.canvas.height / 2;

    if (canvasX < 0 || canvasX >= this.canvas.width || canvasY < 0 || canvasY >= this.canvas.height) {
      return null;
    }

    const worldX = this.playableStart + (canvasX / this.canvas.width) * this.playableSize;
    const worldZ = this.playableStart + (canvasY / this.canvas.height) * this.playableSize;
    return { x: worldX, z: worldZ };
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
