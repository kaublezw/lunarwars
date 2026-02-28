import type { System, World } from '@core/ECS';
import { POSITION, PROJECTILE, HEALTH, VOXEL_STATE, IMPACT_EVENT } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { ProjectileComponent } from '@sim/components/Projectile';
import type { HealthComponent } from '@sim/components/Health';
import type { ImpactEventComponent } from '@sim/components/ImpactEvent';

const HIT_RADIUS_SQ = 0.5 * 0.5; // within 0.5 units = impact

export class ProjectileSystem implements System {
  readonly name = 'ProjectileSystem';

  update(world: World, dt: number): void {
    const projectiles = world.query(POSITION, PROJECTILE);

    for (const e of projectiles) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const proj = world.getComponent<ProjectileComponent>(e, PROJECTILE)!;

      // Move toward target position
      const dx = proj.targetX - pos.x;
      const dy = proj.targetY - pos.y;
      const dz = proj.targetZ - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < 0.01) {
        // Arrived at target
        this.onImpact(world, e, proj, pos);
        continue;
      }

      const moveAmount = proj.speed * dt;

      if (moveAmount >= dist) {
        // Will reach target this frame
        pos.prevX = pos.x;
        pos.prevY = pos.y;
        pos.prevZ = pos.z;
        pos.x = proj.targetX;
        pos.y = proj.targetY;
        pos.z = proj.targetZ;
        this.onImpact(world, e, proj, pos);
      } else {
        // Move toward target
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;

        pos.prevX = pos.x;
        pos.prevY = pos.y;
        pos.prevZ = pos.z;
        pos.x += nx * moveAmount;
        pos.y += ny * moveAmount;
        pos.z += nz * moveAmount;

        // Update rotation to face direction of travel
        pos.rotation = Math.atan2(nx, nz);
      }
    }
  }

  private onImpact(world: World, projectileEntity: number, proj: ProjectileComponent, impactPos: PositionComponent): void {
    // Check if target is still alive
    const targetHealth = world.getComponent<HealthComponent>(proj.targetEntity, HEALTH);
    const targetPos = world.getComponent<PositionComponent>(proj.targetEntity, POSITION);

    if (targetHealth && !targetHealth.dead && targetPos) {
      // Apply damage
      targetHealth.current -= proj.damage;
      if (targetHealth.current <= 0) {
        targetHealth.dead = true;
      }

      // Add impact event for voxel damage
      if (world.hasComponent(proj.targetEntity, VOXEL_STATE)) {
        // Compute bullet direction from last movement step
        const pdx = impactPos.x - impactPos.prevX;
        const pdy = impactPos.y - impactPos.prevY;
        const pdz = impactPos.z - impactPos.prevZ;
        const plen = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz) || 1;

        world.addComponent<ImpactEventComponent>(proj.targetEntity, IMPACT_EVENT, {
          impactX: impactPos.x,
          impactY: impactPos.y,
          impactZ: impactPos.z,
          blastRadius: proj.blastRadius,
          damage: proj.damage,
          dirX: pdx / plen,
          dirY: pdy / plen,
          dirZ: pdz / plen,
        });
      }
    }
    // If target died before impact, projectile detonates at its position (no damage)

    // Destroy projectile
    world.destroyEntity(projectileEntity);
  }
}
