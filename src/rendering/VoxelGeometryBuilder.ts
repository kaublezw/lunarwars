import * as THREE from 'three';
import type { VoxelModel } from '@sim/data/VoxelModels';
import {
  VOXEL_SIZE, SHARED_PALETTE,
  PAL_TEAM_PRIMARY, PAL_TEAM_ACCENT,
} from '@sim/data/VoxelModels';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const TEAM_ACCENT_COLORS = [0x88bbff, 0xff8888];

// Scorch color targets (linear RGB)
const SCORCH_CHARCOAL = { r: 0.15, g: 0.12, b: 0.1 };   // Hot scorch darkens toward this
const SCORCH_ASH = { r: 0.3, g: 0.3, b: 0.3 };           // Permanent ash grey

// Emissive glow range
const EMISSIVE_DIM = { r: 0.4, g: 0.08, b: 0.0 };        // Low heat: dim red
const EMISSIVE_BRIGHT = { r: 1.0, g: 0.4, b: 0.0 };      // High heat: bright orange

/** Resolve a palette index to an RGB Color, applying team color substitution.
 *  Uses the model's own palette for non-team-color indices so that .vox-imported
 *  models with custom colors render correctly. Existing models reference SHARED_PALETTE
 *  as their palette, so behaviour is unchanged for hand-authored models.
 */
function resolveColor(palIdx: number, team: number, palette: number[], _c: THREE.Color): THREE.Color {
  if (palIdx === PAL_TEAM_PRIMARY) {
    _c.setHex(TEAM_COLORS[team] ?? 0xffffff).multiplyScalar(0.6);
  } else if (palIdx === PAL_TEAM_ACCENT) {
    _c.setHex(TEAM_ACCENT_COLORS[team] ?? 0xffffff).multiplyScalar(0.7);
  } else {
    _c.setHex(palette[palIdx] ?? SHARED_PALETTE[palIdx] ?? 0xff00ff);
  }
  return _c;
}

/** Apply scorch tint to diffuse color based on continuous heat */
function applyScorchDiffuse(_c: THREE.Color, heat: number): void {
  if (heat > 0) {
    // Cooling: darken toward charcoal, stronger blend at higher heat
    const blend = 0.6 + 0.25 * heat; // 0.6 at heat~0 to 0.85 at heat=1
    _c.r = _c.r + (SCORCH_CHARCOAL.r - _c.r) * blend;
    _c.g = _c.g + (SCORCH_CHARCOAL.g - _c.g) * blend;
    _c.b = _c.b + (SCORCH_CHARCOAL.b - _c.b) * blend;
  } else {
    // Permanent ash (heat === -1)
    const blend = 0.6;
    _c.r = _c.r + (SCORCH_ASH.r - _c.r) * blend;
    _c.g = _c.g + (SCORCH_ASH.g - _c.g) * blend;
    _c.b = _c.b + (SCORCH_ASH.b - _c.b) * blend;
  }
}

/** Get emissive glow color for a given heat value */
function getScorchEmissive(heat: number): { r: number; g: number; b: number } {
  if (heat <= 0) return { r: 0, g: 0, b: 0 }; // No glow for ash or unscorched
  // Lerp between dim red (heat~0) and bright orange (heat=1)
  return {
    r: EMISSIVE_DIM.r + (EMISSIVE_BRIGHT.r - EMISSIVE_DIM.r) * heat,
    g: EMISSIVE_DIM.g + (EMISSIVE_BRIGHT.g - EMISSIVE_DIM.g) * heat,
    b: EMISSIVE_DIM.b + (EMISSIVE_BRIGHT.b - EMISSIVE_DIM.b) * heat,
  };
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
  scorchHeat?: Float32Array,
): BuiltGeometry {
  const { sizeX, sizeY, sizeZ, grid, turretMinY, turretMaxY } = model;
  const hasTurret = turretMinY != null;

  // Collect faces into body and turret buckets
  const bodyPositions: number[] = [];
  const bodyNormals: number[] = [];
  const bodyColors: number[] = [];
  const bodyEmissive: number[] = [];
  const bodyIndices: number[] = [];

  const turretPositions: number[] = [];
  const turretNormals: number[] = [];
  const turretColors: number[] = [];
  const turretEmissive: number[] = [];
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

  function getScorchHeat(x: number, y: number, z: number): number {
    if (!scorchHeat) return 0;
    const gi = x + z * sizeX + y * sizeX * sizeZ;
    const si = model.gridToSolid[gi];
    if (si === -1) return 0;
    return scorchHeat[si] || 0;
  }

  function getSolidIndex(x: number, y: number, z: number): number {
    const gi = x + z * sizeX + y * sizeX * sizeZ;
    return model.gridToSolid[gi];
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
      // Positive values: (palIdx + 1) for normal (mergeable) voxels
      // Negative values: -(solidIdx + 1) for scorched voxels (unique, won't merge)
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

          const heat = getScorchHeat(cx, cy, cz);
          if (heat !== 0) {
            // Scorched voxel: use negative unique value to prevent merging
            const solidIdx = getSolidIndex(cx, cy, cz);
            mask[u + v * uSize] = -(solidIdx + 1);
          } else {
            // Normal voxel: palette index + 1 (mergeable)
            const palIdx = getPalette(cx, cy, cz);
            mask[u + v * uSize] = palIdx + 1;
          }

          if (hasTurret) {
            isTurretMask[u + v * uSize] = selfTurret ? 1 : 0;
          }
        }
      }

      // Greedy merge: sweep and find maximal rectangles of same value + same turret group
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

          // Resolve color and emissive based on mask value
          let emR = 0, emG = 0, emB = 0;
          if (val < 0) {
            // Scorched voxel: recover solidIdx, look up palette from grid
            const solidIdx = -(val + 1);
            const [gridIdx] = model.solidVoxels[solidIdx];
            const palIdx = model.grid[gridIdx];
            resolveColor(palIdx, team, model.palette, _color);
            const heat = scorchHeat![solidIdx];
            applyScorchDiffuse(_color, heat);
            const em = getScorchEmissive(heat);
            emR = em.r; emG = em.g; emB = em.b;
          } else {
            // Normal voxel
            const palIdx = val - 1;
            resolveColor(palIdx, team, model.palette, _color);
          }

          // Determine which bucket to add to
          const isTurret = hasTurret && turretFlag === 1;
          const positions = isTurret ? turretPositions : bodyPositions;
          const normals = isTurret ? turretNormals : bodyNormals;
          const colors = isTurret ? turretColors : bodyColors;
          const emissive = isTurret ? turretEmissive : bodyEmissive;
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
              emissive.push(emR, emG, emB);
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

  const bodyGeometry = createBufferGeometry(bodyPositions, bodyNormals, bodyColors, bodyEmissive, bodyIndices);
  let turretGeometry: THREE.BufferGeometry | null = null;
  if (hasTurret && turretPositions.length > 0) {
    turretGeometry = createBufferGeometry(turretPositions, turretNormals, turretColors, turretEmissive, turretIndices);
  }

  return { bodyGeometry, turretGeometry };
}

function createBufferGeometry(
  positions: number[],
  normals: number[],
  colors: number[],
  emissive: number[],
  indices: number[],
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aEmissive', new THREE.Float32BufferAttribute(emissive, 3));
  geo.setIndex(indices);
  return geo;
}
