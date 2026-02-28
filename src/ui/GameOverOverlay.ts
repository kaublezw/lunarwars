export class GameOverOverlay {
  private container: HTMLDivElement;
  private heading: HTMLDivElement;
  private subtitle: HTMLDivElement;

  constructor(onRestart: () => void) {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1100;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      pointer-events: auto;
    `;

    this.heading = document.createElement('div');
    this.heading.style.cssText = `
      font-family: monospace;
      font-size: 64px;
      font-weight: bold;
      letter-spacing: 8px;
      margin-bottom: 16px;
    `;

    this.subtitle = document.createElement('div');
    this.subtitle.style.cssText = `
      font-family: monospace;
      font-size: 20px;
      color: #ccc;
      margin-bottom: 40px;
    `;

    const restartBtn = document.createElement('button');
    restartBtn.textContent = 'Restart';
    restartBtn.style.cssText = `
      padding: 12px 40px;
      background: #333;
      color: #eee;
      border: 1px solid #666;
      border-radius: 6px;
      cursor: pointer;
      font-family: monospace;
      font-size: 18px;
    `;
    restartBtn.addEventListener('mouseenter', () => { restartBtn.style.background = '#555'; });
    restartBtn.addEventListener('mouseleave', () => { restartBtn.style.background = '#333'; });
    restartBtn.addEventListener('click', onRestart);

    this.container.appendChild(this.heading);
    this.container.appendChild(this.subtitle);
    this.container.appendChild(restartBtn);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  show(playerWon: boolean): void {
    this.container.style.display = 'flex';

    if (playerWon) {
      this.heading.textContent = 'VICTORY';
      this.heading.style.color = '#4f4';
      this.subtitle.textContent = 'Enemy HQ destroyed';
    } else {
      this.heading.textContent = 'DEFEAT';
      this.heading.style.color = '#f44';
      this.subtitle.textContent = 'Your HQ was destroyed';
    }
  }

  showSpectator(losingTeam: number): void {
    this.container.style.display = 'flex';

    if (losingTeam === 1) {
      this.heading.textContent = 'BLUE WINS';
      this.heading.style.color = '#4488ff';
      this.subtitle.textContent = 'Red HQ destroyed';
    } else {
      this.heading.textContent = 'RED WINS';
      this.heading.style.color = '#ff4444';
      this.subtitle.textContent = 'Blue HQ destroyed';
    }
  }
}
