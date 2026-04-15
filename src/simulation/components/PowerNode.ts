export interface PowerNodeComponent {
  /** Whether this node has a connected path to an HQ. Recomputed by PowerGridSystem. */
  powered: boolean;
  /** Stable ID within the power graph (assigned at creation). */
  nodeId: number;
}
