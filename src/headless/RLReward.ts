import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import { POSITION, TEAM, UNIT_TYPE, HEALTH, BUILDING } from '@sim/components/ComponentTypes';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';

export interface RewardState {
  energyIncome: number;
  matterIncome: number;
  ownExtractors: number;
  ownMatterPlants: number;
  ownUnits: number;
  ownBuildings: number;
  enemyUnits: number;
  enemyBuildings: number;
  ownHqHp: number;
  enemyHqHp: number;
}

export function captureRewardState(world: World, resourceState: ResourceState, team: number): RewardState {
  const res = resourceState.get(team);
  let ownUnits = 0;
  let enemyUnits = 0;
  let ownBuildings = 0;
  let enemyBuildings = 0;
  let ownHqHp = 0;
  let enemyHqHp = 0;
  let ownExtractors = 0;
  let ownMatterPlants = 0;

  const units = world.query(TEAM, UNIT_TYPE, HEALTH);
  for (const e of units) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team === team) ownUnits++;
    else enemyUnits++;
  }

  const buildings = world.query(TEAM, BUILDING, HEALTH);
  for (const e of buildings) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;

    if (t.team === team) {
      ownBuildings++;
      if (bldg.buildingType === BuildingType.HQ) ownHqHp = health.current;
      if (bldg.buildingType === BuildingType.EnergyExtractor) ownExtractors++;
      if (bldg.buildingType === BuildingType.MatterPlant) ownMatterPlants++;
    } else {
      enemyBuildings++;
      if (bldg.buildingType === BuildingType.HQ) enemyHqHp = health.current;
    }
  }

  return {
    energyIncome: res.energyRate,
    matterIncome: res.matterRate,
    ownExtractors,
    ownMatterPlants,
    ownUnits,
    ownBuildings,
    enemyUnits,
    enemyBuildings,
    ownHqHp,
    enemyHqHp,
  };
}

export function calculateReward(
  prev: RewardState,
  curr: RewardState,
  gameOver: boolean,
  winner: number | null,
  team: number,
): number {
  let reward = 0;

  // Income rate reward (encourages building economy)
  reward += (curr.energyIncome + curr.matterIncome) * 0.0005;

  // Resource building bonuses (on top of generic building reward)
  const extractorDelta = curr.ownExtractors - prev.ownExtractors;
  if (extractorDelta > 0) reward += extractorDelta * 0.15;
  const plantDelta = curr.ownMatterPlants - prev.ownMatterPlants;
  if (plantDelta > 0) reward += plantDelta * 0.15;

  // Own unit produced
  const unitDelta = curr.ownUnits - prev.ownUnits;
  if (unitDelta > 0) reward += unitDelta * 0.05;

  // Own building completed
  const buildingDelta = curr.ownBuildings - prev.ownBuildings;
  if (buildingDelta > 0) reward += buildingDelta * 0.1;

  // Enemy unit killed
  const enemyUnitDelta = prev.enemyUnits - curr.enemyUnits;
  if (enemyUnitDelta > 0) reward += enemyUnitDelta * 0.1;

  // Enemy building destroyed
  const enemyBuildingDelta = prev.enemyBuildings - curr.enemyBuildings;
  if (enemyBuildingDelta > 0) reward += enemyBuildingDelta * 0.15;

  // Own unit lost
  if (unitDelta < 0) reward += unitDelta * 0.05; // unitDelta is negative

  // Own building lost
  if (buildingDelta < 0) reward += buildingDelta * 0.1; // buildingDelta is negative

  // HQ damage
  const ownHqDamageTaken = prev.ownHqHp - curr.ownHqHp;
  if (ownHqDamageTaken > 0) reward -= 0.5 * (ownHqDamageTaken / 2000);

  const enemyHqDamageDealt = prev.enemyHqHp - curr.enemyHqHp;
  if (enemyHqDamageDealt > 0) reward += 0.5 * (enemyHqDamageDealt / 2000);

  // Win/lose
  if (gameOver) {
    if (winner === team) reward += 10.0;
    else reward -= 10.0;
  }

  return reward;
}
