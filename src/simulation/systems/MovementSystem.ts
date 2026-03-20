import type { System, World } from '@core/ECS';
import { POSITION, VELOCITY, UNIT_TYPE, STEERING, GARAGE_EXIT } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';
import { UnitCategory } from '@sim/components/UnitType';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';

const WORLD_MIN = 0;
const WORLD_MAX = 276;
const AERIAL_HEIGHT = 5.5;
const TURN_SPEED = 4.0; // radians per second

export class MovementSystem implements System {
  readonly name = 'MovementSystem';
  private occupancy: BuildingOccupancy | null = null;

  constructor(private terrain?: TerrainData) {}

  setOccupancy(occupancy: BuildingOccupancy): void {
    this.occupancy = occupancy;
  }

  update(world: World, dt: number): void {
    const entities = world.query(POSITION, VELOCITY);

    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;
      const unitType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      const steering = world.getComponent<SteeringComponent>(e, STEERING);

      // Apply accumulated steering forces to velocity
      if (steering) {
        vel.x += steering.forceX * dt;
        vel.z += steering.forceZ * dt;

        // Clamp velocity magnitude to max speed
        const speedSq = vel.x * vel.x + vel.z * vel.z;
        const maxSpeed = vel.speed;
        if (speedSq > maxSpeed * maxSpeed) {
          const speed = Math.sqrt(speedSq);
          vel.x = (vel.x / speed) * maxSpeed;
          vel.z = (vel.z / speed) * maxSpeed;
        }
      }

      // Skip position update for idle units
      if (vel.x === 0 && vel.z === 0) {
        if (steering) {
          steering.forceX = 0;
          steering.forceZ = 0;
        }
        continue;
      }

      // Save previous position for interpolation
      pos.prevX = pos.x;
      pos.prevY = pos.y;
      pos.prevZ = pos.z;

      const isAerial = unitType?.category === UnitCategory.AerialDrone;
      const isGarageExit = world.hasComponent(e, GARAGE_EXIT);

      if (isAerial) {
        pos.x += vel.x * dt;
        pos.z += vel.z * dt;
        pos.y = AERIAL_HEIGHT;
      } else if (isGarageExit) {
        // Garage-exiting units move straight through the HQ — skip occupancy/terrain checks
        pos.x += vel.x * dt;
        pos.z += vel.z * dt;
        if (this.terrain) {
          pos.y = this.terrain.getHeight(pos.x, pos.z) + 0.02;
        }
      } else if (this.terrain) {
        const r = unitType?.radius ?? 0.25;
        const newX = pos.x + vel.x * dt;
        const newZ = pos.z + vel.z * dt;

        // Wall sliding: try both axes, then each individually
        // Pass current position so units can move out of building footprints they already overlap
        if (this.isClearAt(newX, newZ, r, pos.x, pos.z)) {
          pos.x = newX;
          pos.z = newZ;
        } else if (this.isClearAt(newX, pos.z, r, pos.x, pos.z)) {
          // Blocked on Z axis — slide along X (wall normal is Z)
          pos.x = newX;
          vel.z = 0;
        } else if (this.isClearAt(pos.x, newZ, r, pos.x, pos.z)) {
          // Blocked on X axis — slide along Z (wall normal is X)
          pos.z = newZ;
          vel.x = 0;
        }
        // If blocked on both axes, don't move (vel stays for next frame's steering to correct)

        pos.y = this.terrain.getHeight(pos.x, pos.z) + 0.02;
      } else {
        pos.x += vel.x * dt;
        pos.z += vel.z * dt;
        pos.y = 0.02;
      }

      // Clamp to world edges
      pos.x = Math.max(WORLD_MIN, Math.min(WORLD_MAX, pos.x));
      pos.z = Math.max(WORLD_MIN, Math.min(WORLD_MAX, pos.z));

      // Smoothly rotate toward movement direction
      if (vel.x !== 0 || vel.z !== 0) {
        const targetRot = Math.atan2(vel.x, vel.z);
        let diff = targetRot - pos.rotation;
        // Wrap to [-PI, PI] for shortest turn
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const maxStep = TURN_SPEED * dt;
        if (Math.abs(diff) <= maxStep) {
          pos.rotation = targetRot;
        } else {
          pos.rotation += Math.sign(diff) * maxStep;
        }
      }

      // Zero out steering forces at end of frame
      if (steering) {
        steering.forceX = 0;
        steering.forceZ = 0;
      }
    }
  }

  private isClearAt(x: number, z: number, r: number, curX?: number, curZ?: number): boolean {
    if (!this.terrain) return true;

    const destFlat =
      this.terrain.isFlatTile(x - r, z - r) &&
      this.terrain.isFlatTile(x + r, z - r) &&
      this.terrain.isFlatTile(x - r, z + r) &&
      this.terrain.isFlatTile(x + r, z + r);

    if (!destFlat) {
      // If unit is currently stuck on non-flat terrain, allow moves where
      // destination has at least 1 flat corner (moving toward flat ground)
      if (curX !== undefined && curZ !== undefined) {
        const stuckOnNonFlat =
          !this.terrain.isFlatTile(curX - r, curZ - r) ||
          !this.terrain.isFlatTile(curX + r, curZ - r) ||
          !this.terrain.isFlatTile(curX - r, curZ + r) ||
          !this.terrain.isFlatTile(curX + r, curZ + r);
        if (stuckOnNonFlat) {
          const anyFlat =
            this.terrain.isFlatTile(x - r, z - r) ||
            this.terrain.isFlatTile(x + r, z - r) ||
            this.terrain.isFlatTile(x - r, z + r) ||
            this.terrain.isFlatTile(x + r, z + r);
          if (anyFlat) return true; // allow escape toward flat terrain
        }
      }
      return false;
    }

    if (this.occupancy) {
      // Check each corner tile; exempt tiles the unit currently overlaps
      // so it can move out of a building footprint
      const corners = [
        [x - r, z - r], [x + r, z - r],
        [x - r, z + r], [x + r, z + r],
      ];
      for (const [cx, cz] of corners) {
        if (!this.occupancy.isBlocked(cx, cz)) continue;
        // If we currently overlap this same tile, allow passage through it
        if (curX !== undefined && curZ !== undefined) {
          const tileX = Math.floor(cx);
          const tileZ = Math.floor(cz);
          const curCorners = [
            Math.floor(curX - r), Math.floor(curX + r),
            Math.floor(curZ - r), Math.floor(curZ + r),
          ];
          // Check if current position also overlaps this tile
          if (tileX >= curCorners[0] && tileX <= curCorners[1] &&
              tileZ >= curCorners[2] && tileZ <= curCorners[3]) {
            continue; // Already overlapping this tile, allow movement
          }
        }
        return false;
      }
    }

    return true;
  }
}
