// Marks a unit as entering the HQ garage door (reverse of GarageExit).
// While active: unit drives straight -Z into the HQ interior.
// On reaching enterZ: entity is destroyed.

export interface GarageEnterComponent {
  /** Z-coordinate inside the HQ to reach before being destroyed */
  enterZ: number;
  /** HQ entity X position (to align the ferry) */
  hqX: number;
}
