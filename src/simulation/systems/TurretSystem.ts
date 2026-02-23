import type { System, World } from '@core/ECS';
import { POSITION, TURRET, TEAM, HEALTH, MOVE_COMMAND, ATTACK_TARGET, UNIT_TYPE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TurretComponent } from '@sim/components/Turret';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { AttackTargetComponent } from '@sim/components/AttackTarget';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { SpatialHash } from '@sim/spatial/SpatialHash';
import { COUNTER_MULTIPLIERS } from '@sim/data/UnitData';

const BODY_TURN_SPEED = 3.0; // radians per second (same as turret turn speed in render)

export class TurretSystem implements System {
  readonly name = 'TurretSystem';
  private spatialHash: SpatialHash;

  constructor() {
    this.spatialHash = new SpatialHash(4, 256, 256);
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

          // Apply damage to target (with unit-type counter multiplier)
          const targetHealth = world.getComponent<HealthComponent>(nearestEntity, HEALTH);
          if (targetHealth) {
            const attackerType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
            const targetType = world.getComponent<UnitTypeComponent>(nearestEntity, UNIT_TYPE);
            const multiplier = (attackerType && targetType)
              ? (COUNTER_MULTIPLIERS[attackerType.category]?.[targetType.category] ?? 1.0)
              : 1.0;
            targetHealth.current -= turret.damage * multiplier;
            if (targetHealth.current <= 0) {
              targetHealth.dead = true;
            }
          }
        }

        // Idle body rotation: rotate body toward target when primitive + no move command
        if (turret.rotateBodyToTarget && !world.hasComponent(e, MOVE_COMMAND)) {
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
      }
    }
  }
}
