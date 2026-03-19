import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';

const MAX_DEBRIS = 5000;
const LUNAR_GRAVITY = 1.6;
const BOUNCE_RESTITUTION = 0.3;
const MAX_BOUNCES = 3;

// Emissive fade: ~1.2 seconds from full to zero
const EMISSIVE_DECAY_RATE = 0.8;

// Debris stays full size until the last FADE_DURATION seconds of its life
const FADE_DURATION = 1.5;

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
  isRubble: boolean;
  emissive: number; // 0-1 glow intensity
  glowColor: THREE.Color;
  dieOnGlowFade: boolean;
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
  private emissiveArray: Float32Array;
  private emissiveAttr: THREE.InstancedBufferAttribute;
  private glowColorArray: Float32Array;
  private glowColorAttr: THREE.InstancedBufferAttribute;

  constructor(scene: THREE.Scene, terrainData: TerrainData) {
    this.terrainData = terrainData;

    const geometry = new THREE.BoxGeometry(1, 1, 1);

    // Per-instance emissive intensity attribute
    this.emissiveArray = new Float32Array(MAX_DEBRIS);
    this.emissiveAttr = new THREE.InstancedBufferAttribute(this.emissiveArray, 1);
    geometry.setAttribute('aInstanceEmissive', this.emissiveAttr);

    // Per-instance glow color (RGB) — used only for emissive tint, not diffuse
    this.glowColorArray = new Float32Array(MAX_DEBRIS * 3);
    this.glowColorAttr = new THREE.InstancedBufferAttribute(this.glowColorArray, 3);
    geometry.setAttribute('aInstanceGlowColor', this.glowColorAttr);

    const material = new THREE.MeshStandardMaterial({
      roughness: 0.8,
      metalness: 0.2,
    });

    // Inject per-instance emissive + glow color into the shader
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          [
            'attribute float aInstanceEmissive;',
            'attribute vec3 aInstanceGlowColor;',
            'varying float vInstanceEmissive;',
            'varying vec3 vInstanceGlowColor;',
            'void main() {',
          ].join('\n'),
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvInstanceEmissive = aInstanceEmissive;\nvInstanceGlowColor = aInstanceGlowColor;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'varying float vInstanceEmissive;\nvarying vec3 vInstanceGlowColor;\nvoid main() {',
        )
        .replace(
          'vec3 totalEmissiveRadiance = emissive;',
          'vec3 totalEmissiveRadiance = emissive + vInstanceEmissive * 1.5 * vInstanceGlowColor;',
        );
    };
    material.customProgramCacheKey = () => 'debris-emissive-v2';

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
        isRubble: false,
        emissive: 0,
        glowColor: new THREE.Color(1, 1, 1),
        dieOnGlowFade: false,
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

  /** Spawn a single debris particle. initialEmissive = 0-1 glow intensity (0 = no glow). */
  spawn(
    x: number, y: number, z: number,
    dirX: number, dirY: number, dirZ: number,
    color: number,
    initialEmissive = 0,
    glowColor = 0xffffff,
    dieOnGlowFade = false,
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

    p.maxLifetime = 5.0 + Math.random() * 3.0;
    p.lifetime = p.maxLifetime;
    p.bounces = 0;
    p.isRubble = false;
    p.color.setHex(color);
    p.emissive = initialEmissive;
    p.glowColor.setHex(glowColor);
    p.dieOnGlowFade = dieOnGlowFade;

    this.activeCount = Math.max(this.activeCount, slot + 1);
  }

  /** Spawn a debris particle that arcs from source to target position.
   *  Uses projectile physics (gravity) with calculated initial velocity. */
  spawnArc(
    srcX: number, srcY: number, srcZ: number,
    tgtX: number, tgtY: number, tgtZ: number,
    color: number,
    initialEmissive = 0.8,
    glowColor = 0x44aaff,
  ): void {
    let slot = -1;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (!this.particles[i].alive) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return;

    const p = this.particles[slot];
    p.alive = true;
    p.x = srcX;
    p.y = srcY;
    p.z = srcZ;

    // Calculate velocity for a parabolic arc from src to tgt
    const flightTime = 0.6 + Math.random() * 0.3; // 0.6-0.9 seconds
    const dx = tgtX - srcX;
    const dy = tgtY - srcY;
    const dz = tgtZ - srcZ;

    // vx = dx/t, vz = dz/t, vy = (dy + 0.5*g*t^2) / t
    p.vx = dx / flightTime + (Math.random() - 0.5) * 1.0;
    p.vy = (dy + 0.5 * LUNAR_GRAVITY * flightTime * flightTime) / flightTime;
    p.vz = dz / flightTime + (Math.random() - 0.5) * 1.0;

    p.ax = (Math.random() - 0.5) * 12;
    p.ay = (Math.random() - 0.5) * 12;
    p.az = (Math.random() - 0.5) * 12;
    p.rotX = Math.random() * Math.PI * 2;
    p.rotY = Math.random() * Math.PI * 2;
    p.rotZ = Math.random() * Math.PI * 2;

    // Short lifetime — particle should disappear near the target
    p.maxLifetime = flightTime + 0.3;
    p.lifetime = p.maxLifetime;
    p.bounces = 0;
    p.isRubble = false;
    p.color.setHex(color);
    p.emissive = initialEmissive;
    p.glowColor.setHex(glowColor);
    p.dieOnGlowFade = true; // die once glow fades (short-lived transfer particle)

    this.activeCount = Math.max(this.activeCount, slot + 1);
  }

  /** Spawn a static rubble piece that sits on the ground and fades over time */
  spawnRubble(x: number, y: number, z: number, color: number): void {
    let slot = -1;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (!this.particles[i].alive) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return;

    const p = this.particles[slot];
    p.alive = true;
    p.x = x + (Math.random() - 0.5) * 0.3;
    p.y = y;
    p.z = z + (Math.random() - 0.5) * 0.3;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.ax = 0;
    p.ay = 0;
    p.az = 0;
    p.rotX = Math.random() * Math.PI * 2;
    p.rotY = Math.random() * Math.PI * 2;
    p.rotZ = Math.random() * Math.PI * 2;
    p.maxLifetime = 120 + Math.random() * 60;
    p.lifetime = p.maxLifetime;
    p.bounces = MAX_BOUNCES; // already settled
    p.isRubble = true;
    p.color.setHex(color);
    p.emissive = 0;

    this.activeCount = Math.max(this.activeCount, slot + 1);
  }

  /** Spawn a burst of debris from a destruction event */
  spawnBurst(
    x: number, y: number, z: number,
    dirX: number, dirY: number, dirZ: number,
    color: number,
    count: number,
    glowColor = 0xffffff,
  ): void {
    // Normalize direction
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const ndx = dirX / len;
    const ndy = dirY / len;
    const ndz = dirZ / len;

    for (let i = 0; i < count; i++) {
      this.spawn(x, y, z, ndx, ndy, ndz, color, 0, glowColor);
    }
  }

  update(dt: number): void {
    let maxAliveSlot = 0;
    let hasEmissive = false;

    for (let i = 0; i < this.activeCount; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;

      p.lifetime -= dt;
      if (p.lifetime <= 0) {
        p.alive = false;
        _mat4.makeScale(0, 0, 0);
        this.instancedMesh.setMatrixAt(i, _mat4);
        this.emissiveArray[i] = 0;
        continue;
      }

      maxAliveSlot = i + 1;

      // Decay emissive glow
      if (p.emissive > 0) {
        p.emissive = Math.max(0, p.emissive - dt * EMISSIVE_DECAY_RATE);
        if (p.emissive === 0 && p.dieOnGlowFade) {
          p.alive = false;
          _mat4.makeScale(0, 0, 0);
          this.instancedMesh.setMatrixAt(i, _mat4);
          this.emissiveArray[i] = 0;
          continue;
        }
      }

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

      // Scale: full size most of life, shrink only in the last FADE_DURATION seconds
      const lifeRatio = p.lifetime / p.maxLifetime;
      const fadeThreshold = p.isRubble ? 0.1 : FADE_DURATION / p.maxLifetime;
      const s = lifeRatio > fadeThreshold
        ? 0.15
        : 0.15 * (lifeRatio / fadeThreshold);

      // Set matrix
      _euler.set(p.rotX, p.rotY, p.rotZ);
      _quat.setFromEuler(_euler);
      _pos.set(p.x, p.y, p.z);
      _scale.set(s, s, s);
      _mat4.compose(_pos, _quat, _scale);
      this.instancedMesh.setMatrixAt(i, _mat4);

      // Diffuse color stays as p.color always — glow is purely additive via shader
      this.instancedMesh.setColorAt(i, p.color);

      if (p.emissive > 0) {
        this.emissiveArray[i] = p.emissive;
        this.glowColorArray[i * 3 + 0] = p.glowColor.r;
        this.glowColorArray[i * 3 + 1] = p.glowColor.g;
        this.glowColorArray[i * 3 + 2] = p.glowColor.b;
        hasEmissive = true;
      } else {
        this.emissiveArray[i] = 0;
      }
    }

    this.activeCount = maxAliveSlot;
    this.instancedMesh.count = this.activeCount;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
    if (hasEmissive) {
      this.emissiveAttr.needsUpdate = true;
      this.glowColorAttr.needsUpdate = true;
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  dispose(): void {
    this.instancedMesh.geometry.dispose();
    (this.instancedMesh.material as THREE.Material).dispose();
    this.instancedMesh.dispose();
  }
}
