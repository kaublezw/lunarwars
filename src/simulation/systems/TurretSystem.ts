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

// Interpolate between two angles, handling wraparound
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

const BODY_TURN_SPEED = 3.0; // radians per second for body rotation
const TURRET_TURN_SPEED = 4.0; // radians per second for independent turret tracking
const TURRET_RETURN_SPEED = 1.5; // radians per second for turret returning to body facing

// Projectile speeds by attacker category
const PROJECTILE_SPEEDS: Partial<Record<UnitCategory, number>> = {
  [UnitCategory.CombatDrone]: 55,
  [UnitCategory.AssaultPlatform]: 70,
  [UnitCategory.AerialDrone]: 60,
};
const DEFAULT_PROJECTILE_SPEED = 45;

// Projectile colors by team
const TEAM_PROJECTILE_COLORS = [0xffffff, 0xffffff];

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

          // --- Single firing line through turret pivot ---
          // Step 1: Turret pivot = rotation center (matches renderer)
          const attackerVoxel = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
          let pivotY: number;
          if (attackerVoxel) {
            const attackerModel = VOXEL_MODELS[attackerVoxel.modelId];
            pivotY = pos.y + (attackerModel?.turretMinY ?? 0) * VOXEL_SIZE;
          } else {
            pivotY = pos.y + turret.muzzleHeight;
          }

          // Step 2: Pick target point
          const targetPos = world.getComponent<PositionComponent>(nearestEntity, POSITION)!;
          const targetVel = world.getComponent<VelocityComponent>(nearestEntity, VELOCITY);

          const dx = targetPos.x - pos.x;
          const dz = targetPos.z - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          const travelTime = dist / projSpeed;

          // Lead prediction
          let aimX = targetPos.x;
          let aimZ = targetPos.z;
          if (targetVel) {
            aimX += targetVel.x * travelTime;
            aimZ += targetVel.z * travelTime;
          }

          const isTargetBuilding = world.hasComponent(nearestEntity, BUILDING);
          const targetVoxel = world.getComponent<VoxelStateComponent>(nearestEntity, VOXEL_STATE);
          let impactX: number, impactY: number, impactZ: number;

          if (isTargetBuilding && targetVoxel) {
            // Building: ray march inward from shooter-facing edge to find solid surface voxel
            const model = VOXEL_MODELS[targetVoxel.modelId];
            if (model) {
              const bHalfX = (model.sizeX * VOXEL_SIZE) / 2;
              const bHalfZ = (model.sizeZ * VOXEL_SIZE) / 2;
              const adx = pos.x - aimX;
              const adz = pos.z - aimZ;
              const marchX = Math.abs(adx) > Math.abs(adz);

              // Determine if attacker is well above the target (aerial drone attacking building)
              const ady = pos.y - targetPos.y;
              const attackFromAbove = ady > 2.0 && ady > Math.sqrt(adx * adx + adz * adz) * 0.5;

              // Helper: pick a random solid surface voxel via ray march
              const marchRandomImpact = (): { x: number; y: number; z: number } => {
                let fGX = -1, fGY = -1, fGZ = -1;
                for (let attempt = 0; attempt < 8 && fGX < 0; attempt++) {
                  if (attackFromAbove) {
                    // Top-down ray march: random X/Z, march downward to find roof
                    const gx = Math.floor(Math.random() * model.sizeX);
                    const gz = Math.floor(Math.random() * model.sizeZ);
                    for (let gy = model.sizeY - 1; gy >= 0; gy--) {
                      if (model.grid[gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ] !== 0) {
                        fGX = gx; fGY = gy; fGZ = gz;
                        break;
                      }
                    }
                  } else if (marchX) {
                    const gy = Math.floor(Math.random() * model.sizeY);
                    const gz = Math.floor(Math.random() * model.sizeZ);
                    const startX = adx > 0 ? model.sizeX - 1 : 0;
                    const step = adx > 0 ? -1 : 1;
                    for (let gx = startX; gx >= 0 && gx < model.sizeX; gx += step) {
                      if (model.grid[gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ] !== 0) {
                        fGX = gx; fGY = gy; fGZ = gz;
                        break;
                      }
                    }
                  } else {
                    const gy = Math.floor(Math.random() * model.sizeY);
                    const gx = Math.floor(Math.random() * model.sizeX);
                    const startZ = adz > 0 ? model.sizeZ - 1 : 0;
                    const step = adz > 0 ? -1 : 1;
                    for (let gz = startZ; gz >= 0 && gz < model.sizeZ; gz += step) {
                      if (model.grid[gx + gz * model.sizeX + gy * model.sizeX * model.sizeZ] !== 0) {
                        fGX = gx; fGY = gy; fGZ = gz;
                        break;
                      }
                    }
                  }
                }
                if (fGX >= 0) {
                  return {
                    x: aimX + (fGX + 0.5) * VOXEL_SIZE - bHalfX,
                    y: targetPos.y + (fGY + 0.5) * VOXEL_SIZE,
                    z: aimZ + (fGZ + 0.5) * VOXEL_SIZE - bHalfZ,
                  };
                }
                return {
                  x: aimX,
                  y: targetPos.y + model.sizeY * VOXEL_SIZE * 0.5,
                  z: aimZ,
                };
              };

              // Use pre-computed aim if available for this target, else compute fresh
              if (turret.pendingAimTarget === nearestEntity && turret.pendingAimX !== undefined) {
                impactX = turret.pendingAimX;
                impactY = turret.pendingAimY!;
                impactZ = turret.pendingAimZ!;
              } else {
                const hit = marchRandomImpact();
                impactX = hit.x; impactY = hit.y; impactZ = hit.z;
              }

              // Pre-compute next aim point for smooth turret sweep between shots
              const next = marchRandomImpact();
              turret.pendingAimX = next.x;
              turret.pendingAimY = next.y;
              turret.pendingAimZ = next.z;
              turret.pendingAimTarget = nearestEntity;
            } else {
              impactX = aimX;
              impactY = targetPos.y + 0.5;
              impactZ = aimZ;
            }
          } else {
            // Unit: positional scatter
            const SCATTER = 0.8;
            impactX = aimX + (Math.random() - 0.5) * SCATTER;
            impactY = targetPos.y + 0.3 + (Math.random() - 0.5) * 0.6;
            impactZ = aimZ + (Math.random() - 0.5) * SCATTER;
          }

          // Step 3: Direction from pivot to impact (the ONE fire line)
          let fireDirX = impactX - pos.x;
          let fireDirY = impactY - pivotY;
          let fireDirZ = impactZ - pos.z;
          const fireDist = Math.sqrt(fireDirX * fireDirX + fireDirY * fireDirY + fireDirZ * fireDirZ) || 1;
          fireDirX /= fireDist;
          fireDirY /= fireDist;
          fireDirZ /= fireDist;

          // Step 4: Muzzle on the fire line (offset from pivot by barrel length)
          const muzzleX = pos.x + fireDirX * turret.muzzleOffset;
          const muzzleY = pivotY + fireDirY * turret.muzzleOffset;
          const muzzleZ = pos.z + fireDirZ * turret.muzzleOffset;

          // Step 5: Snap turret rotation to match fire line
          const fireAngle = Math.atan2(fireDirX, fireDirZ);
          const horizDist = Math.sqrt(fireDirX * fireDirX + fireDirZ * fireDirZ) || 1;
          const firePitch = -Math.atan2(fireDirY, horizDist);

          // Step 6: Spawn projectile along the barrel line
          const teamNum = myTeam ? myTeam.team : 0;
          const projColor = TEAM_PROJECTILE_COLORS[teamNum] ?? 0xffffff;

          const proj = world.createEntity();
          world.addComponent<PositionComponent>(proj, POSITION, {
            x: muzzleX, y: muzzleY, z: muzzleZ,
            prevX: muzzleX, prevY: muzzleY, prevZ: muzzleZ,
            rotation: fireAngle,
          });
          world.addComponent<RenderableComponent>(proj, RENDERABLE, {
            meshType: 'projectile',
            color: projColor,
            scale: turret.damage >= 20 ? 1.5 : 1.0,
          });
          world.addComponent<ProjectileComponent>(proj, PROJECTILE, {
            ownerEntity: e,
            targetEntity: nearestEntity,
            targetX: impactX,
            targetY: impactY,
            targetZ: impactZ,
            speed: projSpeed,
            damage: actualDamage,
            team: teamNum,
            color: projColor,
            blastRadius: turret.damage >= 20 ? 2 : 1,
          });

          // Step 7: Snap rotation to match firing direction
          if (turret.rotateBodyToTarget) {
            pos.rotation = fireAngle;
            turret.turretRotation = fireAngle;
          } else {
            turret.turretRotation = fireAngle;
            turret.turretPitch = firePitch;
          }
          // Store sweep origin for cooldown-based interpolation toward next aim
          if (isTargetBuilding) {
            turret.sweepStartAngle = fireAngle;
            turret.sweepStartPitch = firePitch;
          }
        }

        const targetIsBuilding = world.hasComponent(nearestEntity, BUILDING);

        if (turret.rotateBodyToTarget) {
          // Infantry-like: idle body rotation toward target when not moving and not firing
          turret.turretRotation = pos.rotation;
          const canSweepBody = targetIsBuilding && turret.pendingAimTarget === nearestEntity
            && turret.pendingAimX !== undefined && turret.sweepStartAngle !== undefined;
          if (!turret.firedThisFrame && !world.hasComponent(e, MOVE_COMMAND)) {
            if (canSweepBody) {
              // Building: interpolate from last fire angle to next aim over cooldown period
              const cooldownMax = 1 / turret.fireRate;
              const t = Math.max(0, Math.min(1, 1 - turret.cooldown / cooldownMax));
              const pendingAngle = Math.atan2(turret.pendingAimX! - pos.x, turret.pendingAimZ! - pos.z);
              pos.rotation = lerpAngle(turret.sweepStartAngle!, pendingAngle, t);
            } else {
              // Unit: smoothly track toward target center
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
            }
            turret.turretRotation = pos.rotation;
          }
        } else {
          // Tank-like: smoothly rotate turret toward target
          const canSweepTurret = targetIsBuilding && turret.pendingAimTarget === nearestEntity
            && turret.pendingAimX !== undefined && turret.sweepStartAngle !== undefined;
          if (!turret.firedThisFrame) {
            if (canSweepTurret) {
              // Building: interpolate yaw and pitch over cooldown period
              const cooldownMax = 1 / turret.fireRate;
              const t = Math.max(0, Math.min(1, 1 - turret.cooldown / cooldownMax));
              const pendingAngle = Math.atan2(turret.pendingAimX! - pos.x, turret.pendingAimZ! - pos.z);
              turret.turretRotation = lerpAngle(turret.sweepStartAngle!, pendingAngle, t);

              // Pitch interpolation
              const idleVoxel = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
              let idlePivotY: number;
              if (idleVoxel) {
                const idleModel = VOXEL_MODELS[idleVoxel.modelId];
                idlePivotY = pos.y + (idleModel?.turretMinY ?? 0) * VOXEL_SIZE;
              } else {
                idlePivotY = pos.y + turret.muzzleHeight;
              }
              const pdx = turret.pendingAimX! - pos.x;
              const pdz = turret.pendingAimZ! - pos.z;
              const pdxz = Math.sqrt(pdx * pdx + pdz * pdz) || 1;
              const pendingPitch = -Math.atan2(turret.pendingAimY! - idlePivotY, pdxz);
              turret.turretPitch = lerpAngle(turret.sweepStartPitch ?? 0, pendingPitch, t);
            } else {
              // Unit: smoothly track toward target center
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

              // Pitch tracking
              const idleVoxel = world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
              let idlePivotY: number;
              if (idleVoxel) {
                const idleModel = VOXEL_MODELS[idleVoxel.modelId];
                idlePivotY = pos.y + (idleModel?.turretMinY ?? 0) * VOXEL_SIZE;
              } else {
                idlePivotY = pos.y + turret.muzzleHeight;
              }
              const tgtPos = world.getComponent<PositionComponent>(nearestEntity, POSITION);
              const trackY = tgtPos ? tgtPos.y : pos.y;
              const dy = trackY - idlePivotY;
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
        // No target: clear pre-computed building aim and sweep state
        turret.pendingAimTarget = undefined;
        turret.pendingAimX = undefined;
        turret.sweepStartAngle = undefined;
        turret.sweepStartPitch = undefined;
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
