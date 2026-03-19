import type { System, World } from '@core/ECS';
import { ENERGY_PACKET, POSITION, HEALTH, BUILDING, CONSTRUCTION, RESOURCE_SILO } from '@sim/components/ComponentTypes';
import type { EnergyPacketComponent } from '@sim/components/EnergyPacket';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { SiloSystem } from './SiloSystem';
import { PACKET_ELEVATION } from '@sim/systems/EconomySystem';

const ARRIVAL_DIST_SQ = 1.0; // 1 wu squared
const HOVER_OFFSET_Y = 0.5;  // hover height above beam elevation

export class EnergyPacketSystem implements System {
  readonly name = 'EnergyPacketSystem';

  private siloSystem: SiloSystem | null = null;

  constructor(private resources: ResourceState) {}

  setSiloSystem(siloSystem: SiloSystem): void {
    this.siloSystem = siloSystem;
  }

  update(world: World, dt: number): void {
    const packets = world.query(ENERGY_PACKET, POSITION);

    for (const e of packets) {
      const packet = world.getComponent<EnergyPacketComponent>(e, ENERGY_PACKET)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const health = world.getComponent<HealthComponent>(e, HEALTH);

      // Skip dead packets (let HealthSystem handle destruction)
      if (health && health.dead) continue;

      // Check if target still exists and is alive
      const targetHealth = world.getComponent<HealthComponent>(packet.targetEntity, HEALTH);
      if (!targetHealth || targetHealth.dead) {
        // Target destroyed — energy is lost, destroy packet
        world.destroyEntity(e);
        continue;
      }

      // Check if target is a construction site
      const isConstruction = world.hasComponent(packet.targetEntity, CONSTRUCTION);

      // Hovering above a construction site
      if (packet.hovering) {
        if (!isConstruction) {
          // Construction completed — absorb into antenna (move to antenna height, then destroy)
          const targetPos = world.getComponent<PositionComponent>(packet.targetEntity, POSITION);
          if (targetPos) {
            packet.targetX = targetPos.x;
            packet.targetY = targetPos.y + PACKET_ELEVATION;
            packet.targetZ = targetPos.z;
          }
          packet.hovering = false;
        } else {
          // Stay hovering above the construction site
          const targetPos = world.getComponent<PositionComponent>(packet.targetEntity, POSITION);
          if (targetPos) {
            pos.prevX = pos.x;
            pos.prevY = pos.y;
            pos.prevZ = pos.z;
            pos.x = targetPos.x;
            pos.y = targetPos.y + PACKET_ELEVATION + HOVER_OFFSET_Y;
            pos.z = targetPos.z;
          }
          continue;
        }
      }

      // Update target position from building
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
        if (isConstruction) {
          // Arrived at construction site — start hovering
          packet.hovering = true;
          continue;
        }
        // Arrived at completed building — deliver energy
        if (packet.energyAmount > 0) {
          this.depositEnergyAtBuilding(world, packet);
        }
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

  /** Deposit beam energy into the target building's energy silo. */
  private depositEnergyAtBuilding(world: World, packet: EnergyPacketComponent): void {
    if (this.siloSystem) {
      const silo = this.siloSystem.findOrSpawnSilo(
        world, packet.targetEntity, 'energy', packet.team,
      );
      if (silo !== null) {
        const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
        siloComp.stored += packet.energyAmount;
        return;
      }
    }
    // Fallback: add to global pool if no silo could be created
    this.resources.addEnergy(packet.team, packet.energyAmount);
  }
}
