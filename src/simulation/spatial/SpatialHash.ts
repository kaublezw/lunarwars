import type { Entity } from '@core/ECS';

/**
 * Flat-array spatial hash for fast neighbor queries.
 * Rebuilt every tick (cheap for ~100 units).
 */
export class SpatialHash {
  private readonly cellSize: number;
  private readonly gridW: number;
  private readonly gridH: number;
  // Each cell stores a list of entities
  private cells: Entity[][];

  constructor(cellSize: number = 4, worldWidth: number = 256, worldHeight: number = 256) {
    this.cellSize = cellSize;
    this.gridW = Math.ceil(worldWidth / cellSize);
    this.gridH = Math.ceil(worldHeight / cellSize);
    this.cells = new Array(this.gridW * this.gridH);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = [];
    }
  }

  clear(): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i].length = 0;
    }
  }

  insert(entity: Entity, x: number, z: number): void {
    const cx = Math.max(0, Math.min(this.gridW - 1, (x / this.cellSize) | 0));
    const cz = Math.max(0, Math.min(this.gridH - 1, (z / this.cellSize) | 0));
    this.cells[cz * this.gridW + cx].push(entity);
  }

  query(x: number, z: number, radius: number): Entity[] {
    const results: Entity[] = [];
    const minCX = Math.max(0, ((x - radius) / this.cellSize) | 0);
    const maxCX = Math.min(this.gridW - 1, ((x + radius) / this.cellSize) | 0);
    const minCZ = Math.max(0, ((z - radius) / this.cellSize) | 0);
    const maxCZ = Math.min(this.gridH - 1, ((z + radius) / this.cellSize) | 0);

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const cell = this.cells[cz * this.gridW + cx];
        for (let i = 0; i < cell.length; i++) {
          results.push(cell[i]);
        }
      }
    }

    return results;
  }
}
