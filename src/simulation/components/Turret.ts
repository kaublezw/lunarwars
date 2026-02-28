export interface TurretComponent {
  range: number;           // max targeting range (world units)
  fireRate: number;        // shots per second
  cooldown: number;        // countdown timer to next shot
  targetEntity: number;    // entity ID of target, -1 if none
  targetX: number;         // target world position (for render layer)
  targetZ: number;
  firedThisFrame: boolean; // set by sim, consumed by render
  damage: number;          // damage per shot
  ammo: number;            // current ammo
  maxAmmo: number;         // for future supply depot refill
  muzzleOffset: number;    // distance from entity center to muzzle (varies by unit size)
  muzzleHeight: number;    // height above entity Y
  rotateBodyToTarget: boolean; // true for infantry-like (body faces target), false for tanks (independent turret)
  turretRotation: number;  // world-space Y-axis angle for turret facing (independent of body)
  turretPitch: number;     // X-axis pitch angle for turret (negative = aim up)
}
