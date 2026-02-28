import * as THREE from 'three';
import type { EnergyNode } from '@sim/terrain/MapFeatures';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const NODE_RADIUS = 0.6;
const NODE_HEIGHT = 2.0;
const GLOW_COLOR = 0x00ffff;

const nodeGeometry = new THREE.CylinderGeometry(NODE_RADIUS, NODE_RADIUS, NODE_HEIGHT, 6);
const glowGeometry = new THREE.CylinderGeometry(NODE_RADIUS * 1.8, NODE_RADIUS * 1.8, NODE_HEIGHT * 0.5, 6);

interface NodeRef {
  crystal: THREE.Mesh;
  glow: THREE.Mesh;
  x: number;
  z: number;
}

export class EnergyNodeRenderer {
  private group = new THREE.Group();
  private nodeRefs: NodeRef[] = [];

  constructor(nodes: EnergyNode[], terrain: TerrainData) {
    for (const node of nodes) {
      const y = terrain.getHeight(node.x, node.z);

      // Solid crystal
      const material = new THREE.MeshStandardMaterial({
        color: GLOW_COLOR,
        emissive: GLOW_COLOR,
        emissiveIntensity: 0.4,
        roughness: 0.3,
        metalness: 0.6,
      });
      const crystal = new THREE.Mesh(nodeGeometry, material);
      crystal.position.set(node.x, y + NODE_HEIGHT / 2, node.z);
      crystal.visible = false;
      this.group.add(crystal);

      // Outer glow shell
      const glowMaterial = new THREE.MeshBasicMaterial({
        color: GLOW_COLOR,
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
      });
      const glow = new THREE.Mesh(glowGeometry, glowMaterial);
      glow.position.set(node.x, y + NODE_HEIGHT * 0.25, node.z);
      glow.visible = false;
      this.group.add(glow);

      this.nodeRefs.push({ crystal, glow, x: node.x, z: node.z });
    }
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(fogState: FogOfWarState, playerTeam: number): void {
    for (const ref of this.nodeRefs) {
      // playerTeam < 0 = spectator, show all nodes
      const explored = playerTeam < 0 || fogState.isExplored(playerTeam, ref.x, ref.z);
      ref.crystal.visible = explored;
      ref.glow.visible = explored;
    }
  }
}
