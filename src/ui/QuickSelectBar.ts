export class QuickSelectBar {
  private container: HTMLDivElement;
  private stickyButton: HTMLButtonElement;
  private _stickySelection = false;

  onSelectIdleWorker: (() => void) | null = null;
  onStickySelectionChanged: ((active: boolean) => void) | null = null;

  get stickySelection(): boolean {
    return this._stickySelection;
  }

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 4px;
      z-index: 20;
      pointer-events: auto;
    `;

    this.stickyButton = this.createButton('Sticky: OFF', () => {
      this._stickySelection = !this._stickySelection;
      this.stickyButton.textContent = this._stickySelection ? 'Sticky: ON' : 'Sticky: OFF';
      this.stickyButton.style.background = this._stickySelection
        ? 'rgba(68, 200, 68, 0.3)'
        : 'rgba(68, 136, 255, 0.3)';
      this.stickyButton.style.borderColor = this._stickySelection
        ? 'rgba(68, 200, 68, 0.6)'
        : 'rgba(68, 136, 255, 0.6)';
      this.onStickySelectionChanged?.(this._stickySelection);
    });
    this.container.appendChild(this.stickyButton);

    const idleWorkerBtn = this.createButton('Idle Worker', () => {
      this.onSelectIdleWorker?.();
    });
    this.container.appendChild(idleWorkerBtn);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  private createButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      background: rgba(68, 136, 255, 0.3);
      border: 1px solid rgba(68, 136, 255, 0.6);
      border-radius: 4px;
      color: #ddd;
      font-family: monospace;
      font-size: 11px;
      padding: 8px 10px;
      cursor: pointer;
      min-width: 70px;
      text-align: center;
      touch-action: manipulation;
    `;
    const stop = (e: Event) => { e.stopPropagation(); };
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('touchstart', stop);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }
}
