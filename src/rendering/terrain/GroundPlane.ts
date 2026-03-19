import * as THREE from 'three';
import { GRID_CELL_SIZE } from '@sim/terrain/GridConstants';

const GRID_DIVISIONS = 256 / GRID_CELL_SIZE;

export class GroundPlane {
  readonly grid: THREE.GridHelper;

  constructor() {
    this.grid = new THREE.GridHelper(256, GRID_DIVISIONS, 0x999999, 0x777777);
    this.grid.position.set(128, 0.05, 128); // Slightly above terrain floor
    // depthTest enabled so buildings render on top of grid lines
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.grid);
  }
}
