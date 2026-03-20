import {
  POSITION, BUILDING, TEAM, CONSTRUCTION,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { ConstructionComponent } from '@sim/components/Construction';

import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState, EnemyMemoryEntry, WallSegmentPlan } from '@sim/ai/AITypes';
import { WALL_NEARBY_RADIUS_SQ } from '@sim/ai/AITypes';
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

// --- Wall Placement ---

const WALL_OVERLAP_DIST_SQ = 2.25; // 1.5wu squared

function validateAIWallSegment(ctx: AIContext, x: number, z: number): boolean {
  if (x < 4 || x > 252 || z < 4 || z > 252) return false;
  if (!ctx.terrain.isPassable(x, z)) return false;

  // Check no building within 1.5wu
  const buildings = ctx.world.query(BUILDING, POSITION);
  for (const e of buildings) {
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
    const dx = pos.x - x;
    const dz = pos.z - z;
    if (dx * dx + dz * dz < WALL_OVERLAP_DIST_SQ) return false;
  }
  return true;
}

function hasWallNearby(ctx: AIContext, x: number, z: number, radiusSq: number): boolean {
  const buildings = ctx.world.query(BUILDING, POSITION, TEAM);
  for (const e of buildings) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const bldg = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    if (bldg.buildingType !== BuildingType.Wall) continue;
    const pos = ctx.world.getComponent<PositionComponent>(e, POSITION)!;
    const dx = pos.x - x;
    const dz = pos.z - z;
    if (dx * dx + dz * dz < radiusSq) return true;
  }
  return false;
}

export function findExtractorWallPlan(
  ctx: AIContext,
  _state: AIWorldState,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): WallSegmentPlan[] | null {
  // Find remote extractors (>25wu from base) without walls nearby
  const extractors = ctx.world.query(BUILDING, TEAM, POSITION).filter(e => {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) return false;
    const bldg = ctx.world.getComponent<BuildingComponent>(e, BUILDING)!;
    return bldg.buildingType === BuildingType.EnergyExtractor;
  });

  const enemy = estimateEnemyPosition(ctx, enemyMemory);

  for (const ext of extractors) {
    const pos = ctx.world.getComponent<PositionComponent>(ext, POSITION)!;
    const dx = pos.x - ctx.baseX;
    const dz = pos.z - ctx.baseZ;
    if (dx * dx + dz * dz < 25 * 25) continue; // Not remote

    if (hasWallNearby(ctx, pos.x, pos.z, WALL_NEARBY_RADIUS_SQ)) continue;

    // Threat direction: extractor toward enemy
    const threatDx = enemy.x - pos.x;
    const threatDz = enemy.z - pos.z;
    const threatLen = Math.sqrt(threatDx * threatDx + threatDz * threatDz) || 1;
    const normTx = threatDx / threatLen;
    const normTz = threatDz / threatLen;

    // Wall center 5wu from extractor toward enemy
    const wallCenterX = pos.x + normTx * 5;
    const wallCenterZ = pos.z + normTz * 5;

    // Perpendicular direction
    const perpX = -normTz;
    const perpZ = normTx;

    // Choose wall type based on perpendicular axis
    const meshType: 'wall_x' | 'wall_z' = Math.abs(perpX) > Math.abs(perpZ) ? 'wall_x' : 'wall_z';
    const spacing = 3.0; // wall segment length

    // Place continuous segments, skip offset 0 for unit passage gap
    // Offsets: -3, -2, -1, 1, 2, 3 -> 6 segments forming a shield with a 3wu gap
    const segments: WallSegmentPlan[] = [];
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue; // Unit passage gap
      const sx = Math.round(wallCenterX + perpX * spacing * i);
      const sz = Math.round(wallCenterZ + perpZ * spacing * i);
      if (validateAIWallSegment(ctx, sx, sz)) {
        segments.push({ x: sx, z: sz, meshType });
      }
    }

    if (segments.length >= 3) return segments;
  }

  return null;
}

export function findChokepointWallPlan(
  ctx: AIContext,
  _state: AIWorldState,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): WallSegmentPlan[] | null {
  const enemy = estimateEnemyPosition(ctx, enemyMemory);

  // Axis from base to enemy
  const axisX = enemy.x - ctx.baseX;
  const axisZ = enemy.z - ctx.baseZ;
  const axisLen = Math.sqrt(axisX * axisX + axisZ * axisZ) || 1;
  const normX = axisX / axisLen;
  const normZ = axisZ / axisLen;

  // Perpendicular
  const perpX = -normZ;
  const perpZ = normX;

  // Scan cross-sections every 8 tiles along the axis
  interface Chokepoint {
    cx: number;
    cz: number;
    width: number;
    distFromMid: number;
  }

  const chokepoints: Chokepoint[] = [];
  const maxScanDist = axisLen * 0.8;
  const midDist = axisLen * 0.5;

  for (let t = 16; t < maxScanDist; t += 8) {
    const scanX = ctx.baseX + normX * t;
    const scanZ = ctx.baseZ + normZ * t;

    // Measure contiguous flat-tile width expanding left/right from center
    let leftWidth = 0;
    let rightWidth = 0;

    for (let s = 1; s <= 20; s++) {
      const tx = Math.round(scanX + perpX * s);
      const tz = Math.round(scanZ + perpZ * s);
      if (tx < 4 || tx > 252 || tz < 4 || tz > 252) break;
      if (!ctx.terrain.isPassable(tx, tz)) break;
      rightWidth = s;
    }

    for (let s = 1; s <= 20; s++) {
      const tx = Math.round(scanX - perpX * s);
      const tz = Math.round(scanZ - perpZ * s);
      if (tx < 4 || tx > 252 || tz < 4 || tz > 252) break;
      if (!ctx.terrain.isPassable(tx, tz)) break;
      leftWidth = s;
    }

    const totalWidth = leftWidth + rightWidth + 1;

    // Only consider narrow passages (4-12 tiles)
    if (totalWidth >= 4 && totalWidth <= 12) {
      chokepoints.push({
        cx: scanX,
        cz: scanZ,
        width: totalWidth,
        distFromMid: Math.abs(t - midDist),
      });
    }
  }

  if (chokepoints.length === 0) return null;

  // Pick narrowest, prefer near midpoint
  chokepoints.sort((a, b) => {
    if (a.width !== b.width) return a.width - b.width;
    return a.distFromMid - b.distFromMid;
  });

  const best = chokepoints[0];

  // Skip if already walled (within 6wu)
  if (hasWallNearby(ctx, best.cx, best.cz, 36)) return null;

  // Generate continuous segments spanning gap with center gap for unit passage
  const meshType: 'wall_x' | 'wall_z' = Math.abs(perpX) > Math.abs(perpZ) ? 'wall_x' : 'wall_z';
  const spacing = 3.0;
  // Number of segments per side based on gap width (each tile ~0.15wu, each segment 3wu)
  const halfCount = Math.max(2, Math.min(4, Math.ceil(best.width * 0.15 / spacing)));

  const segments: WallSegmentPlan[] = [];
  for (let i = -halfCount; i <= halfCount; i++) {
    if (i === 0) continue; // Unit passage gap
    const sx = Math.round(best.cx + perpX * spacing * i);
    const sz = Math.round(best.cz + perpZ * spacing * i);
    if (validateAIWallSegment(ctx, sx, sz)) {
      segments.push({ x: sx, z: sz, meshType });
    }
    if (segments.length >= 6) break;
  }

  if (segments.length >= 3) return segments;
  return null;
}

export function findBasePerimeterWallPlan(
  ctx: AIContext,
  _state: AIWorldState,
  enemyMemory: Map<number, EnemyMemoryEntry>,
): WallSegmentPlan[] | null {
  const enemy = estimateEnemyPosition(ctx, enemyMemory);

  // Threat direction base toward enemy
  const threatDx = enemy.x - ctx.baseX;
  const threatDz = enemy.z - ctx.baseZ;
  const threatLen = Math.sqrt(threatDx * threatDx + threatDz * threatDz) || 1;
  const normTx = threatDx / threatLen;
  const normTz = threatDz / threatLen;

  // Wall center 13wu from HQ toward enemy
  const wallCenterX = ctx.baseX + normTx * 13;
  const wallCenterZ = ctx.baseZ + normTz * 13;

  // Skip if already walled
  if (hasWallNearby(ctx, wallCenterX, wallCenterZ, 36)) return null;

  // Perpendicular direction
  const perpX = -normTz;
  const perpZ = normTx;

  const meshType: 'wall_x' | 'wall_z' = Math.abs(perpX) > Math.abs(perpZ) ? 'wall_x' : 'wall_z';
  const spacing = 3.0;

  // Place continuous segments perpendicular, skip center for unit passage
  // Offsets: -3, -2, -1, 1, 2, 3 -> 6 segments forming a perimeter wall
  const segments: WallSegmentPlan[] = [];
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue; // Unit passage gap
    const sx = Math.round(wallCenterX + perpX * spacing * i);
    const sz = Math.round(wallCenterZ + perpZ * spacing * i);
    if (validateAIWallSegment(ctx, sx, sz)) {
      segments.push({ x: sx, z: sz, meshType });
    }
  }

  if (segments.length >= 3) return segments;
  return null;
}
