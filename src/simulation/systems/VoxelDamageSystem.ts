import type { System, World } from '@core/ECS';
import { VOXEL_STATE, IMPACT_EVENT, POSITION, BUILDING, TURRET, RENDERABLE, PROJECTILE } from '@sim/components/ComponentTypes';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ImpactEventComponent } from '@sim/components/ImpactEvent';
import type { PositionComponent } from '@sim/components/Position';
import type { TurretComponent } from '@sim/components/Turret';
import type { ProjectileComponent } from '@sim/components/Projectile';
import type { RenderableComponent } from '@sim/components/Renderable';
import { VOXEL_MODELS, VOXEL_SIZE } from '@sim/data/VoxelModels';
import type { VoxelModel } from '@sim/data/VoxelModels';
import type { SeededRandom } from '@sim/utils/SeededRandom';
import { worldToModelGrid, applyBlastDamage, findSurvivorsInRadius } from '@sim/utils/VoxelDamageUtils';

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
        this.blastPass(voxelState, impact, pos, model, isBuilding, pos.rotation, 0, model.turretMinY! - 1);
        this.blastPass(voxelState, impact, pos, model, isBuilding, turret.turretRotation, model.turretMinY!, model.sizeY - 1);
      } else {
        this.blastPass(voxelState, impact, pos, model, isBuilding, pos.rotation, 0, model.sizeY - 1);
      }

      // Exit blast for buildings: shell occasionally penetrates and damages opposite face
      if (isBuilding && this.rng.next() < 0.3) {
        // Ray-cast bullet trajectory through building AABB to find true exit point
        const halfX = (model.sizeX * VOXEL_SIZE) / 2;
        const halfZ = (model.sizeZ * VOXEL_SIZE) / 2;
        const dx = impact.dirX;
        const dy = impact.dirY;
        const dz = impact.dirZ;

        const tFarX = dx !== 0 ? ((dx > 0 ? pos.x + halfX : pos.x - halfX) - impact.impactX) / dx : Infinity;
        const tFarY = dy !== 0 ? ((dy > 0 ? pos.y + model.sizeY * VOXEL_SIZE : pos.y) - impact.impactY) / dy : Infinity;
        const tFarZ = dz !== 0 ? ((dz > 0 ? pos.z + halfZ : pos.z - halfZ) - impact.impactZ) / dz : Infinity;
        const tSurface = Math.max(0.01, Math.min(tFarX, tFarY, tFarZ));

        // Exit projectile spawns at the surface
        const exitX = impact.impactX + dx * tSurface;
        const exitY = impact.impactY + dy * tSurface;
        const exitZ = impact.impactZ + dz * tSurface;

        // Blast center inset 2 voxels so it hits solid interior voxels
        const tBlast = Math.max(0.01, tSurface - VOXEL_SIZE * 2);
        const blastX = impact.impactX + dx * tBlast;
        const blastY = impact.impactY + dy * tBlast;
        const blastZ = impact.impactZ + dz * tBlast;

        // Convert inset blast point to grid coords
        const { gridX: exitGridX, gridY: exitGridY, gridZ: exitGridZ } = worldToModelGrid(
          blastX, blastY, blastZ, pos.x, pos.y, pos.z, model, 0,
        );

        const exitDestroyed = applyBlastDamage(model, voxelState.destroyed, exitGridX, exitGridY, exitGridZ, impact.blastRadius);
        voxelState.destroyedCount += exitDestroyed.length;

        if (!this.headless) {
          const scatter = 0.4;
          for (const v of exitDestroyed) {
            voxelState.pendingDebris.push({
              solidIndex: v.solidIndex,
              dirX: dx + (this.rng.next() - 0.5) * scatter,
              dirY: this.rng.next() * 0.5,
              dirZ: dz + (this.rng.next() - 0.5) * scatter,
            });
          }

          const exitScorch = findSurvivorsInRadius(model, voxelState.destroyed, exitGridX, exitGridY, exitGridZ, impact.blastRadius + 1);
          voxelState.pendingScorch.push(...exitScorch);
        }

        // Spawn visible exit projectile on the same trajectory line
        const exitSpeed = impact.blastRadius >= 2 ? 70 : 55;
        const ep = world.createEntity();
        world.addComponent<PositionComponent>(ep, POSITION, {
          x: exitX, y: exitY, z: exitZ,
          prevX: exitX - dx * 0.1,
          prevY: exitY - dy * 0.1,
          prevZ: exitZ - dz * 0.1,
          rotation: Math.atan2(dx, dz),
        });
        world.addComponent<RenderableComponent>(ep, RENDERABLE, {
          meshType: 'projectile',
          color: 0xffffff,
          scale: impact.blastRadius >= 2 ? 1.5 : 1.0,
        });
        world.addComponent<ProjectileComponent>(ep, PROJECTILE, {
          ownerEntity: -1,
          targetEntity: -1,
          targetX: exitX + dx * 50,
          targetY: exitY + dy * 50,
          targetZ: exitZ + dz * 50,
          speed: exitSpeed,
          damage: 0,
          team: -1,
          color: 0xffffff,
          blastRadius: 0,
        });
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
    const rot = isBuilding ? 0 : rotation;
    const { gridX, gridY, gridZ } = worldToModelGrid(
      impact.impactX, impact.impactY, impact.impactZ,
      pos.x, pos.y, pos.z, model, rot,
    );

    const blastR = impact.blastRadius;
    const worldDirX = impact.dirX;
    const worldDirY = impact.dirY;
    const worldDirZ = impact.dirZ;

    // Apply blast and get destroyed voxels
    const destroyed = applyBlastDamage(model, voxelState.destroyed, gridX, gridY, gridZ, blastR, minY, maxY);
    voxelState.destroyedCount += destroyed.length;

    // Calculate debris directions for each destroyed voxel
    if (!this.headless) {
      const scatter = 0.4;
      for (const v of destroyed) {
        const radLen = Math.sqrt(v.dx * v.dx + v.dy * v.dy + v.dz * v.dz);
        let debrisDirX: number;
        let debrisDirY: number;
        let debrisDirZ: number;

        if (radLen < 0.001) {
          debrisDirX = -worldDirX + (this.rng.next() - 0.5) * scatter;
          debrisDirY = -worldDirY + this.rng.next() * 0.5;
          debrisDirZ = -worldDirZ + (this.rng.next() - 0.5) * scatter;
        } else {
          let outX = v.dx / radLen;
          let outY = v.dy / radLen;
          let outZ = v.dz / radLen;

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

        voxelState.pendingDebris.push({
          solidIndex: v.solidIndex,
          dirX: debrisDirX,
          dirY: debrisDirY,
          dirZ: debrisDirZ,
        });
      }
    }

    // Scorch pass (skip in headless)
    if (!this.headless) {
      const scorchTargets = findSurvivorsInRadius(model, voxelState.destroyed, gridX, gridY, gridZ, blastR + 1, minY, maxY);
      voxelState.pendingScorch.push(...scorchTargets);
    }
  }
}
