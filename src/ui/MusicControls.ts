export class MusicControls {
  private container: HTMLDivElement;
  private slider: HTMLInputElement;
  private muteBtn: HTMLButtonElement;
  private muted: boolean;
  private volume: number;

  onVolumeChange?: (volume: number) => void;
  onMuteToggle?: (muted: boolean) => void;

  constructor(initialVolume: number = 0.3, initialMuted: boolean = false) {
    this.volume = initialVolume;
    this.muted = initialMuted;

    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 12px;
      right: 12px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 20;
      pointer-events: auto;
      font-family: monospace;
      font-size: 12px;
      color: #ccc;
    `;

    // Mute/unmute button
    this.muteBtn = document.createElement('button');
    this.muteBtn.style.cssText = `
      background: none;
      border: none;
      color: #ccc;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;
      padding: 2px 4px;
      line-height: 1;
    `;
    this.updateIcon();
    this.muteBtn.title = 'Toggle mute (M)';
    this.muteBtn.addEventListener('click', () => {
      this.muted = !this.muted;
      this.updateIcon();
      this.onMuteToggle?.(this.muted);
    });
    this.container.appendChild(this.muteBtn);

    // Volume slider
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = '100';
    this.slider.value = String(Math.round(this.volume * 100));
    this.slider.style.cssText = `
      width: 80px;
      height: 4px;
      cursor: pointer;
      accent-color: #5a5;
    `;
    this.slider.addEventListener('input', () => {
      this.volume = parseInt(this.slider.value) / 100;
      if (this.muted && this.volume > 0) {
        this.muted = false;
        this.onMuteToggle?.(false);
      }
      this.updateIcon();
      this.onVolumeChange?.(this.volume);
    });
    this.container.appendChild(this.slider);
  }

  private updateIcon(): void {
    if (this.muted || this.volume === 0) {
      this.muteBtn.textContent = '[x]';
    } else {
      this.muteBtn.textContent = '[♪]';
    }
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }
}
