import type { World } from '@core/ECS';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import { BUILDING, POSITION, CONSTRUCTION } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { snapToGrid } from '@sim/terrain/GridConstants';

const SNAP_RANGE = 15;
const OCCUPIED_RANGE = 2;
const BUILDING_MIN_SPACING = 5;

export function validateAndSnapPlacement(
  buildingType: BuildingType,
  x: number,
  z: number,
  world: World,
  terrainData: TerrainData,
  energyNodes: EnergyNode[],
  oreDeposits: OreDeposit[],
): { valid: boolean; x: number; z: number } {
  const def = BUILDING_DEFS[buildingType];
  if (!def) return { valid: false, x, z };

  // Build occupied set for node checks
  const occupiedSet = new Set<string>();
  const buildings = world.query(BUILDING, POSITION);
  for (const e of buildings) {
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    occupiedSet.add(`${Math.round(pos.x)},${Math.round(pos.z)}`);
  }

  // Snap to grid cell centers (e.g. 2, 6, 10, ... for 4-unit cells)
  let snappedX = snapToGrid(x);
  let snappedZ = snapToGrid(z);

  // Snap to energy node if needed (overrides grid)
  if (def.needsEnergyNode) {
    const closest = findClosestUnoccupied(
      energyNodes, x, z, occupiedSet,
      (n) => ({ x: n.x, z: n.z }),
    );
    if (!closest || closest.dist > SNAP_RANGE) {
      return { valid: false, x, z };
    }
    snappedX = closest.item.x;
    snappedZ = closest.item.z;
  }

  // Snap to ore deposit if needed
  if (def.needsOreDeposit) {
    const closest = findClosestUnoccupied(
      oreDeposits, x, z, occupiedSet,
      (d) => ({ x: d.x, z: d.z }),
    );
    if (!closest || closest.dist > SNAP_RANGE) {
      return { valid: false, x, z };
    }
    snappedX = closest.item.x;
    snappedZ = closest.item.z;
  }

  // Bounds check
  if (snappedX < 2 || snappedX > 254 || snappedZ < 2 || snappedZ > 254) {
    return { valid: false, x: snappedX, z: snappedZ };
  }

  // Terrain passability
  if (!terrainData.isPassable(snappedX, snappedZ)) {
    return { valid: false, x: snappedX, z: snappedZ };
  }

  // Building spacing
  const spacingSq = BUILDING_MIN_SPACING * BUILDING_MIN_SPACING;
  for (const e of buildings) {
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    const dx = pos.x - snappedX;
    const dz = pos.z - snappedZ;
    if (dx * dx + dz * dz < spacingSq) {
      return { valid: false, x: snappedX, z: snappedZ };
    }
  }

  // Also check construction sites
  const sites = world.query(CONSTRUCTION, POSITION);
  for (const e of sites) {
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    const dx = pos.x - snappedX;
    const dz = pos.z - snappedZ;
    if (dx * dx + dz * dz < spacingSq) {
      return { valid: false, x: snappedX, z: snappedZ };
    }
  }

  return { valid: true, x: snappedX, z: snappedZ };
}

function findClosestUnoccupied<T>(
  items: T[],
  x: number,
  z: number,
  occupiedSet: Set<string>,
  getPos: (item: T) => { x: number; z: number },
): { item: T; dist: number } | null {
  let best: T | null = null;
  let bestDist = Infinity;

  for (const item of items) {
    const pos = getPos(item);
    if (occupiedSet.has(`${Math.round(pos.x)},${Math.round(pos.z)}`)) continue;
    const dx = pos.x - x;
    const dz = pos.z - z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }

  return best ? { item: best, dist: bestDist } : null;
}
