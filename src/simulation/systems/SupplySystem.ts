import type { System, World } from '@core/ECS';
import {
  BUILDING, TEAM, CONSTRUCTION, POSITION, HEALTH,
  SUPPLY_ROUTE, MOVE_COMMAND, RESOURCE_SILO, DEPOT_RADIUS,
} from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { SupplyRouteComponent } from '@sim/components/SupplyRoute';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { SiloSystem } from './SiloSystem';

const LOAD_UNLOAD_TIME = 2.0; // seconds
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
const SILO_FOOTPRINT = 0.75;

export class SupplySystem implements System {
  readonly name = 'SupplySystem';

  private siloSystem: SiloSystem | null = null;

  constructor(private terrainData: TerrainData) {}

  setSiloSystem(siloSystem: SiloSystem): void {
    this.siloSystem = siloSystem;
  }

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

      // Check dest (depot) still alive
      const destHealth = world.getComponent<HealthComponent>(route.destEntity, HEALTH);
      if (!destHealth || destHealth.dead) {
        world.removeComponent(ferry, SUPPLY_ROUTE);
        if (world.hasComponent(ferry, MOVE_COMMAND)) {
          world.removeComponent(ferry, MOVE_COMMAND);
        }
        continue;
      }

      switch (route.state) {
        case 'to_source': {
          // Find nearest matter silo with stored > 0 for this team
          const team = world.getComponent<TeamComponent>(ferry, TEAM);
          if (!team) break;

          const siloEntity = this.findNearestMatterSilo(world, team.team, ferryPos.x, ferryPos.z);
          if (siloEntity === null) {
            // No silos with matter -- wait
            if (world.hasComponent(ferry, MOVE_COMMAND)) {
              world.removeComponent(ferry, MOVE_COMMAND);
            }
            break;
          }

          route.sourceEntity = siloEntity;

          if (!world.hasComponent(ferry, MOVE_COMMAND)) {
            const siloPos = world.getComponent<PositionComponent>(siloEntity, POSITION)!;
            const dx = ferryPos.x - siloPos.x;
            const dz = ferryPos.z - siloPos.z;
            if (dx * dx + dz * dz <= ARRIVAL_DIST_SQ) {
              route.state = 'loading';
              route.timer = 0;
            } else {
              const ap = this.getSiloApproachPoint(ferryPos.x, ferryPos.z, siloPos.x, siloPos.z);
              world.addComponent<MoveCommandComponent>(ferry, MOVE_COMMAND, {
                path: [], currentWaypoint: 0, destX: ap.x, destZ: ap.z,
              });
            }
          }
          break;
        }

        case 'loading': {
          route.timer += dt;
          if (route.timer >= LOAD_UNLOAD_TIME) {
            // Load from the silo
            const siloComp = world.getComponent<ResourceSiloComponent>(route.sourceEntity, RESOURCE_SILO);
            if (siloComp && siloComp.stored > 0) {
              const amount = Math.min(siloComp.stored, route.carryCapacity);
              siloComp.stored -= amount;
              route.carried = amount;
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
              path: [], currentWaypoint: 0, destX: destAp.x, destZ: destAp.z,
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
                path: [], currentWaypoint: 0, destX: dAp.x, destZ: dAp.z,
              });
            }
          }
          break;
        }

        case 'unloading': {
          route.timer += dt;
          if (route.timer >= LOAD_UNLOAD_TIME) {
            // Deliver matter to a silo near the depot
            if (route.carried > 0 && this.siloSystem) {
              const team = world.getComponent<TeamComponent>(ferry, TEAM);
              if (team) {
                const depotSilo = this.siloSystem.findOrSpawnSilo(
                  world, route.destEntity, 'matter', team.team,
                );
                if (depotSilo !== null) {
                  const siloComp = world.getComponent<ResourceSiloComponent>(depotSilo, RESOURCE_SILO)!;
                  siloComp.stored += route.carried;
                }
              }
              route.carried = 0;
            }
            route.state = 'to_source';

            if (world.hasComponent(ferry, MOVE_COMMAND)) {
              world.removeComponent(ferry, MOVE_COMMAND);
            }
          }
          break;
        }

        case 'idle':
          world.removeComponent(ferry, SUPPLY_ROUTE);
          break;
      }
    }
  }

  /** Find nearest matter silo with stored > 0 (at production buildings, not at depots). */
  private findNearestMatterSilo(world: World, team: number, x: number, z: number): number | null {
    const silos = world.query(RESOURCE_SILO, POSITION, TEAM, HEALTH);
    let bestEntity: number | null = null;
    let bestDistSq = Infinity;

    for (const e of silos) {
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      if (silo.resourceType !== 'matter') continue;
      if (silo.stored <= 0) continue;

      // Skip silos at depots (those are the destination, not the source)
      const parentBuilding = world.getComponent<BuildingComponent>(silo.parentBuilding, BUILDING);
      if (parentBuilding && parentBuilding.buildingType === BuildingType.SupplyDepot) continue;

      const siloTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (siloTeam.team !== team) continue;
      const siloHealth = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (siloHealth.dead) continue;

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

  findNearestDepot(world: World, team: number, x: number, z: number): number | null {
    const depots = world.query(DEPOT_RADIUS, BUILDING, TEAM, POSITION, HEALTH);
    let bestEntity: number | null = null;
    let bestDistSq = Infinity;

    for (const e of depots) {
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

  private getSiloApproachPoint(
    fromX: number, fromZ: number, siloX: number, siloZ: number,
  ): { x: number; z: number } {
    const approachDist = SILO_FOOTPRINT + APPROACH_MARGIN;
    const dx = fromX - siloX;
    const dz = fromZ - siloZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) {
      return { x: siloX + approachDist, z: siloZ };
    }
    return {
      x: siloX + (dx / dist) * approachDist,
      z: siloZ + (dz / dist) * approachDist,
    };
  }
}
