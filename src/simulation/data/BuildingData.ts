import { BuildingType } from '@sim/components/Building';

export interface BuildingDef {
  type: BuildingType;
  energyCost: number;
  matterCost: number;
  buildTime: number; // seconds
  hp: number;
  visionRange: number;
  meshType: string;
  needsEnergyNode: boolean;
}

export const BUILDING_DEFS: Record<string, BuildingDef> = {
  [BuildingType.EnergyExtractor]: {
    type: BuildingType.EnergyExtractor,
    energyCost: 0,
    matterCost: 50,
    buildTime: 8,
    hp: 500,
    visionRange: 10,
    meshType: 'energy_extractor',
    needsEnergyNode: true,
  },
  [BuildingType.MatterPlant]: {
    type: BuildingType.MatterPlant,
    energyCost: 100,
    matterCost: 0,
    buildTime: 10,
    hp: 600,
    visionRange: 10,
    meshType: 'matter_plant',
    needsEnergyNode: false,
  },
  [BuildingType.SupplyDepot]: {
    type: BuildingType.SupplyDepot,
    energyCost: 50,
    matterCost: 50,
    buildTime: 8,
    hp: 400,
    visionRange: 10,
    meshType: 'supply_depot',
    needsEnergyNode: false,
  },
  [BuildingType.DroneFactory]: {
    type: BuildingType.DroneFactory,
    energyCost: 150,
    matterCost: 100,
    buildTime: 15,
    hp: 800,
    visionRange: 12,
    meshType: 'drone_factory',
    needsEnergyNode: false,
  },
  [BuildingType.Wall]: {
    type: BuildingType.Wall,
    energyCost: 0,
    matterCost: 12,
    buildTime: 3.5,
    hp: 500,
    visionRange: 3,
    meshType: 'wall_x',
    needsEnergyNode: false,
  },
};
