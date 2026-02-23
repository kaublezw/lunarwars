import * as THREE from 'three';

const POOL_SIZE = 2000;
const SPARK_LIFETIME = 0.8;
const SPARK_SPEED = 10.0;
const GRAVITY = 8.0;

export interface BurstOptions {
  speed?: number;
  gravity?: number;
  lifetime?: number;
  spread?: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  life: number;
  maxLife: number;
  active: boolean;
}

const sparkGeometry = new THREE.SphereGeometry(0.06, 4, 3);

export class ParticleRenderer {
  private particles: Particle[] = [];
  private pool: number[] = []; // indices of inactive particles

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffaa33,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(sparkGeometry, material);
      mesh.visible = false;
      scene.add(mesh);

      this.particles.push({
        mesh,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: GRAVITY,
        life: 0,
        maxLife: SPARK_LIFETIME,
        active: false,
      });
      this.pool.push(i);
    }
  }

  spawnBurst(
    x: number, y: number, z: number,
    dirX: number, dirZ: number,
    color: number,
    count: number,
    opts?: BurstOptions,
  ): void {
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
    const ndx = dirX / dirLen;
    const ndz = dirZ / dirLen;

    const speed = opts?.speed ?? SPARK_SPEED;
    const gravity = opts?.gravity ?? GRAVITY;
    const lifetime = opts?.lifetime ?? SPARK_LIFETIME;
    const spread = opts?.spread ?? 1.2;

    for (let i = 0; i < count; i++) {
      if (this.pool.length === 0) return;
      const idx = this.pool.pop()!;
      const p = this.particles[idx];

      // Fan spread: base direction + random spread angle
      const spreadAngle = (Math.random() - 0.5) * spread;
      const cosA = Math.cos(spreadAngle);
      const sinA = Math.sin(spreadAngle);
      const fanX = ndx * cosA - ndz * sinA;
      const fanZ = ndx * sinA + ndz * cosA;

      const s = speed * (0.5 + Math.random() * 0.5);

      p.vx = fanX * s;
      p.vy = (Math.random() * 0.5 + 0.3) * s;
      p.vz = fanZ * s;
      p.gravity = gravity;
      p.life = lifetime * (0.7 + Math.random() * 0.3);
      p.maxLife = p.life;
      p.active = true;

      p.mesh.position.set(x, y, z);
      p.mesh.visible = true;
      (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        this.pool.push(i);
        continue;
      }

      // Move
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;

      // Gravity (per-particle)
      p.vy -= p.gravity * dt;

      // Fade opacity
      const t = p.life / p.maxLife;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
  }

  dispose(): void {
    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry?.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.particles.length = 0;
    this.pool.length = 0;
  }
}
