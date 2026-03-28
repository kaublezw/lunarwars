export class LobbyOverlay {
  private container: HTMLDivElement;
  private statusText: HTMLDivElement;
  private codeDisplay: HTMLDivElement;
  private copyBtn: HTMLButtonElement;
  private roomCode = '';

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      z-index: 1100;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      pointer-events: auto;
    `;

    const heading = document.createElement('div');
    heading.textContent = 'MULTIPLAYER';
    heading.style.cssText = `
      font-family: monospace;
      font-size: 48px;
      font-weight: bold;
      letter-spacing: 6px;
      color: #fff;
      margin-bottom: 24px;
    `;

    this.codeDisplay = document.createElement('div');
    this.codeDisplay.style.cssText = `
      font-family: monospace;
      font-size: 72px;
      font-weight: bold;
      letter-spacing: 16px;
      color: #4488ff;
      margin-bottom: 16px;
      display: none;
    `;

    this.copyBtn = document.createElement('button');
    this.copyBtn.textContent = 'Copy Code';
    this.copyBtn.style.cssText = `
      font-family: monospace;
      font-size: 16px;
      padding: 8px 20px;
      margin-bottom: 24px;
      background: #333;
      color: #fff;
      border: 1px solid #666;
      cursor: pointer;
      display: none;
    `;
    this.copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.roomCode);
      this.copyBtn.textContent = 'Copied!';
      setTimeout(() => { this.copyBtn.textContent = 'Copy Code'; }, 1500);
    });

    this.statusText = document.createElement('div');
    this.statusText.style.cssText = `
      font-family: monospace;
      font-size: 20px;
      color: #ccc;
    `;

    this.container.appendChild(heading);
    this.container.appendChild(this.codeDisplay);
    this.container.appendChild(this.copyBtn);
    this.container.appendChild(this.statusText);
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

  setStatus(text: string): void {
    this.statusText.textContent = text;
  }

  showRoomCode(code: string): void {
    this.roomCode = code;
    this.codeDisplay.textContent = code;
    this.codeDisplay.style.display = 'block';
    this.copyBtn.style.display = 'inline-block';
  }

  hideRoomCode(): void {
    this.codeDisplay.style.display = 'none';
    this.copyBtn.style.display = 'none';
  }
}
