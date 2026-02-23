import * as THREE from 'three';

const PLATEAU_HEIGHT = 4.5;

// Must match TerrainRenderer/FogRenderer PLATEAU_PAD
const PLATEAU_PAD = 25;

interface PerimeterPoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

// Radial distance steps from the extended terrain edge outward
const RADIAL_DISTANCES = [0, 50, 200, 800];

export class ValleyWallRenderer {
  private mesh: THREE.Mesh;

  constructor() {
    const perimeterPoints = this.buildPerimeter();
    const radialSteps = RADIAL_DISTANCES.length;
    const perimCount = perimeterPoints.length;
    const vertexCount = perimCount * radialSteps;

    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    for (let p = 0; p < perimCount; p++) {
      const pt = perimeterPoints[p];

      for (let r = 0; r < radialSteps; r++) {
        const d = RADIAL_DISTANCES[r];
        const vx = pt.x + pt.nx * d;
        const vz = pt.z + pt.nz * d;

        const idx = (p * radialSteps + r) * 3;
        positions[idx] = vx;
        positions[idx + 1] = PLATEAU_HEIGHT;
        positions[idx + 2] = vz;

        // Match undiscovered fog color (0, 0, 4) = rgb(0, 0, 4/255)
        colors[idx] = 0;
        colors[idx + 1] = 0;
        colors[idx + 2] = 4 / 255;
      }
    }

    // Build triangle indices
    const quadsPerStrip = radialSteps - 1;
    const indexCount = perimCount * quadsPerStrip * 6;
    const indices = new Uint32Array(indexCount);
    let ii = 0;

    for (let p = 0; p < perimCount; p++) {
      const pNext = (p + 1) % perimCount;
      for (let r = 0; r < radialSteps - 1; r++) {
        const a = p * radialSteps + r;
        const b = p * radialSteps + r + 1;
        const c = pNext * radialSteps + r;
        const d = pNext * radialSteps + r + 1;

        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;

        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = d;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
  }

  private buildPerimeter(): PerimeterPoint[] {
    const points: PerimeterPoint[] = [];
    const STEP = 4;
    // Start at the extended terrain boundary
    const MIN = -PLATEAU_PAD;
    const MAX = 276 + PLATEAU_PAD;

    // South edge: z=MIN, x from MIN to MAX
    for (let x = MIN; x <= MAX; x += STEP) {
      points.push({ x, z: MIN, nx: 0, nz: -1 });
    }

    // SE corner arc
    this.addCornerArc(points, MAX, MIN, -Math.PI / 2, 0, 4);

    // East edge: x=MAX, z from MIN+STEP to MAX
    for (let z = MIN + STEP; z <= MAX; z += STEP) {
      points.push({ x: MAX, z, nx: 1, nz: 0 });
    }

    // NE corner arc
    this.addCornerArc(points, MAX, MAX, 0, Math.PI / 2, 4);

    // North edge: z=MAX, x from MAX-STEP down to MIN
    for (let x = MAX - STEP; x >= MIN; x -= STEP) {
      points.push({ x, z: MAX, nx: 0, nz: 1 });
    }

    // NW corner arc
    this.addCornerArc(points, MIN, MAX, Math.PI / 2, Math.PI, 4);

    // West edge: x=MIN, z from MAX-STEP down to MIN+STEP
    for (let z = MAX - STEP; z >= MIN + STEP; z -= STEP) {
      points.push({ x: MIN, z, nx: -1, nz: 0 });
    }

    // SW corner arc
    this.addCornerArc(points, MIN, MIN, Math.PI, Math.PI * 3 / 2, 4);

    return points;
  }

  private addCornerArc(
    points: PerimeterPoint[],
    cx: number, cz: number,
    startAngle: number, endAngle: number,
    segments: number,
  ): void {
    for (let i = 1; i <= segments; i++) {
      const t = i / (segments + 1);
      const angle = startAngle + (endAngle - startAngle) * t;
      points.push({
        x: cx,
        z: cz,
        nx: Math.cos(angle),
        nz: Math.sin(angle),
      });
    }
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
