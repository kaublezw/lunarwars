// VoxelState component: tracks per-entity voxel destruction state.
// Pure simulation data - no Three.js dependency.

export interface VoxelDebrisInfo {
  /** Index into model.solidVoxels */
  solidIndex: number;
  /** Debris launch direction (world-space, normalized + scatter) */
  dirX: number;
  dirY: number;
  dirZ: number;
}

export interface VoxelStateComponent {
  /** Key into VOXEL_MODELS */
  modelId: string;
  /** Total solid voxels in the model */
  totalVoxels: number;
  /** Number of voxels destroyed so far */
  destroyedCount: number;
  /** Bitmask of destroyed voxels. Bit index maps to solidVoxels array index. */
  destroyed: Uint8Array;
  /** Set true when voxels change and rendering needs to rebuild */
  dirty: boolean;
  /** Per-voxel debris direction info, consumed by renderer each frame */
  pendingDebris: VoxelDebrisInfo[];
}
