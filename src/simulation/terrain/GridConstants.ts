// World-space grid cell size (world units per cell).
// Used for visual grid lines, building placement snap, and resource node alignment.
export const GRID_CELL_SIZE = 4;

// Snap a world coordinate to the nearest grid intersection.
// Grid lines are at 0, 4, 8, ..., 256. Buildings and resource nodes sit on intersections.
// Aligns with HQ spawn positions (64, 192).
export function snapToGrid(v: number): number {
  return Math.round(v / GRID_CELL_SIZE) * GRID_CELL_SIZE;
}
