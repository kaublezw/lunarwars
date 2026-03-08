import type { World } from '@core/ECS';
import { BUILDING, POSITION } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';

// Building footprint radii by meshType (in tiles)
const FOOTPRINT_RADIUS: Record<string, number> = {
  hq: 2,
  energy_extractor: 1,
  matter_plant: 2,
  supply_depot: 1,
  drone_factory: 2,
  construction_site: 1,
};

// Rectangular footprints for axis-aligned structures (walls)
const FOOTPRINT_RECT: Record<string, { halfX: number; halfZ: number }> = {
  wall_x: { halfX: 1, halfZ: 0 },
  wall_z: { halfX: 0, halfZ: 1 },
  wall_corner: { halfX: 1, halfZ: 1 },
};

export class BuildingOccupancy {
  private grid: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(width: number = 256, height: number = 256) {
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height);
  }

  update(world: World): void {
    this.grid.fill(0);

    const buildings = world.query(BUILDING, POSITION);
    for (const e of buildings) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const renderable = world.getComponent<{ meshType: string }>(e, 'Renderable');
      const meshType = renderable?.meshType ?? 'construction_site';
      const cx = Math.floor(pos.x);
      const cz = Math.floor(pos.z);

      const rect = FOOTPRINT_RECT[meshType];
      if (rect) {
        for (let dz = -rect.halfZ; dz <= rect.halfZ; dz++) {
          for (let dx = -rect.halfX; dx <= rect.halfX; dx++) {
            const tx = cx + dx;
            const tz = cz + dz;
            if (tx >= 0 && tx < this.width && tz >= 0 && tz < this.height) {
              this.grid[tz * this.width + tx] = 1;
            }
          }
        }
      } else {
        const radius = FOOTPRINT_RADIUS[meshType] ?? 1;
        const isHQ = meshType === 'hq';
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            // Leave a 3-tile-wide corridor on +Z face for HQ garage door
            if (isHQ && dx >= -1 && dx <= 1 && dz > 0) continue;
            const tx = cx + dx;
            const tz = cz + dz;
            if (tx >= 0 && tx < this.width && tz >= 0 && tz < this.height) {
              this.grid[tz * this.width + tx] = 1;
            }
          }
        }
      }
    }
  }

  isBlocked(tx: number, tz: number): boolean {
    const ix = Math.floor(tx);
    const iz = Math.floor(tz);
    if (ix < 0 || ix >= this.width || iz < 0 || iz >= this.height) return false;
    return this.grid[iz * this.width + ix] === 1;
  }
}
