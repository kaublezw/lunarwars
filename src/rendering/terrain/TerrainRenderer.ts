import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { createNoise2D } from '@sim/terrain/SimplexNoise';

// Height range for color mapping (world units)
const MIN_H = -3.0; // -2 levels * 1.5
const MAX_H = 4.5;  //  3 levels * 1.5
const H_RANGE = MAX_H - MIN_H;

// Flat plateau extension beyond the 256x256 terrain so units near the edge
// can reveal it through fog-of-war instead of seeing a black void.
const PLATEAU_PAD = 25;

export class TerrainRenderer {
  private mesh: THREE.Mesh;

  constructor(terrain: TerrainData) {
    const w = terrain.width;
    const h = terrain.height;
    const totalW = w + PLATEAU_PAD * 2;
    const totalH = h + PLATEAU_PAD * 2;

    const geometry = new THREE.PlaneGeometry(totalW, totalH, totalW - 1, totalH - 1);

    // Rotate to XZ plane (PlaneGeometry defaults to XY)
    geometry.rotateX(-Math.PI / 2);

    const posAttr = geometry.getAttribute('position');
    const colors = new Float32Array(posAttr.count * 3);

    // Noise layers for subtle surface detail (rendering only, no geometry impact)
    const coarseNoise = createNoise2D(777);  // broad color patches
    const fineNoise = createNoise2D(1234);   // fine-grain speckle

    // Displace vertices from heightmap and assign vertex colors.
    // Vertices outside [0,256] auto-clamp via terrain.getHeight/getSlope,
    // producing a flat plateau at edge height (4.5) with zero slope.
    for (let i = 0; i < posAttr.count; i++) {
      const gx = posAttr.getX(i);
      const gz = posAttr.getZ(i);

      // Map from geometry local coords to world coords
      const wx = gx + w / 2;
      const wz = gz + h / 2;

      const height = terrain.getHeight(wx, wz);
      posAttr.setY(i, height);

      // Vertex color: grey regolith with height variation
      const normalizedH = (height - MIN_H) / H_RANGE; // 0 to 1

      // Base regolith blue-grey
      let r = 0.34;
      let g = 0.34;
      let b = 0.52;

      // Lighten elevated tiles, darken depressions
      r += (normalizedH - 0.4) * 0.16;
      g += (normalizedH - 0.4) * 0.18;
      b += (normalizedH - 0.4) * 0.22;

      // Darken steep edges between tile heights
      const slope = terrain.getSlope(wx, wz);
      const slopeDarken = Math.min(slope * 0.06, 0.12);
      r -= slopeDarken;
      g -= slopeDarken;
      b -= slopeDarken;

      // Coarse variation — broad patches of slightly different shade
      const coarse = coarseNoise(wx * 0.04, wz * 0.04) * 0.04;
      r += coarse * 0.8;
      g += coarse * 0.9;
      b += coarse;

      // Fine speckle — per-vertex grain
      const fine = fineNoise(wx * 0.5, wz * 0.5) * 0.025;
      r += fine;
      g += fine;
      b += fine;

      colors[i * 3 + 0] = Math.max(0, Math.min(1, r));
      colors[i * 3 + 1] = Math.max(0, Math.min(1, g));
      colors[i * 3 + 2] = Math.max(0, Math.min(1, b));
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Recompute normals AFTER displacement for correct lighting
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.mesh.position.set(w / 2, 0, h / 2);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
