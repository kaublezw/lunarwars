export interface HeadlessConfig {
  seed?: number;
  maxTicks?: number;  // Default 72000 for AI vs AI, 3000 for RL
  // RL mode options (all optional — omit for AI vs AI)
  rlMode?: boolean;
  rlTeam?: number;           // default 1
  ticksPerStep?: number;     // default 30
  observationGridSize?: number; // default 32
}

export interface GameResult {
  seed: number;
  totalTicks: number;
  winner: number | null;  // 0 or 1, or null if truncated
}

// Re-export RL types for convenience
export type { AIAction, ObservationData, StepResult } from './RLTypes';
export { RLActionType } from './RLTypes';
