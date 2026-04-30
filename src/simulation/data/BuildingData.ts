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
  needsOreDeposit: boolean;
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
    needsOreDeposit: false,
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
    needsOreDeposit: true,
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
    needsOreDeposit: false,
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
    needsOreDeposit: false,
  },
  [BuildingType.PowerPole]: {
    type: BuildingType.PowerPole,
    energyCost: 5,
    matterCost: 5,
    buildTime: 2,
    hp: 100,
    visionRange: 2,
    meshType: 'power_pole',
    needsEnergyNode: false,
    needsOreDeposit: false,
  },
};
