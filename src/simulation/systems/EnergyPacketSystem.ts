import type { System, World } from '@core/ECS';
import { ENERGY_PACKET, POSITION, HEALTH, BUILDING, TEAM } from '@sim/components/ComponentTypes';
import type { EnergyPacketComponent } from '@sim/components/EnergyPacket';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { ResourceState } from '@sim/economy/ResourceState';
import { PACKET_ELEVATION } from '@sim/systems/EconomySystem';

const ARRIVAL_DIST_SQ = 1.0; // 1 wu squared

export class EnergyPacketSystem implements System {
  readonly name = 'EnergyPacketSystem';

  constructor(private resources: ResourceState) {}

  update(world: World, dt: number): void {
    const packets = world.query(ENERGY_PACKET, POSITION);

    for (const e of packets) {
      const packet = world.getComponent<EnergyPacketComponent>(e, ENERGY_PACKET)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const health = world.getComponent<HealthComponent>(e, HEALTH);

      // Skip dead packets (let HealthSystem handle destruction)
      if (health && health.dead) continue;

      // Check if target HQ still exists and is alive
      const targetHealth = world.getComponent<HealthComponent>(packet.targetEntity, HEALTH);
      const targetBuilding = world.getComponent<BuildingComponent>(packet.targetEntity, BUILDING);
      if (!targetHealth || targetHealth.dead || !targetBuilding || targetBuilding.buildingType !== BuildingType.HQ) {
        // HQ destroyed - destroy packet (energy lost)
        world.destroyEntity(e);
        continue;
      }

      // Update target position from HQ (in case it somehow moves)
      const targetPos = world.getComponent<PositionComponent>(packet.targetEntity, POSITION);
      if (targetPos) {
        packet.targetX = targetPos.x;
        packet.targetY = targetPos.y + PACKET_ELEVATION;
        packet.targetZ = targetPos.z;
      }

      // Move toward target
      const dx = packet.targetX - pos.x;
      const dy = packet.targetY - pos.y;
      const dz = packet.targetZ - pos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq <= ARRIVAL_DIST_SQ) {
        // Arrived - deliver energy
        this.resources.addEnergy(packet.team, packet.energyAmount);
        world.destroyEntity(e);
        continue;
      }

      // Normalize and move
      const dist = Math.sqrt(distSq);
      const step = packet.speed * dt;
      const factor = Math.min(step / dist, 1.0);

      pos.prevX = pos.x;
      pos.prevY = pos.y;
      pos.prevZ = pos.z;
      pos.x += dx * factor;
      pos.y += dy * factor;
      pos.z += dz * factor;
    }
  }
}
