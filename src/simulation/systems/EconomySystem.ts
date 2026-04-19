import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION, HEALTH, PLANT_STORAGE, POWER_NODE } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { PlantStorageComponent } from '@sim/components/PlantStorage';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';

const EXTRACTOR_RATE = 5;    // +5 energy/s
const PLANT_MATTER_RATE = 2;  // +2 matter/s

export class EconomySystem implements System {
  readonly name = 'EconomySystem';

  constructor(
    private resources: ResourceState,
    private teamCount: number,
    private terrainData: TerrainData,
  ) {}

  update(world: World, dt: number): void {
    const entities = world.query(BUILDING, TEAM);

    // Track per-team rates this tick
    const energyRates = new Float32Array(this.teamCount);
    const matterRates = new Float32Array(this.teamCount);

    // Tick extractors and matter plants — accumulate into PlantStorage
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const powerNode = world.getComponent<PowerNodeComponent>(e, POWER_NODE);
      if (powerNode && !powerNode.powered) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      if (building.buildingType === BuildingType.EnergyExtractor) {
        energyRates[team.team] += EXTRACTOR_RATE;
        this.resources.addEnergy(team.team, EXTRACTOR_RATE * dt);
      } else if (building.buildingType === BuildingType.MatterPlant) {
        matterRates[team.team] += PLANT_MATTER_RATE;
        const storage = this.ensurePlantStorage(world, e, 'matter');
        storage.amount += PLANT_MATTER_RATE * dt;
      }
    }

    // Update display rates
    for (let t = 0; t < this.teamCount; t++) {
      this.resources.setRates(t, energyRates[t], matterRates[t]);
    }
  }

  /** Ensure a building has a PlantStorage component; add one if missing. */
  private ensurePlantStorage(
    world: World,
    entity: number,
    resourceType: 'energy' | 'matter',
  ): PlantStorageComponent {
    let storage = world.getComponent<PlantStorageComponent>(entity, PLANT_STORAGE);
    if (!storage) {
      world.addComponent<PlantStorageComponent>(entity, PLANT_STORAGE, {
        amount: 0,
        resourceType,
      });
      storage = world.getComponent<PlantStorageComponent>(entity, PLANT_STORAGE)!;
    }
    return storage;
  }
}
