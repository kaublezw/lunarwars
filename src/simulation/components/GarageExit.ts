// Marks a unit as exiting the HQ garage door.
// While active: unit moves straight +Z, no pathfinding, no x-ray ghost.
// On reaching exitZ: removed, normal behavior resumes.

export interface GarageExitComponent {
  exitZ: number;
  rallyX: number;
  rallyZ: number;
}
