// ImpactEvent component: consumed each frame by VoxelDamageSystem.
// Marks where damage hit an entity for voxel destruction.

export interface ImpactEventComponent {
  /** World-space impact position */
  impactX: number;
  impactY: number;
  impactZ: number;
  /** Blast radius in grid cells (1 = light, 2 = heavy) */
  blastRadius: number;
  /** Damage dealt (used to scale voxels destroyed) */
  damage: number;
  /** Normalized bullet travel direction (world-space) */
  dirX: number;
  dirY: number;
  dirZ: number;
}
