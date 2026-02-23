import { UnitCategory } from '@sim/components/UnitType';

export interface UnitDef {
  category: UnitCategory;
  energyCost: number;
  matterCost: number;
  trainTime: number; // seconds
  hp: number;
  speed: number;
  radius: number;
  visionRange: number;
  meshType: string;
  // Turret fields (optional - only for combat units)
  range?: number;
  fireRate?: number;
  damage?: number;
  ammo?: number;
  maxAmmo?: number;
  muzzleOffset?: number;
  muzzleHeight?: number;
}

export const UNIT_DEFS: Record<string, UnitDef> = {
  [UnitCategory.WorkerDrone]: {
    category: UnitCategory.WorkerDrone,
    energyCost: 50,
    matterCost: 50,
    trainTime: 10,
    hp: 80,
    speed: 2,
    radius: 0.35,
    visionRange: 12,
    meshType: 'worker_drone',
  },
  [UnitCategory.CombatDrone]: {
    category: UnitCategory.CombatDrone,
    energyCost: 75,
    matterCost: 75,
    trainTime: 15,
    hp: 100,
    speed: 3,
    radius: 0.4,
    visionRange: 10,
    meshType: 'combat_drone',
    range: 8,
    fireRate: 2,
    damage: 10,
    ammo: 38,
    maxAmmo: 38,
    muzzleOffset: 0.5,
    muzzleHeight: 0.6,
  },
  [UnitCategory.AssaultPlatform]: {
    category: UnitCategory.AssaultPlatform,
    energyCost: 200,
    matterCost: 150,
    trainTime: 25,
    hp: 300,
    speed: 1.5,
    radius: 0.6,
    visionRange: 14,
    meshType: 'assault_platform',
    range: 12,
    fireRate: 0.8,
    damage: 40,
    ammo: 22,
    maxAmmo: 22,
    muzzleOffset: 0.8,
    muzzleHeight: 0.8,
  },
  [UnitCategory.AerialDrone]: {
    category: UnitCategory.AerialDrone,
    energyCost: 100,
    matterCost: 50,
    trainTime: 12,
    hp: 60,
    speed: 6,
    radius: 0.35,
    visionRange: 16,
    meshType: 'aerial_drone',
    range: 6,
    fireRate: 3,
    damage: 8,
    ammo: 30,
    maxAmmo: 30,
    muzzleOffset: 0.4,
    muzzleHeight: 0.5,
  },
};

// Damage multiplier: COUNTER_MULTIPLIERS[attacker][target]
// 1.5 = strong vs, 0.67 = weak vs, 1.0 = neutral
export const COUNTER_MULTIPLIERS: Partial<Record<UnitCategory, Partial<Record<UnitCategory, number>>>> = {
  [UnitCategory.AssaultPlatform]: {
    [UnitCategory.CombatDrone]: 1.5,
    [UnitCategory.AerialDrone]: 0.67,
  },
  [UnitCategory.CombatDrone]: {
    [UnitCategory.AerialDrone]: 1.5,
    [UnitCategory.AssaultPlatform]: 0.67,
  },
  [UnitCategory.AerialDrone]: {
    [UnitCategory.AssaultPlatform]: 1.5,
    [UnitCategory.CombatDrone]: 0.67,
  },
};
