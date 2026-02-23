export interface BuildCommandComponent {
  buildingType: string;
  targetX: number;
  targetZ: number;
  state: 'moving' | 'building';
  siteEntity: number;
}
