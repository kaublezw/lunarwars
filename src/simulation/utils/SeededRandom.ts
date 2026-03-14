export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }

  /** Returns float in [0, 1) */
  next(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) / 0x100000000;
  }

  /** Returns int in [0, max) */
  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }

  reseed(seed: number): void {
    this.state = (seed >>> 0) || 1;
  }
}
