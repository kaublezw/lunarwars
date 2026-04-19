// Voxel model definitions for all entity types.
// Each model is a 3D grid (flat Uint8Array) with a color palette.
// Palette index 0 = empty, 1+ = solid with palette color.
// Special palette indices: 253 = team accent, 254 = team primary.
//
// .vox-authored models are merged in at the bottom via GeneratedVoxelModels.ts.
// Run `npm run convert-vox` to regenerate from assets/vox/.

// Generated models are merged into VOXEL_MODELS at module load (see bottom of file).
// Import is here to satisfy TS hoisting rules; Object.assign is at the bottom.
import { GENERATED_VOXEL_MODELS } from './GeneratedVoxelModels';

export const VOXEL_SIZE = 0.15; // world units per voxel

export interface VoxelModel {
  /** Grid dimensions */
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** Flat grid: index = x + z*sizeX + y*sizeX*sizeZ. Value = palette index (0=empty) */
  grid: Uint8Array;
  /** Color palette (index 0 unused). Hex colors. */
  palette: number[];
  /** Precomputed: list of [gridIndex, paletteIndex] for all solid voxels */
  solidVoxels: [number, number][];
  /** Total solid voxel count */
  totalSolid: number;
  /** Lookup: gridIndex -> solidVoxels array index (-1 if not solid) */
  gridToSolid: Int32Array;
  /** Voxels at y >= this are turret (rotate independently from body). undefined = no turret split. */
  turretMinY?: number;
  /** If set, turret voxels are turretMinY <= y <= turretMaxY instead of y >= turretMinY. */
  turretMaxY?: number;
  /** Solid voxel indices sorted bottom-to-top by Y layer, randomized within each layer */
  buildOrder: number[];
  /** Number of voxels in the lowest Y layer (revealed immediately on placement) */
  firstLayerCount: number;
}

// Palette constants for team colors (resolved at render time)
export const PAL_TEAM_PRIMARY = 254;
export const PAL_TEAM_ACCENT = 253;
export const PAL_DARK_GREY = 1;
export const PAL_MED_GREY = 2;
export const PAL_LIGHT_GREY = 3;
export const PAL_BLUE_GLOW = 4;
export const PAL_ORANGE = 5;
export const PAL_BROWN = 6;
export const PAL_CHIMNEY = 7;
export const PAL_WINDOW_GLOW = 8;
export const PAL_WHITE = 11;

// Shared palette for all models
export const SHARED_PALETTE: number[] = [];
SHARED_PALETTE[PAL_DARK_GREY] = 0x333333;
SHARED_PALETTE[PAL_MED_GREY] = 0x666666;
SHARED_PALETTE[PAL_LIGHT_GREY] = 0x999999;
SHARED_PALETTE[PAL_BLUE_GLOW] = 0x66ccff;
SHARED_PALETTE[PAL_ORANGE] = 0xff8833;
SHARED_PALETTE[PAL_BROWN] = 0x554433;
SHARED_PALETTE[PAL_CHIMNEY] = 0x777777;
SHARED_PALETTE[PAL_WINDOW_GLOW] = 0x66ccff;
SHARED_PALETTE[PAL_WHITE] = 0xffffff;
SHARED_PALETTE[PAL_TEAM_PRIMARY] = 0xffffff; // placeholder, resolved at render
SHARED_PALETTE[PAL_TEAM_ACCENT] = 0xffffff; // placeholder, resolved at render

/** Deterministic integer hash for pseudo-random ordering */
function intHash(n: number): number {
  n = ((n >> 16) ^ n) * 0x45d9f3b | 0;
  n = ((n >> 16) ^ n) * 0x45d9f3b | 0;
  n = (n >> 16) ^ n;
  return n;
}

/** Convert grid coords to flat index */
function idx(x: number, y: number, z: number, sx: number, sz: number): number {
  return x + z * sx + y * sx * sz;
}

/** Fill a box region in the grid with a palette index */
function fillBox(
  grid: Uint8Array, sx: number, sz: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  palIdx: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        grid[idx(x, y, z, sx, sz)] = palIdx;
      }
    }
  }
}

/** Fill a cylinder (Y-axis) in the grid */
function fillCylinder(
  grid: Uint8Array, sx: number, sz: number,
  cx: number, cz: number, radius: number,
  y0: number, y1: number,
  palIdx: number,
): void {
  const r2 = radius * radius;
  for (let y = y0; y <= y1; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz <= r2) {
          grid[idx(x, y, z, sx, sz)] = palIdx;
        }
      }
    }
  }
}

/** Build solidVoxels list from grid */
function buildSolidList(grid: Uint8Array): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 0) {
      result.push([i, grid[i]]);
    }
  }
  return result;
}

function createModel(sx: number, sy: number, sz: number, buildFn: (grid: Uint8Array, sx: number, sy: number, sz: number) => void, turretMinY?: number, turretMaxY?: number): VoxelModel {
  const grid = new Uint8Array(sx * sy * sz);
  buildFn(grid, sx, sy, sz);
  const solidVoxels = buildSolidList(grid);

  // Build gridIndex -> solidIndex lookup
  const gridToSolid = new Int32Array(grid.length);
  gridToSolid.fill(-1);
  for (let si = 0; si < solidVoxels.length; si++) {
    gridToSolid[solidVoxels[si][0]] = si;
  }

  // Build bottom-to-top order for progressive construction reveal
  // Sorted by Y layer ascending, pseudo-randomized within each layer
  const buildOrder: number[] = [];
  for (let si = 0; si < solidVoxels.length; si++) {
    buildOrder.push(si);
  }
  buildOrder.sort((a, b) => {
    const giA = solidVoxels[a][0];
    const giB = solidVoxels[b][0];
    const yA = Math.floor(giA / (sx * sz));
    const yB = Math.floor(giB / (sx * sz));
    if (yA !== yB) return yA - yB;
    return intHash(giA) - intHash(giB);
  });

  // Count voxels in the lowest Y layer
  let firstLayerCount = 0;
  if (buildOrder.length > 0) {
    const firstGi = solidVoxels[buildOrder[0]][0];
    const firstY = Math.floor(firstGi / (sx * sz));
    for (let i = 0; i < buildOrder.length; i++) {
      const gi = solidVoxels[buildOrder[i]][0];
      if (Math.floor(gi / (sx * sz)) !== firstY) break;
      firstLayerCount++;
    }
  }

  return { sizeX: sx, sizeY: sy, sizeZ: sz, grid, palette: SHARED_PALETTE, solidVoxels, totalSolid: solidVoxels.length, gridToSolid, turretMinY, turretMaxY, buildOrder, firstLayerCount };
}

// --- Unit Models ---

export const COMBAT_DRONE_MODEL = createModel(3, 7, 3, (g, sx, _sy, sz) => {
  // Legs
  fillBox(g, sx, sz, 0, 0, 1, 0, 1, 1, PAL_MED_GREY);
  fillBox(g, sx, sz, 2, 0, 1, 2, 1, 1, PAL_MED_GREY);
  // Body
  fillBox(g, sx, sz, 0, 2, 0, 2, 3, 2, PAL_TEAM_PRIMARY);
  // Head
  fillBox(g, sx, sz, 0, 4, 0, 2, 5, 2, PAL_TEAM_ACCENT);
  // Weapon arm
  fillBox(g, sx, sz, 2, 2, 1, 2, 3, 1, PAL_DARK_GREY);
  // Barrel (turret) — 3 voxels along Z at y=6
  fillBox(g, sx, sz, 1, 6, 0, 1, 6, 2, PAL_DARK_GREY);
}, 6);

export const ASSAULT_PLATFORM_MODEL = createModel(10, 6, 14, (g, sx, _sy, sz) => {
  // Treads: left and right
  fillBox(g, sx, sz, 0, 0, 0, 1, 1, 13, PAL_DARK_GREY);
  fillBox(g, sx, sz, 8, 0, 0, 9, 1, 13, PAL_DARK_GREY);
  // Hull body
  fillBox(g, sx, sz, 2, 1, 1, 7, 3, 12, PAL_TEAM_PRIMARY);
  // Turret base
  fillBox(g, sx, sz, 3, 4, 4, 6, 5, 9, PAL_TEAM_ACCENT);
  // Barrel
  fillBox(g, sx, sz, 4, 4, 10, 5, 5, 13, PAL_MED_GREY);
  // Front armor
  fillBox(g, sx, sz, 2, 2, 12, 7, 3, 13, PAL_TEAM_ACCENT);
}, 4);

export const AERIAL_DRONE_MODEL = createModel(12, 4, 12, (g, sx, _sy, sz) => {
  // Belly gun turret (y=0, 3 voxels forward)
  fillBox(g, sx, sz, 6, 0, 5, 6, 0, 7, PAL_DARK_GREY);
  // Engine pods
  fillBox(g, sx, sz, 1, 1, 4, 2, 1, 7, PAL_DARK_GREY);
  fillBox(g, sx, sz, 9, 1, 4, 10, 1, 7, PAL_DARK_GREY);
  // Central body
  fillBox(g, sx, sz, 4, 2, 4, 7, 3, 7, PAL_TEAM_PRIMARY);
  // Wings
  fillBox(g, sx, sz, 0, 2, 5, 3, 2, 6, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 8, 2, 5, 11, 2, 6, PAL_TEAM_ACCENT);
  // Nose
  fillBox(g, sx, sz, 5, 2, 8, 6, 2, 11, PAL_MED_GREY);
  // Tail
  fillBox(g, sx, sz, 5, 2, 0, 6, 3, 3, PAL_TEAM_ACCENT);
}, 0, 0);

export const WORKER_DRONE_MODEL = createModel(8, 6, 8, (g, sx, _sy, sz) => {
  // Boxy body
  fillBox(g, sx, sz, 1, 1, 1, 6, 4, 6, PAL_TEAM_PRIMARY);
  // Legs
  fillBox(g, sx, sz, 1, 0, 2, 2, 1, 3, PAL_MED_GREY);
  fillBox(g, sx, sz, 5, 0, 2, 6, 1, 3, PAL_MED_GREY);
  fillBox(g, sx, sz, 1, 0, 4, 2, 1, 5, PAL_MED_GREY);
  fillBox(g, sx, sz, 5, 0, 4, 6, 1, 5, PAL_MED_GREY);
  // Tool arm
  fillBox(g, sx, sz, 7, 2, 3, 7, 3, 4, PAL_ORANGE);
  // Top sensor
  fillBox(g, sx, sz, 3, 5, 3, 4, 5, 4, PAL_TEAM_ACCENT);
});

// --- Building Models ---

export const HQ_MODEL = createModel(27, 38, 27, (g, sx, _sy, sz) => {
  // Wide base platform
  fillBox(g, sx, sz, 0, 0, 0, 26, 3, 26, PAL_DARK_GREY);
  // Main building block
  fillBox(g, sx, sz, 3, 4, 3, 23, 14, 23, PAL_TEAM_PRIMARY);
  // Command tower
  fillBox(g, sx, sz, 8, 15, 8, 18, 28, 18, PAL_TEAM_ACCENT);
  // Antenna spire
  fillCylinder(g, sx, sz, 13, 13, 1, 29, 35, PAL_LIGHT_GREY);
  // Windows row
  fillBox(g, sx, sz, 5, 10, 3, 21, 11, 3, PAL_BLUE_GLOW);
  fillBox(g, sx, sz, 5, 10, 23, 21, 11, 23, PAL_BLUE_GLOW);
  // Energy receiver cap on top of antenna spire
  fillCylinder(g, sx, sz, 13, 13, 1.5, 36, 37, PAL_BLUE_GLOW);
  // Garage door opening on +Z face (front-left in isometric view)
  fillBox(g, sx, sz, 9, 1, 23, 17, 9, 26, 0);
  // Interior bay for depth
  fillBox(g, sx, sz, 10, 1, 20, 16, 8, 22, 0);
});

export const ENERGY_EXTRACTOR_MODEL = createModel(10, 38, 10, (g, sx, _sy, sz) => {
  // Hexagonal base (approximated as cylinder)
  fillCylinder(g, sx, sz, 5, 5, 5, 0, 8, PAL_DARK_GREY);
  // Inner column
  fillCylinder(g, sx, sz, 5, 5, 2, 0, 12, PAL_TEAM_PRIMARY);
  // Glowing orb
  fillCylinder(g, sx, sz, 5, 5, 3, 13, 16, PAL_BLUE_GLOW);
  // Ring at mid height
  fillCylinder(g, sx, sz, 5, 5, 4.5, 6, 7, PAL_TEAM_ACCENT);
  // Transmission spire reaching HQ antenna height
  fillCylinder(g, sx, sz, 5, 5, 1, 17, 35, PAL_LIGHT_GREY);
  // Support ring at mid-spire
  fillCylinder(g, sx, sz, 5, 5, 2, 26, 27, PAL_TEAM_ACCENT);
  // Glowing emitter cap (energy packets originate here)
  fillCylinder(g, sx, sz, 5, 5, 1.5, 36, 37, PAL_BLUE_GLOW);
});

export const MATTER_PLANT_MODEL = createModel(20, 14, 20, (g, sx, _sy, sz) => {
  // Main body
  fillBox(g, sx, sz, 0, 0, 0, 19, 8, 19, PAL_DARK_GREY);
  // Upper section
  fillBox(g, sx, sz, 2, 9, 2, 17, 10, 17, PAL_TEAM_PRIMARY);
  // Chimney
  fillBox(g, sx, sz, 15, 0, 15, 19, 13, 19, PAL_CHIMNEY);
  // Vent
  fillBox(g, sx, sz, 16, 11, 16, 18, 13, 18, PAL_DARK_GREY);
  // Side panels
  fillBox(g, sx, sz, 0, 3, 0, 0, 7, 19, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 19, 3, 0, 19, 7, 19, PAL_TEAM_ACCENT);
  // Windows — glow is power-conditional
  // +Z face (z=19, avoiding chimney at x=15-19)
  fillBox(g, sx, sz, 4, 5, 19, 6, 6, 19, PAL_WINDOW_GLOW);
  fillBox(g, sx, sz, 10, 5, 19, 12, 6, 19, PAL_WINDOW_GLOW);
  // +X face (x=19, within side accent panel)
  fillBox(g, sx, sz, 19, 5, 4, 19, 6, 6, PAL_WINDOW_GLOW);
  fillBox(g, sx, sz, 19, 5, 10, 19, 6, 12, PAL_WINDOW_GLOW);
});

export const SUPPLY_DEPOT_MODEL = createModel(24, 14, 24, (g, sx, _sy, sz) => {
  // Foundation slab
  fillBox(g, sx, sz, 0, 0, 0, 23, 1, 23, PAL_DARK_GREY);
  // Warehouse walls (outer shell)
  fillBox(g, sx, sz, 2, 2, 2, 21, 8, 21, PAL_MED_GREY);
  // Hollow interior
  fillBox(g, sx, sz, 4, 2, 4, 19, 8, 19, 0);
  // Flat roof
  fillBox(g, sx, sz, 1, 9, 1, 22, 9, 22, PAL_TEAM_PRIMARY);
  // Roof edge accent trim
  fillBox(g, sx, sz, 1, 9, 1, 22, 9, 1, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 1, 9, 22, 22, 9, 22, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 1, 9, 2, 1, 9, 21, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 22, 9, 2, 22, 9, 21, PAL_TEAM_ACCENT);
  // Loading bay opening (+Z face)
  fillBox(g, sx, sz, 7, 2, 21, 16, 7, 21, 0);
  // Interior crate stacks (visible through loading bay)
  fillBox(g, sx, sz, 5, 2, 5, 8, 6, 9, PAL_BROWN);
  fillBox(g, sx, sz, 15, 2, 5, 18, 5, 9, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 5, 2, 14, 9, 4, 18, PAL_BROWN);
  // Corner crane tower
  fillBox(g, sx, sz, 20, 2, 0, 23, 13, 3, PAL_LIGHT_GREY);
  fillBox(g, sx, sz, 20, 12, 0, 23, 13, 3, PAL_TEAM_ACCENT);
  // Crane arm extending over roof
  fillBox(g, sx, sz, 12, 12, 1, 19, 12, 2, PAL_LIGHT_GREY);
  // Center marker on platform
  fillBox(g, sx, sz, 10, 1, 10, 13, 1, 13, PAL_TEAM_PRIMARY);
  // Windows — glow is power-conditional
  // +Z face (z=21, flanking loading bay opening at x=7-16)
  fillBox(g, sx, sz, 3, 4, 21, 5, 6, 21, PAL_WINDOW_GLOW);
  fillBox(g, sx, sz, 18, 4, 21, 20, 6, 21, PAL_WINDOW_GLOW);
  // +X face (x=21)
  fillBox(g, sx, sz, 21, 4, 5, 21, 6, 7, PAL_WINDOW_GLOW);
  fillBox(g, sx, sz, 21, 4, 14, 21, 6, 16, PAL_WINDOW_GLOW);
});

export const DRONE_FACTORY_MODEL = createModel(32, 22, 32, (g, sx, _sy, sz) => {
  // Main body (lower section)
  fillBox(g, sx, sz, 0, 0, 0, 31, 12, 31, PAL_MED_GREY);
  // Upper hull
  fillBox(g, sx, sz, 2, 13, 2, 29, 17, 29, PAL_TEAM_PRIMARY);
  // Tower (left side)
  fillBox(g, sx, sz, 1, 0, 10, 5, 20, 21, PAL_TEAM_ACCENT);
  // Dish on top of tower
  fillCylinder(g, sx, sz, 3, 16, 4, 18, 21, PAL_LIGHT_GREY);
  // Roof stripe
  fillBox(g, sx, sz, 5, 17, 5, 26, 17, 26, PAL_TEAM_ACCENT);
  // Side garage opening on +Z face (14 wide x 10 tall — fits assault platform)
  fillBox(g, sx, sz, 9, 1, 31, 22, 10, 31, 0);
  // Interior bay behind side garage (indented 4 deep)
  fillBox(g, sx, sz, 10, 1, 27, 21, 10, 30, 0);
  // Roof hatch opening (16x16 — fits aerial drone 12x12)
  fillBox(g, sx, sz, 8, 13, 8, 23, 17, 23, 0);
  // Roof hatch interior bay (indented 2 voxels below the opening)
  fillBox(g, sx, sz, 9, 11, 9, 22, 12, 22, 0);
  // Windows — glow is power-conditional
  // +Z face (z=31, flanking garage opening)
  fillBox(g, sx, sz, 3, 6, 31, 6, 8, 31, PAL_WINDOW_GLOW);
  fillBox(g, sx, sz, 25, 6, 31, 28, 8, 31, PAL_WINDOW_GLOW);
  // +X face (x=31)
  fillBox(g, sx, sz, 31, 6, 4, 31, 8, 7, PAL_WINDOW_GLOW);
  fillBox(g, sx, sz, 31, 6, 24, 31, 8, 27, PAL_WINDOW_GLOW);
});

export const CONSTRUCTION_SITE_MODEL = createModel(14, 4, 14, (g, sx, _sy, sz) => {
  // Foundation slab
  fillBox(g, sx, sz, 0, 0, 0, 13, 1, 13, PAL_MED_GREY);
  // Scaffolding corners
  fillBox(g, sx, sz, 0, 2, 0, 0, 3, 0, PAL_ORANGE);
  fillBox(g, sx, sz, 13, 2, 0, 13, 3, 0, PAL_ORANGE);
  fillBox(g, sx, sz, 0, 2, 13, 0, 3, 13, PAL_ORANGE);
  fillBox(g, sx, sz, 13, 2, 13, 13, 3, 13, PAL_ORANGE);
  // Cross beams
  fillBox(g, sx, sz, 1, 3, 0, 12, 3, 0, PAL_ORANGE);
  fillBox(g, sx, sz, 1, 3, 13, 12, 3, 13, PAL_ORANGE);
  fillBox(g, sx, sz, 0, 3, 1, 0, 3, 12, PAL_ORANGE);
  fillBox(g, sx, sz, 13, 3, 1, 13, 3, 12, PAL_ORANGE);
});

// Wall segment aligned along X axis: 20 long (X), 10 tall (Y), 5 deep (Z)
export const WALL_X_MODEL = createModel(20, 10, 5, (g, sx, _sy, sz) => {
  // Main wall body
  fillBox(g, sx, sz, 0, 0, 0, 19, 9, 4, PAL_TEAM_PRIMARY);
  // Base reinforcement
  fillBox(g, sx, sz, 0, 0, 0, 19, 1, 4, PAL_DARK_GREY);
  // Top crenellation pattern (every 4 voxels)
  for (let x = 0; x < 20; x += 4) {
    fillBox(g, sx, sz, x, 8, 0, Math.min(x + 1, 19), 9, 4, PAL_TEAM_ACCENT);
  }
});

// Wall segment aligned along Z axis: 5 deep (X), 10 tall (Y), 20 long (Z)
export const WALL_Z_MODEL = createModel(5, 10, 20, (g, sx, _sy, sz) => {
  // Main wall body
  fillBox(g, sx, sz, 0, 0, 0, 4, 9, 19, PAL_TEAM_PRIMARY);
  // Base reinforcement
  fillBox(g, sx, sz, 0, 0, 0, 4, 1, 19, PAL_DARK_GREY);
  // Top crenellation pattern (every 4 voxels)
  for (let z = 0; z < 20; z += 4) {
    fillBox(g, sx, sz, 0, 8, z, 4, 9, Math.min(z + 1, 19), PAL_TEAM_ACCENT);
  }
});

// Wall corner piece: 5x10x5 pillar (matches wall cross-section, connects perpendicular segments)
export const WALL_CORNER_MODEL = createModel(5, 10, 5, (g, sx, _sy, sz) => {
  // Main body
  fillBox(g, sx, sz, 0, 0, 0, 4, 9, 4, PAL_TEAM_PRIMARY);
  // Base reinforcement
  fillBox(g, sx, sz, 0, 0, 0, 4, 1, 4, PAL_DARK_GREY);
  // Top accent
  fillBox(g, sx, sz, 0, 8, 0, 1, 9, 1, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 4, 8, 0, 4, 9, 1, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 0, 8, 4, 1, 9, 4, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 4, 8, 4, 4, 9, 4, PAL_TEAM_ACCENT);
});

export const ENERGY_PACKET_MODEL = createModel(2, 2, 2, (g, sx, _sy, sz) => {
  fillBox(g, sx, sz, 0, 0, 0, 1, 1, 1, PAL_BLUE_GLOW);
});

export const MATTER_PACKET_MODEL = createModel(2, 2, 2, (g, sx, _sy, sz) => {
  fillBox(g, sx, sz, 0, 0, 0, 1, 1, 1, PAL_DARK_GREY);
});

// Garage door model (7 wide x 8 tall x 1 deep) — renderer-managed, not ECS-managed
export const GARAGE_DOOR_MODEL = createModel(7, 8, 1, (g, sx, _sy, sz) => {
  fillBox(g, sx, sz, 0, 0, 0, 6, 7, 0, PAL_WHITE);
});

// Factory side garage door (14 wide x 10 tall x 1 deep) — fits assault platform
export const FACTORY_DOOR_MODEL = createModel(14, 10, 1, (g, sx, _sy, sz) => {
  fillBox(g, sx, sz, 0, 0, 0, 13, 9, 0, PAL_WHITE);
});

// Factory roof hatch (16 wide x 1 tall x 16 deep) — fits aerial drone
export const FACTORY_ROOF_DOOR_MODEL = createModel(16, 1, 16, (g, sx, _sy, sz) => {
  fillBox(g, sx, sz, 0, 0, 0, 15, 0, 15, PAL_TEAM_ACCENT);
});

// --- Power pole: 4x12x4 voxels (0.6 x 1.8 x 0.6 wu) ---
const POWER_POLE_MODEL = createModel(4, 12, 4, (g, sx, _sy, sz) => {
  // Base plate
  fillBox(g, sx, sz, 0, 0, 0, 3, 0, 3, PAL_DARK_GREY);
  // Central shaft (2x2)
  fillBox(g, sx, sz, 1, 1, 1, 2, 9, 2, PAL_MED_GREY);
  // Cross-arm at top
  fillBox(g, sx, sz, 0, 10, 1, 3, 10, 2, PAL_LIGHT_GREY);
  // Team-color accent tips
  fillBox(g, sx, sz, 0, 11, 1, 0, 11, 2, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 3, 11, 1, 3, 11, 2, PAL_TEAM_ACCENT);
});

// --- Train Models ---

// Train engine: 8x5x12 — compact hover locomotive with reactor glow
export const TRAIN_ENGINE_MODEL = createModel(8, 5, 12, (g, sx, _sy, sz) => {
  // Hover skids (side runners)
  fillBox(g, sx, sz, 0, 0, 0, 0, 0, 11, PAL_DARK_GREY);
  fillBox(g, sx, sz, 7, 0, 0, 7, 0, 11, PAL_DARK_GREY);
  // Undercarriage between skids
  fillBox(g, sx, sz, 1, 0, 1, 6, 0, 10, PAL_MED_GREY);
  // Main hull
  fillBox(g, sx, sz, 0, 1, 0, 7, 3, 11, PAL_TEAM_PRIMARY);
  // Side accent stripes
  fillBox(g, sx, sz, 0, 3, 1, 0, 3, 10, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 7, 3, 1, 7, 3, 10, PAL_TEAM_ACCENT);
  // Side vents (dark grey cutouts)
  fillBox(g, sx, sz, 0, 2, 3, 0, 2, 5, PAL_DARK_GREY);
  fillBox(g, sx, sz, 7, 2, 3, 7, 2, 5, PAL_DARK_GREY);
  // Cockpit cabin (raised front)
  fillBox(g, sx, sz, 1, 4, 6, 6, 4, 10, PAL_TEAM_ACCENT);
  // Windshield (front face)
  fillBox(g, sx, sz, 2, 3, 11, 5, 4, 11, PAL_BLUE_GLOW);
  // Engine housing (rear top)
  fillBox(g, sx, sz, 2, 4, 1, 5, 4, 4, PAL_DARK_GREY);
  // Reactor exhaust glow (rear face)
  fillBox(g, sx, sz, 2, 1, 0, 5, 2, 0, PAL_BLUE_GLOW);
});

// Cargo car: 8x5x12 — open-top hovering freight container
// Interior PAL_ORANGE voxels represent matter cargo (shown/hidden by cargo fill system)
export const CARGO_CAR_MODEL = createModel(8, 5, 12, (g, sx, _sy, sz) => {
  // Hover skids
  fillBox(g, sx, sz, 0, 0, 0, 0, 0, 11, PAL_DARK_GREY);
  fillBox(g, sx, sz, 7, 0, 0, 7, 0, 11, PAL_DARK_GREY);
  // Flatbed platform between skids
  fillBox(g, sx, sz, 1, 0, 0, 6, 0, 11, PAL_MED_GREY);
  // Container walls (open top)
  fillBox(g, sx, sz, 0, 1, 0, 0, 4, 11, PAL_TEAM_PRIMARY); // left
  fillBox(g, sx, sz, 7, 1, 0, 7, 4, 11, PAL_TEAM_PRIMARY); // right
  fillBox(g, sx, sz, 1, 1, 0, 6, 4, 0, PAL_TEAM_PRIMARY);  // back
  fillBox(g, sx, sz, 1, 1, 11, 6, 4, 11, PAL_TEAM_PRIMARY); // front
  // Container floor
  fillBox(g, sx, sz, 1, 1, 1, 6, 1, 10, PAL_DARK_GREY);
  // Top edge accent trim
  fillBox(g, sx, sz, 0, 4, 0, 0, 4, 11, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 7, 4, 0, 7, 4, 11, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 1, 4, 0, 6, 4, 0, PAL_TEAM_ACCENT);
  fillBox(g, sx, sz, 1, 4, 11, 6, 4, 11, PAL_TEAM_ACCENT);
  // Cargo matter — interior fill (hidden when empty, revealed as cargo loads)
  fillBox(g, sx, sz, 1, 2, 1, 6, 3, 10, PAL_ORANGE);
});

// --- Power pole ruin: 4x2x4 voxels (broken base stub) ---
const POWER_POLE_RUIN_MODEL = createModel(4, 2, 4, (g, sx, _sy, sz) => {
  // Broken base
  fillBox(g, sx, sz, 0, 0, 0, 3, 0, 3, PAL_DARK_GREY);
  // Stub remnants
  fillBox(g, sx, sz, 1, 1, 1, 2, 1, 2, PAL_MED_GREY);
});

// Map meshType -> VoxelModel
export const VOXEL_MODELS: Record<string, VoxelModel> = {
  combat_drone: COMBAT_DRONE_MODEL,
  assault_platform: ASSAULT_PLATFORM_MODEL,
  aerial_drone: AERIAL_DRONE_MODEL,
  worker_drone: WORKER_DRONE_MODEL,
  hq: HQ_MODEL,
  energy_extractor: ENERGY_EXTRACTOR_MODEL,
  matter_plant: MATTER_PLANT_MODEL,
  supply_depot: SUPPLY_DEPOT_MODEL,
  drone_factory: DRONE_FACTORY_MODEL,
  construction_site: CONSTRUCTION_SITE_MODEL,
  wall_x: WALL_X_MODEL,
  wall_z: WALL_Z_MODEL,
  wall_corner: WALL_CORNER_MODEL,
  energy_packet: ENERGY_PACKET_MODEL,
  matter_packet: MATTER_PACKET_MODEL,
  train_engine: TRAIN_ENGINE_MODEL,
  cargo_car: CARGO_CAR_MODEL,
  power_pole: POWER_POLE_MODEL,
  power_pole_ruin: POWER_POLE_RUIN_MODEL,
};

/** Get the world-space bounding box dimensions for a voxel model */
export function getModelWorldSize(model: VoxelModel): { width: number; height: number; depth: number } {
  return {
    width: model.sizeX * VOXEL_SIZE,
    height: model.sizeY * VOXEL_SIZE,
    depth: model.sizeZ * VOXEL_SIZE,
  };
}

/** Convert flat grid index back to x,y,z coords */
export function indexToCoords(index: number, sx: number, sz: number): [number, number, number] {
  const y = Math.floor(index / (sx * sz));
  const rem = index % (sx * sz);
  const z = Math.floor(rem / sx);
  const x = rem % sx;
  return [x, y, z];
}

// Merge .vox-sourced models — generated models take precedence over hand-authored ones above.
// Generated by `npm run convert-vox` from assets/vox/.
Object.assign(VOXEL_MODELS, GENERATED_VOXEL_MODELS);
