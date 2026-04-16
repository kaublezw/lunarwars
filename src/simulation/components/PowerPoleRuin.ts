export interface PowerPoleRuinComponent {
  /** Macro grid X coordinate of the destroyed pole. */
  gridX: number;
  /** Macro grid Z coordinate of the destroyed pole. */
  gridZ: number;
  /** Grid positions of neighbor nodes at time of destruction (for topology restoration). */
  neighborGridPositions: [number, number][];
}
