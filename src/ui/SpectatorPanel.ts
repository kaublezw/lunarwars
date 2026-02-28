import type { ResourceState } from '@sim/economy/ResourceState';

export type FogMode = 'none' | 'team0' | 'team1';

export class SpectatorPanel {
  private container: HTMLDivElement;
  private speedButtons: HTMLButtonElement[] = [];
  private fogButtons: HTMLButtonElement[] = [];
  private resourceEl: HTMLDivElement;
  private currentSpeed = 1;
  private currentFog: FogMode = 'none';

  onSpeedChange?: (scale: number) => void;
  onFogChange?: (mode: FogMode) => void;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      padding: 8px 16px;
      color: #ddd;
      font-family: monospace;
      font-size: 13px;
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 16px;
      pointer-events: auto;
    `;

    // Speed controls
    const speedGroup = this.createGroup('Speed:');
    const speeds = [1, 2, 4, 8];
    for (const s of speeds) {
      const btn = this.createButton(`${s}x`, () => {
        this.currentSpeed = s;
        this.highlightSpeed();
        this.onSpeedChange?.(s);
      });
      this.speedButtons.push(btn);
      speedGroup.appendChild(btn);
    }
    this.container.appendChild(speedGroup);

    // Separator
    this.container.appendChild(this.createSeparator());

    // Fog controls
    const fogGroup = this.createGroup('View:');
    const fogOptions: { label: string; mode: FogMode; color?: string }[] = [
      { label: 'All', mode: 'none' },
      { label: 'Blue', mode: 'team0', color: '#4488ff' },
      { label: 'Red', mode: 'team1', color: '#ff4444' },
    ];
    for (const opt of fogOptions) {
      const btn = this.createButton(opt.label, () => {
        this.currentFog = opt.mode;
        this.highlightFog();
        this.onFogChange?.(opt.mode);
      });
      if (opt.color) {
        btn.dataset.teamColor = opt.color;
      }
      this.fogButtons.push(btn);
      fogGroup.appendChild(btn);
    }
    this.container.appendChild(fogGroup);

    // Separator
    this.container.appendChild(this.createSeparator());

    // Resources display
    this.resourceEl = document.createElement('div');
    this.resourceEl.style.cssText = 'display:flex;gap:20px;';
    this.container.appendChild(this.resourceEl);

    // Set initial highlights
    this.highlightSpeed();
    this.highlightFog();
  }

  private createGroup(label: string): HTMLDivElement {
    const group = document.createElement('div');
    group.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'color:#999;margin-right:4px;';
    group.appendChild(lbl);
    return group;
  }

  private createButton(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 3px 8px;
      background: #333;
      color: #ccc;
      border: 1px solid #555;
      border-radius: 3px;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;
    `;
    btn.addEventListener('mouseenter', () => {
      if (!btn.dataset.active) btn.style.background = '#444';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.dataset.active) btn.style.background = '#333';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  private createSeparator(): HTMLDivElement {
    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:20px;background:#555;';
    return sep;
  }

  private highlightSpeed(): void {
    const speeds = [1, 2, 4, 8];
    for (let i = 0; i < this.speedButtons.length; i++) {
      const active = speeds[i] === this.currentSpeed;
      const btn = this.speedButtons[i];
      btn.dataset.active = active ? '1' : '';
      btn.style.background = active ? '#5a5' : '#333';
      btn.style.color = active ? '#fff' : '#ccc';
      btn.style.borderColor = active ? '#6b6' : '#555';
    }
  }

  private highlightFog(): void {
    const modes: FogMode[] = ['none', 'team0', 'team1'];
    for (let i = 0; i < this.fogButtons.length; i++) {
      const active = modes[i] === this.currentFog;
      const btn = this.fogButtons[i];
      const teamColor = btn.dataset.teamColor;
      btn.dataset.active = active ? '1' : '';
      if (active && teamColor) {
        btn.style.background = teamColor;
        btn.style.color = '#fff';
        btn.style.borderColor = teamColor;
      } else if (active) {
        btn.style.background = '#5a5';
        btn.style.color = '#fff';
        btn.style.borderColor = '#6b6';
      } else {
        btn.style.background = '#333';
        btn.style.color = teamColor ?? '#ccc';
        btn.style.borderColor = '#555';
      }
    }
  }

  update(resources: ResourceState): void {
    const blue = resources.get(0);
    const red = resources.get(1);

    const bESign = blue.energyRate >= 0 ? '+' : '';
    const bMSign = blue.matterRate >= 0 ? '+' : '';
    const rESign = red.energyRate >= 0 ? '+' : '';
    const rMSign = red.matterRate >= 0 ? '+' : '';

    this.resourceEl.innerHTML =
      `<span style="color:#4488ff">` +
      `E:${Math.floor(blue.energy)}` +
      `<span style="font-size:10px;color:#6699cc"> (${bESign}${blue.energyRate.toFixed(1)})</span>` +
      ` M:${Math.floor(blue.matter)}` +
      `<span style="font-size:10px;color:#6699cc"> (${bMSign}${blue.matterRate.toFixed(1)})</span>` +
      `</span>` +
      `<span style="color:#ff4444">` +
      `E:${Math.floor(red.energy)}` +
      `<span style="font-size:10px;color:#cc6666"> (${rESign}${red.energyRate.toFixed(1)})</span>` +
      ` M:${Math.floor(red.matter)}` +
      `<span style="font-size:10px;color:#cc6666"> (${rMSign}${red.matterRate.toFixed(1)})</span>` +
      `</span>`;
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  dispose(): void {
    this.container.remove();
  }
}
