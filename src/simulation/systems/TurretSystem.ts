import type { System, World } from '@core/ECS';
import { POSITION, TURRET, TEAM, HEALTH, MOVE_COMMAND, ATTACK_TARGET, UNIT_TYPE, PROJECTILE, VELOCITY } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TurretComponent } from '@sim/components/Turret';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { AttackTargetComponent } from '@sim/components/AttackTarget';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { ProjectileComponent } from '@sim/components/Projectile';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { RENDERABLE, BUILDING, VOXEL_STATE } from '@sim/components/ComponentTypes';
import { SpatialHash } from '@sim/spatial/SpatialHash';
import { COUNTER_MULTIPLIERS, UNIT_DEFS } from '@sim/data/UnitData';
import { UnitCategory } from '@sim/components/UnitType';
import { VOXEL_SIZE, VOXEL_MODELS } from '@sim/data/VoxelModels';

const BODY_TURN_SPEED = 3.0; // radians per second for body rotation
const TURRET_TURN_SPEED = 4.0; // radians per second for independent turret tracking
const TURRET_RETURN_SPEED = 1.5; // radians per second for turret returning to body facing

// Projectile speeds by attacker category
const PROJECTILE_SPEEDS: Partial<Record<UnitCategory, number>> = {
  [UnitCategory.CombatDrone]: 55,
  [UnitCategory.AssaultPlatform]: 40,
  [UnitCategory.AerialDrone]: 60,
};
const DEFAULT_PROJECTILE_SPEED = 45;

// Projectile colors by team
const TEAM_PROJECTILE_COLORS = [0x88ccff, 0xff6644];

export class TurretSystem implements System {
  readonly name = 'TurretSystem';
  private spatialHash: SpatialHash;

  constructor() {
    this.spatialHash = new SpatialHash(4, 276, 276);
  }

  update(world: World, dt: number): void {
    const turretEntities = world.query(POSITION, TURRET);
    const targetable = world.query(POSITION, HEALTH);

    // Rebuild spatial hash with targetable entities only (have POSITION + HEALTH, not dead)
    this.spatialHash.clear();
    for (const e of targetable) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      this.spatialHash.insert(e, pos.x, pos.z);
    }

    for (const e of turretEntities) {
      const turret = world.getComponent<TurretComponent>(e, TURRET)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const myTeam = world.getComponent<TeamComponent>(e, TEAM);

      // Reset fire flag at start of each tick
      turret.firedThisFrame = false;

      // Check for pinned attack target before auto-scan
      let pinnedUsed = false;
      const atkTarget = world.getComponent<AttackTargetComponent>(e, ATTACK_TARGET);
      if (atkTarget) {
        const tgtHealth = world.getComponent<HealthComponent>(atkTarget.entity, HEALTH);
        const tgtPos = world.getComponent<PositionComponent>(atkTarget.entity, POSITION);
        if (!tgtHealth || tgtHealth.dead || !tgtPos) {
          // Target dead or invalid: clear pinned target
          world.removeComponent(e, ATTACK_TARGET);
        } else {
          const dx = tgtPos.x - pos.x;
          const dz = tgtPos.z - pos.z;
          const distSq = dx * dx + dz * dz;
          if (distSq <= turret.range * turret.range) {
            // Pinned target in range: use it, skip auto-scan
            turret.targetEntity = atkTarget.entity;
            turret.targetX = tgtPos.x;
            turret.targetZ = tgtPos.z;
            pinnedUsed = true;
          }
          // If out of range: fall through to auto-scan (shoot nearby enemies while chasing)
        }
      }

      // Auto-scan: find nearest enemy entity within range
      if (!pinnedUsed) {
        const neighbors = this.spatialHash.query(pos.x, pos.z, turret.range);
        let nearestDistSq = Infinity;
        let nearestEntity = -1;
        let nearestX = 0;
        let nearestZ = 0;

        for (const other of neighbors) {
          if (other === e) continue;

          // Skip entities on the same team
          const otherTeam = world.getComponent<TeamComponent>(other, TEAM);
          if (myTeam && otherTeam && myTeam.team === otherTeam.team) continue;

          // Skip dead entities
          const otherHealth = world.getComponent<HealthComponent>(other, HEALTH);
          if (otherHealth && otherHealth.dead) continue;

          const otherPos = world.getComponent<PositionComponent>(other, POSITION)!;
          const dx = otherPos.x - pos.x;
          const dz = otherPos.z - pos.z;
          const distSq = dx * dx + dz * dz;

          if (distSq < nearestDistSq && distSq <= turret.range * turret.range) {
            nearestDistSq = distSq;
            nearestEntity = other;
            nearestX = otherPos.x;
            nearestZ = otherPos.z;
          }
        }

        turret.targetEntity = nearestEntity;
        turret.targetX = nearestX;
        turret.targetZ = nearestZ;
      }

      const nearestEntity = turret.targetEntity;
      const nearestX = turret.targetX;
      const nearestZ = turret.targetZ;

      // Cooldown and fire
      if (nearestEntity !== -1) {
        turret.cooldown -= dt;
        if (turret.cooldown <= 0 && turret.ammo > 0) {
          turret.firedThisFrame = true;
          turret.cooldown = 1 / turret.fireRate;
          turret.ammo--;

          // Compute damage with counter multiplier
          const attackerType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
          const targetType = world.getComponent<UnitTypeComponent>(nearestEntity, UNIT_TYPE);
          const multiplier = (attackerType && targetType)
            ? (COUNTER_MULTIPLIERS[attackerType.category]?.[targetType.category] ?? 1.0)
            : 1.0;
          const actualDamage = turret.damage * multiplier;

          // Determine projectile speed
          const projSpeed = attackerType
            ? (PROJECTILE_SPEEDS[attackerType.category] ?? DEFAULT_PROJECTILE_SPEED)
            : DEFAULT_PROJECTILE_SPEED;

          // Predictive aiming: compute intercept point
          const targetPos = world.getComponent<PositionComponent>(nearestEntity, POSITION)!;
          const targetVel = world.getComponent<VelocityComponent>(nearestEntity, VELOCITY);

          const dx = targetPos.x - pos.x;
          const dz = targetPos.z - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          const travelTime = dist / projSpeed;

          let interceptX = targetPos.x;
          let interceptZ = targetPos.z;
          let interceptY = targetPos.y + 0.3; // aim slightly above ground level

          if (targetVel) {
            interceptX += targetVel.x * travelTime;
            interceptZ += targetVel.z * travelTime;
          }

          // Scale scatter to target size: buildings get full-volume randomization,
          // units get small scatter for voxel-level variation
          const isTargetBuilding = world.hasComponent(nearestEntity, BUILDING);
          const targetVoxel = world.getComponent<VoxelStateComponent>(nearestEntity, VOXEL_STATE);
          if (isTargetBuilding && targetVoxel) {
            const model = VOXEL_MODELS[targetVoxel.modelId];
            if (model) {
              const extentX = model.sizeX * VOXEL_SIZE;
              const extentY = model.sizeY * VOXEL_SIZE;
              const extentZ = model.sizeZ * VOXEL_SIZE;
              interceptX += (Math.random() - 0.5) * extentX * 0.8;
              interceptZ += (Math.random() - 0.5) * extentZ * 0.8;
              interceptY = targetPos.y + Math.random() * extentY * 0.9;
            }
          } else {
            // Unit scatter: ~5 voxels of XZ randomness
            const SCATTER = 0.8;
            interceptX += (Math.random() - 0.5) * SCATTER;
            interceptZ += (Math.random() - 0.5) * SCATTER;
            interceptY += (Math.random() - 0.5) * 0.6;
          }

          // Direction to intercept point for muzzle spawn and rotation
          const idxI = interceptX - pos.x;
          const idzI = interceptZ - pos.z;
          const iDist = Math.sqrt(idxI * idxI + idzI * idzI) || 1;
          const ndxI = idxI / iDist;
          const ndzI = idzI / iDist;

          // Muzzle uses turret direction for independent turrets, body direction otherwise
          const muzzleAngle = turret.rotateBodyToTarget
            ? Math.atan2(dx / dist, dz / dist)
            : turret.turretRotation;
          const muzzleDirX = Math.sin(muzzleAngle);
          const muzzleDirZ = Math.cos(muzzleAngle);
          const muzzleX = pos.x + muzzleDirX * turret.muzzleOffset;
          const muzzleY = pos.y + turret.muzzleHeight;
          const muzzleZ = pos.z + muzzleDirZ * turret.muzzleOffset;

          // Determine projectile color
          const teamNum = myTeam ? myTeam.team : 0;
          const projColor = TEAM_PROJECTILE_COLORS[teamNum] ?? 0xffcc33;

          // Spawn projectile entity
          const proj = world.createEntity();
          world.addComponent<PositionComponent>(proj, POSITION, {
            x: muzzleX, y: muzzleY, z: muzzleZ,
            prevX: muzzleX, prevY: muzzleY, prevZ: muzzleZ,
            rotation: Math.atan2(ndxI, ndzI),
          });
          world.addComponent<RenderableComponent>(proj, RENDERABLE, {
            meshType: 'projectile',
            color: projColor,
            scale: turret.damage >= 20 ? 1.5 : 1.0,
          });
          world.addComponent<ProjectileComponent>(proj, PROJECTILE, {
            ownerEntity: e,
            targetEntity: nearestEntity,
            targetX: interceptX,
            targetY: interceptY,
            targetZ: interceptZ,
            speed: projSpeed,
            damage: actualDamage,
            team: teamNum,
            color: projColor,
            blastRadius: turret.damage >= 20 ? 2 : 1,
          });

          if (turret.rotateBodyToTarget) {
            // Infantry-like: snap body to face shot direction
            const ndx = dx / dist;
            const ndz = dz / dist;
            pos.rotation = Math.atan2(ndx, ndz);
            turret.turretRotation = pos.rotation;
          } else {
            // Tank-like: snap turret to intercept direction, body untouched
            turret.turretRotation = Math.atan2(ndxI, ndzI);
            // Pitch toward intercept point
            const pitchDy = interceptY - muzzleY;
            const pitchDxz = Math.sqrt((interceptX - muzzleX) ** 2 + (interceptZ - muzzleZ) ** 2) || 1;
            turret.turretPitch = -Math.atan2(pitchDy, pitchDxz);
          }
        }

        if (turret.rotateBodyToTarget) {
          // Infantry-like: idle body rotation toward target when not moving and not firing
          turret.turretRotation = pos.rotation;
          if (!turret.firedThisFrame && !world.hasComponent(e, MOVE_COMMAND)) {
            const dx = nearestX - pos.x;
            const dz = nearestZ - pos.z;
            const targetAngle = Math.atan2(dx, dz);
            let diff = targetAngle - pos.rotation;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;

            const maxStep = BODY_TURN_SPEED * dt;
            if (Math.abs(diff) <= maxStep) {
              pos.rotation = targetAngle;
            } else {
              pos.rotation += Math.sign(diff) * maxStep;
            }
            turret.turretRotation = pos.rotation;
          }
        } else {
          // Tank-like: smoothly rotate turret toward target (when not snapping on fire)
          if (!turret.firedThisFrame) {
            const dx = nearestX - pos.x;
            const dz = nearestZ - pos.z;
            const targetAngle = Math.atan2(dx, dz);
            let diff = targetAngle - turret.turretRotation;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;

            const maxStep = TURRET_TURN_SPEED * dt;
            if (Math.abs(diff) <= maxStep) {
              turret.turretRotation = targetAngle;
            } else {
              turret.turretRotation += Math.sign(diff) * maxStep;
            }

            // Pitch tracking toward target
            const tgtPos = world.getComponent<PositionComponent>(nearestEntity, POSITION);
            if (tgtPos) {
              const dy = tgtPos.y - (pos.y + turret.muzzleHeight);
              const dxz = Math.sqrt(dx * dx + dz * dz) || 1;
              const targetPitch = -Math.atan2(dy, dxz);
              let pitchDiff = targetPitch - turret.turretPitch;
              const maxPitchStep = TURRET_TURN_SPEED * dt;
              if (Math.abs(pitchDiff) <= maxPitchStep) {
                turret.turretPitch = targetPitch;
              } else {
                turret.turretPitch += Math.sign(pitchDiff) * maxPitchStep;
              }
            }
          }
        }
      } else {
        // No target
        if (turret.rotateBodyToTarget) {
          turret.turretRotation = pos.rotation;
        } else {
          // Tank-like: slowly return turret to match body facing
          let diff = pos.rotation - turret.turretRotation;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;

          const maxStep = TURRET_RETURN_SPEED * dt;
          if (Math.abs(diff) <= maxStep) {
            turret.turretRotation = pos.rotation;
          } else {
            turret.turretRotation += Math.sign(diff) * maxStep;
          }

          // Return pitch to level
          const pitchDiff = -turret.turretPitch;
          const maxPitchStep = TURRET_RETURN_SPEED * dt;
          if (Math.abs(pitchDiff) <= maxPitchStep) {
            turret.turretPitch = 0;
          } else {
            turret.turretPitch += Math.sign(pitchDiff) * maxPitchStep;
          }
        }
      }
    }
  }
}
