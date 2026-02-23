import * as THREE from 'three';
import type { EventBus } from '@core/EventBus';
import type { TerrainData } from '@sim/terrain/TerrainData';

interface WaypointMarker {
  mesh: THREE.Mesh;
  timeLeft: number;
}

const MARKER_DURATION = 2.0; // seconds
const MARKER_RADIUS = 0.8;

export class WaypointRenderer {
  private markers: WaypointMarker[] = [];
  private geometry: THREE.RingGeometry;
  private terrain: TerrainData;

  constructor(private scene: THREE.Scene, events: EventBus, terrain: TerrainData) {
    this.terrain = terrain;
    this.geometry = new THREE.RingGeometry(MARKER_RADIUS * 0.6, MARKER_RADIUS, 16);

    events.on('command:move', (destX, destZ) => {
      this.addMarker(destX as number, destZ as number, 0x44dddd);
    });

    events.on('command:rally', (destX, destZ) => {
      this.addMarker(destX as number, destZ as number, 0x44ff88);
    });
  }

  private addMarker(x: number, z: number, color: number): void {
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    const y = this.terrain.getHeight(x, z) + 0.2;
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.markers.push({ mesh, timeLeft: MARKER_DURATION });
  }

  update(dt: number): void {
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const marker = this.markers[i];
      marker.timeLeft -= dt;

      if (marker.timeLeft <= 0) {
        this.scene.remove(marker.mesh);
        (marker.mesh.material as THREE.Material).dispose();
        this.markers.splice(i, 1);
      } else {
        // Fade out
        const mat = marker.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.min(0.8, marker.timeLeft / MARKER_DURATION * 0.8);
      }
    }
  }
}
