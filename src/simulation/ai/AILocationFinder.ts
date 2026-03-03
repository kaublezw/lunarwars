import {
  POSITION, BUILDING, TEAM, CONSTRUCTION,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
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
  const existing = ctx.world.query(BUILDING, TEAM).filter(e => {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) return false;
    const bldg = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    return bldg.buildingType === BuildingType.SupplyDepot;
  });

  const underConstruction = ctx.world.query(CONSTRUCTION, TEAM).filter(e => {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) return false;
    const con = ctx.world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
    return con.buildingType === BuildingType.SupplyDepot;
  });

  const depotIndex = existing.length + underConstruction.length;

  if (depotIndex === 0) {
    return findLocationNear(ctx, ctx.baseX, ctx.baseZ);
  }

  const enemy = estimateEnemyPosition(ctx, enemyMemory);
  const midX = (ctx.baseX + enemy.x) / 2;
  const midZ = (ctx.baseZ + enemy.z) / 2;

  let targetX = midX;
  let targetZ = midZ;

  if (depotIndex >= 2) {
    const axisX = enemy.x - ctx.baseX;
    const axisZ = enemy.z - ctx.baseZ;
    const len = Math.sqrt(axisX * axisX + axisZ * axisZ) || 1;
    const perpX = -axisZ / len;
    const perpZ = axisX / len;
    const side = (depotIndex % 2 === 0) ? 1 : -1;
    const spread = 10 * Math.ceil((depotIndex - 1) / 2);
    targetX = midX + perpX * spread * side;
    targetZ = midZ + perpZ * spread * side;
  }

  return findLocationNear(ctx, targetX, targetZ);
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

  for (const node of ctx.energyNodes) {
    if (claimedNodes.has(`${node.x},${node.z}`)) continue;
    if (!ctx.fog.isExplored(ctx.team, node.x, node.z)) continue;

    const dx = node.x - ctx.baseX;
    const dz = node.z - ctx.baseZ;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestNode = { x: node.x, z: node.z };
    }
  }

  if (bestNode) {
    return { x: Math.round(bestNode.x), z: Math.round(bestNode.z) };
  }

  return null;
}
