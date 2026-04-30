import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { VOXEL_SIZE } from '@sim/data/VoxelModels';

// Colors
const FLOOR_SIDE_COLOR = 0x5a432e;
const FLOOR_TOP_COLOR = 0x6e5438;
const MOUNTAIN_TOP_COLOR = 0x5c4530;
const MOUNTAIN_SIDE_COLOR = 0x483624;
const BORDER_SIDE_COLOR = 0x483624;
const BORDER_TOP_COLOR = 0x5c4530;

// Chunk size in tiles
const CHUNK_TILES = 32;

// Tiles within this distance from the map edge are border walls
const BORDER_DEPTH = 5;

const _color = new THREE.Color();

export class TerrainVoxelRenderer {
  private meshes: THREE.Mesh[] = [];
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
        const mesh = this.buildChunk(startX, startZ, tilesX, tilesZ);
        this.meshes.push(mesh);
        this.group.add(mesh);
      }
    }
  }

  private buildChunk(startTileX: number, startTileZ: number, tilesX: number, tilesZ: number): THREE.Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    // Floor quad covers the entire chunk
    emitQuadY(positions, normals, colors, indices, 0, 0, tilesX, tilesZ, VOXEL_SIZE, FLOOR_TOP_COLOR, true);
    emitQuadY(positions, normals, colors, indices, 0, 0, tilesX, tilesZ, 0, FLOOR_SIDE_COLOR, false);

    // Add box geometry for elevated tiles
    this.buildElevatedBoxes(positions, normals, colors, indices, startTileX, startTileZ, tilesX, tilesZ);

    const geometry = createBufferGeometry(positions, normals, colors, indices);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(startTileX, -VOXEL_SIZE, startTileZ);
    return mesh;
  }

  private isBorderTile(tx: number, tz: number): boolean {
    return tx < BORDER_DEPTH || tx >= this.terrain.width - BORDER_DEPTH
        || tz < BORDER_DEPTH || tz >= this.terrain.height - BORDER_DEPTH;
  }

  private tileHeight(tx: number, tz: number): number {
    if (tx < 0 || tx >= this.terrain.width || tz < 0 || tz >= this.terrain.height) return 0;
    return this.terrain.getTileHeight(tx, tz);
  }

  private buildElevatedBoxes(
    positions: number[], normals: number[], colors: number[], indices: number[],
    startTileX: number, startTileZ: number, tilesX: number, tilesZ: number,
  ): void {
    const visited = new Uint8Array(tilesX * tilesZ);

    for (let lz = 0; lz < tilesZ; lz++) {
      for (let lx = 0; lx < tilesX; lx++) {
        if (visited[lx + lz * tilesX]) continue;
        const tx = startTileX + lx;
        const tz = startTileZ + lz;
        const h = this.terrain.getTileHeight(tx, tz);
        if (h === 0) continue;

        const isBorder = this.isBorderTile(tx, tz);

        // Greedy expand width
        let w = 1;
        while (lx + w < tilesX && !visited[(lx + w) + lz * tilesX]) {
          const ntx = startTileX + lx + w;
          if (this.terrain.getTileHeight(ntx, tz) !== h) break;
          if (this.isBorderTile(ntx, tz) !== isBorder) break;
          w++;
        }

        // Greedy expand depth
        let d = 1;
        let canExpand = true;
        while (lz + d < tilesZ && canExpand) {
          for (let dx = 0; dx < w; dx++) {
            const ntx = startTileX + lx + dx;
            const ntz = startTileZ + lz + d;
            if (visited[(lx + dx) + (lz + d) * tilesX]
                || this.terrain.getTileHeight(ntx, ntz) !== h
                || this.isBorderTile(ntx, ntz) !== isBorder) {
              canExpand = false;
              break;
            }
          }
          if (canExpand) d++;
        }

        // Mark visited
        for (let dz = 0; dz < d; dz++)
          for (let dx = 0; dx < w; dx++)
            visited[(lx + dx) + (lz + dz) * tilesX] = 1;

        // Emit box
        const topY = (h + 1) * VOXEL_SIZE;
        const bottomY = VOXEL_SIZE;
        const topColor = isBorder ? BORDER_TOP_COLOR : MOUNTAIN_TOP_COLOR;
        const sideColor = isBorder ? BORDER_SIDE_COLOR : MOUNTAIN_SIDE_COLOR;

        // Top face
        emitQuadY(positions, normals, colors, indices, lx, lz, w, d, topY, topColor, true);

        // Side faces with 1D greedy merge along each edge
        this.emitEdgeSidesX(positions, normals, colors, indices,
          startTileX + lx - 1, startTileZ + lz, d, h,
          lx, lz, bottomY, topY, sideColor, false);
        this.emitEdgeSidesX(positions, normals, colors, indices,
          startTileX + lx + w, startTileZ + lz, d, h,
          lx + w, lz, bottomY, topY, sideColor, true);
        this.emitEdgeSidesZ(positions, normals, colors, indices,
          startTileX + lx, startTileZ + lz - 1, w, h,
          lx, lz, bottomY, topY, sideColor, false);
        this.emitEdgeSidesZ(positions, normals, colors, indices,
          startTileX + lx, startTileZ + lz + d, w, h,
          lx, lz + d, bottomY, topY, sideColor, true);
      }
    }
  }

  private emitEdgeSidesX(
    p: number[], n: number[], c: number[], idx: number[],
    adjTileX: number, adjTileZStart: number, count: number, height: number,
    localX: number, localZStart: number,
    bottomY: number, topY: number,
    color: number, facePositive: boolean,
  ): void {
    let runStart = -1;
    for (let i = 0; i <= count; i++) {
      const needsFace = i < count && this.tileHeight(adjTileX, adjTileZStart + i) < height;
      if (needsFace && runStart === -1) {
        runStart = i;
      } else if (!needsFace && runStart !== -1) {
        emitQuadX(p, n, c, idx, localX, localZStart + runStart, i - runStart, bottomY, topY, color, facePositive);
        runStart = -1;
      }
    }
  }

  private emitEdgeSidesZ(
    p: number[], n: number[], c: number[], idx: number[],
    adjTileXStart: number, adjTileZ: number, count: number, height: number,
    localXStart: number, localZ: number,
    bottomY: number, topY: number,
    color: number, facePositive: boolean,
  ): void {
    let runStart = -1;
    for (let i = 0; i <= count; i++) {
      const needsFace = i < count && this.tileHeight(adjTileXStart + i, adjTileZ) < height;
      if (needsFace && runStart === -1) {
        runStart = i;
      } else if (!needsFace && runStart !== -1) {
        emitQuadZ(p, n, c, idx, localXStart + runStart, localZ, i - runStart, bottomY, topY, color, facePositive);
        runStart = -1;
      }
    }
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
    }
    this.material.dispose();
    this.group.removeFromParent();
  }
}

// --- Quad emission helpers ---

function emitQuadY(
  p: number[], n: number[], c: number[], idx: number[],
  x0: number, z0: number, w: number, d: number, y: number,
  color: number, faceUp: boolean,
): void {
  const vi = p.length / 3;
  _color.setHex(color);
  p.push(x0, y, z0, x0 + w, y, z0, x0, y, z0 + d, x0 + w, y, z0 + d);
  const ny = faceUp ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    n.push(0, ny, 0);
    c.push(_color.r, _color.g, _color.b);
  }
  if (faceUp) {
    idx.push(vi, vi + 2, vi + 3, vi, vi + 3, vi + 1);
  } else {
    idx.push(vi, vi + 1, vi + 3, vi, vi + 3, vi + 2);
  }
}

function emitQuadX(
  p: number[], n: number[], c: number[], idx: number[],
  x: number, z0: number, zLen: number, y0: number, y1: number,
  color: number, facePositive: boolean,
): void {
  const vi = p.length / 3;
  _color.setHex(color);
  p.push(x, y0, z0, x, y0, z0 + zLen, x, y1, z0, x, y1, z0 + zLen);
  const nx = facePositive ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    n.push(nx, 0, 0);
    c.push(_color.r, _color.g, _color.b);
  }
  if (facePositive) {
    idx.push(vi, vi + 2, vi + 3, vi, vi + 3, vi + 1);
  } else {
    idx.push(vi, vi + 1, vi + 3, vi, vi + 3, vi + 2);
  }
}

function emitQuadZ(
  p: number[], n: number[], c: number[], idx: number[],
  x0: number, z: number, xLen: number, y0: number, y1: number,
  color: number, facePositive: boolean,
): void {
  const vi = p.length / 3;
  _color.setHex(color);
  p.push(x0, y0, z, x0 + xLen, y0, z, x0, y1, z, x0 + xLen, y1, z);
  const nz = facePositive ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    n.push(0, 0, nz);
    c.push(_color.r, _color.g, _color.b);
  }
  if (facePositive) {
    idx.push(vi, vi + 1, vi + 3, vi, vi + 3, vi + 2);
  } else {
    idx.push(vi, vi + 2, vi + 3, vi, vi + 3, vi + 1);
  }
}

function createBufferGeometry(
  positions: number[], normals: number[], colors: number[], indices: number[],
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}
