// Projectile component: visible voxel shot flying toward a target position.

export interface ProjectileComponent {
  /** Entity that fired this projectile */
  ownerEntity: number;
  /** Target entity (for tracking if it dies) */
  targetEntity: number;
  /** Target intercept position */
  targetX: number;
  targetY: number;
  targetZ: number;
  /** Travel speed in world units/sec */
  speed: number;
  /** Damage to apply on impact */
  damage: number;
  /** Team of the shooter */
  team: number;
  /** Projectile color (hex) */
  color: number;
  /** Blast radius for voxel damage (1=light, 2=heavy) */
  blastRadius: number;
}
