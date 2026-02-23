export enum BuildingType {
  HQ = 'hq',
  EnergyExtractor = 'energy_extractor',
  MatterPlant = 'matter_plant',
  SupplyDepot = 'supply_depot',
  DroneFactory = 'drone_factory',
}

export interface BuildingComponent {
  buildingType: BuildingType;
}
