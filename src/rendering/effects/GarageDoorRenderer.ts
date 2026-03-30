import * as THREE from 'three';
import type { World } from '@core/ECS';
import { BUILDING, TEAM, POSITION, PRODUCTION_QUEUE, CONSTRUCTION, VOXEL_STATE, DEATH_TIMER } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { VoxelStateComponent, BufferedImpact } from '@sim/components/VoxelState';
import type { DeathTimerComponent } from '@sim/components/DeathTimer';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import { VOXEL_SIZE, GARAGE_DOOR_MODEL, FACTORY_DOOR_MODEL, FACTORY_ROOF_DOOR_MODEL, indexToCoords, type VoxelModel } from '@sim/data/VoxelModels';
import { UnitCategory } from '@sim/components/UnitType';
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

// Factory side door constants (32x22x32 factory, center at grid 16)
// Side opening: x=9..22, y=1..10, z=31. Interior bay z=27..30. Door inset at grid z~28.5
const FACTORY_SIDE_Z_OFFSET = (28.5 - 16) * VOXEL_SIZE; // 1.875 wu
const FACTORY_SIDE_Y_OFFSET = 1 * VOXEL_SIZE;            // 0.15 wu — door at y=1
const FACTORY_SIDE_DOOR_HEIGHT = 10 * VOXEL_SIZE;         // 1.5 wu
const FACTORY_SIDE_CLIP_VOXEL_Y = 11;                    // wall above door opening (y=11)

// Factory roof door constants (32x22x32 factory)
// Roof opening: x=8..23, y=13..17, z=8..23. Interior bay y=10..12
// Door sits at y=13 (bottom of upper hull opening)
const FACTORY_ROOF_Y_OFFSET = 13 * VOXEL_SIZE;            // 1.95 wu
const FACTORY_ROOF_X_CENTER = (15.5 - 16) * VOXEL_SIZE;   // -0.075 wu (near center)
const FACTORY_ROOF_Z_CENTER = (15.5 - 16) * VOXEL_SIZE;   // -0.075 wu
const FACTORY_ROOF_SLIDE_DIST = 16 * VOXEL_SIZE;          // 2.4 wu — slides +X fully open

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

interface SimpleDoor {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  state: DoorState;
  openAmount: number;
  closeTimer: number;
  clipPlane?: THREE.Plane;
  // Damage tracking
  model: VoxelModel;
  destroyed: Uint8Array;
  scorchHeat: Float32Array;
  damageOrder: number[];
  lastDamageRatio: number;
  hasCoolingVoxels: boolean;
  scorchRebuildTimer: number;
}

interface FactoryDoorsTracker {
  entity: number;
  side: SimpleDoor;
  roof: SimpleDoor;
  lastQueueLength: number;
  team: number;
  isFlashing: boolean;
  hasExploded: boolean;
}

export class GarageDoorRenderer {
  private scene: THREE.Scene;
  private debrisRenderer: DebrisRenderer;
  private trackers = new Map<number, DoorTracker>();
  private factoryTrackers = new Map<number, FactoryDoorsTracker>();
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
    const activeFactories = new Set<number>();

    for (const e of buildings) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;

      if (building.buildingType === BuildingType.DroneFactory) {
        activeFactories.add(e);
        this.updateFactory(world, e, dt);
        continue;
      }

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

      switch (tracker.state) {
        case 'closed':
          if (firstItem && firstItem.timeRemaining <= OPEN_TRIGGER_TIME) {
            tracker.state = 'opening';
          }
          break;

        case 'opening':
          if (queueLen === 0) {
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
          if (tracker.closeTimer > 0) {
            tracker.closeTimer -= dt;
            if (tracker.closeTimer <= 0) {
              if (firstItem && firstItem.timeRemaining <= OPEN_TRIGGER_TIME) {
                tracker.closeTimer = 0;
              } else {
                tracker.state = 'closing';
              }
            }
          } else if (queueLen === 0) {
            tracker.state = 'closing';
          }
          break;

        case 'closing':
          if (firstItem && firstItem.timeRemaining <= OPEN_TRIGGER_TIME) {
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

    // Scorch heat decay for factory doors
    for (const [, ft] of this.factoryTrackers) {
      if (ft.hasExploded) continue;
      const doors = [ft.side, ft.roof];
      for (const door of doors) {
        if (!door.hasCoolingVoxels) continue;
        door.scorchRebuildTimer--;
        if (door.scorchRebuildTimer > 0) continue;
        door.scorchRebuildTimer = SCORCH_REBUILD_INTERVAL;

        let stillCooling = false;
        const heat = door.scorchHeat;
        for (let i = 0; i < heat.length; i++) {
          const h = heat[i];
          if (h <= 0) continue;
          heat[i] = h - HEAT_DECAY_PER_REBUILD;
          if (heat[i] <= 0) {
            heat[i] = -1;
          } else {
            stillCooling = true;
          }
        }
        door.hasCoolingVoxels = stillCooling;

        const model = door.model;
        const built = buildVoxelGeometry(model, door.destroyed, ft.team, door.scorchHeat);
        door.mesh.geometry.dispose();
        door.mesh.geometry = built.bodyGeometry;
      }
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

    // Clean up destroyed factories
    for (const [entity, ft] of this.factoryTrackers) {
      if (!activeFactories.has(entity)) {
        this.scene.remove(ft.side.mesh);
        ft.side.mesh.geometry.dispose();
        ft.side.material.dispose();
        // Dispose flash material if different from original
        if (ft.isFlashing && ft.side.mesh.material !== ft.side.material) {
          (ft.side.mesh.material as THREE.MeshStandardMaterial).dispose();
        }
        this.scene.remove(ft.roof.mesh);
        ft.roof.mesh.geometry.dispose();
        ft.roof.material.dispose();
        if (ft.isFlashing && ft.roof.mesh.material !== ft.roof.material) {
          (ft.roof.mesh.material as THREE.MeshStandardMaterial).dispose();
        }
        this.factoryTrackers.delete(entity);
      }
    }
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

    const damageOrder = GarageDoorRenderer.buildDamageOrder(entity, model.totalSolid);

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

  private static buildDamageOrder(entitySeed: number, totalSolid: number): number[] {
    const order: number[] = [];
    for (let i = 0; i < totalSolid; i++) {
      order.push(i);
    }
    let seed = entitySeed * 2654435761;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  private syncSimpleDoorDamage(door: SimpleDoor, team: number, newRatio: number): void {
    const model = door.model;
    const targetDestroyed = Math.floor(newRatio * model.totalSolid);
    let currentDestroyed = 0;
    for (let si = 0; si < model.totalSolid; si++) {
      if (door.destroyed[si >> 3] & (1 << (si & 7))) currentDestroyed++;
    }
    if (targetDestroyed > currentDestroyed) {
      let destroyed = currentDestroyed;
      for (const si of door.damageOrder) {
        if (destroyed >= targetDestroyed) break;
        const byteIdx = si >> 3;
        const bitIdx = si & 7;
        if (!(door.destroyed[byteIdx] & (1 << bitIdx))) {
          door.destroyed[byteIdx] |= (1 << bitIdx);
          destroyed++;
        }
      }
    }
    const built = buildVoxelGeometry(model, door.destroyed, team, door.scorchHeat);
    door.mesh.geometry.dispose();
    door.mesh.geometry = built.bodyGeometry;
    door.lastDamageRatio = newRatio;
  }

  private applySimpleDoorImpact(door: SimpleDoor, impact: BufferedImpact, team: number): void {
    const model = door.model;
    const doorPos = door.mesh.position;
    const halfX = (model.sizeX * VOXEL_SIZE) / 2;
    const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;

    const localX = impact.impactX - doorPos.x;
    const localY = impact.impactY - doorPos.y;
    const localZ = impact.impactZ - doorPos.z;

    const gridX = Math.floor((localX + halfX) / VOXEL_SIZE);
    const gridY = Math.floor(localY / VOXEL_SIZE);
    const gridZ = Math.floor((localZ + halfZ) / VOXEL_SIZE);

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
          if (door.destroyed[byteIdx] & (1 << bitIdx)) continue;

          door.destroyed[byteIdx] |= (1 << bitIdx);
          anyDestroyed = true;

          const [svGx, svGy, svGz] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);
          const wx = doorPos.x - halfX + svGx * VOXEL_SIZE + VOXEL_SIZE * 0.5;
          const wy = doorPos.y + svGy * VOXEL_SIZE + VOXEL_SIZE * 0.5;
          const wz = doorPos.z - halfZ + svGz * VOXEL_SIZE + VOXEL_SIZE * 0.5;

          let color = TEAM_COLORS[team] ?? 0xffffff;
          const palIdx = model.solidVoxels[solidIdx][1];
          if (palIdx !== 254 && palIdx !== 253) {
            color = model.palette[palIdx] ?? 0x333333;
          }

          this.debrisRenderer.spawn(
            wx, wy, wz,
            -impact.dirX + (Math.random() - 0.5) * 0.4,
            -impact.dirY + Math.random() * 0.5,
            -impact.dirZ + (Math.random() - 0.5) * 0.4,
            color, 1.0, 0xffffff,
          );
        }
      }
    }

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
          if (door.destroyed[solidIdx >> 3] & (1 << (solidIdx & 7))) continue;

          const randomHeat = 0.7 + Math.random() * 0.3;
          door.scorchHeat[solidIdx] = Math.max(door.scorchHeat[solidIdx], randomHeat);
        }
      }
    }
    door.hasCoolingVoxels = true;
    door.scorchRebuildTimer = 0;

    if (anyDestroyed || door.hasCoolingVoxels) {
      const built = buildVoxelGeometry(model, door.destroyed, team, door.scorchHeat);
      door.mesh.geometry.dispose();
      door.mesh.geometry = built.bodyGeometry;
    }
  }

  private explodeSimpleDoor(door: SimpleDoor, team: number, biasPos: PositionComponent): void {
    const model = door.model;
    const pos = door.mesh.position;
    const halfX = model.sizeX * VOXEL_SIZE * 0.5;
    const halfZ = model.sizeZ * VOXEL_SIZE * 0.5;
    const centerY = pos.y + model.sizeY * VOXEL_SIZE * 0.5;

    for (let si = 0; si < model.totalSolid; si++) {
      const byteIdx = si >> 3;
      const bitIdx = si & 7;
      if (door.destroyed[byteIdx] & (1 << bitIdx)) continue;

      const [gridIdx, palIdx] = model.solidVoxels[si];
      const [gx, gy, gz] = indexToCoords(gridIdx, model.sizeX, model.sizeZ);

      const wx = pos.x - halfX + gx * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const wy = pos.y + gy * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const wz = pos.z - halfZ + gz * VOXEL_SIZE + VOXEL_SIZE * 0.5;

      let color = TEAM_COLORS[team] ?? 0xffffff;
      if (palIdx !== 254 && palIdx !== 253) {
        color = model.palette[palIdx] ?? 0x333333;
      }

      const dirX = wx - pos.x;
      const dirY = wy - centerY;
      const dirZ = wz - biasPos.z;
      const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;

      this.debrisRenderer.spawn(
        wx, wy, wz,
        (dirX / len) * 2.5 + (Math.random() - 0.5) * 1.0,
        (dirY / len) * 2.5 + Math.random() * 1.5,
        (dirZ / len) * 2.5 + (Math.random() - 0.5) * 1.0,
        color, 1.0, 0xffffff,
      );

      door.destroyed[byteIdx] |= (1 << bitIdx);
    }
  }

  // --- Factory door logic (side + roof) ---

  private updateFactory(world: World, entity: number, dt: number): void {
    const team = world.getComponent<TeamComponent>(entity, TEAM)!;
    const pos = world.getComponent<PositionComponent>(entity, POSITION)!;
    const queue = world.getComponent<ProductionQueueComponent>(entity, PRODUCTION_QUEUE);

    let ft = this.factoryTrackers.get(entity);
    if (!ft) {
      ft = this.createFactoryDoors(entity, team.team);
      this.factoryTrackers.set(entity, ft);
    }

    // Skip all logic if already exploded
    if (ft.hasExploded) return;

    // Check for death timer (factory dying)
    const deathTimer = world.getComponent<DeathTimerComponent>(entity, DEATH_TIMER);
    if (deathTimer) {
      if (deathTimer.timeRemaining > 0 && !deathTimer.exploded) {
        // Flash white — create per-door flash materials (different clipping planes)
        if (!ft.isFlashing) {
          const sideFlash = new THREE.MeshStandardMaterial({
            color: 0xffffff, roughness: 0.5, metalness: 0.0, vertexColors: false,
            clippingPlanes: ft.side.clipPlane ? [ft.side.clipPlane] : [],
          });
          const roofFlash = new THREE.MeshStandardMaterial({
            color: 0xffffff, roughness: 0.5, metalness: 0.0, vertexColors: false,
            clippingPlanes: ft.roof.clipPlane ? [ft.roof.clipPlane] : [],
          });
          ft.side.mesh.material = sideFlash;
          ft.roof.mesh.material = roofFlash;
          ft.isFlashing = true;
        }
        const flashIntensity = Math.sin(deathTimer.timeRemaining * 30) * 0.5 + 0.5;
        const r = 0.5 + 0.5 * flashIntensity;
        (ft.side.mesh.material as THREE.MeshStandardMaterial).color.setRGB(r, r, r);
        (ft.roof.mesh.material as THREE.MeshStandardMaterial).color.setRGB(r, r, r);
      } else if (deathTimer.exploded || deathTimer.timeRemaining <= 0) {
        this.explodeSimpleDoor(ft.side, ft.team, pos);
        this.explodeSimpleDoor(ft.roof, ft.team, pos);
        ft.hasExploded = true;
        ft.side.mesh.visible = false;
        ft.roof.mesh.visible = false;
        return;
      }
    } else {
      // Sync door damage with factory voxel state
      const voxelState = world.getComponent<VoxelStateComponent>(entity, VOXEL_STATE);
      if (voxelState && voxelState.totalVoxels > 0) {
        const damageRatio = voxelState.destroyedCount / voxelState.totalVoxels;
        if (Math.abs(damageRatio - ft.side.lastDamageRatio) > DAMAGE_REBUILD_THRESHOLD) {
          this.syncSimpleDoorDamage(ft.side, ft.team, damageRatio);
        }
        if (Math.abs(damageRatio - ft.roof.lastDamageRatio) > DAMAGE_REBUILD_THRESHOLD) {
          this.syncSimpleDoorDamage(ft.roof, ft.team, damageRatio);
        }
      }

      // Direct impact damage on doors
      if (voxelState?.recentImpacts && voxelState.recentImpacts.length > 0) {
        for (const impact of voxelState.recentImpacts) {
          this.applySimpleDoorImpact(ft.side, impact, ft.team);
          this.applySimpleDoorImpact(ft.roof, impact, ft.team);
        }
        voxelState.recentImpacts.length = 0;
      }
    }

    const queueLen = queue ? queue.queue.length : 0;
    const firstItem = queue && queue.queue.length > 0 ? queue.queue[0] : null;
    const isAerial = firstItem ? firstItem.unitType === UnitCategory.AerialDrone : false;

    // Side door triggers for ground units, roof for aerial
    const sideReady = firstItem != null && !isAerial && firstItem.timeRemaining <= OPEN_TRIGGER_TIME;
    const roofReady = firstItem != null && isAerial && firstItem.timeRemaining <= OPEN_TRIGGER_TIME;

    this.animateDoor(ft.side, sideReady, queueLen, ft.lastQueueLength, dt,
      OPEN_SPEED, CLOSE_SPEED);
    this.animateDoor(ft.roof, roofReady, queueLen, ft.lastQueueLength, dt,
      OPEN_SPEED, CLOSE_SPEED);

    ft.lastQueueLength = queueLen;

    // Position side door (slides up, like HQ)
    const sideY = pos.y + FACTORY_SIDE_Y_OFFSET + ft.side.openAmount * FACTORY_SIDE_DOOR_HEIGHT;
    ft.side.mesh.position.set(pos.x, sideY, pos.z + FACTORY_SIDE_Z_OFFSET);
    ft.side.clipPlane!.constant = pos.y + FACTORY_SIDE_CLIP_VOXEL_Y * VOXEL_SIZE;

    // Position roof door (slides +X to open, clipped at building edge)
    const roofSlide = ft.roof.openAmount * FACTORY_ROOF_SLIDE_DIST;
    ft.roof.mesh.position.set(
      pos.x + FACTORY_ROOF_X_CENTER + roofSlide,
      pos.y + FACTORY_ROOF_Y_OFFSET,
      pos.z + FACTORY_ROOF_Z_CENTER,
    );
    ft.roof.clipPlane!.constant = pos.x + 29 * VOXEL_SIZE - 16 * VOXEL_SIZE;

    // Fog visibility
    const visible = !this.fogState || this.playerTeam < 0
      || this.fogState.isVisible(this.playerTeam, pos.x, pos.z);
    ft.side.mesh.visible = visible;
    ft.roof.mesh.visible = visible;
  }

  private createFactoryDoors(entity: number, team: number): FactoryDoorsTracker {
    // Side door
    const sideModel = FACTORY_DOOR_MODEL;
    const sideDestroyed = new Uint8Array(Math.ceil(sideModel.totalSolid / 8));
    const sideSH = new Float32Array(sideModel.totalSolid);
    const sideBuilt = buildVoxelGeometry(sideModel, sideDestroyed, team, sideSH);
    const sideClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const sideMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0.3,
      clippingPlanes: [sideClip],
    });
    const sideMesh = new THREE.Mesh(sideBuilt.bodyGeometry, sideMat);
    sideMesh.castShadow = false;
    sideMesh.receiveShadow = false;
    this.scene.add(sideMesh);
    const sideDamageOrder = GarageDoorRenderer.buildDamageOrder(entity, sideModel.totalSolid);

    // Roof door — clips at the +X edge of the building so it slides under the hull
    const roofModel = FACTORY_ROOF_DOOR_MODEL;
    const roofDestroyed = new Uint8Array(Math.ceil(roofModel.totalSolid / 8));
    const roofSH = new Float32Array(roofModel.totalSolid);
    const roofBuilt = buildVoxelGeometry(roofModel, roofDestroyed, team, roofSH);
    const roofClip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    const roofMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0.3,
      clippingPlanes: [roofClip],
    });
    const roofMesh = new THREE.Mesh(roofBuilt.bodyGeometry, roofMat);
    roofMesh.castShadow = false;
    roofMesh.receiveShadow = false;
    this.scene.add(roofMesh);
    // Use offset seed so side and roof have different damage patterns
    const roofDamageOrder = GarageDoorRenderer.buildDamageOrder(entity + 7919, roofModel.totalSolid);

    return {
      entity,
      side: {
        mesh: sideMesh, material: sideMat, state: 'closed', openAmount: 0, closeTimer: 0,
        clipPlane: sideClip,
        model: sideModel, destroyed: sideDestroyed, scorchHeat: sideSH,
        damageOrder: sideDamageOrder, lastDamageRatio: 0,
        hasCoolingVoxels: false, scorchRebuildTimer: 0,
      },
      roof: {
        mesh: roofMesh, material: roofMat, state: 'closed', openAmount: 0, closeTimer: 0,
        clipPlane: roofClip,
        model: roofModel, destroyed: roofDestroyed, scorchHeat: roofSH,
        damageOrder: roofDamageOrder, lastDamageRatio: 0,
        hasCoolingVoxels: false, scorchRebuildTimer: 0,
      },
      lastQueueLength: 0,
      team,
      isFlashing: false,
      hasExploded: false,
    };
  }

  private animateDoor(door: SimpleDoor, shouldOpen: boolean, queueLen: number, lastQueueLen: number, dt: number, openSpeed: number, closeSpeed: number): void {
    switch (door.state) {
      case 'closed':
        if (shouldOpen) door.state = 'opening';
        break;
      case 'opening':
        if (door.openAmount >= 1.0) {
          door.state = 'open';
          door.openAmount = 1.0;
        }
        break;
      case 'open':
        if (queueLen < lastQueueLen) door.closeTimer = CLOSE_DELAY;
        if (door.closeTimer > 0) {
          door.closeTimer -= dt;
          if (door.closeTimer <= 0) {
            if (shouldOpen) { door.closeTimer = 0; }
            else { door.state = 'closing'; }
          }
        } else if (!shouldOpen) {
          door.state = 'closing';
        }
        break;
      case 'closing':
        if (shouldOpen) { door.state = 'opening'; break; }
        if (door.openAmount <= 0) {
          door.state = 'closed';
          door.openAmount = 0;
        }
        break;
    }

    if (door.state === 'opening') {
      door.openAmount = Math.min(1.0, door.openAmount + openSpeed / FACTORY_SIDE_DOOR_HEIGHT * dt);
    } else if (door.state === 'closing') {
      door.openAmount = Math.max(0, door.openAmount - closeSpeed / FACTORY_SIDE_DOOR_HEIGHT * dt);
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

    for (const [, ft] of this.factoryTrackers) {
      this.scene.remove(ft.side.mesh);
      ft.side.mesh.geometry.dispose();
      ft.side.material.dispose();
      if (ft.isFlashing && ft.side.mesh.material !== ft.side.material) {
        (ft.side.mesh.material as THREE.MeshStandardMaterial).dispose();
      }
      this.scene.remove(ft.roof.mesh);
      ft.roof.mesh.geometry.dispose();
      ft.roof.material.dispose();
      if (ft.isFlashing && ft.roof.mesh.material !== ft.roof.material) {
        (ft.roof.mesh.material as THREE.MeshStandardMaterial).dispose();
      }
    }
    this.factoryTrackers.clear();
  }

  dispose(): void {
    this.clearAll();
    this.flashMaterial.dispose();
  }
}
