import type { System, World } from '@core/ECS';
import { VOXEL_STATE, IMPACT_EVENT, POSITION, BUILDING, TURRET } from '@sim/components/ComponentTypes';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ImpactEventComponent } from '@sim/components/ImpactEvent';
import type { PositionComponent } from '@sim/components/Position';
import type { TurretComponent } from '@sim/components/Turret';
import { VOXEL_MODELS, VOXEL_SIZE } from '@sim/data/VoxelModels';
import type { VoxelModel } from '@sim/data/VoxelModels';

export class VoxelDamageSystem implements System {
  readonly name = 'VoxelDamageSystem';

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

    // Convert bullet direction to local space (undo rotation for units)
    let localDirX = impact.dirX;
    let localDirY = impact.dirY;
    let localDirZ = impact.dirZ;

    if (!isBuilding && rotation !== 0) {
      const cos = Math.cos(-rotation);
      const sin = Math.sin(-rotation);
      const rx = localX * cos - localZ * sin;
      const rz = localX * sin + localZ * cos;
      localX = rx;
      localZ = rz;

      // Rotate direction too
      const rdx = localDirX * cos - localDirZ * sin;
      const rdz = localDirX * sin + localDirZ * cos;
      localDirX = rdx;
      localDirZ = rdz;
    }

    // Convert to grid coordinates (clamped to valid range for surface boundary safety)
    const gridX = Math.max(0, Math.min(model.sizeX - 1, Math.floor((localX + halfX) / VOXEL_SIZE)));
    const gridY = Math.max(0, Math.min(model.sizeY - 1, Math.floor(localY / VOXEL_SIZE)));
    const gridZ = Math.max(0, Math.min(model.sizeZ - 1, Math.floor((localZ + halfZ) / VOXEL_SIZE)));

    // Convert bullet direction to grid-space step for "behind" check
    const absDX = Math.abs(localDirX);
    const absDY = Math.abs(localDirY);
    const absDZ = Math.abs(localDirZ);
    const maxAbs = Math.max(absDX, absDY, absDZ) || 1;
    const stepX = Math.round(localDirX / maxAbs);
    const stepY = Math.round(localDirY / maxAbs);
    const stepZ = Math.round(localDirZ / maxAbs);

    // World-space bullet direction (for debris, which needs world coords)
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

          // Determine debris direction: check if there's a voxel "behind" this one
          const behindX = gx + stepX;
          const behindY = gy + stepY;
          const behindZ = gz + stepZ;

          let ricochet = false;
          if (
            behindX >= 0 && behindX < model.sizeX &&
            behindY >= 0 && behindY < model.sizeY &&
            behindZ >= 0 && behindZ < model.sizeZ
          ) {
            const behindGridIdx = behindX + behindZ * model.sizeX + behindY * model.sizeX * model.sizeZ;
            if (model.grid[behindGridIdx] !== 0) {
              const behindSolidIdx = model.gridToSolid[behindGridIdx];
              if (behindSolidIdx !== -1) {
                const bByte = behindSolidIdx >> 3;
                const bBit = behindSolidIdx & 7;
                if (!(voxelState.destroyed[bByte] & (1 << bBit))) {
                  ricochet = true;
                }
              }
            }
          }

          // Compute debris direction in world-space
          const scatter = 0.4;
          let debrisDirX: number;
          let debrisDirY: number;
          let debrisDirZ: number;

          if (ricochet) {
            debrisDirX = -worldDirX + (Math.random() - 0.5) * scatter;
            debrisDirY = -worldDirY + Math.random() * 0.5;
            debrisDirZ = -worldDirZ + (Math.random() - 0.5) * scatter;
          } else {
            debrisDirX = worldDirX + (Math.random() - 0.5) * scatter;
            debrisDirY = worldDirY + Math.random() * 0.5;
            debrisDirZ = worldDirZ + (Math.random() - 0.5) * scatter;
          }

          // Destroy this voxel
          voxelState.destroyed[byteIdx] |= (1 << bitIdx);
          voxelState.destroyedCount++;

          // Queue debris info for renderer
          voxelState.pendingDebris.push({
            solidIndex: solidIdx,
            dirX: debrisDirX,
            dirY: debrisDirY,
            dirZ: debrisDirZ,
          });
        }
      }
    }

    // Scorch pass: mark surviving solid voxels in a slightly larger radius
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
