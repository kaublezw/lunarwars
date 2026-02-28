export class PauseOverlay {
  private container: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 1050;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      pointer-events: auto;
    `;

    const heading = document.createElement('div');
    heading.textContent = 'PAUSED';
    heading.style.cssText = `
      font-family: monospace;
      font-size: 64px;
      font-weight: bold;
      letter-spacing: 8px;
      color: #fff;
      margin-bottom: 16px;
    `;

    const hint = document.createElement('div');
    hint.textContent = 'Press P to resume';
    hint.style.cssText = `
      font-family: monospace;
      font-size: 20px;
      color: #ccc;
    `;

    this.container.appendChild(heading);
    this.container.appendChild(hint);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  show(): void {
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.container.style.display = 'none';
  }
}
