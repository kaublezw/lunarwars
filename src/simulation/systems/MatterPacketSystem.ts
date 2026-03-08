import type { System, World } from '@core/ECS';
import { MATTER_PACKET, POSITION, HEALTH, BUILDING, MOVE_COMMAND } from '@sim/components/ComponentTypes';
import type { MatterPacketComponent } from '@sim/components/MatterPacket';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { ResourceState } from '@sim/economy/ResourceState';

const ARRIVAL_DIST_SQ = 16.0; // 4 wu radius — accounts for HQ building footprint

export class MatterPacketSystem implements System {
  readonly name = 'MatterPacketSystem';

  constructor(private resources: ResourceState) {}

  update(world: World, dt: number): void {
    const packets = world.query(MATTER_PACKET, POSITION);

    for (const e of packets) {
      const packet = world.getComponent<MatterPacketComponent>(e, MATTER_PACKET)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const health = world.getComponent<HealthComponent>(e, HEALTH);

      if (health && health.dead) continue;

      // Check if target HQ still exists and is alive
      const targetHealth = world.getComponent<HealthComponent>(packet.targetEntity, HEALTH);
      const targetBuilding = world.getComponent<BuildingComponent>(packet.targetEntity, BUILDING);
      if (!targetHealth || targetHealth.dead || !targetBuilding || targetBuilding.buildingType !== BuildingType.HQ) {
        world.destroyEntity(e);
        continue;
      }

      // Check proximity to HQ
      const targetPos = world.getComponent<PositionComponent>(packet.targetEntity, POSITION);
      if (!targetPos) continue;

      const dx = targetPos.x - pos.x;
      const dz = targetPos.z - pos.z;
      const distSq = dx * dx + dz * dz;

      if (distSq <= ARRIVAL_DIST_SQ) {
        // Arrived - deliver matter
        this.resources.addMatter(packet.team, packet.matterAmount);
        world.destroyEntity(e);
        continue;
      }

      // If no MOVE_COMMAND (arrived at waypoint or got stuck), re-issue toward HQ
      if (!world.hasComponent(e, MOVE_COMMAND)) {
        world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
          path: [],
          currentWaypoint: 0,
          destX: targetPos.x,
          destZ: targetPos.z,
        });
      }
    }
  }
}
