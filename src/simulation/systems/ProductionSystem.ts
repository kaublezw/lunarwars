import type { System, World } from '@core/ECS';
import { PRODUCTION_QUEUE, TEAM, POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, VISION, MOVE_COMMAND, TURRET, VOXEL_STATE, BUILDING, SUPPLY_ROUTE } from '@sim/components/ComponentTypes';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import { UnitCategory } from '@sim/components/UnitType';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { SteeringComponent } from '@sim/components/Steering';
import type { HealthComponent } from '@sim/components/Health';
import type { VisionComponent } from '@sim/components/Vision';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { TurretComponent } from '@sim/components/Turret';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { SupplyRouteComponent } from '@sim/components/SupplyRoute';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';

const TEAM_COLORS = [0x4488ff, 0xff4444];

export class ProductionSystem implements System {
  readonly name = 'ProductionSystem';

  constructor(private resources: ResourceState, private terrainData: TerrainData) {}

  update(world: World, dt: number): void {
    const producers = world.query(PRODUCTION_QUEUE, TEAM, POSITION);

    for (const e of producers) {
      const queue = world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE)!;
      if (queue.queue.length === 0) continue;

      const item = queue.queue[0];
      item.timeRemaining -= dt;

      if (item.timeRemaining <= 0) {
        // Spawn the unit
        const team = world.getComponent<TeamComponent>(e, TEAM)!;
        const bldgPos = world.getComponent<PositionComponent>(e, POSITION)!;
        const def = UNIT_DEFS[item.unitType];
        if (!def) {
          queue.queue.shift();
          continue;
        }

        const isHQ = world.hasComponent(e, BUILDING)
          && world.getComponent<BuildingComponent>(e, BUILDING)!.buildingType === BuildingType.HQ;

        const spawnX = isHQ ? bldgPos.x : bldgPos.x + 4;
        const spawnZ = isHQ ? bldgPos.z + 2.0 : bldgPos.z + 4;
        const spawnY = this.terrainData.getHeight(spawnX, spawnZ) + 0.02;

        const unit = world.createEntity();
        world.addComponent<PositionComponent>(unit, POSITION, {
          x: spawnX, y: spawnY, z: spawnZ,
          prevX: spawnX, prevY: spawnY, prevZ: spawnZ,
          rotation: 0,
        });
        world.addComponent<VelocityComponent>(unit, VELOCITY, {
          x: 0, z: 0, speed: def.speed,
        });
        world.addComponent<RenderableComponent>(unit, RENDERABLE, {
          meshType: def.meshType,
          color: TEAM_COLORS[team.team] ?? 0xffffff,
          scale: 1.0,
        });
        world.addComponent<UnitTypeComponent>(unit, UNIT_TYPE, {
          category: def.category,
          radius: def.radius,
        });
        world.addComponent<SelectableComponent>(unit, SELECTABLE, { selected: false });
        world.addComponent<SteeringComponent>(unit, STEERING, { forceX: 0, forceZ: 0 });
        world.addComponent<HealthComponent>(unit, HEALTH, {
          current: def.hp, max: def.hp, dead: false,
        });
        world.addComponent<TeamComponent>(unit, TEAM, { team: team.team });
        world.addComponent<VisionComponent>(unit, VISION, { range: def.visionRange });

        // Add voxel state for voxel rendering
        const voxelModel = VOXEL_MODELS[def.meshType];
        if (voxelModel) {
          world.addComponent<VoxelStateComponent>(unit, VOXEL_STATE, {
            modelId: def.meshType,
            totalVoxels: voxelModel.totalSolid,
            destroyedCount: 0,
            destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
            dirty: true,
            pendingDebris: [],
            pendingScorch: [],
          });
        }

        // Add turret for combat units
        if (def.range != null) {
          world.addComponent<TurretComponent>(unit, TURRET, {
            range: def.range,
            fireRate: def.fireRate ?? 1,
            cooldown: 0,
            targetEntity: -1,
            targetX: 0,
            targetZ: 0,
            firedThisFrame: false,
            damage: def.damage ?? 10,
            ammo: def.ammo ?? 50,
            maxAmmo: def.maxAmmo ?? def.ammo ?? 50,
            muzzleOffset: def.muzzleOffset ?? 0.5,
            muzzleHeight: def.muzzleHeight ?? 0.6,
            rotateBodyToTarget: false,
            turretRotation: 0,
            turretPitch: 0,
          });
        }

        // Auto-ferry: FerryDrones spawned from Supply Depots get a SUPPLY_ROUTE
        const isDepotSpawn = def.category === UnitCategory.FerryDrone
          && world.hasComponent(e, BUILDING)
          && world.getComponent<BuildingComponent>(e, BUILDING)!.buildingType === BuildingType.SupplyDepot;

        if (isDepotSpawn) {
          const hq = this.findHQ(world, team.team);
          if (hq !== null) {
            const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;
            world.addComponent<SupplyRouteComponent>(unit, SUPPLY_ROUTE, {
              sourceEntity: hq,
              destEntity: e,
              state: 'to_source',
              timer: 0,
              carried: 0,
              carryCapacity: 10,
            });
            // Move toward HQ to start ferrying
            world.addComponent<MoveCommandComponent>(unit, MOVE_COMMAND, {
              path: [], currentWaypoint: 0,
              destX: hqPos.x, destZ: hqPos.z,
            });
          }
        } else if (isHQ) {
          // HQ spawns: always issue move so unit walks out the garage door
          world.addComponent<MoveCommandComponent>(unit, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: queue.rallyX, destZ: queue.rallyZ,
          });
        } else if (queue.rallyX !== bldgPos.x || queue.rallyZ !== bldgPos.z) {
          // Move to rally point
          world.addComponent<MoveCommandComponent>(unit, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: queue.rallyX, destZ: queue.rallyZ,
          });
        }

        queue.queue.shift();
      }
    }
  }

  private findHQ(world: World, team: number): number | null {
    const buildings = world.query(BUILDING, TEAM, HEALTH);
    for (const e of buildings) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const b = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (b.buildingType !== BuildingType.HQ) continue;
      const h = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (h.dead) continue;
      return e;
    }
    return null;
  }
}
