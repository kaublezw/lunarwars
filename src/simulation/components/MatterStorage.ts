export interface MatterStorageComponent {
  stored: number;
  capacity: number;
  /** Energy stored at this depot (for building/training costs) */
  energyStored: number;
  energyCapacity: number;
}
