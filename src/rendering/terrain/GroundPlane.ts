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

    // Grid with 256 divisions = 1 world unit per cell (matches terrain tiles)
    this.grid = new THREE.GridHelper(256, 256, 0x666666, 0x555555);
    this.grid.position.set(128, 0.01, 128); // Slight Y offset to avoid z-fighting
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
    scene.add(this.grid);
  }
}
