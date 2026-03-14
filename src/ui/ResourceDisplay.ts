import type { ResourceState } from '@sim/economy/ResourceState';

export class ResourceDisplay {
  private container: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      top: 12px;
      left: 12px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 8px 14px;
      color: #ddd;
      font-family: monospace;
      font-size: 14px;
      pointer-events: none;
      z-index: 10;
    `;
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  update(resources: ResourceState, team: number, tickCount: number = 0): void {
    const res = resources.get(team);
    const eSign = res.energyRate >= 0 ? '+' : '';
    const mSign = res.matterRate >= 0 ? '+' : '';
    const totalSeconds = Math.floor(tickCount / 60);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    this.container.innerHTML =
      `<span style="color:#ff4">Energy: ${Math.floor(res.energy)}</span>` +
      `<span style="color:#aa8;font-size:11px"> (${eSign}${res.energyRate.toFixed(1)}/s)</span>` +
      `  <span style="color:#4cf">Matter: ${Math.floor(res.matter)}</span>` +
      `<span style="color:#8ab;font-size:11px"> (${mSign}${res.matterRate.toFixed(1)}/s)</span>` +
      `  <span style="color:#aaa">${clock}</span>`;
  }
}
