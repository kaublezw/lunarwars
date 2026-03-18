import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, HEALTH, RESOURCE_SILO } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { SiloSystem } from './SiloSystem';

// Legacy: kept for EnergyPacketSystem import compatibility
export const PACKET_ELEVATION = 5.5;

const EXTRACTOR_RATE = 5;    // +5 energy/s
const PLANT_MATTER_RATE = 2;  // +2 matter/s
const PLANT_ENERGY_COST = 2;  // energy/s consumed by each matter plant

export class EconomySystem implements System {
  readonly name = 'EconomySystem';

  private siloSystem: SiloSystem | null = null;

  constructor(
    private resources: ResourceState,
    private teamCount: number,
  ) {}

  setSiloSystem(siloSystem: SiloSystem): void {
    this.siloSystem = siloSystem;
  }

  update(world: World, dt: number): void {
    // Recalculate global pool from physical stores at start of each tick
    this.resources.recalculate();

    const entities = world.query(BUILDING, TEAM);

    const energyRates = new Float32Array(this.teamCount);
    const matterRates = new Float32Array(this.teamCount);

    // Extractors: produce energy into adjacent silos
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.EnergyExtractor) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      energyRates[team.team] += EXTRACTOR_RATE;

      if (this.siloSystem) {
        const silo = this.siloSystem.findOrSpawnSilo(world, e, 'energy', team.team);
        if (silo !== null) {
          const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
          siloComp.stored += EXTRACTOR_RATE * dt;
          // Overflow handled by SiloSystem.handleOverflow
        }
      }
    }

    // Matter plants: produce matter into adjacent silos (costs energy)
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.MatterPlant) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      // Matter plants cost energy to operate
      const energyCost = PLANT_ENERGY_COST * dt;
      if (!this.resources.canAfford(team.team, energyCost)) continue;
      this.resources.spend(team.team, energyCost);

      matterRates[team.team] += PLANT_MATTER_RATE;

      if (this.siloSystem) {
        const silo = this.siloSystem.findOrSpawnSilo(world, e, 'matter', team.team);
        if (silo !== null) {
          const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
          siloComp.stored += PLANT_MATTER_RATE * dt;
        }
      }
    }

    // Update display rates
    for (let t = 0; t < this.teamCount; t++) {
      this.resources.setRates(t, energyRates[t], matterRates[t]);
    }
  }
}
