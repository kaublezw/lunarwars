import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { ResourceState } from '@sim/economy/ResourceState';

const EXTRACTOR_RATE = 5;    // +5 energy/s
const PLANT_MATTER_RATE = 2;  // +2 matter/s
const PLANT_ENERGY_COST = 2;  // -2 energy/s per active plant

export class EconomySystem implements System {
  readonly name = 'EconomySystem';

  constructor(private resources: ResourceState, private teamCount: number) {}

  update(world: World, dt: number): void {
    const entities = world.query(BUILDING, TEAM);

    // Track per-team rates this tick
    const energyRates = new Float32Array(this.teamCount);
    const matterRates = new Float32Array(this.teamCount);

    // First pass: add energy from extractors
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      if (building.buildingType === BuildingType.EnergyExtractor) {
        this.resources.addEnergy(team.team, EXTRACTOR_RATE * dt);
        energyRates[team.team] += EXTRACTOR_RATE;
      }
    }

    // Second pass: matter plants consume energy to produce matter
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.MatterPlant) continue;

      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      // Only produce matter if team can afford the energy cost
      const energyCost = PLANT_ENERGY_COST * dt;
      if (!this.resources.canAfford(team.team, energyCost)) continue;

      this.resources.spend(team.team, energyCost);
      energyRates[team.team] -= PLANT_ENERGY_COST;

      this.resources.addMatter(team.team, PLANT_MATTER_RATE * dt);
      matterRates[team.team] += PLANT_MATTER_RATE;
    }

    // Update display rates
    for (let t = 0; t < this.teamCount; t++) {
      this.resources.setRates(t, energyRates[t], matterRates[t]);
    }
  }
}
