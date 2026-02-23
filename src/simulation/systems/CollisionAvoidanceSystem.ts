import type { System, World } from '@core/ECS';
import { POSITION, VELOCITY, UNIT_TYPE, MOVE_COMMAND, STEERING } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';
import { UnitCategory } from '@sim/components/UnitType';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { SpatialHash } from '@sim/spatial/SpatialHash';

const SEPARATION_WEIGHT = 5.0;

export class CollisionAvoidanceSystem implements System {
  readonly name = 'CollisionAvoidanceSystem';
  private spatialHash: SpatialHash;

  constructor() {
    this.spatialHash = new SpatialHash(4, 256, 256);
  }

  update(world: World, _dt: number): void {
    const entities = world.query(POSITION, VELOCITY);

    // Rebuild spatial hash
    this.spatialHash.clear();
    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      this.spatialHash.insert(e, pos.x, pos.z);
    }

    // Apply separation forces
    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;
      const unitType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      const steering = world.getComponent<SteeringComponent>(e, STEERING);

      const radius = unitType?.radius ?? 0.25;
      const isAerial = unitType?.category === UnitCategory.AerialDrone;
      const queryRadius = Math.max(radius * 4, 2.0);

      const neighbors = this.spatialHash.query(pos.x, pos.z, queryRadius);

      let sepX = 0;
      let sepZ = 0;

      for (const other of neighbors) {
        if (other === e) continue;

        const otherType = world.getComponent<UnitTypeComponent>(other, UNIT_TYPE);
        const otherAerial = otherType?.category === UnitCategory.AerialDrone;

        // Only collide within same layer (aerial with aerial, ground with ground)
        if (isAerial !== otherAerial) continue;

        const otherPos = world.getComponent<PositionComponent>(other, POSITION)!;
        const otherRadius = otherType?.radius ?? 0.25;

        const dx = pos.x - otherPos.x;
        const dz = pos.z - otherPos.z;
        const distSq = dx * dx + dz * dz;
        const minDist = radius + otherRadius;
        const minDistSq = minDist * minDist;

        if (distSq < minDistSq && distSq > 0.0001) {
          const dist = Math.sqrt(distSq);
          const overlap = minDist - dist;
          const pushStrength = overlap * SEPARATION_WEIGHT;
          sepX += (dx / dist) * pushStrength;
          sepZ += (dz / dist) * pushStrength;
        } else if (distSq <= 0.0001) {
          // Nearly on top of each other — push in arbitrary direction
          sepX += (Math.random() - 0.5) * 2;
          sepZ += (Math.random() - 0.5) * 2;
        }
      }

      // Apply separation only to moving units (with MOVE_COMMAND)
      // Idle units are skipped to prevent drift/vibration
      if ((sepX !== 0 || sepZ !== 0) && steering && world.hasComponent(e, MOVE_COMMAND)) {
        steering.forceX += sepX;
        steering.forceZ += sepZ;
      }
    }
  }
}
