import { VOXEL_SIZE } from '@sim/data/VoxelModels';

export interface FlatZone {
  x: number;
  z: number;
  radius: number;
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state >>> 0;
}

export class TerrainData {
  readonly width: number;
  readonly height: number;
  private tileHeights: Uint8Array;
  private flatZones: FlatZone[];
  private maxTileHeight = 0;

  constructor(config: { width?: number; height?: number; seed?: number } = {}) {
    this.width = config.width ?? 276;
    this.height = config.height ?? 276;
    this.tileHeights = new Uint8Array(this.width * this.height);

    this.flatZones = [
      { x: 64, z: 64, radius: 15 },
      { x: 192, z: 192, radius: 15 },
      { x: 128, z: 200, radius: 15 },
    ];

    this.generate(config.seed ?? 12345);
  }

  private generate(seed: number): void {
    // Start fully flat (all zeros), then stamp discrete features
    this.paintMountainBlocks(seed);
    this.clearFlatZones();
    this.paintBorderWall();

    // Compute max height for renderer
    this.maxTileHeight = 0;
    for (let i = 0; i < this.tileHeights.length; i++) {
      if (this.tileHeights[i] > this.maxTileHeight) {
        this.maxTileHeight = this.tileHeights[i];
      }
    }
  }

  private paintMountainBlocks(seed: number): void {
    let rng = (seed * 2654435761) >>> 0 || 1;
    const next = (): number => {
      rng = xorshift32(rng);
      return rng / 0xffffffff;
    };

    const blockCount = 5 + Math.floor(next() * 4); // 5-8 blocks
    const placed: { x: number; z: number; w: number; d: number }[] = [];

    for (let b = 0; b < blockCount; b++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const bw = 10 + Math.floor(next() * 21); // 10-30 tiles width
        const bd = 10 + Math.floor(next() * 21); // 10-30 tiles depth
        const bh = 30; // match border wall height
        const bx = 15 + Math.floor(next() * (this.width - 30 - bw));
        const bz = 15 + Math.floor(next() * (this.height - 30 - bd));

        // Check clearance from flat zones
        let overlaps = false;
        for (const zone of this.flatZones) {
          const closestX = Math.max(bx, Math.min(bx + bw, zone.x));
          const closestZ = Math.max(bz, Math.min(bz + bd, zone.z));
          const dx = closestX - zone.x;
          const dz = closestZ - zone.z;
          if (Math.sqrt(dx * dx + dz * dz) < zone.radius + 20) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        // Check gap from other blocks
        for (const other of placed) {
          const gapX = Math.max(0, Math.max(bx - (other.x + other.w), other.x - (bx + bw)));
          const gapZ = Math.max(0, Math.max(bz - (other.z + other.d), other.z - (bz + bd)));
          if (gapX < 5 && gapZ < 5) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        placed.push({ x: bx, z: bz, w: bw, d: bd });

        // Paint the block
        for (let z = bz; z < bz + bd; z++) {
          for (let x = bx; x < bx + bw; x++) {
            if (x < 0 || x >= this.width || z < 0 || z >= this.height) continue;
            const idx = z * this.width + x;
            if (bh > this.tileHeights[idx]) {
              this.tileHeights[idx] = bh;
            }
          }
        }
        break;
      }
    }
  }

  private clearFlatZones(): void {
    for (const zone of this.flatZones) {
      const r = zone.radius;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r) continue;
          const tx = Math.round(zone.x + dx);
          const tz = Math.round(zone.z + dz);
          if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) continue;
          this.tileHeights[tz * this.width + tx] = 0;
        }
      }
    }
  }

  private paintBorderWall(): void {
    const BORDER_DEPTH = 5;
    const WALL_HEIGHT = 30;

    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const distToEdge = Math.min(x, z, this.width - 1 - x, this.height - 1 - z);
        if (distToEdge >= BORDER_DEPTH) continue;
        const idx = z * this.width + x;
        this.tileHeights[idx] = WALL_HEIGHT;
      }
    }
  }

  // Returns world-space height (discrete, no interpolation)
  getHeight(x: number, z: number): number {
    const tx = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    const tz = Math.max(0, Math.min(this.height - 1, Math.floor(z)));
    return this.tileHeights[tz * this.width + tx] * VOXEL_SIZE;
  }

  // Raw tile height in voxel units (for renderer)
  getTileHeight(tx: number, tz: number): number {
    tx = Math.max(0, Math.min(this.width - 1, tx));
    tz = Math.max(0, Math.min(this.height - 1, tz));
    return this.tileHeights[tz * this.width + tx];
  }

  // Max tile height across entire map (for renderer)
  getMaxHeight(): number {
    return this.maxTileHeight;
  }

  isPassable(x: number, z: number): boolean {
    return this.isFlatTile(x, z);
  }

  isFlatTile(x: number, z: number): boolean {
    const tx = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    const tz = Math.max(0, Math.min(this.height - 1, Math.floor(z)));
    return this.tileHeights[tz * this.width + tx] === 0;
  }

  getFlatZones(): ReadonlyArray<FlatZone> {
    return this.flatZones;
  }
}
