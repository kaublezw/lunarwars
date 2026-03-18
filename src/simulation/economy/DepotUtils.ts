import type { World } from '@core/ECS';
import { BUILDING, TEAM, POSITION, HEALTH, CONSTRUCTION, DEPOT_RADIUS } from '@sim/components/ComponentTypes';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import { getBuildingSiloTotal } from './SiloUtils';

export const RESUPPLY_RANGE = 5;
export const AMMO_MATTER_COST = 0.2;   // 1 matter per 5 ammo
export const REPAIR_MATTER_COST = 0.1;  // 1 matter per 10 HP
export const REPAIR_RATE = 20;          // HP per second

/** Find nearest alive completed depot with matter silos > 0 for a given team. */
export function findNearestDepot(world: World, team: number, x: number, z: number): number | null {
  const entities = world.query(DEPOT_RADIUS, BUILDING, TEAM, POSITION, HEALTH);
  let bestEntity: number | null = null;
  let bestDistSq = Infinity;

  for (const e of entities) {
    if (world.hasComponent(e, CONSTRUCTION)) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const health = world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;

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
