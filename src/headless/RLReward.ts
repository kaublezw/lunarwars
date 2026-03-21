import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import { TEAM, UNIT_TYPE, HEALTH, BUILDING, CONSTRUCTION } from '@sim/components/ComponentTypes';
import type { TeamComponent } from '@sim/components/Team';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { UnitCategory } from '@sim/components/UnitType';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';

// --- Reward weight constants ---

// Exploration velocity
const NEW_TILE_REWARD = 0.00005;
const EARLY_GAME_TICK_THRESHOLD = 10000;
const EARLY_GAME_EXPLORE_MULTIPLIER = 3.0;

// Coverage milestones (one-time)
const MILESTONE_25_REWARD = 0.5;
const MILESTONE_50_REWARD = 1.0;
const MILESTONE_75_REWARD = 1.5;

// First-mover extraction
const FIRST_MOVER_BASE = 5.0;
const FIRST_MOVER_THRESHOLD = 2;
const FIRST_MOVER_SCALE_DOWN = 0.1;

// Resource growth (derivative-based)
const GROWTH_REWARD_MULTIPLIER = 0.1;

// Stagnation
const STAGNATION_TICK_THRESHOLD = 5000;
const STAGNATION_PENALTY_PER_STEP = 0.02;

// Early tech milestones (one-time)
const FIRST_FACTORY_REWARD = 3.0;
const FIRST_AERIAL_REWARD = 2.0;

// Resource denial
const RESOURCE_DENIAL_REWARD = 3.0;

// Combat (retained from original)
const UNIT_PRODUCED_REWARD = 0.05;
const BUILDING_COMPLETED_REWARD = 0.5;
const ENEMY_UNIT_KILLED_REWARD = 0.1;
const ENEMY_BUILDING_DESTROYED_REWARD = 0.15;
const OWN_UNIT_LOST_PENALTY = 0.05;
const OWN_BUILDING_LOST_PENALTY = 0.1;
const HQ_DAMAGE_WEIGHT = 0.5;
const HQ_MAX_HP = 2000;
const WIN_REWARD = 50.0;
const LOSE_PENALTY = 10.0;

// ---

export interface RewardState {
  energyIncome: number;
  matterIncome: number;
  ownExtractors: number;
  ownMatterPlants: number;
  ownDroneFactories: number;
  ownAerialDrones: number;
  enemyExtractors: number;
  enemyMatterPlants: number;
  ownUnits: number;
  ownBuildings: number;
  enemyUnits: number;
  enemyBuildings: number;
  ownHqHp: number;
  enemyHqHp: number;
  revealedTiles: number;
  tick: number;
}

function countRevealedTiles(fogState: FogOfWarState, team: number): number {
  const grid = fogState.getGrid(team);
  let count = 0;
  const p = fogState.padding;
  const w = fogState.width;
  const h = fogState.height;
  const gw = fogState.gridWidth;
  for (let z = p; z < p + h; z++) {
    const rowBase = z * gw;
    for (let x = p; x < p + w; x++) {
      if (grid[rowBase + x] >= 1) count++;
    }
  }
  return count;
}

export function captureRewardState(
  world: World,
  resourceState: ResourceState,
  fogState: FogOfWarState,
  team: number,
  tick: number,
): RewardState {
  const res = resourceState.get(team);
  let ownUnits = 0;
  let enemyUnits = 0;
  let ownBuildings = 0;
  let enemyBuildings = 0;
  let ownHqHp = 0;
  let enemyHqHp = 0;
  let ownExtractors = 0;
  let ownMatterPlants = 0;
  let ownDroneFactories = 0;
  let ownAerialDrones = 0;
  let enemyExtractors = 0;
  let enemyMatterPlants = 0;

  const units = world.query(TEAM, UNIT_TYPE, HEALTH);
  for (const e of units) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team === team) {
      ownUnits++;
      const ut = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      if (ut.category === UnitCategory.AerialDrone) ownAerialDrones++;
    } else {
      enemyUnits++;
    }
  }

  const buildings = world.query(TEAM, BUILDING, HEALTH);
  for (const e of buildings) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;

    if (t.team === team) {
      const underConstruction = !!world.getComponent(e, CONSTRUCTION);
      if (bldg.buildingType === BuildingType.HQ) ownHqHp = health.current;
      if (!underConstruction) {
        ownBuildings++;
        if (bldg.buildingType === BuildingType.EnergyExtractor) ownExtractors++;
        if (bldg.buildingType === BuildingType.MatterPlant) ownMatterPlants++;
        if (bldg.buildingType === BuildingType.DroneFactory) ownDroneFactories++;
      }
    } else {
      enemyBuildings++;
      if (bldg.buildingType === BuildingType.HQ) enemyHqHp = health.current;
      if (bldg.buildingType === BuildingType.EnergyExtractor) enemyExtractors++;
      if (bldg.buildingType === BuildingType.MatterPlant) enemyMatterPlants++;
    }
  }

  return {
    energyIncome: res.energyRate,
    matterIncome: res.matterRate,
    ownExtractors,
    ownMatterPlants,
    ownDroneFactories,
    ownAerialDrones,
    enemyExtractors,
    enemyMatterPlants,
    ownUnits,
    ownBuildings,
    enemyUnits,
    enemyBuildings,
    ownHqHp,
    enemyHqHp,
    revealedTiles: countRevealedTiles(fogState, team),
    tick,
  };
}

// Exponential bonus for the first FIRST_MOVER_THRESHOLD resource buildings,
// flat small reward after that.
// count=1: 0.15*16=2.4, count=2: 1.2, count=3: 0.6, count=4: 0.3, count=5: 0.15, count>5: 0.05
function firstMoverBonus(count: number): number {
  if (count <= FIRST_MOVER_THRESHOLD) {
    return FIRST_MOVER_BASE;
  }
  return FIRST_MOVER_BASE * FIRST_MOVER_SCALE_DOWN;
}

/**
 * Persistent reward tracker that maintains state across steps within an episode.
 * Tracks coverage milestones and stagnation timer — must be reset per episode.
 */
export class RewardTracker {
  private milestone25 = false;
  private milestone50 = false;
  private milestone75 = false;
  private builtFirstFactory = false;
  private builtFirstAerial = false;
  private lastEnergyRateIncreaseTick = 0;
  private readonly totalPlayableTiles: number;

  constructor(fogState: FogOfWarState) {
    this.totalPlayableTiles = fogState.width * fogState.height;
  }

  reset(): void {
    this.milestone25 = false;
    this.milestone50 = false;
    this.milestone75 = false;
    this.builtFirstFactory = false;
    this.builtFirstAerial = false;
    this.lastEnergyRateIncreaseTick = 0;
  }

  calculateReward(
    prev: RewardState,
    curr: RewardState,
    gameOver: boolean,
    truncated: boolean,
    winner: number | null,
    team: number,
  ): number {
    let reward = 0;

    // --- 1. Exploration Velocity Reward ---
    const newTiles = curr.revealedTiles - prev.revealedTiles;
    if (newTiles > 0) {
      const multiplier = curr.tick < EARLY_GAME_TICK_THRESHOLD
        ? EARLY_GAME_EXPLORE_MULTIPLIER
        : 1.0;
      reward += newTiles * NEW_TILE_REWARD * multiplier;
    }

    // --- 2. Coverage Milestone Bonuses (one-time) ---
    const coverage = curr.revealedTiles / this.totalPlayableTiles;
    if (!this.milestone25 && coverage >= 0.25) {
      reward += MILESTONE_25_REWARD;
      this.milestone25 = true;
    }
    if (!this.milestone50 && coverage >= 0.50) {
      reward += MILESTONE_50_REWARD;
      this.milestone50 = true;
    }
    if (!this.milestone75 && coverage >= 0.75) {
      reward += MILESTONE_75_REWARD;
      this.milestone75 = true;
    }

    // --- 3. First-Mover Extraction Bonus ---
    const extractorDelta = curr.ownExtractors - prev.ownExtractors;
    if (extractorDelta > 0) {
      for (let i = 0; i < extractorDelta; i++) {
        reward += firstMoverBonus(prev.ownExtractors + i + 1);
      }
    }
    const plantDelta = curr.ownMatterPlants - prev.ownMatterPlants;
    if (plantDelta > 0) {
      for (let i = 0; i < plantDelta; i++) {
        reward += firstMoverBonus(prev.ownMatterPlants + i + 1);
      }
    }

    // --- 4. Resource Growth Reward (derivative-based) ---
    const energyRateIncrease = curr.energyIncome - prev.energyIncome;
    if (energyRateIncrease > 0) {
      reward += energyRateIncrease * GROWTH_REWARD_MULTIPLIER;
    }
    const matterRateIncrease = curr.matterIncome - prev.matterIncome;
    if (matterRateIncrease > 0) {
      reward += matterRateIncrease * GROWTH_REWARD_MULTIPLIER;
    }

    // --- 5. Stagnation Penalty ---
    if (curr.energyIncome > prev.energyIncome) {
      this.lastEnergyRateIncreaseTick = curr.tick;
    }
    if (curr.tick > STAGNATION_TICK_THRESHOLD &&
        curr.tick - this.lastEnergyRateIncreaseTick > STAGNATION_TICK_THRESHOLD) {
      reward -= STAGNATION_PENALTY_PER_STEP;
    }

    // --- 6. Early Tech Milestones (one-time) ---
    if (!this.builtFirstFactory && curr.ownDroneFactories > 0) {
      reward += FIRST_FACTORY_REWARD;
      this.builtFirstFactory = true;
    }
    if (!this.builtFirstAerial && curr.ownAerialDrones > 0) {
      reward += FIRST_AERIAL_REWARD;
      this.builtFirstAerial = true;
    }

    // --- 7. Resource Denial ---
    const enemyExtractorLoss = prev.enemyExtractors - curr.enemyExtractors;
    if (enemyExtractorLoss > 0) {
      reward += enemyExtractorLoss * RESOURCE_DENIAL_REWARD;
    }
    const enemyPlantLoss = prev.enemyMatterPlants - curr.enemyMatterPlants;
    if (enemyPlantLoss > 0) {
      reward += enemyPlantLoss * RESOURCE_DENIAL_REWARD;
    }

    // --- 8. Combat & Strategic Rewards ---

    // Own unit produced
    const unitDelta = curr.ownUnits - prev.ownUnits;
    if (unitDelta > 0) reward += unitDelta * UNIT_PRODUCED_REWARD;

    // Own building completed
    const buildingDelta = curr.ownBuildings - prev.ownBuildings;
    if (buildingDelta > 0) reward += buildingDelta * BUILDING_COMPLETED_REWARD;

    // Enemy unit killed
    const enemyUnitDelta = prev.enemyUnits - curr.enemyUnits;
    if (enemyUnitDelta > 0) reward += enemyUnitDelta * ENEMY_UNIT_KILLED_REWARD;

    // Enemy building destroyed
    const enemyBuildingDelta = prev.enemyBuildings - curr.enemyBuildings;
    if (enemyBuildingDelta > 0) reward += enemyBuildingDelta * ENEMY_BUILDING_DESTROYED_REWARD;

    // Own unit lost
    if (unitDelta < 0) reward += unitDelta * OWN_UNIT_LOST_PENALTY;

    // Own building lost
    if (buildingDelta < 0) reward += buildingDelta * OWN_BUILDING_LOST_PENALTY;

    // HQ damage
    const ownHqDamageTaken = prev.ownHqHp - curr.ownHqHp;
    if (ownHqDamageTaken > 0) reward -= HQ_DAMAGE_WEIGHT * (ownHqDamageTaken / HQ_MAX_HP);

    const enemyHqDamageDealt = prev.enemyHqHp - curr.enemyHqHp;
    if (enemyHqDamageDealt > 0) reward += HQ_DAMAGE_WEIGHT * (enemyHqDamageDealt / HQ_MAX_HP);

    // Win/lose/timeout
    if (gameOver) {
      if (winner === team) reward += WIN_REWARD;
      else reward -= LOSE_PENALTY;
    } else if (truncated) {
      // Punish the AI for failing to defeat the enemy before the time limit
      reward -= LOSE_PENALTY;
    }

    return reward;
  }
}
