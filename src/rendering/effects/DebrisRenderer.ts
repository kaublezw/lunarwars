import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';

const MAX_DEBRIS = 5000;
const LUNAR_GRAVITY = 1.6;
const BOUNCE_RESTITUTION = 0.3;
const MAX_BOUNCES = 3;

interface DebrisParticle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number; // angular velocity
  ay: number;
  az: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  lifetime: number;
  maxLifetime: number;
  bounces: number;
  color: THREE.Color;
}

// Temp objects
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();

export class DebrisRenderer {
  private instancedMesh: THREE.InstancedMesh;
  private particles: DebrisParticle[] = [];
  private activeCount = 0;
  private terrainData: TerrainData;

  constructor(scene: THREE.Scene, terrainData: TerrainData) {
    this.terrainData = terrainData;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.8,
      metalness: 0.2,
    });

    this.instancedMesh = new THREE.InstancedMesh(geometry, material, MAX_DEBRIS);
    this.instancedMesh.count = 0;
    this.instancedMesh.castShadow = false;
    this.instancedMesh.receiveShadow = false;
    this.instancedMesh.frustumCulled = false;

    // Initialize particle pool
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.particles.push({
        alive: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 0, az: 0,
        rotX: 0, rotY: 0, rotZ: 0,
        lifetime: 0,
        maxLifetime: 0,
        bounces: 0,
        color: new THREE.Color(),
      });
    }

    // Hide all instances initially
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.instancedMesh.setMatrixAt(i, _mat4);
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true;

    scene.add(this.instancedMesh);
  }

  /** Spawn a single debris particle */
  spawn(
    x: number, y: number, z: number,
    dirX: number, dirY: number, dirZ: number,
    color: number,
  ): void {
    // Find a dead particle slot
    let slot = -1;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (!this.particles[i].alive) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return; // pool exhausted

    const p = this.particles[slot];
    p.alive = true;
    p.x = x;
    p.y = y;
    p.z = z;

    // Velocity: outward direction + random scatter
    const speed = 4 + Math.random() * 6;
    p.vx = dirX * speed + (Math.random() - 0.5) * 3;
    p.vy = dirY * speed + Math.random() * 3; // upward bias
    p.vz = dirZ * speed + (Math.random() - 0.5) * 3;

    // Angular velocity (tumbling)
    p.ax = (Math.random() - 0.5) * 16;
    p.ay = (Math.random() - 0.5) * 16;
    p.az = (Math.random() - 0.5) * 16;
    p.rotX = Math.random() * Math.PI * 2;
    p.rotY = Math.random() * Math.PI * 2;
    p.rotZ = Math.random() * Math.PI * 2;

    p.maxLifetime = 2.0 + Math.random() * 1.5;
    p.lifetime = p.maxLifetime;
    p.bounces = 0;
    p.color.setHex(color);

    this.activeCount = Math.max(this.activeCount, slot + 1);
  }

  /** Spawn a burst of debris from a destruction event */
  spawnBurst(
    x: number, y: number, z: number,
    dirX: number, dirY: number, dirZ: number,
    color: number,
    count: number,
  ): void {
    // Normalize direction
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const ndx = dirX / len;
    const ndy = dirY / len;
    const ndz = dirZ / len;

    for (let i = 0; i < count; i++) {
      this.spawn(x, y, z, ndx, ndy, ndz, color);
    }
  }

  update(dt: number): void {
    let maxAliveSlot = 0;

    for (let i = 0; i < this.activeCount; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;

      p.lifetime -= dt;
      if (p.lifetime <= 0) {
        p.alive = false;
        _mat4.makeScale(0, 0, 0);
        this.instancedMesh.setMatrixAt(i, _mat4);
        continue;
      }

      maxAliveSlot = i + 1;

      // Physics: gravity + velocity
      p.vy -= LUNAR_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Rotation
      p.rotX += p.ax * dt;
      p.rotY += p.ay * dt;
      p.rotZ += p.az * dt;

      // Terrain collision
      const terrainY = this.terrainData.getHeight(p.x, p.z);
      if (p.y < terrainY && p.bounces < MAX_BOUNCES) {
        p.y = terrainY;
        p.vy = Math.abs(p.vy) * BOUNCE_RESTITUTION;
        p.vx *= 0.7;
        p.vz *= 0.7;
        p.ax *= 0.5;
        p.ay *= 0.5;
        p.az *= 0.5;
        p.bounces++;
      } else if (p.y < terrainY) {
        // Settled on ground
        p.y = terrainY;
        p.vy = 0;
        p.vx *= 0.9;
        p.vz *= 0.9;
      }

      // Scale fades with lifetime
      const lifeRatio = p.lifetime / p.maxLifetime;
      const s = 0.15 * lifeRatio; // voxel size, shrinking over time

      // Set matrix
      _euler.set(p.rotX, p.rotY, p.rotZ);
      _quat.setFromEuler(_euler);
      _pos.set(p.x, p.y, p.z);
      _scale.set(s, s, s);
      _mat4.compose(_pos, _quat, _scale);
      this.instancedMesh.setMatrixAt(i, _mat4);
      this.instancedMesh.setColorAt(i, p.color);
    }

    this.activeCount = maxAliveSlot;
    this.instancedMesh.count = this.activeCount;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.instancedMesh.geometry.dispose();
    (this.instancedMesh.material as THREE.Material).dispose();
    this.instancedMesh.dispose();
  }
}
