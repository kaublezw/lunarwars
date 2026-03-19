// Marks a temporary matter ferry as docked at a construction site.
// While docked, the ferry's voxels are progressively destroyed and
// particles arc to the building being constructed.
// When construction completes, the ferry returns to its home HQ.

export interface FerryDockComponent {
  /** Construction site entity this ferry is supplying */
  siteEntity: number;
  /** HQ entity to return to after construction (-1 if none) */
  homeHQ: number;
  /** Number of ferry solid voxels that have been consumed so far */
  voxelsConsumed: number;
  /** Total ferry solid voxels available for consumption (excludes supports) */
  consumableVoxels: number;
  /** Last observed construction progress (0-1), used to detect increments */
  lastProgress: number;
  /** True when construction is done and ferry is returning home */
  returning: boolean;
}
