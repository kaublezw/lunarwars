export interface ConstructionComponent {
  buildingType: string;
  progress: number; // 0..1
  buildTime: number; // seconds total
  builderEntity: number;
}
