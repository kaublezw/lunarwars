export class MultiplayerMenu {
  private container: HTMLDivElement;
  private mainView: HTMLDivElement;
  private joinView: HTMLDivElement;
  private codeInput: HTMLInputElement;
  private errorText: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.85);
      z-index: 1100;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      pointer-events: auto;
    `;

    // --- Main view: Create / Join / Back ---
    this.mainView = document.createElement('div');
    this.mainView.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;';

    const heading = document.createElement('div');
    heading.textContent = 'MULTIPLAYER';
    heading.style.cssText = 'font-family:monospace;font-size:48px;font-weight:bold;letter-spacing:6px;color:#fff;margin-bottom:16px;';

    const createBtn = this.makeButton('Create Game', '#2a5a3a', '#3a6a4a', '#44aa66');
    createBtn.addEventListener('click', () => this.onCreateGame());

    const joinBtn = this.makeButton('Join Game', '#2a3a5a', '#3a4a6a', '#4466aa');
    joinBtn.addEventListener('click', () => this.showJoinView());

    const backBtn = this.makeButton('Back', '#333', '#555', '#666');
    backBtn.style.marginTop = '8px';
    backBtn.addEventListener('click', () => this.hide());

    this.mainView.appendChild(heading);
    this.mainView.appendChild(createBtn);
    this.mainView.appendChild(joinBtn);
    this.mainView.appendChild(backBtn);

    // --- Join view: code input + join + back ---
    this.joinView = document.createElement('div');
    this.joinView.style.cssText = 'display:none;flex-direction:column;align-items:center;gap:16px;';

    const joinHeading = document.createElement('div');
    joinHeading.textContent = 'ENTER ROOM CODE';
    joinHeading.style.cssText = 'font-family:monospace;font-size:32px;font-weight:bold;letter-spacing:4px;color:#fff;margin-bottom:8px;';

    this.codeInput = document.createElement('input');
    this.codeInput.type = 'text';
    this.codeInput.maxLength = 4;
    this.codeInput.placeholder = 'CODE';
    this.codeInput.style.cssText = `
      font-family: monospace; font-size: 48px; font-weight: bold;
      letter-spacing: 12px; text-align: center; text-transform: uppercase;
      width: 240px; padding: 12px 16px;
      background: #1a1a1a; color: #4488ff; border: 2px solid #4466aa;
      border-radius: 4px; outline: none;
    `;
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      this.errorText.textContent = '';
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.onJoinGame();
    });

    this.errorText = document.createElement('div');
    this.errorText.style.cssText = 'font-family:monospace;font-size:14px;color:#ff6644;min-height:20px;';

    const joinConfirmBtn = this.makeButton('Join', '#2a3a5a', '#3a4a6a', '#4466aa');
    joinConfirmBtn.addEventListener('click', () => this.onJoinGame());

    const joinBackBtn = this.makeButton('Back', '#333', '#555', '#666');
    joinBackBtn.addEventListener('click', () => this.showMainView());

    this.joinView.appendChild(joinHeading);
    this.joinView.appendChild(this.codeInput);
    this.joinView.appendChild(this.errorText);
    this.joinView.appendChild(joinConfirmBtn);
    this.joinView.appendChild(joinBackBtn);

    this.container.appendChild(this.mainView);
    this.container.appendChild(this.joinView);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  show(): void {
    this.container.style.display = 'flex';
    this.showMainView();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  private showMainView(): void {
    this.mainView.style.display = 'flex';
    this.joinView.style.display = 'none';
  }

  private showJoinView(): void {
    this.mainView.style.display = 'none';
    this.joinView.style.display = 'flex';
    this.codeInput.value = '';
    this.errorText.textContent = '';
    this.codeInput.focus();
  }

  private onCreateGame(): void {
    window.location.href = window.location.pathname + '?host';
  }

  private onJoinGame(): void {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      this.errorText.textContent = 'Enter a 4-character room code';
      return;
    }
    window.location.href = window.location.pathname + '?room=' + code;
  }

  private makeButton(text: string, bg: string, hoverBg: string, border: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      font-family: monospace; font-size: 18px; font-weight: bold;
      padding: 12px 40px; min-width: 220px;
      background: ${bg}; color: #eee; border: 1px solid ${border};
      border-radius: 4px; cursor: pointer; letter-spacing: 2px;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = hoverBg; });
    btn.addEventListener('mouseleave', () => { btn.style.background = bg; });
    return btn;
  }
}
