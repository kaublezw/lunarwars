// Marks a unit as exiting through a building's roof.
// While active: unit rises straight +Y, no steering, no AERIAL_HEIGHT override.
// On reaching exitY: removed, normal behavior resumes.

export interface RoofExitComponent {
  exitY: number;
  rallyX: number;
  rallyZ: number;
}
