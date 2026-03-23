import { UnitCategory } from '@sim/components/UnitType';

export class QuickSelectBar {
  private container: HTMLDivElement;
  private scopeButton: HTMLButtonElement;
  private selectAll = false;

  onSelectIdleWorker: (() => void) | null = null;
  onSelectMilitary: ((categories: UnitCategory[], selectAll: boolean) => void) | null = null;

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

    this.scopeButton = this.createButton('Screen', () => {
      this.selectAll = !this.selectAll;
      this.scopeButton.textContent = this.selectAll ? 'MAP' : 'Screen';
      this.scopeButton.style.background = this.selectAll
        ? 'rgba(68, 200, 68, 0.3)'
        : 'rgba(68, 136, 255, 0.3)';
      this.scopeButton.style.borderColor = this.selectAll
        ? 'rgba(68, 200, 68, 0.6)'
        : 'rgba(68, 136, 255, 0.6)';
    });
    this.container.appendChild(this.scopeButton);

    const idleWorkerBtn = this.createButton('Idle Worker', () => {
      this.onSelectIdleWorker?.();
    });
    this.container.appendChild(idleWorkerBtn);

    const tankBtn = this.createButton('Tanks', () => {
      this.onSelectMilitary?.([UnitCategory.AssaultPlatform], this.selectAll);
    });
    this.container.appendChild(tankBtn);

    const airBtn = this.createButton('Air', () => {
      this.onSelectMilitary?.([UnitCategory.AerialDrone], this.selectAll);
    });
    this.container.appendChild(airBtn);

    const combatBtn = this.createButton('Combat', () => {
      this.onSelectMilitary?.([UnitCategory.CombatDrone], this.selectAll);
    });
    this.container.appendChild(combatBtn);
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
