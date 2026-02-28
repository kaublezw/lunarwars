import * as THREE from 'three';
import type { VoxelModel } from '@sim/data/VoxelModels';
import {
  VOXEL_SIZE, SHARED_PALETTE,
  PAL_TEAM_PRIMARY, PAL_TEAM_ACCENT,
} from '@sim/data/VoxelModels';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const TEAM_ACCENT_COLORS = [0x88bbff, 0xff8888];

/** Resolve a palette index to an RGB Color, applying team color substitution */
function resolveColor(palIdx: number, team: number, _c: THREE.Color): THREE.Color {
  if (palIdx === PAL_TEAM_PRIMARY) {
    _c.setHex(TEAM_COLORS[team] ?? 0xffffff).multiplyScalar(0.6);
  } else if (palIdx === PAL_TEAM_ACCENT) {
    _c.setHex(TEAM_ACCENT_COLORS[team] ?? 0xffffff).multiplyScalar(0.7);
  } else {
    _c.setHex(SHARED_PALETTE[palIdx] ?? 0xff00ff);
  }
  return _c;
}

// Face normals for the 6 directions: +X, -X, +Y, -Y, +Z, -Z
const FACE_NORMALS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

// For each face direction, the two axes that define the face plane
// uAxis/vAxis: indices into [x,y,z] for the two sweep axes
// normalAxis: the axis perpendicular to the face
// nDir: +1 for positive face, -1 for negative face
const FACE_INFO: {
  uAxis: number; vAxis: number; normalAxis: number;
  nDir: number;
}[] = [
  // +X face: plane is ZY
  { uAxis: 2, vAxis: 1, normalAxis: 0, nDir: 1 },
  // -X face: plane is ZY
  { uAxis: 2, vAxis: 1, normalAxis: 0, nDir: -1 },
  // +Y face: plane is XZ
  { uAxis: 0, vAxis: 2, normalAxis: 1, nDir: 1 },
  // -Y face: plane is XZ
  { uAxis: 0, vAxis: 2, normalAxis: 1, nDir: -1 },
  // +Z face: plane is XY
  { uAxis: 0, vAxis: 1, normalAxis: 2, nDir: 1 },
  // -Z face: plane is XY
  { uAxis: 0, vAxis: 1, normalAxis: 2, nDir: -1 },
];

// Whether the default triangle winding (0,1,3),(0,3,2) produces the WRONG normal
// for each face direction. If true, use flipped winding (0,2,3),(0,3,1) instead.
// Derived from: cross(edge_u, edge_v) direction vs desired face normal.
const FLIP_WINDING = [true, false, true, false, false, true];

export interface BuiltGeometry {
  bodyGeometry: THREE.BufferGeometry;
  turretGeometry: THREE.BufferGeometry | null;
}

const _color = new THREE.Color();

/**
 * Build greedy-meshed geometry for a voxel model.
 * Produces separate body and turret geometries for independent rotation.
 */
export function buildVoxelGeometry(
  model: VoxelModel,
  destroyed: Uint8Array,
  team: number,
): BuiltGeometry {
  const { sizeX, sizeY, sizeZ, grid, turretMinY, turretMaxY } = model;
  const hasTurret = turretMinY != null;

  // Collect faces into body and turret buckets
  const bodyPositions: number[] = [];
  const bodyNormals: number[] = [];
  const bodyColors: number[] = [];
  const bodyIndices: number[] = [];

  const turretPositions: number[] = [];
  const turretNormals: number[] = [];
  const turretColors: number[] = [];
  const turretIndices: number[] = [];

  // Helper to check if a voxel is solid (not empty, not destroyed)
  function isSolid(x: number, y: number, z: number): boolean {
    if (x < 0 || x >= sizeX || y < 0 || y >= sizeY || z < 0 || z >= sizeZ) return false;
    const gi = x + z * sizeX + y * sizeX * sizeZ;
    if (grid[gi] === 0) return false;
    const solidIdx = model.gridToSolid[gi];
    if (solidIdx === -1) return false;
    const byteIdx = solidIdx >> 3;
    const bitIdx = solidIdx & 7;
    return (destroyed[byteIdx] & (1 << bitIdx)) === 0;
  }

  function getPalette(x: number, y: number, z: number): number {
    const gi = x + z * sizeX + y * sizeX * sizeZ;
    return grid[gi];
  }

  function isTurretVoxel(y: number): boolean {
    if (!hasTurret) return false;
    return y >= turretMinY! && (turretMaxY == null || y <= turretMaxY);
  }

  // Center offset so model is centered on XZ
  const halfX = (sizeX * VOXEL_SIZE) / 2;
  const halfZ = (sizeZ * VOXEL_SIZE) / 2;

  // Turret pivot Y (in local model space, not world)
  const pivotY = hasTurret ? turretMinY! * VOXEL_SIZE : 0;

  // For each face direction, sweep slices and greedily merge
  for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
    const info = FACE_INFO[faceIdx];
    const [nx, ny, nz] = FACE_NORMALS[faceIdx];
    const flip = FLIP_WINDING[faceIdx];

    // Determine axis sizes
    const sizes = [sizeX, sizeY, sizeZ];
    const normalSize = sizes[info.normalAxis];
    const uSize = sizes[info.uAxis];
    const vSize = sizes[info.vAxis];

    // Sweep each slice along the normal axis
    for (let d = 0; d < normalSize; d++) {
      // Build a 2D mask of exposed faces for this slice
      // Each entry: palette index + 1 if exposed, 0 if not
      const mask = new Int32Array(uSize * vSize);
      const isTurretMask = new Uint8Array(uSize * vSize);

      for (let v = 0; v < vSize; v++) {
        for (let u = 0; u < uSize; u++) {
          // Map (u, v, d) back to (x, y, z)
          const coords = [0, 0, 0];
          coords[info.uAxis] = u;
          coords[info.vAxis] = v;
          coords[info.normalAxis] = d;
          const cx = coords[0], cy = coords[1], cz = coords[2];

          if (!isSolid(cx, cy, cz)) {
            mask[u + v * uSize] = 0;
            continue;
          }

          // Check neighbor in normal direction
          const nbx = cx + nx, nby = cy + ny, nbz = cz + nz;
          const neighborSolid = isSolid(nbx, nby, nbz);

          // Face is exposed if neighbor is empty/destroyed, OR if neighbor is
          // in a different turret group (body vs turret are separate meshes)
          const selfTurret = isTurretVoxel(cy);
          const neighborTurret = isTurretVoxel(nby);
          const sameGroup = selfTurret === neighborTurret;

          if (neighborSolid && sameGroup) {
            mask[u + v * uSize] = 0; // hidden face
            continue;
          }

          const palIdx = getPalette(cx, cy, cz);
          mask[u + v * uSize] = palIdx + 1;

          if (hasTurret) {
            isTurretMask[u + v * uSize] = selfTurret ? 1 : 0;
          }
        }
      }

      // Greedy merge: sweep and find maximal rectangles of same color + same turret group
      for (let v = 0; v < vSize; v++) {
        for (let u = 0; u < uSize;) {
          const idx = u + v * uSize;
          const val = mask[idx];
          if (val === 0) { u++; continue; }

          const turretFlag = isTurretMask[idx];

          // Extend width (u direction)
          let w = 1;
          while (u + w < uSize) {
            const ni = (u + w) + v * uSize;
            if (mask[ni] !== val || isTurretMask[ni] !== turretFlag) break;
            w++;
          }

          // Extend height (v direction)
          let h = 1;
          let done = false;
          while (v + h < vSize && !done) {
            for (let du = 0; du < w; du++) {
              const ni = (u + du) + (v + h) * uSize;
              if (mask[ni] !== val || isTurretMask[ni] !== turretFlag) {
                done = true;
                break;
              }
            }
            if (!done) h++;
          }

          // Clear merged region from mask
          for (let dv = 0; dv < h; dv++) {
            for (let du = 0; du < w; du++) {
              mask[(u + du) + (v + dv) * uSize] = 0;
            }
          }

          // Emit quad for this merged rectangle
          const palIdx = val - 1;
          resolveColor(palIdx, team, _color);

          // Determine which bucket to add to
          const isTurret = hasTurret && turretFlag === 1;
          const positions = isTurret ? turretPositions : bodyPositions;
          const normals = isTurret ? turretNormals : bodyNormals;
          const colors = isTurret ? turretColors : bodyColors;
          const indices = isTurret ? turretIndices : bodyIndices;

          const vertexBase = positions.length / 3;

          // Emit 4 vertices: (cu,cv) in {0,1}x{0,1}
          // 0=(u,v), 1=(u+w,v), 2=(u,v+h), 3=(u+w,v+h)
          for (let cv = 0; cv < 2; cv++) {
            for (let cu = 0; cu < 2; cu++) {
              const fu = u + cu * w;
              const fv = v + cv * h;

              const coords = [0, 0, 0];
              coords[info.uAxis] = fu;
              coords[info.vAxis] = fv;
              // Positive normal: face is at d+1; negative normal: face is at d
              coords[info.normalAxis] = info.nDir > 0 ? d + 1 : d;

              // Convert grid coords to model-local position
              let px = coords[0] * VOXEL_SIZE - halfX;
              const py = coords[1] * VOXEL_SIZE;
              let pz = coords[2] * VOXEL_SIZE - halfZ;

              let finalY = py;
              // If turret, offset so pivot is at origin
              if (isTurret) {
                finalY -= pivotY;
              }

              positions.push(px, finalY, pz);
              normals.push(nx, ny, nz);
              colors.push(_color.r, _color.g, _color.b);
            }
          }

          // Two triangles for the quad with correct winding
          if (flip) {
            // Flipped: CCW for +X, +Y, -Z faces
            indices.push(vertexBase, vertexBase + 2, vertexBase + 3);
            indices.push(vertexBase, vertexBase + 3, vertexBase + 1);
          } else {
            // Normal: CCW for -X, -Y, +Z faces
            indices.push(vertexBase, vertexBase + 1, vertexBase + 3);
            indices.push(vertexBase, vertexBase + 3, vertexBase + 2);
          }

          u += w;
        }
      }
    }
  }

  const bodyGeometry = createBufferGeometry(bodyPositions, bodyNormals, bodyColors, bodyIndices);
  let turretGeometry: THREE.BufferGeometry | null = null;
  if (hasTurret && turretPositions.length > 0) {
    turretGeometry = createBufferGeometry(turretPositions, turretNormals, turretColors, turretIndices);
  }

  return { bodyGeometry, turretGeometry };
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
