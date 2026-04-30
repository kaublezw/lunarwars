export interface TrackFollowerComponent {
  path: { x: number; y: number; z: number; entityId: number | null; isHQ: boolean }[];
  currentWaypointIndex: number;
  distanceAlongSegment: number;
  /** 1 = forward along path, -1 = reversing back to reconnect orphaned cars. */
  direction: number;
  /** Entity ID of the orphaned car the engine is reversing to reconnect with. -1 if none. */
  reconnectTarget: number;
  /** When true, TrainMovementSystem skips this engine (halted for loading/unloading). */
  halted: boolean;
  /** Current speed (wu/s). Ramps up from 0 after each halt. */
  currentSpeed: number;
}
