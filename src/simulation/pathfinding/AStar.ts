import { hasLineOfSight } from './LineOfSight';

export interface PathNode {
  x: number;
  z: number;
}

const SQRT2 = Math.SQRT2;

// 8 directions: cardinal + diagonal
const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DZ = [0, 0, 1, -1, 1, -1, -1, 1];
const DCOST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

function octileHeuristic(x: number, z: number, gx: number, gz: number): number {
  const dx = Math.abs(x - gx);
  const dz = Math.abs(z - gz);
  return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
}

/**
 * Binary min-heap for A* open set. Uses flat Float32Array for f-scores
 * and Int32Array for indices to minimize GC pressure.
 */
class MinHeap {
  private heap: Int32Array;
  private fScores: Float32Array;
  private size = 0;

  constructor(capacity: number) {
    this.heap = new Int32Array(capacity);
    this.fScores = new Float32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }

  push(index: number, f: number): void {
    const pos = this.size++;
    this.heap[pos] = index;
    this.fScores[pos] = f;
    this.bubbleUp(pos);
  }

  pop(): number {
    const top = this.heap[0];
    this.size--;
    if (this.size > 0) {
      this.heap[0] = this.heap[this.size];
      this.fScores[0] = this.fScores[this.size];
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.fScores[i] < this.fScores[parent]) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  private bubbleDown(i: number): void {
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < this.size && this.fScores[left] < this.fScores[smallest]) smallest = left;
      if (right < this.size && this.fScores[right] < this.fScores[smallest]) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmpH = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = tmpH;
    const tmpF = this.fScores[a];
    this.fScores[a] = this.fScores[b];
    this.fScores[b] = tmpF;
  }
}

/**
 * A* pathfinder with pre-allocated buffers.
 * Call findPath() repeatedly without GC overhead from buffer allocation.
 */
export class AStarPathfinder {
  private readonly width: number;
  private readonly height: number;
  private readonly totalCells: number;

  // Pre-allocated buffers
  private gScore: Float32Array;
  private fScore: Float32Array;
  private cameFrom: Int32Array;
  private closed: Uint8Array;
  private openSet: MinHeap;

  constructor(width: number = 256, height: number = 256) {
    this.width = width;
    this.height = height;
    this.totalCells = width * height;

    this.gScore = new Float32Array(this.totalCells);
    this.fScore = new Float32Array(this.totalCells);
    this.cameFrom = new Int32Array(this.totalCells);
    this.closed = new Uint8Array(this.totalCells);
    this.openSet = new MinHeap(this.totalCells);
  }

  findPath(
    sx: number,
    sz: number,
    gx: number,
    gz: number,
    isWalkable: (tx: number, tz: number) => boolean,
  ): PathNode[] | null {
    // Clamp to grid
    sx = Math.max(0, Math.min(this.width - 1, Math.floor(sx)));
    sz = Math.max(0, Math.min(this.height - 1, Math.floor(sz)));
    gx = Math.max(0, Math.min(this.width - 1, Math.floor(gx)));
    gz = Math.max(0, Math.min(this.height - 1, Math.floor(gz)));

    if (!isWalkable(gx, gz)) {
      // Find nearest walkable tile via spiral search
      const found = this.findNearestWalkable(gx, gz, isWalkable);
      if (!found) return null;
      gx = found.x;
      gz = found.z;
    }

    if (!isWalkable(sx, sz)) {
      const found = this.findNearestWalkable(sx, sz, isWalkable);
      if (!found) return null;
      sx = found.x;
      sz = found.z;
    }

    const startIdx = sz * this.width + sx;
    const goalIdx = gz * this.width + gx;

    if (startIdx === goalIdx) return [{ x: gx + 0.5, z: gz + 0.5 }];

    // Reset buffers
    this.gScore.fill(Infinity);
    this.fScore.fill(Infinity);
    this.cameFrom.fill(-1);
    this.closed.fill(0);
    this.openSet.clear();

    this.gScore[startIdx] = 0;
    this.fScore[startIdx] = octileHeuristic(sx, sz, gx, gz);
    this.openSet.push(startIdx, this.fScore[startIdx]);

    while (this.openSet.length > 0) {
      const currentIdx = this.openSet.pop();
      if (currentIdx === goalIdx) {
        return this.reconstructPath(goalIdx, isWalkable);
      }

      if (this.closed[currentIdx]) continue;
      this.closed[currentIdx] = 1;

      const cx = currentIdx % this.width;
      const cz = (currentIdx / this.width) | 0;

      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d];
        const nz = cz + DZ[d];

        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;

        const nIdx = nz * this.width + nx;
        if (this.closed[nIdx]) continue;
        if (!isWalkable(nx, nz)) continue;

        // No corner-cutting: diagonals require both adjacent cardinal tiles walkable
        if (d >= 4) {
          if (!isWalkable(cx + DX[d], cz) || !isWalkable(cx, cz + DZ[d])) continue;
        }

        const tentativeG = this.gScore[currentIdx] + DCOST[d];
        if (tentativeG < this.gScore[nIdx]) {
          this.gScore[nIdx] = tentativeG;
          this.fScore[nIdx] = tentativeG + octileHeuristic(nx, nz, gx, gz);
          this.cameFrom[nIdx] = currentIdx;
          this.openSet.push(nIdx, this.fScore[nIdx]);
        }
      }
    }

    return null; // No path found
  }

  private findNearestWalkable(
    cx: number,
    cz: number,
    isWalkable: (tx: number, tz: number) => boolean,
  ): PathNode | null {
    // Spiral search outward — pick closest tile by Euclidean distance at each ring
    for (let r = 1; r <= 20; r++) {
      let bestTile: PathNode | null = null;
      let bestDistSq = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // Only check perimeter
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;
          if (isWalkable(nx, nz)) {
            const distSq = dx * dx + dz * dz;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestTile = { x: nx, z: nz };
            }
          }
        }
      }
      if (bestTile) return bestTile;
    }
    return null;
  }

  private reconstructPath(
    goalIdx: number,
    isWalkable: (tx: number, tz: number) => boolean,
  ): PathNode[] {
    // Build raw path from cameFrom chain
    const raw: PathNode[] = [];
    let idx = goalIdx;
    while (idx !== -1) {
      raw.push({ x: (idx % this.width) + 0.5, z: ((idx / this.width) | 0) + 0.5 });
      idx = this.cameFrom[idx];
    }
    raw.reverse();

    // Smooth: skip waypoints that have direct LOS
    return smoothPath(raw, isWalkable);
  }
}

/**
 * Post-process: remove redundant waypoints using Bresenham LOS checks.
 */
function smoothPath(
  path: PathNode[],
  isWalkable: (tx: number, tz: number) => boolean,
): PathNode[] {
  if (path.length <= 2) return path;

  const smoothed: PathNode[] = [path[0]];
  let anchor = 0;

  while (anchor < path.length - 1) {
    let furthest = anchor + 1;

    for (let test = path.length - 1; test > anchor + 1; test--) {
      const ax = Math.floor(path[anchor].x);
      const az = Math.floor(path[anchor].z);
      const tx = Math.floor(path[test].x);
      const tz = Math.floor(path[test].z);

      if (hasLineOfSight(ax, az, tx, tz, isWalkable)) {
        furthest = test;
        break;
      }
    }

    smoothed.push(path[furthest]);
    anchor = furthest;
  }

  return smoothed;
}
