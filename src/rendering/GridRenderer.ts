import * as THREE from 'three';
import { MACRO_GRID_SIZE } from '@sim/components/ComponentTypes';

/**
 * Renders the MACRO_GRID_SIZE debug grid as yellow lines.
 * Lines are placed at exact multiples of MACRO_GRID_SIZE (0, 4, 8, 12, ...)
 * matching where track pieces, buildings, and resource nodes snap to.
 */
export class GridRenderer {
  private lines: THREE.LineSegments;

  constructor(mapSize: number) {
    const G = MACRO_GRID_SIZE;
    const points: number[] = [];

    // Vertical lines (along Z axis) at each X grid position
    for (let x = 0; x <= mapSize; x += G) {
      points.push(x, 0.2, 0);
      points.push(x, 0.2, mapSize);
    }

    // Horizontal lines (along X axis) at each Z grid position
    for (let z = 0; z <= mapSize; z += G) {
      points.push(0, 0.2, z);
      points.push(mapSize, 0.2, z);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x333333,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(geometry, material);
    this.lines.renderOrder = -1;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.lines);
  }
}
