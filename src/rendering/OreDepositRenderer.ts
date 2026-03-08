import * as THREE from 'three';
import type { OreDeposit } from '@sim/terrain/MapFeatures';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const DISC_COLOR = 0x1a1a1a;
const RING_COLOR = 0x222222;
const CHUNK_COLOR = 0x111111;

const discGeometry = new THREE.CylinderGeometry(1.2, 1.5, 0.15, 8);
const ringGeometry = new THREE.CylinderGeometry(1.8, 2.0, 0.05, 8);
const chunkGeometry = new THREE.BoxGeometry(0.3, 0.2, 0.3);

interface NodeRef {
  group: THREE.Group;
  x: number;
  z: number;
}

export class OreDepositRenderer {
  private sceneGroup = new THREE.Group();
  private nodeRefs: NodeRef[] = [];

  constructor(deposits: OreDeposit[], terrain: TerrainData) {
    for (const deposit of deposits) {
      const y = terrain.getHeight(deposit.x, deposit.z);
      const group = new THREE.Group();
      group.position.set(deposit.x, y, deposit.z);
      group.visible = false;

      // Main dark disc
      const discMat = new THREE.MeshStandardMaterial({
        color: DISC_COLOR,
        roughness: 0.9,
        metalness: 0.2,
      });
      const disc = new THREE.Mesh(discGeometry, discMat);
      disc.position.y = 0.075;
      group.add(disc);

      // Subtle dark ring
      const ringMat = new THREE.MeshBasicMaterial({
        color: RING_COLOR,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeometry, ringMat);
      ring.position.y = 0.025;
      group.add(ring);

      // Scattered ore chunks
      const chunkOffsets = [
        { x: 0.5, z: 0.3 },
        { x: -0.4, z: 0.5 },
        { x: 0.2, z: -0.6 },
        { x: -0.6, z: -0.2 },
      ];
      const chunkMat = new THREE.MeshStandardMaterial({
        color: CHUNK_COLOR,
        roughness: 1.0,
        metalness: 0.1,
      });
      for (const offset of chunkOffsets) {
        const chunk = new THREE.Mesh(chunkGeometry, chunkMat);
        chunk.position.set(offset.x, 0.1, offset.z);
        chunk.rotation.y = Math.random() * Math.PI;
        group.add(chunk);
      }

      this.sceneGroup.add(group);
      this.nodeRefs.push({ group, x: deposit.x, z: deposit.z });
    }
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.sceneGroup);
  }

  update(fogState: FogOfWarState, playerTeam: number): void {
    for (const ref of this.nodeRefs) {
      const explored = playerTeam < 0 || fogState.isExplored(playerTeam, ref.x, ref.z);
      ref.group.visible = explored;
    }
  }
}
