import type { System, World } from '@core/ECS';
import { VOXEL_STATE, IMPACT_EVENT, POSITION, BUILDING, TURRET } from '@sim/components/ComponentTypes';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ImpactEventComponent } from '@sim/components/ImpactEvent';
import type { PositionComponent } from '@sim/components/Position';
import type { TurretComponent } from '@sim/components/Turret';
import { VOXEL_MODELS, VOXEL_SIZE } from '@sim/data/VoxelModels';
import type { VoxelModel } from '@sim/data/VoxelModels';
import type { SeededRandom } from '@sim/utils/SeededRandom';

export class VoxelDamageSystem implements System {
  readonly name = 'VoxelDamageSystem';
  private rng: SeededRandom;
  private headless: boolean;

  constructor(rng: SeededRandom, headless: boolean = false) {
    this.rng = rng;
    this.headless = headless;
  }

  update(world: World, _dt: number): void {
    const entities = world.query(VOXEL_STATE, IMPACT_EVENT);

    for (const e of entities) {
      const voxelState = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE)!;
      const impact = world.getComponent<ImpactEventComponent>(e, IMPACT_EVENT)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION);

      if (!pos) {
        world.removeComponent(e, IMPACT_EVENT);
        continue;
      }

      const model = VOXEL_MODELS[voxelState.modelId];
      if (!model) {
        world.removeComponent(e, IMPACT_EVENT);
        continue;
      }

      const isBuilding = world.hasComponent(e, BUILDING);
      const turret = world.getComponent<TurretComponent>(e, TURRET);
      const hasTurretSplit = turret && model.turretMinY != null;

      const countBefore = voxelState.destroyedCount;

      if (hasTurretSplit) {
        // Two-pass: body voxels use body rotation, turret voxels use turret rotation
        this.blastPass(voxelState, impact, pos, model, isBuilding, pos.rotation, 0, model.turretMinY! - 1);
        this.blastPass(voxelState, impact, pos, model, isBuilding, turret.turretRotation, model.turretMinY!, model.sizeY - 1);
      } else {
        // Single pass: all voxels use body rotation
        this.blastPass(voxelState, impact, pos, model, isBuilding, pos.rotation, 0, model.sizeY - 1);
      }

      if (voxelState.destroyedCount > countBefore || voxelState.pendingScorch.length > 0) {
        voxelState.dirty = true;
      }

      // Buffer impact for renderer-side consumers (e.g. garage door)
      if (!this.headless) {
        if (!voxelState.recentImpacts) voxelState.recentImpacts = [];
        voxelState.recentImpacts.push({
          impactX: impact.impactX,
          impactY: impact.impactY,
          impactZ: impact.impactZ,
          blastRadius: impact.blastRadius,
          dirX: impact.dirX,
          dirY: impact.dirY,
          dirZ: impact.dirZ,
        });
      }

      // Consume the impact event
      world.removeComponent(e, IMPACT_EVENT);
    }
  }

  /** Run blast damage for voxels in a Y range, using a specific rotation to undo */
  private blastPass(
    voxelState: VoxelStateComponent,
    impact: ImpactEventComponent,
    pos: PositionComponent,
    model: VoxelModel,
    isBuilding: boolean,
    rotation: number,
    minY: number,
    maxY: number,
  ): void {
    const halfX = (model.sizeX * VOXEL_SIZE) / 2;
    const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;

    // Local-space impact position (undo entity position and rotation)
    let localX = impact.impactX - pos.x;
    let localY = impact.impactY - pos.y;
    let localZ = impact.impactZ - pos.z;

    if (!isBuilding && rotation !== 0) {
      const cos = Math.cos(-rotation);
      const sin = Math.sin(-rotation);
      const rx = localX * cos - localZ * sin;
      const rz = localX * sin + localZ * cos;
      localX = rx;
      localZ = rz;
    }

    // Convert to grid coordinates (clamped to valid range for surface boundary safety)
    const gridX = Math.max(0, Math.min(model.sizeX - 1, Math.floor((localX + halfX) / VOXEL_SIZE)));
    const gridY = Math.max(0, Math.min(model.sizeY - 1, Math.floor(localY / VOXEL_SIZE)));
    const gridZ = Math.max(0, Math.min(model.sizeZ - 1, Math.floor((localZ + halfZ) / VOXEL_SIZE)));

    // World-space bullet direction (for debris at impact center)
    const worldDirX = impact.dirX;
    const worldDirY = impact.dirY;
    const worldDirZ = impact.dirZ;

    const blastR = impact.blastRadius;

    for (let dy = -blastR; dy <= blastR; dy++) {
      for (let dz = -blastR; dz <= blastR; dz++) {
        for (let dx = -blastR; dx <= blastR; dx++) {
          const gx = gridX + dx;
          const gy = gridY + dy;
          const gz = gridZ + dz;

          if (gx < 0 || gx >= model.sizeX || gy < 0 || gy >= model.sizeY || gz < 0 || gz >= model.sizeZ) continue;

          // Filter to the Y range for this pass
          if (gy < minY || gy > maxY) continue;

          // Sphere check
          if (dx * dx + dy * dy + dz * dz > blastR * blastR + 1) continue;

          // Find this grid position in solidVoxels
          const gridIdx = gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ;
          if (model.grid[gridIdx] === 0) continue;

          const solidIdx = model.gridToSolid[gridIdx];
          if (solidIdx === -1) continue;

          // Check if already destroyed
          const byteIdx = solidIdx >> 3;
          const bitIdx = solidIdx & 7;
          if (voxelState.destroyed[byteIdx] & (1 << bitIdx)) continue;

          // Debris direction: radial outward from impact center (explosion-style)
          const scatter = 0.4;
          let radX = dx;
          let radY = dy;
          let radZ = dz;
          const radLen = Math.sqrt(radX * radX + radY * radY + radZ * radZ);

          let debrisDirX: number;
          let debrisDirY: number;
          let debrisDirZ: number;

          if (radLen < 0.001) {
            // Voxel is at impact center: bounce back along bullet direction
            debrisDirX = -worldDirX + (this.rng.next() - 0.5) * scatter;
            debrisDirY = -worldDirY + this.rng.next() * 0.5;
            debrisDirZ = -worldDirZ + (this.rng.next() - 0.5) * scatter;
          } else {
            // Radial outward from impact center (in grid/local space)
            let outX = radX / radLen;
            let outY = radY / radLen;
            let outZ = radZ / radLen;

            // Rotate back to world space for non-building entities
            if (!isBuilding && rotation !== 0) {
              const cos = Math.cos(rotation);
              const sin = Math.sin(rotation);
              const wx = outX * cos - outZ * sin;
              const wz = outX * sin + outZ * cos;
              outX = wx;
              outZ = wz;
            }

            debrisDirX = outX + (this.rng.next() - 0.5) * scatter;
            debrisDirY = outY + this.rng.next() * 0.5;
            debrisDirZ = outZ + (this.rng.next() - 0.5) * scatter;
          }

          // Destroy this voxel
          voxelState.destroyed[byteIdx] |= (1 << bitIdx);
          voxelState.destroyedCount++;

          // Queue debris info for renderer (skip in headless mode)
          if (!this.headless) {
            voxelState.pendingDebris.push({
              solidIndex: solidIdx,
              dirX: debrisDirX,
              dirY: debrisDirY,
              dirZ: debrisDirZ,
            });
          }
        }
      }
    }

    // Scorch pass: mark surviving solid voxels in a slightly larger radius (skip in headless)
    if (this.headless) return;
    const scorchR = blastR + 1;
    for (let dy = -scorchR; dy <= scorchR; dy++) {
      for (let dz = -scorchR; dz <= scorchR; dz++) {
        for (let dx = -scorchR; dx <= scorchR; dx++) {
          const gx = gridX + dx;
          const gy = gridY + dy;
          const gz = gridZ + dz;

          if (gx < 0 || gx >= model.sizeX || gy < 0 || gy >= model.sizeY || gz < 0 || gz >= model.sizeZ) continue;
          if (gy < minY || gy > maxY) continue;
          if (dx * dx + dy * dy + dz * dz > scorchR * scorchR + 1) continue;

          const gridIdx = gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ;
          if (model.grid[gridIdx] === 0) continue;

          const solidIdx = model.gridToSolid[gridIdx];
          if (solidIdx === -1) continue;

          // Only scorch surviving voxels
          const byteIdx = solidIdx >> 3;
          const bitIdx = solidIdx & 7;
          if (voxelState.destroyed[byteIdx] & (1 << bitIdx)) continue;

          voxelState.pendingScorch.push(solidIdx);
        }
      }
    }
  }
}
