import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { VOXEL_SIZE } from '@sim/data/VoxelModels';

// Terrain palette (0 = empty)
const PAL_FLOOR = 1;
const PAL_MOUNTAIN = 2;
const PAL_BORDER = 3;

const PALETTE_COLORS: Record<number, number> = {
  [PAL_FLOOR]: 0x4a4a4a,
  [PAL_MOUNTAIN]: 0x5a5a5a,
  [PAL_BORDER]: 0x2a2a2a,
};

// Top faces get a lighter shade
const PALETTE_TOP_COLORS: Record<number, number> = {
  [PAL_FLOOR]: 0x555555,
  [PAL_MOUNTAIN]: 0x666666,
  [PAL_BORDER]: 0x333333,
};

// Chunk size in tiles
const CHUNK_TILES = 32;

// Border wall height threshold (tiles with height >= this are border)
const BORDER_HEIGHT = 30;

// Face normals for 6 directions: +X, -X, +Y, -Y, +Z, -Z
const FACE_NORMALS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

const FACE_INFO: {
  uAxis: number; vAxis: number; normalAxis: number; nDir: number;
}[] = [
  { uAxis: 2, vAxis: 1, normalAxis: 0, nDir: 1 },  // +X
  { uAxis: 2, vAxis: 1, normalAxis: 0, nDir: -1 }, // -X
  { uAxis: 0, vAxis: 2, normalAxis: 1, nDir: 1 },  // +Y
  { uAxis: 0, vAxis: 2, normalAxis: 1, nDir: -1 }, // -Y
  { uAxis: 0, vAxis: 1, normalAxis: 2, nDir: 1 },  // +Z
  { uAxis: 0, vAxis: 1, normalAxis: 2, nDir: -1 }, // -Z
];

const FLIP_WINDING = [true, false, true, false, false, true];

interface ChunkData {
  mesh: THREE.Mesh;
  startTileX: number;
  startTileZ: number;
  tilesX: number;
  tilesZ: number;
  solidCount: number;
  destroyed: Uint8Array;
  dirty: boolean;
}

const _color = new THREE.Color();

export class TerrainVoxelRenderer {
  private chunks: ChunkData[] = [];
  private terrain: TerrainData;
  private material: THREE.MeshStandardMaterial;
  private group: THREE.Group;

  constructor(terrain: TerrainData) {
    this.terrain = terrain;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.0,
    });
    this.group = new THREE.Group();

    this.buildAllChunks();
  }

  private buildAllChunks(): void {
    const tw = this.terrain.width;
    const th = this.terrain.height;
    const chunksX = Math.ceil(tw / CHUNK_TILES);
    const chunksZ = Math.ceil(th / CHUNK_TILES);

    for (let cz = 0; cz < chunksZ; cz++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const startX = cx * CHUNK_TILES;
        const startZ = cz * CHUNK_TILES;
        const tilesX = Math.min(CHUNK_TILES, tw - startX);
        const tilesZ = Math.min(CHUNK_TILES, th - startZ);

        const chunk = this.buildChunk(startX, startZ, tilesX, tilesZ);
        this.chunks.push(chunk);
        this.group.add(chunk.mesh);
      }
    }
  }

  private buildChunk(startTileX: number, startTileZ: number, tilesX: number, tilesZ: number): ChunkData {
    // Determine the max tile height in this chunk
    let maxH = 0;
    for (let tz = startTileZ; tz < startTileZ + tilesZ; tz++) {
      for (let tx = startTileX; tx < startTileX + tilesX; tx++) {
        const h = this.terrain.getTileHeight(tx, tz);
        if (h > maxH) maxH = h;
      }
    }

    // Voxel grid dimensions: each tile = 1/VOXEL_SIZE voxels wide
    // But to keep things sane, 1 tile = 1 voxel column in the grid
    // The voxel grid has tile-level XZ resolution (1 voxel per tile)
    // and voxel-level Y resolution (1 voxel per VOXEL_SIZE height unit)
    const gridX = tilesX;
    const gridZ = tilesZ;
    const gridY = maxH + 1; // +1 for the floor layer

    if (gridY === 1) {
      // All-flat chunk: just the floor layer
      return this.buildFlatChunk(startTileX, startTileZ, tilesX, tilesZ);
    }

    // Populate the 3D voxel grid
    // Grid index: gx + gz * gridX + gy * gridX * gridZ
    const grid = new Uint8Array(gridX * gridZ * gridY);
    let solidCount = 0;

    for (let gz = 0; gz < gridZ; gz++) {
      for (let gx = 0; gx < gridX; gx++) {
        const tx = startTileX + gx;
        const tz = startTileZ + gz;
        const tileH = this.terrain.getTileHeight(tx, tz);

        // gy=0: floor layer (always solid for all tiles)
        // gy=1..tileH: terrain above floor
        const totalH = tileH + 1; // floor + mountain

        for (let gy = 0; gy < totalH; gy++) {
          const gi = gx + gz * gridX + gy * gridX * gridZ;
          if (gy === 0) {
            // Floor layer
            if (tileH === 0) {
              grid[gi] = PAL_FLOOR;
            } else if (tileH >= BORDER_HEIGHT) {
              grid[gi] = PAL_BORDER;
            } else {
              grid[gi] = PAL_MOUNTAIN;
            }
          } else {
            // Mountain/wall layers above floor
            if (tileH >= BORDER_HEIGHT) {
              grid[gi] = PAL_BORDER;
            } else {
              grid[gi] = PAL_MOUNTAIN;
            }
          }
          solidCount++;
        }
      }
    }

    const destroyed = new Uint8Array(Math.ceil(solidCount / 8));

    const geometry = this.greedyMesh(grid, gridX, gridY, gridZ);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Position the chunk in world space
    // Tile (tx,tz) occupies world XZ from tx to tx+1
    // Voxel floor layer is at y = [-VOXEL_SIZE, 0) so surface is at y=0 for flat tiles
    mesh.position.set(startTileX, -VOXEL_SIZE, startTileZ);

    return {
      mesh,
      startTileX,
      startTileZ,
      tilesX,
      tilesZ,
      solidCount,
      destroyed,
      dirty: false,
    };
  }

  private buildFlatChunk(startTileX: number, startTileZ: number, tilesX: number, tilesZ: number): ChunkData {
    // Optimized path for all-flat chunks: single quad on the top surface
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    _color.setHex(PALETTE_TOP_COLORS[PAL_FLOOR]);

    // One big quad for the top face
    const x0 = 0;
    const z0 = 0;
    const x1 = tilesX;
    const z1 = tilesZ;
    const y = VOXEL_SIZE; // top of floor layer at y=VOXEL_SIZE (offset by -VOXEL_SIZE in position = y=0 world)

    const vi = positions.length / 3;
    positions.push(x0, y, z0);
    positions.push(x1, y, z0);
    positions.push(x0, y, z1);
    positions.push(x1, y, z1);

    for (let i = 0; i < 4; i++) {
      normals.push(0, 1, 0);
      colors.push(_color.r, _color.g, _color.b);
    }

    // +Y face winding (flip=true): 0,2,3 / 0,3,1
    indices.push(vi, vi + 2, vi + 3);
    indices.push(vi, vi + 3, vi + 1);

    // Bottom face
    _color.setHex(PALETTE_COLORS[PAL_FLOOR]);
    const bi = positions.length / 3;
    const yb = 0;
    positions.push(x0, yb, z0);
    positions.push(x1, yb, z0);
    positions.push(x0, yb, z1);
    positions.push(x1, yb, z1);

    for (let i = 0; i < 4; i++) {
      normals.push(0, -1, 0);
      colors.push(_color.r, _color.g, _color.b);
    }

    // -Y face winding (flip=false): 0,1,3 / 0,3,2
    indices.push(bi, bi + 1, bi + 3);
    indices.push(bi, bi + 3, bi + 2);

    const geometry = createBufferGeometry(positions, normals, colors, indices);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(startTileX, -VOXEL_SIZE, startTileZ);

    return {
      mesh,
      startTileX,
      startTileZ,
      tilesX,
      tilesZ,
      solidCount: tilesX * tilesZ,
      destroyed: new Uint8Array(Math.ceil((tilesX * tilesZ) / 8)),
      dirty: false,
    };
  }

  private greedyMesh(
    grid: Uint8Array,
    sizeX: number, sizeY: number, sizeZ: number,
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    function isSolid(x: number, y: number, z: number): boolean {
      if (x < 0 || x >= sizeX || y < 0 || y >= sizeY || z < 0 || z >= sizeZ) return false;
      return grid[x + z * sizeX + y * sizeX * sizeZ] !== 0;
    }

    function getPalette(x: number, y: number, z: number): number {
      return grid[x + z * sizeX + y * sizeX * sizeZ];
    }

    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
      const info = FACE_INFO[faceIdx];
      const [nx, ny, nz] = FACE_NORMALS[faceIdx];
      const flip = FLIP_WINDING[faceIdx];

      const sizes = [sizeX, sizeY, sizeZ];
      const normalSize = sizes[info.normalAxis];
      const uSize = sizes[info.uAxis];
      const vSize = sizes[info.vAxis];

      for (let d = 0; d < normalSize; d++) {
        // 2D mask: encode palette + whether it's a top face
        const mask = new Int32Array(uSize * vSize);

        for (let v = 0; v < vSize; v++) {
          for (let u = 0; u < uSize; u++) {
            const coords = [0, 0, 0];
            coords[info.uAxis] = u;
            coords[info.vAxis] = v;
            coords[info.normalAxis] = d;
            const cx = coords[0], cy = coords[1], cz = coords[2];

            if (!isSolid(cx, cy, cz)) {
              mask[u + v * uSize] = 0;
              continue;
            }

            const nbx = cx + nx, nby = cy + ny, nbz = cz + nz;
            if (isSolid(nbx, nby, nbz)) {
              mask[u + v * uSize] = 0;
              continue;
            }

            // Encode: palette index + 1, shifted to also encode top-face flag
            const palIdx = getPalette(cx, cy, cz);
            // Check if this is the topmost voxel in this column (for top face color)
            const isTopFace = faceIdx === 2; // +Y face
            const topFlag = isTopFace ? 0x100 : 0;
            mask[u + v * uSize] = (palIdx + 1) | topFlag;
          }
        }

        // Greedy merge
        for (let v = 0; v < vSize; v++) {
          for (let u = 0; u < uSize;) {
            const idx = u + v * uSize;
            const val = mask[idx];
            if (val === 0) { u++; continue; }

            let w = 1;
            while (u + w < uSize && mask[(u + w) + v * uSize] === val) w++;

            let h = 1;
            let done = false;
            while (v + h < vSize && !done) {
              for (let du = 0; du < w; du++) {
                if (mask[(u + du) + (v + h) * uSize] !== val) {
                  done = true;
                  break;
                }
              }
              if (!done) h++;
            }

            for (let dv = 0; dv < h; dv++) {
              for (let du = 0; du < w; du++) {
                mask[(u + du) + (v + dv) * uSize] = 0;
              }
            }

            // Emit quad
            const palIdx = (val & 0xff) - 1;
            const isTop = (val & 0x100) !== 0;

            const colorHex = isTop ? (PALETTE_TOP_COLORS[palIdx] ?? 0xff00ff) : (PALETTE_COLORS[palIdx] ?? 0xff00ff);
            _color.setHex(colorHex);

            const vertexBase = positions.length / 3;

            for (let cv = 0; cv < 2; cv++) {
              for (let cu = 0; cu < 2; cu++) {
                const fu = u + cu * w;
                const fv = v + cv * h;

                const coords = [0, 0, 0];
                coords[info.uAxis] = fu;
                coords[info.vAxis] = fv;
                coords[info.normalAxis] = info.nDir > 0 ? d + 1 : d;

                // Convert grid coords to local chunk position
                // X: 1 grid unit = 1 tile = 1 world unit
                // Y: 1 grid unit = VOXEL_SIZE world units
                // Z: 1 grid unit = 1 tile = 1 world unit
                const px = coords[0]; // tiles
                const py = coords[1] * VOXEL_SIZE; // voxel units -> world units
                const pz = coords[2]; // tiles

                positions.push(px, py, pz);
                normals.push(nx, ny, nz);
                colors.push(_color.r, _color.g, _color.b);
              }
            }

            if (flip) {
              indices.push(vertexBase, vertexBase + 2, vertexBase + 3);
              indices.push(vertexBase, vertexBase + 3, vertexBase + 1);
            } else {
              indices.push(vertexBase, vertexBase + 1, vertexBase + 3);
              indices.push(vertexBase, vertexBase + 3, vertexBase + 2);
            }

            u += w;
          }
        }
      }
    }

    return createBufferGeometry(positions, normals, colors, indices);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  dispose(): void {
    for (const chunk of this.chunks) {
      chunk.mesh.geometry.dispose();
    }
    this.material.dispose();
    this.group.removeFromParent();
  }
}

function createBufferGeometry(
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}
