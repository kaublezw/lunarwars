export class GameLoop {
  private readonly TICK_RATE = 1 / 60;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private rafId = 0;

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

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now() / 1000;
    let frameTime = now - this.lastTime;
    this.lastTime = now;

    // Clamp to avoid spiral of death
    if (frameTime > 0.25) frameTime = 0.25;

    this.accumulator += frameTime;

    while (this.accumulator >= this.TICK_RATE) {
      this.simulate(this.TICK_RATE);
      this.accumulator -= this.TICK_RATE;
    }

    const alpha = this.accumulator / this.TICK_RATE;
    this.render(alpha);
  };
}
