import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Entity, World } from '@core/ECS';
import { POSITION, RENDERABLE, TURRET, TEAM, BUILDING, VOXEL_STATE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { TurretComponent } from '@sim/components/Turret';
import type { TeamComponent } from '@sim/components/Team';
import type { ParticleRenderer } from '@render/effects/ParticleRenderer';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

// Shared geometries for primitive mesh types (units + construction site only)
const geometries: Record<string, THREE.BufferGeometry> = {
  cube: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 8, 6),
  cylinder: new THREE.CylinderGeometry(0.3, 0.5, 1, 8),
  combat_drone: new THREE.BoxGeometry(0.5, 0.9, 0.5),
  aerial_drone: new THREE.CylinderGeometry(1, 1, 0.3, 8),
  worker_drone: new THREE.BoxGeometry(0.7, 0.5, 0.7),
  construction_site: new THREE.BoxGeometry(2, 0.5, 2),
  projectile: new THREE.BoxGeometry(0.15, 0.15, 0.15),
};

function createBuildingGroup(meshType: string, color: number): THREE.Group | null {
  const baseColor = new THREE.Color(color).multiplyScalar(0.5);
  const accentColor = new THREE.Color(color);

  const makeMat = (c: THREE.Color) => new THREE.MeshStandardMaterial({
    color: c,
    roughness: 0.7,
    metalness: 0.3,
  });

  const group = new THREE.Group();

  switch (meshType) {
    case 'hq': {
      // Box base + command tower on top + thin antenna
      const base = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), makeMat(baseColor));
      base.position.y = 1;
      base.castShadow = true;
      group.add(base);

      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), makeMat(accentColor));
      tower.position.y = 3;
      tower.castShadow = true;
      group.add(tower);

      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.5, 6), makeMat(accentColor));
      antenna.position.y = 4.75;
      group.add(antenna);
      break;
    }
    case 'energy_extractor': {
      // Hexagonal cylinder base + glowing sphere on top
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 2, 6), makeMat(baseColor));
      base.position.y = 1;
      base.castShadow = true;
      group.add(base);

      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 12, 8),
        new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x3388cc, emissiveIntensity: 0.8, roughness: 0.3 }),
      );
      orb.position.y = 2.5;
      group.add(orb);
      break;
    }
    case 'matter_plant': {
      // Box base + tall cylinder chimney offset to one corner
      const base = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), makeMat(baseColor));
      base.position.y = 1;
      base.castShadow = true;
      group.add(base);

      const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 3, 8), makeMat(accentColor));
      chimney.position.set(1.0, 3.5, 1.0);
      chimney.castShadow = true;
      group.add(chimney);
      break;
    }
    case 'supply_depot': {
      // Wide flat platform + two small storage boxes on corners
      const platform = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.6, 3.5), makeMat(baseColor));
      platform.position.y = 0.3;
      platform.castShadow = true;
      group.add(platform);

      const crate1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), makeMat(accentColor));
      crate1.position.set(-1.0, 1.0, -1.0);
      crate1.castShadow = true;
      group.add(crate1);

      const crate2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), makeMat(accentColor));
      crate2.position.set(1.0, 1.0, 1.0);
      crate2.castShadow = true;
      group.add(crate2);
      break;
    }
    case 'drone_factory': {
      // Large box body + taller tower on one side + small dish on top
      const body = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.5, 3.5), makeMat(baseColor));
      body.position.y = 1.25;
      body.castShadow = true;
      group.add(body);

      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.8, 1.2), makeMat(accentColor));
      tower.position.set(-1.2, 3.4, 0);
      tower.castShadow = true;
      group.add(tower);

      const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.2, 0.3, 8), makeMat(accentColor));
      dish.position.set(-1.2, 4.6, 0);
      group.add(dish);
      break;
    }
    default:
      return null;
  }

  return group;
}

// GLTF model paths keyed by meshType
const modelPaths: Record<string, string> = {
  assault_platform: '/models/assault_platform.glb',
};

// Y-axis rotation offsets (radians) to align model forward with game forward
const modelRotationOffsets: Record<string, number> = {
  assault_platform: -Math.PI / 2,
};

// Vertical offset to adjust model placement relative to ground
const modelYOffsets: Record<string, number> = {
  assault_platform: -0.4,
};

const TURRET_TURN_SPEED = 3.0; // radians per second
const RECOIL_DISTANCE = 0.6;
const RECOIL_DURATION = 0.3;
const SHOCK_TILT_ANGLE = 0.18;   // max lean in radians (~10 degrees)
const SHOCK_FREQUENCY = 8.0;     // oscillation speed (rad/s)
const SHOCK_DAMPING = 3.5;       // how fast the spring settles
const SHOCK_DURATION = 1.0;      // total animation time
const MUZZLE_SPARK_COUNT_GLTF = 16;
const MUZZLE_SPARK_COUNT_PRIM = 8;
const PRIMITIVE_SHOCK_SCALE = 0.3;

interface TurretRef {
  turret: THREE.Object3D;
  barrel: THREE.Object3D;
  barrelTip: THREE.Object3D; // empty at the barrel tip for world-position queries
  rotCompensation: number; // undo parent rotation chain to get world-space aiming
  recoilTimer: number;
  recoilActive: boolean;
  barrelRestX: number;
  shockTimer: number;
  shockActive: boolean;
  shockAxisX: number; // world-space tilt axis (perpendicular to fire dir, in XZ plane)
  shockAxisZ: number;
  isPrimitive: boolean; // true for primitive meshes, false for GLTF models
}

const GHOST_OPACITY = 0.35;
const GHOST_GREY = new THREE.Color(0.4, 0.4, 0.4);
const GHOST_GREY_LERP = 0.6; // how much to desaturate toward grey

export class RenderSync {
  private objects = new Map<Entity, THREE.Object3D>();
  private meshTypes = new Map<Entity, string>();
  private turrets = new Map<Entity, TurretRef>();
  private trackedEntities = new Set<Entity>();
  private ghostedEntities = new Set<Entity>();
  private originalMaterials = new Map<Entity, Map<THREE.Material, { color: THREE.Color; opacity: number; transparent: boolean }>>();
  private loadedModels = new Map<string, THREE.Object3D>();
  private loadingModels = new Map<string, Promise<THREE.Object3D>>();
  private loader = new GLTFLoader();
  private particleRenderer: ParticleRenderer | null = null;
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;
  private muzzleWorldPos = new THREE.Vector3();
  private baseQuat = new THREE.Quaternion();
  private tiltQuat = new THREE.Quaternion();
  private tiltAxis = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {}

  getObject(entity: Entity): THREE.Object3D | undefined {
    return this.objects.get(entity);
  }

  setParticleRenderer(pr: ParticleRenderer): void {
    this.particleRenderer = pr;
  }

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  private applyGhostEffect(entity: Entity, obj: THREE.Object3D): void {
    if (this.ghostedEntities.has(entity)) return;
    this.ghostedEntities.add(entity);

    const originals = new Map<THREE.Material, { color: THREE.Color; opacity: number; transparent: boolean }>();
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
            if (!originals.has(mat)) {
              originals.set(mat, {
                color: mat.color.clone(),
                opacity: mat.opacity,
                transparent: mat.transparent,
              });
            }
            mat.color.lerp(GHOST_GREY, GHOST_GREY_LERP);
            mat.opacity = GHOST_OPACITY;
            mat.transparent = true;
          }
        }
      }
    });
    this.originalMaterials.set(entity, originals);
  }

  private removeGhostEffect(entity: Entity, obj: THREE.Object3D): void {
    if (!this.ghostedEntities.has(entity)) return;
    this.ghostedEntities.delete(entity);

    const originals = this.originalMaterials.get(entity);
    if (originals) {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of mats) {
            const orig = originals.get(mat);
            if (orig) {
              mat.color.copy(orig.color);
              mat.opacity = orig.opacity;
              mat.transparent = orig.transparent;
            }
          }
        }
      });
      this.originalMaterials.delete(entity);
    }
  }

  async preload(): Promise<void> {
    const entries = Object.entries(modelPaths);
    await Promise.all(entries.map(async ([key, path]) => {
      const gltf = await this.loader.loadAsync(path);
      this.loadedModels.set(key, gltf.scene);
    }));
  }

  sync(world: World, alpha: number): void {
    const entities = world.query(POSITION, RENDERABLE);
    const currentEntities = new Set<Entity>(entities);

    // Add new entities or recreate if meshType changed
    // Skip entities with VOXEL_STATE — those are handled by VoxelMeshManager
    for (const e of entities) {
      if (world.hasComponent(e, VOXEL_STATE)) continue;

      const renderable = world.getComponent<RenderableComponent>(e, RENDERABLE)!;
      const prevType = this.meshTypes.get(e);

      if (!this.objects.has(e)) {
        this.createObject(e, world);
      } else if (prevType && prevType !== renderable.meshType) {
        // meshType changed (e.g. construction_site -> building) -- recreate
        const oldObj = this.objects.get(e)!;
        this.scene.remove(oldObj);
        this.disposeObject(oldObj);
        this.objects.delete(e);
        this.turrets.delete(e);
        this.createObject(e, world);
      }
    }

    // Update existing entities with interpolated positions
    // Skip voxel entities for mesh positioning (VoxelMeshManager handles that)
    for (const e of entities) {
      if (world.hasComponent(e, VOXEL_STATE)) continue;

      const obj = this.objects.get(e);
      if (!obj) continue;

      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      obj.position.x = pos.prevX + (pos.x - pos.prevX) * alpha;
      obj.position.y = pos.prevY + (pos.y - pos.prevY) * alpha;
      obj.position.z = pos.prevZ + (pos.z - pos.prevZ) * alpha;
      obj.rotation.y = pos.rotation;

      // Fog of war visibility for enemy entities
      if (this.fogState) {
        if (this.playerTeam < 0) {
          // Spectator: no fog filtering, show everything
          obj.visible = true;
          this.removeGhostEffect(e, obj);
        } else {
          const team = world.getComponent<TeamComponent>(e, TEAM);
          if (team && team.team !== this.playerTeam) {
            const visible = this.fogState.isVisible(this.playerTeam, pos.x, pos.z);
            if (visible) {
              // Fully visible — show normally, remove ghost if was ghosted
              obj.visible = true;
              this.removeGhostEffect(e, obj);
            } else if (this.fogState.isExplored(this.playerTeam, pos.x, pos.z) && world.hasComponent(e, BUILDING)) {
              // Explored territory + building — show as faded ghost
              obj.visible = true;
              this.applyGhostEffect(e, obj);
            } else {
              // Unexplored or non-building unit — hide
              obj.visible = false;
            }
          } else {
            obj.visible = true;
          }
        }
      }
    }

    // Update turrets to track nearest unit (still applies to voxel entities for firing animation)
    this.updateTurrets(world, alpha);

    // Remove entities that no longer exist
    for (const e of this.trackedEntities) {
      if (!currentEntities.has(e)) {
        const obj = this.objects.get(e);
        if (obj) {
          this.scene.remove(obj);
          this.disposeObject(obj);
          this.objects.delete(e);
        }
        this.meshTypes.delete(e);
        this.turrets.delete(e);
        this.ghostedEntities.delete(e);
        this.originalMaterials.delete(e);
      }
    }

    this.trackedEntities = currentEntities;
  }

  private updateTurrets(world: World, _alpha: number): void {
    const dt = 1 / 60; // fixed timestep

    // Handle muzzle flash for voxel entities (no TurretRef, just particle effects)
    this.updateVoxelTurretEffects(world);

    for (const [entity, ref] of this.turrets) {
      const pos = world.getComponent<PositionComponent>(entity, POSITION);
      if (!pos) continue;

      const obj = this.objects.get(entity);
      const turret = world.getComponent<TurretComponent>(entity, TURRET);

      // Determine target position for aiming
      let hasTarget = false;
      let targetX = 0;
      let targetZ = 0;

      if (turret && turret.targetEntity !== -1) {
        hasTarget = true;
        targetX = turret.targetX;
        targetZ = turret.targetZ;
      }

      // Turret rotation: only for GLTF models (primitives rotate body via pos.rotation in sim)
      if (hasTarget && !ref.isPrimitive) {
        // Compute world-space angle to target
        const dx = targetX - pos.x;
        const dz = targetZ - pos.z;
        const targetWorldAngle = Math.atan2(dx, dz);

        // Convert to turret local space by undoing parent rotations
        const targetLocalAngle = targetWorldAngle - pos.rotation + ref.rotCompensation;

        // Smooth rotation toward target
        let diff = targetLocalAngle - ref.turret.rotation.y;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;

        const maxStep = TURRET_TURN_SPEED * dt;
        if (Math.abs(diff) <= maxStep) {
          ref.turret.rotation.y = targetLocalAngle;
        } else {
          ref.turret.rotation.y += Math.sign(diff) * maxStep;
        }
      }

      // Handle firing: recoil + particles
      if (turret && turret.firedThisFrame) {
        turret.firedThisFrame = false;
        const objVisible = obj ? obj.visible : true;

        // Barrel recoil only for GLTF models
        if (!ref.isPrimitive && objVisible) {
          ref.recoilActive = true;
          ref.recoilTimer = 0;
        }

        // Suspension shock — tilt chassis away from fire direction
        const dirX = targetX - pos.x;
        const dirZ = targetZ - pos.z;
        const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
        const ndx = dirX / dirLen;
        const ndz = dirZ / dirLen;
        if (objVisible) {
          ref.shockActive = true;
          ref.shockTimer = 0;
          ref.shockAxisX = -ndz;
          ref.shockAxisZ = ndx;
        }

        // Spawn particles using per-entity muzzle offset/height (only if visible)
        if (this.particleRenderer && objVisible) {
          const muzzleX = pos.x + ndx * turret.muzzleOffset;
          const muzzleY = pos.y + turret.muzzleHeight;
          const muzzleZ = pos.z + ndz * turret.muzzleOffset;
          const sparkCount = ref.isPrimitive ? MUZZLE_SPARK_COUNT_PRIM : MUZZLE_SPARK_COUNT_GLTF;
          this.particleRenderer.spawnBurst(
            muzzleX, muzzleY, muzzleZ,
            dirX, dirZ,
            0xffcc33,
            sparkCount,
          );
        }
      }

      // Animate barrel recoil (GLTF only)
      if (!ref.isPrimitive && ref.recoilActive) {
        ref.recoilTimer += dt;
        if (ref.recoilTimer >= RECOIL_DURATION) {
          ref.recoilActive = false;
          ref.barrel.position.x = ref.barrelRestX;
        } else {
          const t = ref.recoilTimer / RECOIL_DURATION;
          const recoilOffset = Math.sin(t * Math.PI) * RECOIL_DISTANCE;
          ref.barrel.position.x = ref.barrelRestX - recoilOffset;
        }
      }

      // Animate suspension shock — damped oscillation tilt via quaternion
      if (obj) {
        this.baseQuat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, pos.rotation);

        if (ref.shockActive) {
          ref.shockTimer += dt;
          if (ref.shockTimer >= SHOCK_DURATION) {
            ref.shockActive = false;
            obj.quaternion.copy(this.baseQuat);
          } else {
            const t = ref.shockTimer;
            const shockScale = ref.isPrimitive ? PRIMITIVE_SHOCK_SCALE : 1.0;
            const angle = Math.sin(SHOCK_FREQUENCY * t) * Math.exp(-SHOCK_DAMPING * t) * SHOCK_TILT_ANGLE * shockScale;
            this.tiltAxis.set(ref.shockAxisX, 0, ref.shockAxisZ).normalize();
            this.tiltQuat.setFromAxisAngle(this.tiltAxis, angle);
            obj.quaternion.multiplyQuaternions(this.tiltQuat, this.baseQuat);
          }
        } else {
          obj.quaternion.copy(this.baseQuat);
        }
      }
    }
  }

  /** Handle muzzle flash particles for voxel entities that don't have TurretRef entries */
  private updateVoxelTurretEffects(world: World): void {
    const turretEntities = world.query(POSITION, TURRET);
    for (const e of turretEntities) {
      // Skip non-voxel entities (handled by normal turret path)
      if (!world.hasComponent(e, VOXEL_STATE)) continue;
      // Skip if already tracked in turrets map
      if (this.turrets.has(e)) continue;

      const turret = world.getComponent<TurretComponent>(e, TURRET)!;
      if (!turret.firedThisFrame) continue;

      turret.firedThisFrame = false;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      if (!this.particleRenderer) continue;

      const dirX = turret.targetX - pos.x;
      const dirZ = turret.targetZ - pos.z;
      const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
      const ndx = dirX / dirLen;
      const ndz = dirZ / dirLen;

      const muzzleX = pos.x + ndx * turret.muzzleOffset;
      const muzzleY = pos.y + turret.muzzleHeight;
      const muzzleZ = pos.z + ndz * turret.muzzleOffset;

      this.particleRenderer.spawnBurst(
        muzzleX, muzzleY, muzzleZ,
        dirX, dirZ,
        0xffcc33,
        MUZZLE_SPARK_COUNT_PRIM,
      );
    }
  }

  private createObject(e: Entity, world: World): void {
    const renderable = world.getComponent<RenderableComponent>(e, RENDERABLE)!;
    const pos = world.getComponent<PositionComponent>(e, POSITION)!;

    this.meshTypes.set(e, renderable.meshType);

    const isBuilding = world.hasComponent(e, BUILDING);

    // Try compound building shapes first
    const buildingGroup = createBuildingGroup(renderable.meshType, renderable.color);
    if (buildingGroup) {
      if (isBuilding) this.enableBuildingLayer(buildingGroup);
      buildingGroup.scale.setScalar(renderable.scale);
      buildingGroup.position.set(pos.x, pos.y, pos.z);
      this.scene.add(buildingGroup);
      this.objects.set(e, buildingGroup);
      this.trackedEntities.add(e);
      return;
    }

    const template = this.loadedModels.get(renderable.meshType);
    let obj: THREE.Object3D;

    if (template) {
      // Wrap in a container so rotation offset doesn't fight entity rotation
      const container = new THREE.Group();
      const clone = template.clone();
      const rotOffset = modelRotationOffsets[renderable.meshType] ?? 0;
      const yOffset = modelYOffsets[renderable.meshType] ?? 0;
      clone.rotation.y = rotOffset;
      clone.position.y = yOffset;

      // Find turret node for independent rotation
      let turretNode: THREE.Object3D | null = null;
      clone.traverse((child) => {
        if (child.name === 'turret') turretNode = child;
      });

      // Collect meshes first, then modify — avoid mutating during traverse
      const meshes: THREE.Mesh[] = [];
      clone.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child);
      });
      // Darken base color for the solid material, use renderable color for wireframe
      const baseColor = new THREE.Color(renderable.color).multiplyScalar(0.4);
      for (const mesh of meshes) {
        mesh.castShadow = true;
        mesh.material = new THREE.MeshStandardMaterial({
          color: baseColor,
          roughness: 0.8,
          metalness: 0.2,
        });
        const wire = new THREE.Mesh(
          mesh.geometry,
          new THREE.MeshBasicMaterial({
            color: renderable.color,
            wireframe: true,
            transparent: true,
            opacity: 0.6,
          }),
        );
        mesh.add(wire);
      }
      container.add(clone);
      obj = container;

      // Register turret for tracking
      if (turretNode) {
        const tn: THREE.Object3D = turretNode;
        // Find barrel child node within turret subtree
        let barrelNode: THREE.Object3D | null = null;
        tn.traverse((child: THREE.Object3D) => {
          if (child.name === 'barrel') barrelNode = child;
        });
        const barrel: THREE.Object3D = barrelNode ?? tn;

        // Create an empty at the barrel tip (local +Z end)
        // Blender default cube extends -1..+1, so the barrel tip is at z = +1.
        // Nudge slightly past (+1.15) so sparks appear in front of the muzzle.
        const barrelTip = new THREE.Object3D();
        barrelTip.position.set(0, 0, 1.15);
        barrel.add(barrelTip);

        this.turrets.set(e, {
          turret: tn,
          barrel,
          barrelTip,
          rotCompensation: 0,
          recoilTimer: 0,
          recoilActive: false,
          barrelRestX: barrel.position.x,
          shockTimer: 0,
          shockActive: false,
          shockAxisX: 0,
          shockAxisZ: 0,
          isPrimitive: false,
        });
      }
    } else {
      const geometry = geometries[renderable.meshType] ?? geometries.cube;
      let material: THREE.Material;
      if (renderable.meshType === 'projectile') {
        // Projectiles glow with emissive
        material = new THREE.MeshStandardMaterial({
          color: renderable.color,
          emissive: renderable.color,
          emissiveIntensity: 2.0,
          roughness: 0.3,
          metalness: 0.0,
        });
      } else {
        material = new THREE.MeshStandardMaterial({
          color: renderable.color,
          roughness: 0.6,
          metalness: 0.3,
        });
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = renderable.meshType !== 'projectile';
      obj = mesh;

      // Register primitive mesh as turret if entity has TURRET component
      if (world.hasComponent(e, TURRET)) {
        this.turrets.set(e, {
          turret: mesh,
          barrel: mesh,
          barrelTip: mesh,
          rotCompensation: 0,
          recoilTimer: 0,
          recoilActive: false,
          barrelRestX: 0,
          shockTimer: 0,
          shockActive: false,
          shockAxisX: 0,
          shockAxisZ: 0,
          isPrimitive: true,
        });
      }
    }

    if (isBuilding) this.enableBuildingLayer(obj);

    obj.scale.setScalar(renderable.scale);
    obj.position.set(pos.x, pos.y, pos.z);

    this.scene.add(obj);
    this.objects.set(e, obj);
    this.trackedEntities.add(e);
  }

  private enableBuildingLayer(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      child.layers.enable(1);
    });
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of materials) mat.dispose();
        }
      }
    });
  }
}
