import {
  POSITION, BUILDING, CONSTRUCTION,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { BuildingComponent } from '@sim/components/Building';
import type { ConstructionComponent } from '@sim/components/Construction';

import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState, EnemyMemoryEntry } from '@sim/ai/AITypes';
import { estimateEnemyPosition } from '@sim/ai/AIQueries';

export function findBuildLocation(
  ctx: AIContext,
  type: BuildingType,
  state: AIWorldState,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): { x: number; z: number } | null {
  if (type === BuildingType.EnergyExtractor) {
    return findEnergyNodeLocation(ctx);
  }

  if (type === BuildingType.MatterPlant) {
    return findOreDepositLocation(ctx);
  }

  if (type === BuildingType.SupplyDepot) {
    return findDepotLocation(ctx, state, enemyMemory);
  }

  return findLocationNear(ctx, ctx.baseX, ctx.baseZ);
}

export function findDepotLocation(
  ctx: AIContext,
  _state: AIWorldState,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): { x: number; z: number } | null {
  // Enemy must be discovered before placing a forward depot
  let enemyDiscovered = false;
  for (const [, entry] of enemyMemory) {
    if (entry.type === 'building') {
      enemyDiscovered = true;
      break;
    }
  }
  if (!enemyDiscovered) return null;

  const enemy = estimateEnemyPosition(ctx, enemyMemory);
  const midX = (ctx.baseX + enemy.x) / 2;
  const midZ = (ctx.baseZ + enemy.z) / 2;

  // Walk from midpoint back toward our base, testing each spot
  const dx = ctx.baseX - midX;
  const dz = ctx.baseZ - midZ;
  const dist = Math.sqrt(dx * dx + dz * dz) || 1;
  const stepX = dx / dist;
  const stepZ = dz / dist;
  const STEP_SIZE = 4;

  for (let t = 0; t <= dist; t += STEP_SIZE) {
    const x = Math.round(midX + stepX * t);
    const z = Math.round(midZ + stepZ * t);
    const loc = findLocationNear(ctx, x, z);
    if (loc) return loc;
  }

  return null;
}

export function findLocationNear(
  ctx: AIContext,
  centerX: number,
  centerZ: number,
): { x: number; z: number } | null {
  const radii = [0, 4, 8, 12, 16, 20];
  const directions = [
    { dx: 0, dz: 0 },
    { dx: 1, dz: 0 },   { dx: -1, dz: 0 },
    { dx: 0, dz: 1 },   { dx: 0, dz: -1 },
    { dx: 1, dz: 1 },   { dx: -1, dz: 1 },
    { dx: 1, dz: -1 },  { dx: -1, dz: -1 },
  ];

  for (const radius of radii) {
    const dirs = radius === 0 ? [directions[0]] : directions.slice(1);
    for (const dir of dirs) {
      const x = Math.round(centerX + dir.dx * radius);
      const z = Math.round(centerZ + dir.dz * radius);

      if (x < 4 || x > 252 || z < 4 || z > 252) continue;
      if (!ctx.terrain.isPassable(x, z)) continue;

      let blocked = false;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (ctx.occupancy.isBlocked(x + dx, z + dz)) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
      if (blocked) continue;

      // Euclidean building spacing check (matches PlacementValidator BUILDING_MIN_SPACING=5)
      const spacingSq = 5 * 5;
      let tooClose = false;
      const allBuildings = ctx.world.query(BUILDING, POSITION);
      for (const e of allBuildings) {
        const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
        const bdx = pos.x - x;
        const bdz = pos.z - z;
        if (bdx * bdx + bdz * bdz < spacingSq) { tooClose = true; break; }
      }
      if (!tooClose) {
        const allConstructions = ctx.world.query(CONSTRUCTION, POSITION);
        for (const e of allConstructions) {
          const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
          const bdx = pos.x - x;
          const bdz = pos.z - z;
          if (bdx * bdx + bdz * bdz < spacingSq) { tooClose = true; break; }
        }
      }
      if (tooClose) continue;

      return { x, z };
    }
  }

  return null;
}

export function findEnergyNodeLocation(ctx: AIContext): { x: number; z: number } | null {
  const claimedNodes = new Set<string>();

  const buildings = ctx.world.query(BUILDING, POSITION);
  for (const e of buildings) {
    const building = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    if (building.buildingType === BuildingType.EnergyExtractor) {
      const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
      for (const node of ctx.energyNodes) {
        const dx = node.x - pos.x;
        const dz = node.z - pos.z;
        if (dx * dx + dz * dz < 25) {
          claimedNodes.add(`${node.x},${node.z}`);
        }
      }
    }
  }

  const constructions = ctx.world.query(CONSTRUCTION, POSITION);
  for (const e of constructions) {
    const construction = ctx.world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
    if (construction.buildingType === BuildingType.EnergyExtractor) {
      const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
      for (const node of ctx.energyNodes) {
        const dx = node.x - pos.x;
        const dz = node.z - pos.z;
        if (dx * dx + dz * dz < 25) {
          claimedNodes.add(`${node.x},${node.z}`);
        }
      }
    }
  }

  let bestNode: { x: number; z: number } | null = null;
  let bestDistSq = Infinity;

  let exploredCount = 0;
  let unexploredCount = 0;
  for (const node of ctx.energyNodes) {
    if (claimedNodes.has(`${node.x},${node.z}`)) continue;
    if (!ctx.fog.isExplored(ctx.team, node.x, node.z)) {
      unexploredCount++;
      continue;
    }
    exploredCount++;

    const dx = node.x - ctx.baseX;
    const dz = node.z - ctx.baseZ;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestNode = { x: node.x, z: node.z };
    }
  }

  // Fallback: consider unexplored nodes near base (within 40 wu)
  let fallbackCount = 0;
  if (!bestNode) {
    for (const node of ctx.energyNodes) {
      if (claimedNodes.has(`${node.x},${node.z}`)) continue;
      const dx = node.x - ctx.baseX;
      const dz = node.z - ctx.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > 40 * 40) continue;
      fallbackCount++;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestNode = { x: node.x, z: node.z };
      }
    }
  }

  if (bestNode) {
    return { x: Math.round(bestNode.x), z: Math.round(bestNode.z) };
  }

  return null;
}

export function findOreDepositLocation(ctx: AIContext): { x: number; z: number } | null {
  const claimedDeposits = new Set<string>();

  const buildings = ctx.world.query(BUILDING, POSITION);
  for (const e of buildings) {
    const building = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    if (building.buildingType === BuildingType.MatterPlant) {
      const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
      for (const dep of ctx.oreDeposits) {
        const dx = dep.x - pos.x;
        const dz = dep.z - pos.z;
        if (dx * dx + dz * dz < 25) {
          claimedDeposits.add(`${dep.x},${dep.z}`);
        }
      }
    }
  }

  const constructions = ctx.world.query(CONSTRUCTION, POSITION);
  for (const e of constructions) {
    const construction = ctx.world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
    if (construction.buildingType === BuildingType.MatterPlant) {
      const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
      for (const dep of ctx.oreDeposits) {
        const dx = dep.x - pos.x;
        const dz = dep.z - pos.z;
        if (dx * dx + dz * dz < 25) {
          claimedDeposits.add(`${dep.x},${dep.z}`);
        }
      }
    }
  }

  let bestDeposit: { x: number; z: number } | null = null;
  let bestDistSq = Infinity;

  for (const dep of ctx.oreDeposits) {
    if (claimedDeposits.has(`${dep.x},${dep.z}`)) continue;
    if (!ctx.fog.isExplored(ctx.team, dep.x, dep.z)) continue;

    const dx = dep.x - ctx.baseX;
    const dz = dep.z - ctx.baseZ;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestDeposit = { x: dep.x, z: dep.z };
    }
  }

  // Fallback: consider unexplored deposits near base (within 40 wu)
  if (!bestDeposit) {
    for (const dep of ctx.oreDeposits) {
      if (claimedDeposits.has(`${dep.x},${dep.z}`)) continue;
      const dx = dep.x - ctx.baseX;
      const dz = dep.z - ctx.baseZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > 40 * 40) continue;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestDeposit = { x: dep.x, z: dep.z };
      }
    }
  }

  if (bestDeposit) {
    return { x: Math.round(bestDeposit.x), z: Math.round(bestDeposit.z) };
  }

  return null;
}

