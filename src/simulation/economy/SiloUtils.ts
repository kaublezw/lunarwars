import type { World } from '@core/ECS';
import { RESOURCE_SILO, TEAM, HEALTH, POSITION, DEPOT_RADIUS, BUILDING, CONSTRUCTION } from '@sim/components/ComponentTypes';
import type { ResourceSiloComponent, SiloResourceType } from '@sim/components/ResourceSilo';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { PositionComponent } from '@sim/components/Position';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';

/** Find all live silos belonging to a building (parentBuilding = buildingEntity). */
export function findSilosForBuilding(
  world: World,
  buildingEntity: number,
  resourceType: SiloResourceType,
): number[] {
  const result: number[] = [];
  const silos = world.query(RESOURCE_SILO, HEALTH);
  for (const e of silos) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
    if (silo.resourceType !== resourceType) continue;
    if (silo.parentBuilding !== buildingEntity) continue;
    result.push(e);
  }
  return result;
}

/** Get total stored resources in silos belonging to a building. */
export function getBuildingSiloTotal(
  world: World,
  buildingEntity: number,
  resourceType: SiloResourceType,
): number {
  let total = 0;
  const silos = world.query(RESOURCE_SILO, HEALTH);
  for (const e of silos) {
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
    if (silo.resourceType !== resourceType) continue;
    if (silo.parentBuilding !== buildingEntity) continue;
    total += silo.stored;
  }
  return total;
}

/** Deduct resources from silos belonging to a building. Returns actual amount deducted. */
export function deductFromBuildingSilos(
  world: World,
  buildingEntity: number,
  resourceType: SiloResourceType,
  amount: number,
): number {
  let remaining = amount;
  const silos = world.query(RESOURCE_SILO, HEALTH);
  for (const e of silos) {
    if (remaining <= 0) break;
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
    if (silo.resourceType !== resourceType) continue;
    if (silo.parentBuilding !== buildingEntity) continue;

    const take = Math.min(silo.stored, remaining);
    silo.stored -= take;
    remaining -= take;
  }
  return amount - remaining;
}

/** Find nearest completed Supply Depot for a team that has matter silos with storage > 0. */
export function findNearestDepotWithMatter(
  world: World,
  team: number,
  x: number,
  z: number,
): number | null {
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

    // Check if this depot has matter silos with stored > 0
    const matterTotal = getBuildingSiloTotal(world, e, 'matter');
    if (matterTotal <= 0) continue;

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

// Constants re-exported for ResupplySystem/RepairSystem
export const AMMO_MATTER_COST = 0.2;
export const REPAIR_MATTER_COST = 0.1;
export const REPAIR_RATE = 20;
