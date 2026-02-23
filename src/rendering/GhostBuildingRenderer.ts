import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';

const ghostGeometries: Record<string, THREE.BufferGeometry> = {
  energy_extractor: new THREE.CylinderGeometry(1.2, 1.5, 2, 6),
  matter_plant: new THREE.BoxGeometry(3, 2, 3),
  supply_depot: new THREE.BoxGeometry(3.5, 0.6, 3.5),
  drone_factory: new THREE.BoxGeometry(3.5, 2.5, 3.5),
};

const ghostYOffsets: Record<string, number> = {
  energy_extractor: 1,
  matter_plant: 1,
  supply_depot: 0.3,
  drone_factory: 1.25,
};

export class GhostBuildingRenderer {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshStandardMaterial;
  private currentType: string | null = null;

  constructor(private scene: THREE.Scene, private terrainData: TerrainData) {
    this.material = new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
  }

  update(active: boolean, type: string | null, x: number, z: number, valid: boolean): void {
    if (!active || !type) {
      this.hide();
      return;
    }

    // Create or swap mesh if type changed
    if (type !== this.currentType) {
      this.hide();
      const geo = ghostGeometries[type];
      if (!geo) return;
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.renderOrder = 999;
      this.scene.add(this.mesh);
      this.currentType = type;
    }

    if (!this.mesh) return;

    const yOffset = ghostYOffsets[type] ?? 1;
    const terrainY = this.terrainData.getHeight(x, z);
    this.mesh.position.set(x, terrainY + yOffset, z);
    this.material.color.setHex(valid ? 0x44ff44 : 0xff4444);
    this.mesh.visible = true;
  }

  hide(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry = new THREE.BufferGeometry(); // detach shared geo ref
      this.mesh = null;
      this.currentType = null;
    }
  }
}
