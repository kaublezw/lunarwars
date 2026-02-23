import { createNoise2D } from './SimplexNoise';

export interface FlatZone {
  x: number;
  z: number;
  radius: number;
}

// Each height level = 1.5 world units of elevation
// Tile heights range from -2 to 3 (world heights -3.0 to 4.5)
const TILE_ELEVATION = 1.5;

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state >>> 0;
}

export class TerrainData {
  readonly width: number;
  readonly height: number;
  private tileHeights: Int8Array;
  private flatZones: FlatZone[];

  constructor(config: { width?: number; height?: number; seed?: number } = {}) {
    this.width = config.width ?? 256;
    this.height = config.height ?? 256;
    this.tileHeights = new Int8Array(this.width * this.height);

    this.flatZones = [
      { x: 64, z: 64, radius: 15 },
      { x: 192, z: 192, radius: 15 },
      { x: 128, z: 200, radius: 15 },
    ];

    this.generate(config.seed ?? 12345);
  }

  private generate(seed: number): void {
    // Start fully flat (all zeros), then stamp discrete features
    this.paintMountainRanges(seed);
    this.paintCraters(seed);
    this.clearFlatZones();
  }

  private paintMountainRanges(seed: number): void {
    const ranges = [
      // NW to center-east ridge
      { sx: 15, sz: 40, ex: 120, ez: 100, hw: 3, peak: 3, ns: seed },
      // Center-west to SE ridge
      { sx: 140, sz: 30, ex: 240, ez: 150, hw: 3, peak: 3, ns: seed + 100 },
      // Short central ridge
      { sx: 90, sz: 150, ex: 170, ez: 130, hw: 2, peak: 2, ns: seed + 200 },
    ];

    for (const r of ranges) {
      this.paintRange(r.sx, r.sz, r.ex, r.ez, r.hw, r.peak, r.ns);
    }
  }

  private paintRange(
    sx: number, sz: number, ex: number, ez: number,
    halfWidth: number, peakHeight: number, noiseSeed: number,
  ): void {
    const noise = createNoise2D(noiseSeed);
    const dx = ex - sx;
    const dz = ez - sz;
    const length = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.ceil(length);

    // Perpendicular direction for wobble
    const perpX = -dz / length;
    const perpZ = dx / length;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const wobble = noise(t * 3, 0.5) * 10;
      const cx = sx + dx * t + perpX * wobble;
      const cz = sz + dz * t + perpZ * wobble;

      const brushR = halfWidth + 2;
      for (let bz = -brushR; bz <= brushR; bz++) {
        for (let bx = -brushR; bx <= brushR; bx++) {
          const tx = Math.round(cx + bx);
          const tz = Math.round(cz + bz);
          if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) continue;

          const dist = Math.sqrt(bx * bx + bz * bz);
          let h = 0;
          if (dist <= halfWidth) h = peakHeight;
          else if (dist <= halfWidth + 1) h = Math.max(1, peakHeight - 1);
          else if (dist <= halfWidth + 2) h = 1;
          else continue;

          const idx = tz * this.width + tx;
          if (h > this.tileHeights[idx]) {
            this.tileHeights[idx] = h;
          }
        }
      }
    }
  }

  private paintCraters(seed: number): void {
    let rng = (seed * 7919) >>> 0 || 1;
    const next = (): number => {
      rng = xorshift32(rng);
      return rng / 0xffffffff;
    };

    const craterCount = 5;
    const placed: { cx: number; cz: number; radius: number }[] = [];

    for (let c = 0; c < craterCount; c++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const cx = 20 + next() * 216;
        const cz = 20 + next() * 216;
        const radius = 8 + next() * 12; // 8-20 tiles

        // No overlap with flat zones
        let overlaps = false;
        for (const zone of this.flatZones) {
          const ddx = cx - zone.x;
          const ddz = cz - zone.z;
          if (Math.sqrt(ddx * ddx + ddz * ddz) < zone.radius + radius + 5) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        // No overlap with other craters
        for (const other of placed) {
          const ddx = cx - other.cx;
          const ddz = cz - other.cz;
          if (Math.sqrt(ddx * ddx + ddz * ddz) < other.radius + radius + 5) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        placed.push({ cx, cz, radius });
        this.paintCrater(cx, cz, radius);
        break;
      }
    }
  }

  private paintCrater(cx: number, cz: number, radius: number): void {
    const extent = Math.ceil(radius);
    for (let dz = -extent; dz <= extent; dz++) {
      for (let dx = -extent; dx <= extent; dx++) {
        const tx = Math.round(cx + dx);
        const tz = Math.round(cz + dz);
        if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) continue;

        const dist = Math.sqrt(dx * dx + dz * dz);
        const r = dist / radius;
        const idx = tz * this.width + tx;

        // Don't carve craters into mountain tiles
        if (this.tileHeights[idx] > 1) continue;

        if (r <= 0.5) {
          this.tileHeights[idx] = -2;
        } else if (r <= 0.75) {
          this.tileHeights[idx] = -1;
        } else if (r <= 1.0) {
          // Rim — only raise flat or lower tiles
          if (this.tileHeights[idx] <= 0) {
            this.tileHeights[idx] = 1;
          }
        }
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

  // Returns world-space height with bilinear interpolation between tiles
  getHeight(x: number, z: number): number {
    x = Math.max(0, Math.min(this.width - 1, x));
    z = Math.max(0, Math.min(this.height - 1, z));

    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;

    const ix1 = Math.min(ix + 1, this.width - 1);
    const iz1 = Math.min(iz + 1, this.height - 1);
    const w = this.width;

    const h00 = this.tileHeights[iz * w + ix];
    const h10 = this.tileHeights[iz * w + ix1];
    const h01 = this.tileHeights[iz1 * w + ix];
    const h11 = this.tileHeights[iz1 * w + ix1];

    const h0 = h00 + (h10 - h00) * fx;
    const h1 = h01 + (h11 - h01) * fx;
    return (h0 + (h1 - h0) * fz) * TILE_ELEVATION;
  }

  // Central-difference gradient magnitude
  getSlope(x: number, z: number): number {
    const hL = this.getHeight(x - 1, z);
    const hR = this.getHeight(x + 1, z);
    const hD = this.getHeight(x, z - 1);
    const hU = this.getHeight(x, z + 1);

    const dx = (hR - hL) * 0.5;
    const dz = (hU - hD) * 0.5;
    return Math.sqrt(dx * dx + dz * dz);
  }

  isPassable(x: number, z: number): boolean {
    return this.getSlope(x, z) < 3.0;
  }

  getMovementCost(x: number, z: number): number {
    return 1.0 + this.getSlope(x, z) * 0.5;
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
