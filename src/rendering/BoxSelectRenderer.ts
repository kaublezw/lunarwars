/**
 * HTML div overlay for box selection visualization.
 */
export class BoxSelectRenderer {
  private div: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.div = document.createElement('div');
    this.div.style.position = 'absolute';
    this.div.style.border = '1px solid #44ff44';
    this.div.style.backgroundColor = 'rgba(68, 255, 68, 0.1)';
    this.div.style.pointerEvents = 'none';
    this.div.style.display = 'none';
    this.div.style.zIndex = '10';
    parent.appendChild(this.div);
  }

  show(x0: number, y0: number, x1: number, y1: number): void {
    this.div.style.display = 'block';
    this.div.style.left = x0 + 'px';
    this.div.style.top = y0 + 'px';
    this.div.style.width = (x1 - x0) + 'px';
    this.div.style.height = (y1 - y0) + 'px';
  }

  hide(): void {
    this.div.style.display = 'none';
  }
}
