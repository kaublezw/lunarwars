export interface HeadlessConfig {
  seed?: number;
  maxTicks?: number;  // Default 72000
}

export interface GameResult {
  seed: number;
  totalTicks: number;
  winner: number | null;  // 0 or 1, or null if truncated
}
