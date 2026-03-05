import * as THREE from 'three';
import type { Entity, World } from '@core/ECS';
import { POSITION, RENDERABLE, TEAM, VOXEL_STATE, BUILDING, DEATH_TIMER, TURRET } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { TeamComponent } from '@sim/components/Team';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import {
  VOXEL_SIZE, VOXEL_MODELS, SHARED_PALETTE,
  PAL_TEAM_PRIMARY, PAL_TEAM_ACCENT,
  indexToCoords,
} from '@sim/data/VoxelModels';
import type { VoxelModel } from '@sim/data/VoxelModels';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { DeathTimerComponent } from '@sim/components/DeathTimer';
import type { TurretComponent } from '@sim/components/Turret';
import type { DebrisRenderer } from '@render/effects/DebrisRenderer';
import { buildVoxelGeometry } from '@render/VoxelGeometryBuilder';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const TEAM_ACCENT_COLORS = [0x88bbff, 0xff8888];

// Temp objects to avoid per-frame allocation
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _turretEuler = new THREE.Euler();
const _turretQuat = new THREE.Quaternion();
const _pos = new THREE.Vector3();

const _material = new THREE.MeshStandardMaterial({
  roughness: 0.7,
  metalness: 0.3,
  vertexColors: true,
});

// Inject per-vertex emissive attribute into the standard material shader
_material.onBeforeCompile = (shader) => {
  // Vertex: declare attribute and varying, pass emissive to fragment
  shader.vertexShader = shader.vertexShader
    .replace(
      'void main() {',
      'attribute vec3 aEmissive;\nvarying vec3 vEmissive;\nvoid main() {',
    )
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvEmissive = aEmissive;',
    );

  // Fragment: declare varying and add to total emissive radiance
  shader.fragmentShader = shader.fragmentShader
    .replace(
      'void main() {',
      'varying vec3 vEmissive;\nvoid main() {',
    )
    .replace(
      'vec3 totalEmissiveRadiance = emissive;',
      'vec3 totalEmissiveRadiance = emissive + vEmissive;',
    );
};
_material.customProgramCacheKey = () => 'voxel-emissive';

// White flash material for death timer
const _flashMaterial = new THREE.MeshStandardMaterial({
  roughness: 0.7,
  metalness: 0.3,
  vertexColors: false,
  color: 0xffffff,
});

// Scorch rebuild interval in frames (~10fps at 60fps)
const SCORCH_REBUILD_INTERVAL = 6;
// Heat decay per rebuild (covers SCORCH_REBUILD_INTERVAL frames)
const HEAT_DECAY_PER_REBUILD = SCORCH_REBUILD_INTERVAL * (1 / 60) / 1.5;

interface EntityMeshState {
  bodyMesh: THREE.Mesh;
  turretMesh: THREE.Mesh | null;
  model: VoxelModel;
  meshType: string;
  team: number;
  /** True when damage has been taken and geometry needs rebuild */
  geometryDirty: boolean;
  /** True if this entity has its own geometry (damaged). False = shares template. */
  hasOwnGeometry: boolean;
  /** True while flashing white during death */
  isFlashing: boolean;
  /** Per-solid-voxel heat values for scorch. >0=cooling, 0=never scorched, -1=permanent ash. null=no scorch. */
  scorchHeat: Float32Array | null;
  /** Frame counter for periodic scorch geometry rebuilds */
  scorchRebuildTimer: number;
  /** True if any voxel has heat > 0 (still cooling) */
  hasCoolingVoxels: boolean;
}

/** Cache key for template geometries: "modelId:team" */
type TemplateCacheKey = string;

export class VoxelMeshManager {
  // Entity tracking
  private entityStates = new Map<Entity, EntityMeshState>();
  private trackedEntities = new Set<Entity>();

  // Template cache: undamaged geometry per model+team
  private templateCache = new Map<TemplateCacheKey, { body: THREE.BufferGeometry; turret: THREE.BufferGeometry | null }>();

  // Fog state
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;

  // Bounding boxes for selection renderer
  private entityBounds = new Map<Entity, THREE.Box3>();

  // Debris renderer for spawning debris on voxel destruction
  private debrisRenderer: DebrisRenderer | null = null;

  constructor(private scene: THREE.Scene) {}

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  setDebrisRenderer(dr: DebrisRenderer): void {
    this.debrisRenderer = dr;
  }

  /** Get the world-space bounding box for an entity (for selection renderer) */
  getEntityBounds(entity: Entity): THREE.Box3 | undefined {
    return this.entityBounds.get(entity);
  }

  /** Get the body mesh for an entity */
  getEntityMesh(entity: Entity): THREE.Mesh | null {
    const state = this.entityStates.get(entity);
    return state ? state.bodyMesh : null;
  }

  /** Check if an entity is managed by this renderer */
  hasEntity(entity: Entity): boolean {
    return this.entityStates.has(entity);
  }

  sync(world: World, alpha: number): void {
    const entities = world.query(POSITION, VOXEL_STATE);
    const currentEntities = new Set<Entity>(entities);

    // Add new entities or handle changes
    for (const e of entities) {
      const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE)!;
      const renderable = world.getComponent<RenderableComponent>(e, RENDERABLE);
      const team = world.getComponent<TeamComponent>(e, TEAM);
      const teamNum = team ? team.team : 0;

      const existing = this.entityStates.get(e);

      if (!existing) {
        this.addEntity(e, voxelState, renderable, teamNum, world);
      } else if (existing.meshType !== voxelState.modelId) {
        // Model changed (e.g., construction_site -> building)
        this.removeEntity(e);
        this.addEntity(e, voxelState, renderable, teamNum, world);
      } else if (voxelState.dirty) {
        // Damage changed - mark for rebuild and handle debris
        const pos = world.getComponent<PositionComponent>(e, POSITION)!;
        const isBuilding = world.hasComponent(e, BUILDING);
        const turret = world.getComponent<TurretComponent>(e, TURRET);
        this.updateDamage(e, voxelState, pos, isBuilding, turret?.turretRotation, existing.model.turretMinY, existing.model.turretMaxY);
        voxelState.dirty = false;
      }
    }

    // Handle death timer explosions
    for (const e of entities) {
      const deathTimer = world.getComponent<DeathTimerComponent>(e, DEATH_TIMER);
      if (!deathTimer) continue;

      const state = this.entityStates.get(e);
      if (!state) continue;

      if (deathTimer.timeRemaining > 0 && !deathTimer.exploded) {
        // Flash white during death delay
        if (!state.isFlashing) {
          state.bodyMesh.material = _flashMaterial;
          if (state.turretMesh) state.turretMesh.material = _flashMaterial;
          state.isFlashing = true;
        }
        const flashIntensity = Math.sin(deathTimer.timeRemaining * 30) * 0.5 + 0.5;
        _flashMaterial.color.setRGB(
          0.5 + 0.5 * flashIntensity,
          0.5 + 0.5 * flashIntensity,
          0.5 + 0.5 * flashIntensity,
        );
      } else if (!deathTimer.exploded) {
        // Timer reached 0: explode all remaining voxels as debris
        const pos = world.getComponent<PositionComponent>(e, POSITION);
        const isBuilding = world.hasComponent(e, BUILDING);
        if (pos && this.debrisRenderer) {
          const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE)!;
          const model = state.model;
          const turret = world.getComponent<TurretComponent>(e, TURRET);

          // For buildings: pre-select bottom-layer voxels as rubble (spawned during
          // the loop to guarantee pool slots before flying debris fills it)
          const rubbleSet = new Set<number>();
          if (isBuilding) {
            const candidates: number[] = [];
            for (let si = 0; si < model.totalSolid; si++) {
              const byteIdx = si >> 3;
              const bitIdx = si & 7;
              if (voxelState.destroyed[byteIdx] & (1 << bitIdx)) continue;
              const [gridIdx] = model.solidVoxels[si];
              const [, gy] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);
              if (gy <= 1) candidates.push(si);
            }
            // Shuffle and pick a random subset
            for (let i = candidates.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
            }
            const rubbleCount = Math.min(50 + Math.floor(Math.random() * 51), candidates.length);
            for (let i = 0; i < rubbleCount; i++) rubbleSet.add(candidates[i]);
          }

          for (let si = 0; si < model.totalSolid; si++) {
            const byteIdx = si >> 3;
            const bitIdx = si & 7;
            if (voxelState.destroyed[byteIdx] & (1 << bitIdx)) continue;

            if (rubbleSet.has(si)) {
              // Spawn as persistent rubble at foundation level
              const worldPos = this.getDestroyedVoxelWorldPos(e, si, pos, isBuilding, turret?.turretRotation, model.turretMinY, model.turretMaxY);
              if (worldPos) {
                this.debrisRenderer.spawnRubble(worldPos.x, pos.y, worldPos.z, worldPos.color);
              }
            } else {
              // Only spawn flying debris for surface voxels (at least one empty neighbor)
              const [gridIdx] = model.solidVoxels[si];
              const [gx, gy, gz] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);
              let isSurface = false;
              const sx = model.sizeX;
              const sy = model.sizeY;
              const sz = model.sizeZ;
              // Check 6 neighbors: if any is out-of-bounds or empty, this is a surface voxel
              if (gx <= 0 || gx >= sx - 1 || gy <= 0 || gy >= sy - 1 || gz <= 0 || gz >= sz - 1) {
                isSurface = true;
              } else {
                const neighbors = [
                  (gx - 1) + gz * sx + gy * sx * sz,
                  (gx + 1) + gz * sx + gy * sx * sz,
                  gx + gz * sx + (gy - 1) * sx * sz,
                  gx + gz * sx + (gy + 1) * sx * sz,
                  gx + (gz - 1) * sx + gy * sx * sz,
                  gx + (gz + 1) * sx + gy * sx * sz,
                ];
                for (const ni of neighbors) {
                  if (model.grid[ni] === 0) {
                    isSurface = true;
                    break;
                  }
                }
              }

              if (isSurface) {
                const worldPos = this.getDestroyedVoxelWorldPos(e, si, pos, isBuilding, turret?.turretRotation, model.turretMinY, model.turretMaxY);
                if (worldPos) {
                  const centerY = pos.y + model.sizeY * VOXEL_SIZE * 0.5;
                  const dirX = worldPos.x - pos.x;
                  const dirY = worldPos.y - centerY;
                  const dirZ = worldPos.z - pos.z;
                  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
                  this.debrisRenderer.spawn(
                    worldPos.x, worldPos.y, worldPos.z,
                    (dirX / len) * 2.5 + (Math.random() - 0.5) * 1.0,
                    (dirY / len) * 2.5 + Math.random() * 1.5,
                    (dirZ / len) * 2.5 + (Math.random() - 0.5) * 1.0,
                    worldPos.color,
                    1.0, // explosion debris starts fully lit
                    0xffffff, // death explosion stays white
                  );
                }
              }
              // else: interior voxel, silently mark destroyed below
            }

            voxelState.destroyed[byteIdx] |= (1 << bitIdx);
            voxelState.destroyedCount++;
          }

          // Hide meshes
          state.bodyMesh.visible = false;
          if (state.turretMesh) state.turretMesh.visible = false;
        }

        deathTimer.exploded = true;
      }
    }

    // Periodic scorch heat decay and geometry rebuild for cooling entities
    for (const e of entities) {
      const state = this.entityStates.get(e);
      if (!state || !state.hasCoolingVoxels || !state.scorchHeat) continue;

      state.scorchRebuildTimer--;
      if (state.scorchRebuildTimer > 0) continue;

      // Reset timer for next rebuild
      state.scorchRebuildTimer = SCORCH_REBUILD_INTERVAL;

      // Decay heat and check if still cooling
      let stillCooling = false;
      const heat = state.scorchHeat;

      for (let i = 0; i < heat.length; i++) {
        const h = heat[i];
        if (h <= 0) continue; // Already settled (0 = never scorched, -1 = permanent ash)

        heat[i] = h - HEAT_DECAY_PER_REBUILD;
        if (heat[i] <= 0) {
          heat[i] = -1; // Permanent ash
        } else {
          stillCooling = true;
        }
      }

      state.hasCoolingVoxels = stillCooling;
      state.geometryDirty = true;
      if (!state.hasOwnGeometry) {
        state.hasOwnGeometry = true;
      }
    }

    // Rebuild any dirty geometries
    for (const e of entities) {
      const state = this.entityStates.get(e);
      if (!state || !state.geometryDirty) continue;
      state.geometryDirty = false;

      const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE)!;
      const scorchHeat = state.scorchHeat ?? undefined;
      const result = buildVoxelGeometry(state.model, voxelState.destroyed, state.team, scorchHeat);

      // Dispose old geometry if we own it
      if (state.hasOwnGeometry) {
        state.bodyMesh.geometry.dispose();
        if (state.turretMesh) state.turretMesh.geometry.dispose();
      }

      state.bodyMesh.geometry = result.bodyGeometry;
      if (state.turretMesh && result.turretGeometry) {
        state.turretMesh.geometry = result.turretGeometry;
      }
      state.hasOwnGeometry = true;
    }

    // Update positions for all tracked entities
    for (const e of entities) {
      const state = this.entityStates.get(e);
      if (!state) continue;

      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const isBuilding = world.hasComponent(e, BUILDING);

      // Interpolate
      const ix = pos.prevX + (pos.x - pos.prevX) * alpha;
      const iy = pos.prevY + (pos.y - pos.prevY) * alpha;
      const iz = pos.prevZ + (pos.z - pos.prevZ) * alpha;
      const rotation = pos.rotation;

      // Fog of war visibility
      let visible = true;
      if (this.fogState && this.playerTeam >= 0) {
        const team = world.getComponent<TeamComponent>(e, TEAM);
        if (team && team.team !== this.playerTeam) {
          const fogVisible = this.fogState.isVisible(this.playerTeam, pos.x, pos.z);
          if (fogVisible) {
            visible = true;
          } else if (this.fogState.isExplored(this.playerTeam, pos.x, pos.z) && isBuilding) {
            visible = true;
          } else {
            visible = false;
          }
        }
      }

      // Update bounding box
      const model = state.model;
      const halfX = (model.sizeX * VOXEL_SIZE) / 2;
      const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;
      let bounds = this.entityBounds.get(e);
      if (!bounds) {
        bounds = new THREE.Box3();
        this.entityBounds.set(e, bounds);
      }
      bounds.min.set(ix - halfX, iy, iz - halfZ);
      bounds.max.set(ix + halfX, iy + model.sizeY * VOXEL_SIZE, iz + halfZ);

      state.bodyMesh.visible = visible;
      if (state.turretMesh) state.turretMesh.visible = visible;

      if (!visible) continue;

      // Position body mesh
      state.bodyMesh.position.set(ix, iy, iz);
      if (!isBuilding) {
        _euler.set(0, rotation, 0);
        _quat.setFromEuler(_euler);
        state.bodyMesh.quaternion.copy(_quat);
      }

      // Position turret mesh
      if (state.turretMesh) {
        const turret = world.getComponent<TurretComponent>(e, TURRET);
        const pivotY = (model.turretMinY ?? 0) * VOXEL_SIZE;

        state.turretMesh.position.set(ix, iy + pivotY, iz);

        if (!isBuilding && turret) {
          _turretEuler.set(turret.turretPitch, turret.turretRotation, 0, 'YXZ');
          _turretQuat.setFromEuler(_turretEuler);
          state.turretMesh.quaternion.copy(_turretQuat);
        }
      }
    }

    // Remove entities that no longer exist
    for (const e of this.trackedEntities) {
      if (!currentEntities.has(e)) {
        this.removeEntity(e);
      }
    }

    this.trackedEntities = currentEntities;
  }

  private getOrCreateTemplate(modelId: string, team: number, model: VoxelModel): { body: THREE.BufferGeometry; turret: THREE.BufferGeometry | null } {
    const key: TemplateCacheKey = `${modelId}:${team}`;
    let cached = this.templateCache.get(key);
    if (!cached) {
      const emptyDestroyed = new Uint8Array(Math.ceil(model.totalSolid / 8));
      const result = buildVoxelGeometry(model, emptyDestroyed, team);
      cached = { body: result.bodyGeometry, turret: result.turretGeometry };
      this.templateCache.set(key, cached);
    }
    return cached;
  }

  private addEntity(e: Entity, voxelState: VoxelStateComponent, _renderable: RenderableComponent | undefined, team: number, world: World): void {
    const model = VOXEL_MODELS[voxelState.modelId];
    if (!model) return;
    if (model.totalSolid === 0) return;

    const hasDamage = voxelState.destroyedCount > 0;
    let bodyGeo: THREE.BufferGeometry;
    let turretGeo: THREE.BufferGeometry | null = null;
    let hasOwnGeometry: boolean;

    if (hasDamage) {
      // Build individual geometry for damaged entity
      const result = buildVoxelGeometry(model, voxelState.destroyed, team);
      bodyGeo = result.bodyGeometry;
      turretGeo = result.turretGeometry;
      hasOwnGeometry = true;
    } else {
      // Use shared template geometry
      const template = this.getOrCreateTemplate(voxelState.modelId, team, model);
      bodyGeo = template.body;
      turretGeo = template.turret;
      hasOwnGeometry = false;
    }

    const bodyMesh = new THREE.Mesh(bodyGeo, _material);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = false;
    this.scene.add(bodyMesh);

    // Enable layer 1 on building meshes for XRay depth pass
    if (world.hasComponent(e, BUILDING)) {
      bodyMesh.layers.enable(1);
    }

    let turretMesh: THREE.Mesh | null = null;
    if (turretGeo) {
      turretMesh = new THREE.Mesh(turretGeo, _material);
      turretMesh.castShadow = true;
      turretMesh.receiveShadow = false;
      this.scene.add(turretMesh);

      if (world.hasComponent(e, BUILDING)) {
        turretMesh.layers.enable(1);
      }
    }

    this.entityStates.set(e, {
      bodyMesh,
      turretMesh,
      model,
      meshType: voxelState.modelId,
      team,
      geometryDirty: false,
      hasOwnGeometry,
      isFlashing: false,
      scorchHeat: null,
      scorchRebuildTimer: 0,
      hasCoolingVoxels: false,
    });

    this.trackedEntities.add(e);
    voxelState.dirty = false;
  }

  private removeEntity(e: Entity): void {
    const state = this.entityStates.get(e);
    if (!state) return;

    this.scene.remove(state.bodyMesh);
    if (state.hasOwnGeometry) {
      state.bodyMesh.geometry.dispose();
    }

    if (state.turretMesh) {
      this.scene.remove(state.turretMesh);
      if (state.hasOwnGeometry) {
        state.turretMesh.geometry.dispose();
      }
    }

    this.entityStates.delete(e);
    this.entityBounds.delete(e);
    this.trackedEntities.delete(e);
  }

  private updateDamage(e: Entity, voxelState: VoxelStateComponent, pos: PositionComponent, isBuilding: boolean, turretRotation?: number, turretMinY?: number, turretMaxY?: number): void {
    const state = this.entityStates.get(e);
    if (!state) return;

    // Spawn debris for newly destroyed voxels
    const model = state.model;
    const debrisDirMap = new Map<number, { dirX: number; dirY: number; dirZ: number }>();
    for (const info of voxelState.pendingDebris) {
      debrisDirMap.set(info.solidIndex, { dirX: info.dirX, dirY: info.dirY, dirZ: info.dirZ });
    }
    voxelState.pendingDebris.length = 0;

    if (this.debrisRenderer) {
      for (let si = 0; si < model.totalSolid; si++) {
        const byteIdx = si >> 3;
        const bitIdx = si & 7;
        const isDestroyed = (voxelState.destroyed[byteIdx] & (1 << bitIdx)) !== 0;
        if (!isDestroyed) continue;

        const debrisDir = debrisDirMap.get(si);
        if (!debrisDir) continue; // Only spawn debris for newly destroyed (has pending dir)

        const worldPos = this.getDestroyedVoxelWorldPos(e, si, pos, isBuilding, turretRotation, turretMinY, turretMaxY);
        if (worldPos) {
          this.debrisRenderer.spawn(
            worldPos.x, worldPos.y, worldPos.z,
            debrisDir.dirX, debrisDir.dirY, debrisDir.dirZ,
            worldPos.color,
            1.0, // hit debris starts fully lit
            0xff6600, // orange glow matches scorch hue
          );
        }
      }
    }

    // Process pending scorch marks
    if (voxelState.pendingScorch.length > 0) {
      if (!state.scorchHeat) {
        state.scorchHeat = new Float32Array(model.totalSolid);
      }
      for (const solidIdx of voxelState.pendingScorch) {
        if (solidIdx < model.totalSolid) {
          // Random initial heat (0.7-1.0) so adjacent voxels cool at different rates
          const randomHeat = 0.7 + Math.random() * 0.3;
          // Max with existing heat so overlapping impacts don't reset cooling voxels
          state.scorchHeat[solidIdx] = Math.max(state.scorchHeat[solidIdx], randomHeat);
        }
      }
      voxelState.pendingScorch.length = 0;
      state.hasCoolingVoxels = true;
      // Trigger immediate rebuild for new scorch marks
      state.scorchRebuildTimer = 0;
    }

    // If entity was sharing template, it now needs its own geometry
    if (!state.hasOwnGeometry) {
      state.hasOwnGeometry = true;
      // Will be rebuilt on next sync pass via geometryDirty
    }

    state.geometryDirty = true;
  }

  /** Get info about a destroyed voxel for debris spawning */
  getDestroyedVoxelWorldPos(
    entity: Entity,
    solidIndex: number,
    pos: PositionComponent,
    isBuilding: boolean,
    turretRotation?: number,
    turretMinY?: number,
    turretMaxY?: number,
  ): { x: number; y: number; z: number; color: number } | null {
    const state = this.entityStates.get(entity);
    if (!state) return null;

    const model = state.model;
    if (solidIndex >= model.totalSolid) return null;

    const [gridIdx, palIdx] = model.solidVoxels[solidIndex];
    const [gx, gy, gz] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);

    const halfX = (model.sizeX * VOXEL_SIZE) / 2;
    const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;

    _pos.set(
      (gx + 0.5) * VOXEL_SIZE - halfX,
      (gy + 0.5) * VOXEL_SIZE,
      (gz + 0.5) * VOXEL_SIZE - halfZ,
    );

    if (!isBuilding) {
      const isTurretVoxel = turretMinY != null && turretRotation != null && gy >= turretMinY &&
        (turretMaxY == null || gy <= turretMaxY);
      const rot = isTurretVoxel ? turretRotation : pos.rotation;
      _euler.set(0, rot, 0);
      _quat.setFromEuler(_euler);
      _pos.applyQuaternion(_quat);
    }

    _pos.x += pos.x;
    _pos.y += pos.y;
    _pos.z += pos.z;

    // Resolve color
    let color: number;
    if (palIdx === PAL_TEAM_PRIMARY) {
      color = TEAM_COLORS[state.team] ?? 0xffffff;
    } else if (palIdx === PAL_TEAM_ACCENT) {
      color = TEAM_ACCENT_COLORS[state.team] ?? 0xffffff;
    } else {
      color = SHARED_PALETTE[palIdx] ?? 0xff00ff;
    }

    return { x: _pos.x, y: _pos.y, z: _pos.z, color };
  }

  dispose(): void {
    for (const [, state] of this.entityStates) {
      this.scene.remove(state.bodyMesh);
      if (state.turretMesh) this.scene.remove(state.turretMesh);
      if (state.hasOwnGeometry) {
        state.bodyMesh.geometry.dispose();
        if (state.turretMesh) state.turretMesh.geometry.dispose();
      }
    }
    this.entityStates.clear();

    for (const [, cached] of this.templateCache) {
      cached.body.dispose();
      if (cached.turret) cached.turret.dispose();
    }
    this.templateCache.clear();

    _material.dispose();
    _flashMaterial.dispose();
  }
}
