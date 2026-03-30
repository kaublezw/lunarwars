import type { VoxelModel } from '@sim/data/VoxelModels';
import { VOXEL_SIZE } from '@sim/data/VoxelModels';

export interface DestroyedVoxelInfo {
  solidIndex: number;
  gridIndex: number;
  /** Offset from blast center in grid space */
  dx: number;
  dy: number;
  dz: number;
}

/**
 * Convert a world-space impact point to model grid coordinates.
 * Optionally applies inverse rotation for rotated entities (units).
 * Buildings are axis-aligned so rotation should be 0.
 */
export function worldToModelGrid(
  impactX: number, impactY: number, impactZ: number,
  originX: number, originY: number, originZ: number,
  model: VoxelModel,
  rotation = 0,
): { gridX: number; gridY: number; gridZ: number } {
  const halfX = (model.sizeX * VOXEL_SIZE) / 2;
  const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;

  let localX = impactX - originX;
  let localY = impactY - originY;
  let localZ = impactZ - originZ;

  if (rotation !== 0) {
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const rx = localX * cos - localZ * sin;
    const rz = localX * sin + localZ * cos;
    localX = rx;
    localZ = rz;
  }

  return {
    gridX: Math.max(0, Math.min(model.sizeX - 1, Math.floor((localX + halfX) / VOXEL_SIZE))),
    gridY: Math.max(0, Math.min(model.sizeY - 1, Math.floor(localY / VOXEL_SIZE))),
    gridZ: Math.max(0, Math.min(model.sizeZ - 1, Math.floor((localZ + halfZ) / VOXEL_SIZE))),
  };
}

/**
 * Apply spherical blast damage to a destroyed bitmask.
 * Returns info about each newly destroyed voxel (for debris spawning, etc.).
 */
export function applyBlastDamage(
  model: VoxelModel,
  destroyed: Uint8Array,
  gridX: number, gridY: number, gridZ: number,
  blastRadius: number,
  minY = 0, maxY = model.sizeY - 1,
): DestroyedVoxelInfo[] {
  const result: DestroyedVoxelInfo[] = [];
  const rSq = blastRadius * blastRadius + 1;

  for (let dy = -blastRadius; dy <= blastRadius; dy++) {
    for (let dz = -blastRadius; dz <= blastRadius; dz++) {
      for (let dx = -blastRadius; dx <= blastRadius; dx++) {
        const gx = gridX + dx;
        const gy = gridY + dy;
        const gz = gridZ + dz;

        if (gx < 0 || gx >= model.sizeX || gy < 0 || gy >= model.sizeY || gz < 0 || gz >= model.sizeZ) continue;
        if (gy < minY || gy > maxY) continue;
        if (dx * dx + dy * dy + dz * dz > rSq) continue;

        const gridIdx = gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ;
        if (model.grid[gridIdx] === 0) continue;

        const solidIdx = model.gridToSolid[gridIdx];
        if (solidIdx === -1) continue;

        const byteIdx = solidIdx >> 3;
        const bitIdx = solidIdx & 7;
        if (destroyed[byteIdx] & (1 << bitIdx)) continue;

        destroyed[byteIdx] |= (1 << bitIdx);
        result.push({ solidIndex: solidIdx, gridIndex: gridIdx, dx, dy, dz });
      }
    }
  }
  return result;
}

/**
 * Find surviving (non-destroyed) voxels within a radius of a grid point.
 * Used for scorch mark application. Returns solid indices of survivors.
 */
export function findSurvivorsInRadius(
  model: VoxelModel,
  destroyed: Uint8Array,
  gridX: number, gridY: number, gridZ: number,
  radius: number,
  minY = 0, maxY = model.sizeY - 1,
): number[] {
  const result: number[] = [];
  const rSq = radius * radius + 1;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const gx = gridX + dx;
        const gy = gridY + dy;
        const gz = gridZ + dz;

        if (gx < 0 || gx >= model.sizeX || gy < 0 || gy >= model.sizeY || gz < 0 || gz >= model.sizeZ) continue;
        if (gy < minY || gy > maxY) continue;
        if (dx * dx + dy * dy + dz * dz > rSq) continue;

        const gridIdx = gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ;
        if (model.grid[gridIdx] === 0) continue;

        const solidIdx = model.gridToSolid[gridIdx];
        if (solidIdx === -1) continue;

        if (destroyed[solidIdx >> 3] & (1 << (solidIdx & 7))) continue;

        result.push(solidIdx);
      }
    }
  }
  return result;
}

/**
 * Progressively destroy voxels to match a target damage ratio.
 * Uses a pre-shuffled damage order for deterministic visual progression.
 * Returns the number of newly destroyed voxels.
 */
export function syncDamageToRatio(
  totalSolid: number,
  destroyed: Uint8Array,
  damageOrder: number[],
  targetRatio: number,
): number {
  const targetCount = Math.floor(targetRatio * totalSolid);
  let current = 0;
  for (let si = 0; si < totalSolid; si++) {
    if (destroyed[si >> 3] & (1 << (si & 7))) current++;
  }
  if (targetCount <= current) return 0;

  let added = 0;
  for (const si of damageOrder) {
    if (current + added >= targetCount) break;
    const byteIdx = si >> 3;
    const bitIdx = si & 7;
    if (!(destroyed[byteIdx] & (1 << bitIdx))) {
      destroyed[byteIdx] |= (1 << bitIdx);
      added++;
    }
  }
  return added;
}

/**
 * Build a deterministic damage order for progressive voxel destruction.
 * Fisher-Yates shuffle seeded by entity ID.
 */
export function buildDamageOrder(seed: number, totalSolid: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < totalSolid; i++) {
    order.push(i);
  }
  let s = seed * 2654435761;
  for (let i = order.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Decay scorch heat values. Values > 0 are actively cooling;
 * values that reach 0 are set to -1 (permanent ash).
 * Returns true if any voxels are still actively cooling.
 */
export function decayScorchHeat(heat: Float32Array, decayAmount: number): boolean {
  let stillCooling = false;
  for (let i = 0; i < heat.length; i++) {
    const h = heat[i];
    if (h <= 0) continue;
    heat[i] = h - decayAmount;
    if (heat[i] <= 0) {
      heat[i] = -1;
    } else {
      stillCooling = true;
    }
  }
  return stillCooling;
}
