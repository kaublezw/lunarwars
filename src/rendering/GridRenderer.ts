import * as THREE from 'three';

export class GridRenderer {
  private grid: THREE.GridHelper;

  constructor(size: number, divisions: number) {
    this.grid = new THREE.GridHelper(size, divisions, 0x444444, 0x222222);
    this.grid.position.set(size / 2, 0.05, size / 2);

    const mat = this.grid.material;
    if (Array.isArray(mat)) {
      for (const m of mat) {
        m.transparent = true;
        m.opacity = 0.25;
        m.depthWrite = false;
      }
    } else {
      mat.transparent = true;
      mat.opacity = 0.25;
      mat.depthWrite = false;
    }
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.grid);
  }
}
