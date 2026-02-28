export class GameLoop {
  private readonly TICK_RATE = 1 / 60;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private paused = false;
  private rafId = 0;
  private timeScale = 1;

  constructor(
    private simulate: (dt: number) => void,
    private render: (alpha: number) => void
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (!this.paused) {
      // Reset accumulator and lastTime to avoid tick burst on unpause
      this.accumulator = 0;
      this.lastTime = performance.now() / 1000;
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0.25, Math.min(8, scale));
  }

  getTimeScale(): number {
    return this.timeScale;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now() / 1000;
    let frameTime = now - this.lastTime;
    this.lastTime = now;

    // Clamp to avoid spiral of death
    if (frameTime > 0.25) frameTime = 0.25;

    if (!this.paused) {
      this.accumulator += frameTime * this.timeScale;

      // Cap at 16 ticks per frame to prevent runaway at high time scales
      if (this.accumulator > this.TICK_RATE * 16) {
        this.accumulator = this.TICK_RATE * 16;
      }

      while (this.accumulator >= this.TICK_RATE) {
        this.simulate(this.TICK_RATE);
        this.accumulator -= this.TICK_RATE;
      }
    }

    const alpha = this.paused ? 0 : this.accumulator / this.TICK_RATE;
    this.render(alpha);
  };
}
