export class GameLoop {
  private readonly TICK_RATE = 1 / 60;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private paused = false;
  private rafId = 0;
  private timeScale = 1;
  private tickCount = 0;
  private beforeTick: ((tick: number) => boolean) | null = null;
  private maxTicksPerFrame = 16;

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

  getTickCount(): number {
    return this.tickCount;
  }

  /** Optional gate called before each tick. Return false to stall (e.g., waiting for network). */
  setBeforeTick(fn: ((tick: number) => boolean) | null): void {
    this.beforeTick = fn;
  }

  /** Limit simulation ticks per render frame. Lower values prevent tick batching from hiding short-lived entities. */
  setMaxTicksPerFrame(max: number): void {
    this.maxTicksPerFrame = Math.max(1, max);
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

      // Cap ticks per frame to prevent runaway and ensure short-lived entities get rendered
      if (this.accumulator > this.TICK_RATE * this.maxTicksPerFrame) {
        this.accumulator = this.TICK_RATE * this.maxTicksPerFrame;
      }

      while (this.accumulator >= this.TICK_RATE) {
        if (this.beforeTick && !this.beforeTick(this.tickCount)) {
          break; // stall — waiting for network or other gate
        }
        this.simulate(this.TICK_RATE);
        this.tickCount++;
        this.accumulator -= this.TICK_RATE;
      }
    }

    const alpha = this.paused ? 0 : this.accumulator / this.TICK_RATE;
    this.render(alpha);
  };
}
