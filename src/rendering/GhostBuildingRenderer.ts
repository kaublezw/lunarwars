import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { WallSegment } from '@input/PlacementController';

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

// Wall ghost dimensions (world units)
const WALL_X_SIZE = { x: 3.0, y: 1.5, z: 0.75 };
const WALL_Z_SIZE = { x: 0.75, y: 1.5, z: 3.0 };
const WALL_CORNER_SIZE = { x: 0.75, y: 1.5, z: 0.75 };

export class GhostBuildingRenderer {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshStandardMaterial;
  private currentType: string | null = null;

  // Wall ghost state
  private wallGhosts: THREE.Mesh[] = [];
  private wallGeo = new THREE.BoxGeometry(1, 1, 1);

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

  updateWall(segments: WallSegment[]): void {
    // Hide normal ghost
    this.hide();

    // Remove excess ghosts
    while (this.wallGhosts.length > segments.length) {
      const ghost = this.wallGhosts.pop()!;
      this.scene.remove(ghost);
    }

    // Create new ghosts if needed
    while (this.wallGhosts.length < segments.length) {
      const mat = new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const ghost = new THREE.Mesh(this.wallGeo, mat);
      ghost.renderOrder = 999;
      this.scene.add(ghost);
      this.wallGhosts.push(ghost);
    }

    // Update positions and colors
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const ghost = this.wallGhosts[i];
      const terrainY = this.terrainData.getHeight(seg.x, seg.z);
      const size = seg.meshType === 'wall_corner' ? WALL_CORNER_SIZE
        : seg.meshType === 'wall_x' ? WALL_X_SIZE : WALL_Z_SIZE;

      ghost.scale.set(size.x, size.y, size.z);
      ghost.position.set(seg.x, terrainY + size.y / 2, seg.z);
      (ghost.material as THREE.MeshStandardMaterial).color.setHex(seg.valid ? 0x44ff44 : 0xff4444);
      ghost.visible = true;
    }
  }

  hideWall(): void {
    for (const ghost of this.wallGhosts) {
      this.scene.remove(ghost);
    }
    this.wallGhosts = [];
  }
}
