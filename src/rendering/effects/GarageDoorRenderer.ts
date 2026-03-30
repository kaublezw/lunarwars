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
import {
  worldToModelGrid, applyBlastDamage, findSurvivorsInRadius,
  syncDamageToRatio, buildDamageOrder, decayScorchHeat,
} from '@sim/utils/VoxelDamageUtils';
import { buildVoxelGeometry } from '@render/VoxelGeometryBuilder';
import type { DebrisRenderer } from '@render/effects/DebrisRenderer';

const TEAM_COLORS = [0x4488ff, 0xff4444];

// HQ door constants
const DOOR_HEIGHT = GARAGE_DOOR_MODEL.sizeY * VOXEL_SIZE;
const DOOR_Z_OFFSET = 1.2;
const DOOR_CLOSED_Y_OFFSET = 1 * VOXEL_SIZE;

// Animation timing
const OPEN_SPEED = DOOR_HEIGHT / 1.0;
const CLOSE_SPEED = DOOR_HEIGHT / 0.8;
const OPEN_TRIGGER_TIME = 1.5;
const CLOSE_DELAY = 2.0;

// Factory side door constants
const FACTORY_SIDE_Z_OFFSET = (28.5 - 16) * VOXEL_SIZE;
const FACTORY_SIDE_Y_OFFSET = 1 * VOXEL_SIZE;
const FACTORY_SIDE_DOOR_HEIGHT = 10 * VOXEL_SIZE;
const FACTORY_SIDE_CLIP_VOXEL_Y = 11;

// Factory roof door constants
const FACTORY_ROOF_Y_OFFSET = 13 * VOXEL_SIZE;
const FACTORY_ROOF_X_CENTER = (15.5 - 16) * VOXEL_SIZE;
const FACTORY_ROOF_Z_CENTER = (15.5 - 16) * VOXEL_SIZE;
const FACTORY_ROOF_SLIDE_DIST = 16 * VOXEL_SIZE;

// Damage/scorch constants
const DAMAGE_REBUILD_THRESHOLD = 0.01;
const SCORCH_REBUILD_INTERVAL = 6;
const HEAT_DECAY_PER_REBUILD = SCORCH_REBUILD_INTERVAL * (1 / 60) / 1.5;

type DoorState = 'closed' | 'opening' | 'open' | 'closing';

/** A single animated door panel with damage state */
interface DoorMesh {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  model: VoxelModel;
  state: DoorState;
  openAmount: number;
  closeTimer: number;
  clipPlane: THREE.Plane;
  // Damage
  destroyed: Uint8Array;
  scorchHeat: Float32Array;
  damageOrder: number[];
  lastDamageRatio: number;
  hasCoolingVoxels: boolean;
  scorchRebuildTimer: number;
}

/** Per-building tracker grouping one or more door panels */
interface BuildingDoors {
  entity: number;
  team: number;
  buildingType: BuildingType;
  doors: DoorMesh[];
  lastQueueLength: number;
  isFlashing: boolean;
  hasExploded: boolean;
}

export class GarageDoorRenderer {
  private scene: THREE.Scene;
  private debrisRenderer: DebrisRenderer;
  private trackers = new Map<number, BuildingDoors>();
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;
  private flashMaterial: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, debrisRenderer: DebrisRenderer) {
    this.scene = scene;
    this.debrisRenderer = debrisRenderer;
    this.flashMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.5, metalness: 0.0, vertexColors: false,
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
    const activeEntities = new Set<number>();

    for (const e of buildings) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const bType = building.buildingType;
      if (bType !== BuildingType.HQ && bType !== BuildingType.DroneFactory) continue;

      activeEntities.add(e);

      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const queue = world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE);

      let bd = this.trackers.get(e);
      if (!bd) {
        bd = bType === BuildingType.HQ
          ? this.createHQDoors(e, team.team)
          : this.createFactoryDoors(e, team.team);
        this.trackers.set(e, bd);
      }

      if (bd.hasExploded) continue;

      // --- Death timer: flash then explode ---
      const deathTimer = world.getComponent<DeathTimerComponent>(e, DEATH_TIMER);
      if (deathTimer) {
        if (deathTimer.timeRemaining > 0 && !deathTimer.exploded) {
          this.applyFlash(bd, deathTimer.timeRemaining);
        } else if (deathTimer.exploded || deathTimer.timeRemaining <= 0) {
          for (const door of bd.doors) {
            this.explodeDoor(door, bd.team, pos);
            door.mesh.visible = false;
          }
          bd.hasExploded = true;
          continue;
        }
      } else {
        // --- Damage sync + impact processing ---
        const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
        if (voxelState && voxelState.totalVoxels > 0) {
          const damageRatio = voxelState.destroyedCount / voxelState.totalVoxels;
          for (const door of bd.doors) {
            if (Math.abs(damageRatio - door.lastDamageRatio) > DAMAGE_REBUILD_THRESHOLD) {
              syncDamageToRatio(door.model.totalSolid, door.destroyed, door.damageOrder, damageRatio);
              door.lastDamageRatio = damageRatio;
              this.rebuildDoorGeometry(door, bd.team);
            }
          }
        }

        if (voxelState?.recentImpacts && voxelState.recentImpacts.length > 0) {
          for (const impact of voxelState.recentImpacts) {
            for (const door of bd.doors) {
              this.applyDoorImpact(door, impact, bd.team);
            }
          }
          voxelState.recentImpacts.length = 0;
        }
      }

      // --- Animation ---
      const queueLen = queue ? queue.queue.length : 0;
      const firstItem = queue && queue.queue.length > 0 ? queue.queue[0] : null;

      if (bType === BuildingType.HQ) {
        const door = bd.doors[0];
        const shouldOpen = firstItem != null && firstItem.timeRemaining <= OPEN_TRIGGER_TIME;
        this.animateDoor(door, shouldOpen, queueLen, bd.lastQueueLength, dt, OPEN_SPEED, CLOSE_SPEED);

        const doorY = pos.y + DOOR_CLOSED_Y_OFFSET + door.openAmount * DOOR_HEIGHT;
        door.mesh.position.set(pos.x, doorY, pos.z + DOOR_Z_OFFSET);
        door.clipPlane.constant = pos.y + 10 * VOXEL_SIZE;
      } else {
        const isAerial = firstItem ? firstItem.unitType === UnitCategory.AerialDrone : false;
        const sideReady = firstItem != null && !isAerial && firstItem.timeRemaining <= OPEN_TRIGGER_TIME;
        const roofReady = firstItem != null && isAerial && firstItem.timeRemaining <= OPEN_TRIGGER_TIME;

        const side = bd.doors[0];
        const roof = bd.doors[1];

        this.animateDoor(side, sideReady, queueLen, bd.lastQueueLength, dt, OPEN_SPEED, CLOSE_SPEED);
        this.animateDoor(roof, roofReady, queueLen, bd.lastQueueLength, dt, OPEN_SPEED, CLOSE_SPEED);

        const sideY = pos.y + FACTORY_SIDE_Y_OFFSET + side.openAmount * FACTORY_SIDE_DOOR_HEIGHT;
        side.mesh.position.set(pos.x, sideY, pos.z + FACTORY_SIDE_Z_OFFSET);
        side.clipPlane.constant = pos.y + FACTORY_SIDE_CLIP_VOXEL_Y * VOXEL_SIZE;

        const roofSlide = roof.openAmount * FACTORY_ROOF_SLIDE_DIST;
        roof.mesh.position.set(
          pos.x + FACTORY_ROOF_X_CENTER + roofSlide,
          pos.y + FACTORY_ROOF_Y_OFFSET,
          pos.z + FACTORY_ROOF_Z_CENTER,
        );
        roof.clipPlane.constant = pos.x + 29 * VOXEL_SIZE - 16 * VOXEL_SIZE;
      }

      bd.lastQueueLength = queueLen;

      // Fog visibility
      const visible = !this.fogState || this.playerTeam < 0
        || this.fogState.isVisible(this.playerTeam, pos.x, pos.z);
      for (const door of bd.doors) door.mesh.visible = visible;
    }

    // --- Scorch heat decay for all doors ---
    for (const [, bd] of this.trackers) {
      if (bd.hasExploded) continue;
      for (const door of bd.doors) {
        if (!door.hasCoolingVoxels) continue;
        door.scorchRebuildTimer--;
        if (door.scorchRebuildTimer > 0) continue;
        door.scorchRebuildTimer = SCORCH_REBUILD_INTERVAL;
        door.hasCoolingVoxels = decayScorchHeat(door.scorchHeat, HEAT_DECAY_PER_REBUILD);
        this.rebuildDoorGeometry(door, bd.team);
      }
    }

    // --- Cleanup removed buildings ---
    for (const [entity, bd] of this.trackers) {
      if (!activeEntities.has(entity)) {
        for (const door of bd.doors) {
          this.scene.remove(door.mesh);
          door.mesh.geometry.dispose();
          door.material.dispose();
          if (bd.isFlashing && door.mesh.material !== door.material) {
            (door.mesh.material as THREE.MeshStandardMaterial).dispose();
          }
        }
        this.trackers.delete(entity);
      }
    }
  }

  // --- Door creation ---

  private createDoorMesh(model: VoxelModel, team: number, entitySeed: number, clipNormal: THREE.Vector3): DoorMesh {
    const destroyed = new Uint8Array(Math.ceil(model.totalSolid / 8));
    const scorchHeat = new Float32Array(model.totalSolid);
    const built = buildVoxelGeometry(model, destroyed, team, scorchHeat);
    const clipPlane = new THREE.Plane(clipNormal, 0);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0.3,
      clippingPlanes: [clipPlane],
    });
    const mesh = new THREE.Mesh(built.bodyGeometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.scene.add(mesh);

    return {
      mesh, material, model, clipPlane,
      state: 'closed', openAmount: 0, closeTimer: 0,
      destroyed, scorchHeat,
      damageOrder: buildDamageOrder(entitySeed, model.totalSolid),
      lastDamageRatio: 0, hasCoolingVoxels: false, scorchRebuildTimer: 0,
    };
  }

  private createHQDoors(entity: number, team: number): BuildingDoors {
    const door = this.createDoorMesh(GARAGE_DOOR_MODEL, team, entity, new THREE.Vector3(0, -1, 0));
    return {
      entity, team, buildingType: BuildingType.HQ,
      doors: [door], lastQueueLength: 0,
      isFlashing: false, hasExploded: false,
    };
  }

  private createFactoryDoors(entity: number, team: number): BuildingDoors {
    const side = this.createDoorMesh(FACTORY_DOOR_MODEL, team, entity, new THREE.Vector3(0, -1, 0));
    const roof = this.createDoorMesh(FACTORY_ROOF_DOOR_MODEL, team, entity + 7919, new THREE.Vector3(-1, 0, 0));
    return {
      entity, team, buildingType: BuildingType.DroneFactory,
      doors: [side, roof], lastQueueLength: 0,
      isFlashing: false, hasExploded: false,
    };
  }

  // --- Damage handling (delegates grid math to VoxelDamageUtils) ---

  private applyDoorImpact(door: DoorMesh, impact: BufferedImpact, team: number): void {
    const model = door.model;
    const doorPos = door.mesh.position;

    const { gridX, gridY, gridZ } = worldToModelGrid(
      impact.impactX, impact.impactY, impact.impactZ,
      doorPos.x, doorPos.y, doorPos.z, model,
    );

    // Early out if impact is far from door grid
    const blastR = impact.blastRadius;
    if (gridX < -blastR || gridX >= model.sizeX + blastR) return;
    if (gridY < -blastR || gridY >= model.sizeY + blastR) return;
    if (gridZ < -blastR || gridZ >= model.sizeZ + blastR) return;

    // Apply blast damage
    const destroyed = applyBlastDamage(model, door.destroyed, gridX, gridY, gridZ, blastR);

    // Spawn debris for each destroyed voxel
    const halfX = (model.sizeX * VOXEL_SIZE) / 2;
    const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;
    for (const v of destroyed) {
      const [gx, gy, gz] = indexToCoords(v.gridIndex, model.sizeX, model.sizeZ);
      const wx = doorPos.x - halfX + gx * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const wy = doorPos.y + gy * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const wz = doorPos.z - halfZ + gz * VOXEL_SIZE + VOXEL_SIZE * 0.5;
      const color = this.resolveVoxelColor(model, v.solidIndex, team);

      this.debrisRenderer.spawn(
        wx, wy, wz,
        -impact.dirX + (Math.random() - 0.5) * 0.4,
        -impact.dirY + Math.random() * 0.5,
        -impact.dirZ + (Math.random() - 0.5) * 0.4,
        color, 1.0, 0xffffff,
      );
    }

    // Apply scorch heat to survivors
    const scorchTargets = findSurvivorsInRadius(model, door.destroyed, gridX, gridY, gridZ, blastR + 1);
    for (const solidIdx of scorchTargets) {
      const randomHeat = 0.7 + Math.random() * 0.3;
      door.scorchHeat[solidIdx] = Math.max(door.scorchHeat[solidIdx], randomHeat);
    }
    if (scorchTargets.length > 0) {
      door.hasCoolingVoxels = true;
      door.scorchRebuildTimer = 0;
    }

    if (destroyed.length > 0 || scorchTargets.length > 0) {
      this.rebuildDoorGeometry(door, team);
    }
  }

  private explodeDoor(door: DoorMesh, team: number, biasPos: PositionComponent): void {
    const model = door.model;
    const pos = door.mesh.position;
    const halfX = model.sizeX * VOXEL_SIZE * 0.5;
    const halfZ = model.sizeZ * VOXEL_SIZE * 0.5;
    const centerY = pos.y + model.sizeY * VOXEL_SIZE * 0.5;

    for (let si = 0; si < model.totalSolid; si++) {
      if (door.destroyed[si >> 3] & (1 << (si & 7))) continue;

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

      door.destroyed[si >> 3] |= (1 << (si & 7));
    }
  }

  // --- Rendering helpers ---

  private rebuildDoorGeometry(door: DoorMesh, team: number): void {
    const built = buildVoxelGeometry(door.model, door.destroyed, team, door.scorchHeat);
    door.mesh.geometry.dispose();
    door.mesh.geometry = built.bodyGeometry;
  }

  private resolveVoxelColor(model: VoxelModel, solidIndex: number, team: number): number {
    const palIdx = model.solidVoxels[solidIndex][1];
    if (palIdx === 254 || palIdx === 253) return TEAM_COLORS[team] ?? 0xffffff;
    return model.palette[palIdx] ?? 0x333333;
  }

  private applyFlash(bd: BuildingDoors, timeRemaining: number): void {
    if (!bd.isFlashing) {
      for (const door of bd.doors) {
        const flash = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 0.5, metalness: 0.0, vertexColors: false,
          clippingPlanes: [door.clipPlane],
        });
        door.mesh.material = flash;
      }
      bd.isFlashing = true;
    }
    const intensity = Math.sin(timeRemaining * 30) * 0.5 + 0.5;
    const r = 0.5 + 0.5 * intensity;
    for (const door of bd.doors) {
      (door.mesh.material as THREE.MeshStandardMaterial).color.setRGB(r, r, r);
    }
  }

  private animateDoor(
    door: DoorMesh, shouldOpen: boolean, queueLen: number, lastQueueLen: number,
    dt: number, openSpeed: number, closeSpeed: number,
  ): void {
    switch (door.state) {
      case 'closed':
        if (shouldOpen) door.state = 'opening';
        break;
      case 'opening':
        if (queueLen === 0) { door.state = 'closing'; break; }
        if (door.openAmount >= 1.0) { door.state = 'open'; door.openAmount = 1.0; }
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
        if (door.openAmount <= 0) { door.state = 'closed'; door.openAmount = 0; }
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
    for (const [, bd] of this.trackers) {
      for (const door of bd.doors) {
        this.scene.remove(door.mesh);
        door.mesh.geometry.dispose();
        door.material.dispose();
        if (bd.isFlashing && door.mesh.material !== door.material) {
          (door.mesh.material as THREE.MeshStandardMaterial).dispose();
        }
      }
    }
    this.trackers.clear();
  }

  dispose(): void {
    this.clearAll();
    this.flashMaterial.dispose();
  }
}
