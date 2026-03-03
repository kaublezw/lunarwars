import type * as THREE from 'three';

const EMA_ALPHA = 0.05;

export class PerfPanel {
  private container: HTMLDivElement;
  private visible = false;
  private smoothedFps = 60;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      top: 46px;
      right: 10px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 4px 10px;
      color: #ccc;
      font-family: monospace;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      white-space: nowrap;
      display: none;
    `;
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
  }

  update(fps: number, rendererInfo: THREE.WebGLInfo, entityCount: number, debrisCount: number): void {
    if (!this.visible) return;

    this.smoothedFps += EMA_ALPHA * (fps - this.smoothedFps);

    const draws = rendererInfo.render.calls;
    const tris = rendererInfo.render.triangles;
    const triStr = tris >= 1000 ? (tris / 1000).toFixed(1) + 'K' : String(tris);

    this.container.textContent =
      `FPS: ${Math.round(this.smoothedFps)}  |  Draw: ${draws}  |  Tri: ${triStr}  |  Ents: ${entityCount}  |  Debris: ${debrisCount}`;
  }
}
