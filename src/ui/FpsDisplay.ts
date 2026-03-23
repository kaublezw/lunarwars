const EMA_ALPHA = 0.05;

export class FpsDisplay {
  private el: HTMLDivElement;
  private smoothedFps = 60;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      bottom: 12px;
      right: 12px;
      background: rgba(0, 0, 0, 0.5);
      border-radius: 3px;
      padding: 2px 6px;
      color: #aaa;
      font-family: monospace;
      font-size: 11px;
      pointer-events: none;
      z-index: 1000;
    `;
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  update(fps: number): void {
    this.smoothedFps += EMA_ALPHA * (fps - this.smoothedFps);
    this.el.textContent = `FPS: ${Math.round(this.smoothedFps)}`;
  }
}
