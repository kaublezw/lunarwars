export enum UnitCategory {
  CombatDrone = 'combat_drone',
  AssaultPlatform = 'assault_platform',
  AerialDrone = 'aerial_drone',
  WorkerDrone = 'worker_drone',
}

export interface UnitTypeComponent {
  category: UnitCategory;
  radius: number; // Half-width of footprint for terrain collision
}
