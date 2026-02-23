import type { System, World } from '@core/ECS';
import {
  BUILDING, TEAM, CONSTRUCTION, POSITION, HEALTH, MATTER_STORAGE,
  SUPPLY_ROUTE, MOVE_COMMAND,
} from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { SupplyRouteComponent } from '@sim/components/SupplyRoute';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';

const LOAD_UNLOAD_TIME = 2.0; // seconds
const CARRY_CAPACITY = 10;
const ARRIVAL_DIST = 5;
const ARRIVAL_DIST_SQ = ARRIVAL_DIST * ARRIVAL_DIST;

// Building footprint radii for approach-point calculation
const FOOTPRINT_RADIUS: Record<string, number> = {
  [BuildingType.HQ]: 2,
  [BuildingType.MatterPlant]: 2,
  [BuildingType.DroneFactory]: 2,
  [BuildingType.SupplyDepot]: 1.5,
  [BuildingType.EnergyExtractor]: 1.5,
};
const DEFAULT_FOOTPRINT = 1.5;
const APPROACH_MARGIN = 1.5;

export class SupplySystem implements System {
  readonly name = 'SupplySystem';

  constructor(private terrainData: TerrainData, private resources: ResourceState) {}

  update(world: World, dt: number): void {
    this.updateFerries(world, dt);
  }

  private updateFerries(world: World, dt: number): void {
    const ferries = world.query(SUPPLY_ROUTE, POSITION, HEALTH);

    for (const ferry of ferries) {
      const health = world.getComponent<HealthComponent>(ferry, HEALTH)!;
      if (health.dead) {
        world.removeComponent(ferry, SUPPLY_ROUTE);
        continue;
      }

      const route = world.getComponent<SupplyRouteComponent>(ferry, SUPPLY_ROUTE)!;
      const ferryPos = world.getComponent<PositionComponent>(ferry, POSITION)!;

      // Check source (HQ) and dest (depot) still alive
      const sourceHealth = world.getComponent<HealthComponent>(route.sourceEntity, HEALTH);
      const destHealth = world.getComponent<HealthComponent>(route.destEntity, HEALTH);
      if (!sourceHealth || sourceHealth.dead || !destHealth || destHealth.dead) {
        world.removeComponent(ferry, SUPPLY_ROUTE);
        if (world.hasComponent(ferry, MOVE_COMMAND)) {
          world.removeComponent(ferry, MOVE_COMMAND);
        }
        continue;
      }

      switch (route.state) {
        case 'to_source': {
          if (!world.hasComponent(ferry, MOVE_COMMAND)) {
            const sourcePos = world.getComponent<PositionComponent>(route.sourceEntity, POSITION)!;
            const dx = ferryPos.x - sourcePos.x;
            const dz = ferryPos.z - sourcePos.z;
            if (dx * dx + dz * dz <= ARRIVAL_DIST_SQ) {
              route.state = 'loading';
              route.timer = 0;
            } else {
              const srcBldg = world.getComponent<BuildingComponent>(route.sourceEntity, BUILDING)!;
              const ap = this.getApproachPoint(ferryPos.x, ferryPos.z, sourcePos.x, sourcePos.z, srcBldg.buildingType);
              world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
                path: [],
                currentWaypoint: 0,
                destX: ap.x,
                destZ: ap.z,
              });
            }
          }
          break;
        }

        case 'loading': {
          route.timer += dt;
          if (route.timer >= LOAD_UNLOAD_TIME) {
            // Load from global matter pool
            const team = world.getComponent<TeamComponent>(ferry, TEAM);
            if (team) {
              const available = this.resources.get(team.team).matter;
              const amount = Math.min(available, route.carryCapacity);
              if (amount > 0) {
                this.resources.spendMatter(team.team, amount);
                route.carried = amount;
              }
            }
            route.state = 'to_dest';

            // Issue move to depot
            const destPos = world.getComponent<PositionComponent>(route.destEntity, POSITION)!;
            const destBldg = world.getComponent<BuildingComponent>(route.destEntity, BUILDING)!;
            const destAp = this.getApproachPoint(ferryPos.x, ferryPos.z, destPos.x, destPos.z, destBldg.buildingType);
            if (world.hasComponent(ferry, MOVE_COMMAND)) {
              world.removeComponent(ferry, MOVE_COMMAND);
            }
            world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
              path: [],
              currentWaypoint: 0,
              destX: destAp.x,
              destZ: destAp.z,
            });
          }
          break;
        }

        case 'to_dest': {
          if (!world.hasComponent(ferry, MOVE_COMMAND)) {
            const destPos = world.getComponent<PositionComponent>(route.destEntity, POSITION)!;
            const dx = ferryPos.x - destPos.x;
            const dz = ferryPos.z - destPos.z;
            if (dx * dx + dz * dz <= ARRIVAL_DIST_SQ) {
              route.state = 'unloading';
              route.timer = 0;
            } else {
              const dBldg = world.getComponent<BuildingComponent>(route.destEntity, BUILDING)!;
              const dAp = this.getApproachPoint(ferryPos.x, ferryPos.z, destPos.x, destPos.z, dBldg.buildingType);
              world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
                path: [],
                currentWaypoint: 0,
                destX: dAp.x,
                destZ: dAp.z,
              });
            }
          }
          break;
        }

        case 'unloading': {
          route.timer += dt;
          if (route.timer >= LOAD_UNLOAD_TIME) {
            // Deliver matter to depot's local storage
            if (route.carried > 0) {
              const destStorage = world.getComponent<MatterStorageComponent>(route.destEntity, MATTER_STORAGE);
              if (destStorage) {
                destStorage.stored += route.carried;
              }
              route.carried = 0;
            }
            route.state = 'to_source';

            // Issue move back to HQ
            const sourcePos2 = world.getComponent<PositionComponent>(route.sourceEntity, POSITION)!;
            const srcBldg2 = world.getComponent<BuildingComponent>(route.sourceEntity, BUILDING)!;
            const srcAp2 = this.getApproachPoint(ferryPos.x, ferryPos.z, sourcePos2.x, sourcePos2.z, srcBldg2.buildingType);
            if (world.hasComponent(ferry, MOVE_COMMAND)) {
              world.removeComponent(ferry, MOVE_COMMAND);
            }
            world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
              path: [],
              currentWaypoint: 0,
              destX: srcAp2.x,
              destZ: srcAp2.z,
            });
          }
          break;
        }

        case 'idle':
          // Stale route -- clean up
          world.removeComponent(ferry, SUPPLY_ROUTE);
          break;
      }
    }
  }

  findNearestDepot(world: World, team: number, x: number, z: number): number | null {
    const buildings = world.query(BUILDING, TEAM, POSITION, HEALTH, MATTER_STORAGE);
    let bestEntity: number | null = null;
    let bestDistSq = Infinity;

    for (const e of buildings) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const bTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (bTeam.team !== team) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.SupplyDepot) continue;
      const bHealth = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (bHealth.dead) continue;

      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    return bestEntity;
  }

  private getApproachPoint(
    fromX: number, fromZ: number,
    buildingX: number, buildingZ: number,
    buildingType: BuildingType,
  ): { x: number; z: number } {
    const footprint = FOOTPRINT_RADIUS[buildingType] ?? DEFAULT_FOOTPRINT;
    const approachDist = footprint + APPROACH_MARGIN;
    const dx = fromX - buildingX;
    const dz = fromZ - buildingZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) {
      return { x: buildingX + approachDist, z: buildingZ };
    }
    return {
      x: buildingX + (dx / dist) * approachDist,
      z: buildingZ + (dz / dist) * approachDist,
    };
  }
}
