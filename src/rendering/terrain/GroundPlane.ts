import * as THREE from 'three';

export class GroundPlane {
  readonly mesh: THREE.Mesh;
  readonly grid: THREE.GridHelper;

  constructor() {
    const geometry = new THREE.PlaneGeometry(256, 256);
    const material = new THREE.MeshStandardMaterial({
      color: 0x808080,
      roughness: 0.9,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(128, 0, 128); // Center at world midpoint

    // 64 divisions = 4 world units per cell
    this.grid = new THREE.GridHelper(256, 64, 0x999999, 0x777777);
    this.grid.position.set(128, 0.05, 128); // Y offset above terrain floor voxels
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
    scene.add(this.grid);
  }
}
