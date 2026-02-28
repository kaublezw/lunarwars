// DeathTimer component: brief delay before entity explodes into voxels.

export interface DeathTimerComponent {
  /** Time remaining before explosion (seconds) */
  timeRemaining: number;
  /** Whether the explosion has been triggered */
  exploded: boolean;
}
