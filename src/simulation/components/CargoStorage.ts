export interface CargoStorageComponent {
  current: number;
  capacity: number;
  committedType: 'energy' | 'matter' | null;
}
