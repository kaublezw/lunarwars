import type { System, World } from '@core/ECS';
import { POSITION, VELOCITY, MOVE_COMMAND, UNIT_TYPE, STEERING } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { SteeringComponent } from '@sim/components/Steering';
import { UnitCategory } from '@sim/components/UnitType';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { AStarPathfinder } from '@sim/pathfinding/AStar';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';

const WAYPOINT_ARRIVE_DIST = 0.5;
const WAYPOINT_ARRIVE_DIST_SQ = WAYPOINT_ARRIVE_DIST * WAYPOINT_ARRIVE_DIST;
const DECEL_DIST = 3.0;  // start slowing within this distance of final destination
const MAX_FORCE = 15.0;  // cap steering force magnitude
const CORNER_BRAKE_ANGLE = Math.PI / 4; // start braking when turn > 45 deg

export class PathfindingSystem implements System {
  readonly name = 'PathfindingSystem';
  private pathfinder: AStarPathfinder;
  private terrain: TerrainData;
  private occupancy: BuildingOccupancy | null = null;

  constructor(terrain: TerrainData) {
    this.terrain = terrain;
    this.pathfinder = new AStarPathfinder(terrain.width, terrain.height);
  }

  setOccupancy(occupancy: BuildingOccupancy): void {
    this.occupancy = occupancy;
  }

  update(world: World, _dt: number): void {
    const entities = world.query(POSITION, MOVE_COMMAND, VELOCITY, STEERING);

    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const vel = world.getComponent<VelocityComponent>(e, VELOCITY)!;
      const cmd = world.getComponent<MoveCommandComponent>(e, MOVE_COMMAND)!;
      const steering = world.getComponent<SteeringComponent>(e, STEERING)!;
      const unitType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);

      const isAerial = unitType?.category === UnitCategory.AerialDrone;
      const radius = unitType?.radius ?? 0.25;

      // Compute path if empty
      if (cmd.path.length === 0) {
        if (isAerial) {
          // Aerial units fly straight
          cmd.path = [{ x: cmd.destX, z: cmd.destZ }];
          cmd.currentWaypoint = 0;
        } else {
          // Exempt the start tile from building occupancy so units can leave
          const startTX = Math.floor(pos.x);
          const startTZ = Math.floor(pos.z);
          const walkable = this.makeWalkableCheck(radius, startTX, startTZ);
          const path = this.pathfinder.findPath(
            pos.x, pos.z,
            cmd.destX, cmd.destZ,
            walkable,
          );
          if (path && path.length > 0) {
            cmd.path = path;
            cmd.currentWaypoint = 0;
          } else {
            // No path found — cancel command
            world.removeComponent(e, MOVE_COMMAND);
            vel.x = 0;
            vel.z = 0;
            continue;
          }
        }
      }

      // Steer toward current waypoint
      const wp = cmd.path[cmd.currentWaypoint];
      const dx = wp.x - pos.x;
      const dz = wp.z - pos.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < WAYPOINT_ARRIVE_DIST_SQ) {
        // Arrived at waypoint
        cmd.currentWaypoint++;

        if (cmd.currentWaypoint >= cmd.path.length) {
          // Arrived at final destination
          world.removeComponent(e, MOVE_COMMAND);
          vel.x = 0;
          vel.z = 0;
          continue;
        }
      }

      // Compute desired speed: decelerate near final destination
      const dist = Math.sqrt(distSq);
      const isLastWaypoint = cmd.currentWaypoint >= cmd.path.length - 1;
      let desiredSpeed = vel.speed;

      if (isLastWaypoint && dist < DECEL_DIST) {
        desiredSpeed *= dist / DECEL_DIST;
      }

      // Corner braking: if there's a next waypoint with a sharp turn, slow down
      if (!isLastWaypoint && cmd.currentWaypoint < cmd.path.length - 1) {
        const nextWp = cmd.path[cmd.currentWaypoint + 1];
        const curWp = cmd.path[cmd.currentWaypoint];
        // Vector from current pos to current waypoint
        const toCurX = curWp.x - pos.x;
        const toCurZ = curWp.z - pos.z;
        // Vector from current waypoint to next waypoint
        const toNextX = nextWp.x - curWp.x;
        const toNextZ = nextWp.z - curWp.z;

        const magCur = Math.sqrt(toCurX * toCurX + toCurZ * toCurZ);
        const magNext = Math.sqrt(toNextX * toNextX + toNextZ * toNextZ);

        if (magCur > 0.01 && magNext > 0.01) {
          const dot = (toCurX * toNextX + toCurZ * toNextZ) / (magCur * magNext);
          const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

          if (angle > CORNER_BRAKE_ANGLE) {
            // Scale speed down: 1.0 at 45 deg, approaching 0.3 at 180 deg
            const brakeFactor = 1.0 - 0.7 * ((angle - CORNER_BRAKE_ANGLE) / (Math.PI - CORNER_BRAKE_ANGLE));
            desiredSpeed *= Math.max(0.3, brakeFactor);
          }
        }
      }

      // Compute steering force: desired velocity - current velocity
      if (dist > 0.01) {
        const desiredVelX = (dx / dist) * desiredSpeed;
        const desiredVelZ = (dz / dist) * desiredSpeed;

        let steerX = desiredVelX - vel.x;
        let steerZ = desiredVelZ - vel.z;

        // Cap steering force magnitude
        const forceMag = Math.sqrt(steerX * steerX + steerZ * steerZ);
        if (forceMag > MAX_FORCE) {
          steerX = (steerX / forceMag) * MAX_FORCE;
          steerZ = (steerZ / forceMag) * MAX_FORCE;
        }

        steering.forceX += steerX;
        steering.forceZ += steerZ;
      }
    }
  }

  private makeWalkableCheck(radius: number, exemptX?: number, exemptZ?: number): (tx: number, tz: number) => boolean {
    const occ = this.occupancy;
    if (radius <= 0.5) {
      return (tx: number, tz: number) => {
        // Exempt start tile from terrain checks so units can path out of non-flat terrain
        const isExempt = tx === exemptX && tz === exemptZ;
        if (!isExempt && !this.terrain.isFlatTile(tx, tz)) return false;
        if (occ && occ.isBlocked(tx, tz) && !isExempt) return false;
        return true;
      };
    }

    const r = Math.ceil(radius);
    return (tx: number, tz: number) => {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = tx + dx;
          const cz = tz + dz;
          const isExempt = cx === exemptX && cz === exemptZ;
          if (!isExempt && !this.terrain.isFlatTile(cx, cz)) return false;
          if (occ && occ.isBlocked(cx, cz) && !isExempt) return false;
        }
      }
      return true;
    };
  }
}
