import * as THREE from 'three';
import type { World } from '@core/ECS';
import { BUILDING, TEAM, POSITION, PRODUCTION_QUEUE, CONSTRUCTION, VOXEL_STATE, DEATH_TIMER, GARAGE_EXIT, GARAGE_ENTER, FERRY_DOCK } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { VoxelStateComponent, BufferedImpact } from '@sim/components/VoxelState';
import type { DeathTimerComponent } from '@sim/components/DeathTimer';
import type { FerryDockComponent } from '@sim/components/FerryDock';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import { VOXEL_SIZE, GARAGE_DOOR_MODEL, indexToCoords } from '@sim/data/VoxelModels';
import { buildVoxelGeometry } from '@render/VoxelGeometryBuilder';
import type { DebrisRenderer } from '@render/effects/DebrisRenderer';

const TEAM_COLORS = [0x4488ff, 0xff4444];

// Door model dimensions
const DOOR_VOXELS_Y = GARAGE_DOOR_MODEL.sizeY; // 8
const DOOR_HEIGHT = DOOR_VOXELS_Y * VOXEL_SIZE; // 1.2 wu

// Inset position: door sits at HQ grid z=21..22 (inside interior bay)
// HQ center is at entity.z, halfZ = 13.5 * VOXEL_SIZE = 2.025
// Grid z=21.5 center -> world offset = (21.5 - 13.5) * VOXEL_SIZE = 1.2
const DOOR_Z_OFFSET = 1.2;

// Door closed Y: aligns door y=0 with HQ y=1 -> offset = 1 * VOXEL_SIZE = 0.15
const DOOR_CLOSED_Y_OFFSET = 1 * VOXEL_SIZE;

// Animation timing
const OPEN_SPEED = DOOR_HEIGHT / 1.0;   // slides up fully in ~1s
const CLOSE_SPEED = DOOR_HEIGHT / 0.8;  // closes slightly faster
const OPEN_TRIGGER_TIME = 1.5;          // start opening when production has <=1.5s left
const CLOSE_DELAY = 2.0;               // seconds after spawn before closing

// Damage sync threshold: rebuild geometry when HQ damage changes by this much
const DAMAGE_REBUILD_THRESHOLD = 0.01;

// Scorch mark constants (mirrors VoxelMeshManager)
const SCORCH_REBUILD_INTERVAL = 6;
const HEAT_DECAY_PER_REBUILD = SCORCH_REBUILD_INTERVAL * (1 / 60) / 1.5;

type DoorState = 'closed' | 'opening' | 'open' | 'closing';

interface DoorTracker {
  entity: number;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  state: DoorState;
  openAmount: number;       // 0 = closed, 1 = fully open
  closeTimer: number;       // countdown to start closing after open
  lastQueueLength: number;  // detect when a unit spawns (queue shrinks)
  team: number;
  destroyed: Uint8Array;    // door's own destroyed bitmask
  lastDamageRatio: number;  // last synced HQ damage ratio
  clipPlane: THREE.Plane;
  isFlashing: boolean;
  hasExploded: boolean;
  // Stable random ordering for progressive damage (seeded by entity ID)
  damageOrder: number[];
  // Scorch mark state
  scorchHeat: Float32Array;
  scorchRebuildTimer: number;
  hasCoolingVoxels: boolean;
}

export class GarageDoorRenderer {
  private scene: THREE.Scene;
  private debrisRenderer: DebrisRenderer;
  private trackers = new Map<number, DoorTracker>();
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;
  private flashMaterial: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, debrisRenderer: DebrisRenderer) {
    this.scene = scene;
    this.debrisRenderer = debrisRenderer;
    this.flashMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.0,
      vertexColors: false,
    });
  }

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  update(world: World, dt: number): void {
    const buildings = world.query(BUILDING, TEAM, POSITION);
    const activeHQs = new Set<number>();

    for (const e of buildings) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;

      activeHQs.add(e);

      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const queue = world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE);

      let tracker = this.trackers.get(e);
      if (!tracker) {
        tracker = this.createDoor(e, team.team);
        this.trackers.set(e, tracker);
      }

      // Skip all logic if already exploded
      if (tracker.hasExploded) continue;

      // Check for death timer (HQ dying)
      const deathTimer = world.getComponent<DeathTimerComponent>(e, DEATH_TIMER);
      if (deathTimer) {
        if (deathTimer.timeRemaining > 0 && !deathTimer.exploded) {
          // Flash white
          if (!tracker.isFlashing) {
            this.flashMaterial.clippingPlanes = [tracker.clipPlane];
            tracker.mesh.material = this.flashMaterial;
            tracker.isFlashing = true;
          }
          const flashIntensity = Math.sin(deathTimer.timeRemaining * 30) * 0.5 + 0.5;
          this.flashMaterial.color.setRGB(
            0.5 + 0.5 * flashIntensity,
            0.5 + 0.5 * flashIntensity,
            0.5 + 0.5 * flashIntensity,
          );
        } else if (deathTimer.exploded || deathTimer.timeRemaining <= 0) {
          // Explode all remaining door voxels as debris
          this.explodeDoor(tracker, pos);
          tracker.hasExploded = true;
          tracker.mesh.visible = false;
          continue;
        }
      } else {
        // Sync door damage with HQ voxel state
        const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
        if (voxelState && voxelState.totalVoxels > 0) {
          const damageRatio = voxelState.destroyedCount / voxelState.totalVoxels;
          if (Math.abs(damageRatio - tracker.lastDamageRatio) > DAMAGE_REBUILD_THRESHOLD) {
            this.syncDamage(tracker, damageRatio);
          }
        }

        // Direct impact damage on the door (read from buffered impacts)
        if (voxelState?.recentImpacts && voxelState.recentImpacts.length > 0) {
          for (const impact of voxelState.recentImpacts) {
            this.applyImpact(tracker, impact, pos);
          }
          voxelState.recentImpacts.length = 0;
        }
      }

      // State machine transitions
      const queueLen = queue ? queue.queue.length : 0;
      const firstItem = queue && queue.queue.length > 0 ? queue.queue[0] : null;

      // Check if any GARAGE_EXIT entity is inside this HQ (ferry or unit exiting)
      const hasGarageExiter = this.hasGarageExitNear(world, pos.x, pos.z);
      const shouldOpen = (firstItem && firstItem.timeRemaining <= OPEN_TRIGGER_TIME) || hasGarageExiter;

      switch (tracker.state) {
        case 'closed':
          if (shouldOpen) {
            tracker.state = 'opening';
          }
          break;

        case 'opening':
          if (queueLen === 0 && !hasGarageExiter) {
            tracker.state = 'closing';
            break;
          }
          if (tracker.openAmount >= 1.0) {
            tracker.state = 'open';
            tracker.openAmount = 1.0;
          }
          break;

        case 'open':
          if (queueLen < tracker.lastQueueLength) {
            tracker.closeTimer = CLOSE_DELAY;
          }
          if (hasGarageExiter) {
            tracker.closeTimer = CLOSE_DELAY;
          }
          if (tracker.closeTimer > 0) {
            tracker.closeTimer -= dt;
            if (tracker.closeTimer <= 0) {
              if (shouldOpen) {
                tracker.closeTimer = 0;
              } else {
                tracker.state = 'closing';
              }
            }
          } else if (queueLen === 0 && !hasGarageExiter) {
            tracker.state = 'closing';
          }
          break;

        case 'closing':
          if (shouldOpen) {
            tracker.state = 'opening';
            break;
          }
          if (tracker.openAmount <= 0) {
            tracker.state = 'closed';
            tracker.openAmount = 0;
          }
          break;
      }

      tracker.lastQueueLength = queueLen;

      // Animate door position
      if (tracker.state === 'opening') {
        tracker.openAmount = Math.min(1.0, tracker.openAmount + (OPEN_SPEED / DOOR_HEIGHT) * dt);
      } else if (tracker.state === 'closing') {
        tracker.openAmount = Math.max(0, tracker.openAmount - (CLOSE_SPEED / DOOR_HEIGHT) * dt);
      }

      // Position the door mesh
      const doorY = pos.y + DOOR_CLOSED_Y_OFFSET + tracker.openAmount * DOOR_HEIGHT;
      tracker.mesh.position.set(pos.x, doorY, pos.z + DOOR_Z_OFFSET);

      // Clip door geometry above garage opening (y=10 is where solid wall starts)
      tracker.clipPlane.constant = pos.y + 10 * VOXEL_SIZE;

      // Fog visibility
      const visible = !this.fogState || this.playerTeam < 0
        || this.fogState.isVisible(this.playerTeam, pos.x, pos.z);
      tracker.mesh.visible = visible;
    }

    // Scorch heat decay for cooling doors
    for (const [, tracker] of this.trackers) {
      if (!tracker.hasCoolingVoxels || tracker.hasExploded) continue;

      tracker.scorchRebuildTimer--;
      if (tracker.scorchRebuildTimer > 0) continue;

      tracker.scorchRebuildTimer = SCORCH_REBUILD_INTERVAL;

      let stillCooling = false;
      const heat = tracker.scorchHeat;
      for (let i = 0; i < heat.length; i++) {
        const h = heat[i];
        if (h <= 0) continue;
        heat[i] = h - HEAT_DECAY_PER_REBUILD;
        if (heat[i] <= 0) {
          heat[i] = -1; // Permanent ash
        } else {
          stillCooling = true;
        }
      }

      tracker.hasCoolingVoxels = stillCooling;

      // Rebuild geometry with updated scorch
      const model = GARAGE_DOOR_MODEL;
      const built = buildVoxelGeometry(model, tracker.destroyed, tracker.team, tracker.scorchHeat);
      tracker.mesh.geometry.dispose();
      tracker.mesh.geometry = built.bodyGeometry;
    }

    // Clean up destroyed HQs
    for (const [entity, tracker] of this.trackers) {
      if (!activeHQs.has(entity)) {
        this.scene.remove(tracker.mesh);
        tracker.mesh.geometry.dispose();
        if (tracker.mesh.material === tracker.material) {
          tracker.material.dispose();
        }
        this.trackers.delete(entity);
      }
    }
  }

  /** Check if any entity is exiting, entering, or approaching the garage. */
  private hasGarageExitNear(world: World, hqX: number, hqZ: number): boolean {
    // Check exiting entities (inside the garage, moving +Z)
    const exiters = world.query(GARAGE_EXIT, POSITION);
    for (const e of exiters) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - hqX;
      const dz = pos.z - hqZ;
      if (dx * dx + dz * dz < 16 && pos.z < hqZ + 3) {
        return true;
      }
    }
    // Check entering entities (driving -Z into garage)
    const enterers = world.query(GARAGE_ENTER, POSITION);
    for (const e of enterers) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - hqX;
      const dz = pos.z - hqZ;
      if (dx * dx + dz * dz < 16 && pos.z < hqZ + 4) {
        return true;
      }
    }
    // Check returning ferries approaching the garage (opens door before arrival)
    const ferries = world.query(FERRY_DOCK, POSITION);
    for (const f of ferries) {
      const dock = world.getComponent<FerryDockComponent>(f, FERRY_DOCK)!;
      if (!dock.returning) continue;
      const pos = world.getComponent<PositionComponent>(f, POSITION)!;
      const dx = pos.x - hqX;
      const dz = pos.z - (hqZ + 2.5); // Distance to garage entrance
      const distSq = dx * dx + dz * dz;
      if (distSq < 16) { // Within 4 units of garage entrance
        return true;
      }
    }
    return false;
  }

  private createDoor(entity: number, team: number): DoorTracker {
    const model = GARAGE_DOOR_MODEL;
    const destroyed = new Uint8Array(Math.ceil(model.totalSolid / 8));
    const scorchHeat = new Float32Array(model.totalSolid);
    const built = buildVoxelGeometry(model, destroyed, team, scorchHeat);

    const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.3,
      clippingPlanes: [clipPlane],
    });
    const mesh = new THREE.Mesh(built.bodyGeometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.scene.add(mesh);

    // Build stable random damage order seeded by entity ID
    const damageOrder: number[] = [];
    for (let i = 0; i < model.totalSolid; i++) {
      damageOrder.push(i);
    }
    // Simple deterministic shuffle using entity ID as seed
    let seed = entity * 2654435761;
    for (let i = damageOrder.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [damageOrder[i], damageOrder[j]] = [damageOrder[j], damageOrder[i]];
    }

    return {
      entity,
      mesh,
      material,
      state: 'closed',
      openAmount: 0,
      closeTimer: 0,
      lastQueueLength: 0,
      team,
      destroyed,
      lastDamageRatio: 0,
      clipPlane,
      isFlashing: false,
      hasExploded: false,
      damageOrder,
      scorchHeat,
      scorchRebuildTimer: 0,
      hasCoolingVoxels: false,
    };
  }

  private syncDamage(tracker: DoorTracker, hqDamageRatio: number): void {
    const model = GARAGE_DOOR_MODEL;
    const targetDestroyed = Math.floor(hqDamageRatio * model.totalSolid);
    let currentDestroyed = 0;

    // Count current destroyed
    for (let si = 0; si < model.totalSolid; si++) {
      if (tracker.destroyed[si >> 3] & (1 << (si & 7))) currentDestroyed++;
    }

    // Destroy more voxels to match ratio
    if (targetDestroyed > currentDestroyed) {
      let destroyed = currentDestroyed;
      for (const si of tracker.damageOrder) {
        if (destroyed >= targetDestroyed) break;
        const byteIdx = si >> 3;
        const bitIdx = si & 7;
        if (!(tracker.destroyed[byteIdx] & (1 << bitIdx))) {
          tracker.destroyed[byteIdx] |= (1 << bitIdx);
          destroyed++;
        }
      }
    }

    // Rebuild geometry
    const built = buildVoxelGeometry(model, tracker.destroyed, tracker.team, tracker.scorchHeat);
    tracker.mesh.geometry.dispose();
    tracker.mesh.geometry = built.bodyGeometry;
    tracker.lastDamageRatio = hqDamageRatio;
  }

  private applyImpact(tracker: DoorTracker, impact: BufferedImpact, hqPos: PositionComponent): void {
    const model = GARAGE_DOOR_MODEL;
    const doorPos = tracker.mesh.position;
    const halfX = (model.sizeX * VOXEL_SIZE) / 2;
    const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;

    // Convert impact to door-local grid coordinates
    const localX = impact.impactX - doorPos.x;
    const localY = impact.impactY - doorPos.y;
    const localZ = impact.impactZ - doorPos.z;

    const gridX = Math.floor((localX + halfX) / VOXEL_SIZE);
    const gridY = Math.floor(localY / VOXEL_SIZE);
    const gridZ = Math.floor((localZ + halfZ) / VOXEL_SIZE);

    // Check if impact is within or near the door grid
    const blastR = impact.blastRadius;
    if (gridX < -blastR || gridX >= model.sizeX + blastR) return;
    if (gridY < -blastR || gridY >= model.sizeY + blastR) return;
    if (gridZ < -blastR || gridZ >= model.sizeZ + blastR) return;

    let anyDestroyed = false;

    for (let dy = -blastR; dy <= blastR; dy++) {
      for (let dz = -blastR; dz <= blastR; dz++) {
        for (let dx = -blastR; dx <= blastR; dx++) {
          const gx = gridX + dx;
          const gy = gridY + dy;
          const gz = gridZ + dz;

          if (gx < 0 || gx >= model.sizeX || gy < 0 || gy >= model.sizeY || gz < 0 || gz >= model.sizeZ) continue;
          if (dx * dx + dy * dy + dz * dz > blastR * blastR + 1) continue;

          const gridIdx = gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ;
          if (model.grid[gridIdx] === 0) continue;

          const solidIdx = model.gridToSolid[gridIdx];
          if (solidIdx === -1) continue;

          const byteIdx = solidIdx >> 3;
          const bitIdx = solidIdx & 7;
          if (tracker.destroyed[byteIdx] & (1 << bitIdx)) continue;

          // Destroy voxel
          tracker.destroyed[byteIdx] |= (1 << bitIdx);
          anyDestroyed = true;

          // Spawn debris
          const [svGx, svGy, svGz] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);
          const wx = doorPos.x - halfX + svGx * VOXEL_SIZE + VOXEL_SIZE * 0.5;
          const wy = doorPos.y + svGy * VOXEL_SIZE + VOXEL_SIZE * 0.5;
          const wz = doorPos.z - halfZ + svGz * VOXEL_SIZE + VOXEL_SIZE * 0.5;

          let color = TEAM_COLORS[tracker.team] ?? 0xffffff;
          const palIdx = model.solidVoxels[solidIdx][1];
          if (palIdx !== 254 && palIdx !== 253) {
            color = model.palette[palIdx] ?? 0x333333;
          }

          this.debrisRenderer.spawn(
            wx, wy, wz,
            -impact.dirX + (Math.random() - 0.5) * 0.4,
            -impact.dirY + Math.random() * 0.5,
            -impact.dirZ + (Math.random() - 0.5) * 0.4,
            color,
            1.0,
            0xffffff,
          );
        }
      }
    }

    // Scorch surviving voxels near impact (blastR + 1 radius)
    const scorchR = blastR + 1;
    for (let dy = -scorchR; dy <= scorchR; dy++) {
      for (let dz = -scorchR; dz <= scorchR; dz++) {
        for (let dx = -scorchR; dx <= scorchR; dx++) {
          const gx = gridX + dx;
          const gy = gridY + dy;
          const gz = gridZ + dz;

          if (gx < 0 || gx >= model.sizeX || gy < 0 || gy >= model.sizeY || gz < 0 || gz >= model.sizeZ) continue;
          if (dx * dx + dy * dy + dz * dz > scorchR * scorchR + 1) continue;

          const gridIdx = gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ;
          if (model.grid[gridIdx] === 0) continue;

          const solidIdx = model.gridToSolid[gridIdx];
          if (solidIdx === -1) continue;

          // Skip destroyed voxels
          if (tracker.destroyed[solidIdx >> 3] & (1 << (solidIdx & 7))) continue;

          const randomHeat = 0.7 + Math.random() * 0.3;
          tracker.scorchHeat[solidIdx] = Math.max(tracker.scorchHeat[solidIdx], randomHeat);
        }
      }
    }
    tracker.hasCoolingVoxels = true;
    tracker.scorchRebuildTimer = 0;

    if (anyDestroyed || tracker.hasCoolingVoxels) {
      const built = buildVoxelGeometry(model, tracker.destroyed, tracker.team, tracker.scorchHeat);
      tracker.mesh.geometry.dispose();
      tracker.mesh.geometry = built.bodyGeometry;
    }
  }

  private explodeDoor(tracker: DoorTracker, hqPos: PositionComponent): void {
    const model = GARAGE_DOOR_MODEL;
    const pos = tracker.mesh.position;

    // Half-sizes for centering
    const halfX = model.sizeX * VOXEL_SIZE * 0.5;
    const halfZ = model.sizeZ * VOXEL_SIZE * 0.5;
    const centerY = pos.y + model.sizeY * VOXEL_SIZE * 0.5;

    for (let si = 0; si < model.totalSolid; si++) {
      const byteIdx = si >> 3;
      const bitIdx = si & 7;
      if (tracker.destroyed[byteIdx] & (1 << bitIdx)) continue;

      const [gridIdx, palIdx] = model.solidVoxels[si];
      const [gx, gy, gz] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);

      // World position of this voxel
      const wx = pos.x - halfX + gx * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const wy = pos.y + gy * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const wz = pos.z - halfZ + gz * VOXEL_SIZE + VOXEL_SIZE * 0.5;

      // Resolve color
      let color = TEAM_COLORS[tracker.team] ?? 0xffffff;
      if (palIdx !== 254 && palIdx !== 253) {
        color = model.palette[palIdx] ?? 0x333333;
      }

      // Direction from center outward
      const dirX = wx - pos.x;
      const dirY = wy - centerY;
      const dirZ = wz - hqPos.z; // Bias outward from HQ center
      const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;

      this.debrisRenderer.spawn(
        wx, wy, wz,
        (dirX / len) * 2.5 + (Math.random() - 0.5) * 1.0,
        (dirY / len) * 2.5 + Math.random() * 1.5,
        (dirZ / len) * 2.5 + (Math.random() - 0.5) * 1.0,
        color,
        1.0,
        0xffffff,
      );

      tracker.destroyed[byteIdx] |= (1 << bitIdx);
    }
  }

  /** Remove all tracked door meshes but keep the renderer alive (for world revert). */
  clearAll(): void {
    for (const [, tracker] of this.trackers) {
      this.scene.remove(tracker.mesh);
      tracker.mesh.geometry.dispose();
      tracker.material.dispose();
    }
    this.trackers.clear();
  }

  dispose(): void {
    this.clearAll();
    this.flashMaterial.dispose();
  }
}
