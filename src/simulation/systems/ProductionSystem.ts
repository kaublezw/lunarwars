import type { System, World } from '@core/ECS';
import { PRODUCTION_QUEUE, TEAM, POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, VISION, MOVE_COMMAND, TURRET, VOXEL_STATE, BUILDING, GARAGE_EXIT, ROOF_EXIT, TRAIN_LINK, TRACK_FOLLOWER, CARGO_STORAGE, PENDING_CAR_ATTACH, POWER_NODE } from '@sim/components/ComponentTypes';
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
import type { GarageExitComponent } from '@sim/components/GarageExit';
import type { RoofExitComponent } from '@sim/components/RoofExit';
import type { TrainLinkComponent } from '@sim/components/TrainLink';
import type { TrackFollowerComponent } from '@sim/components/TrackFollower';
import type { CargoStorageComponent } from '@sim/components/CargoStorage';
import type { PendingCarAttachComponent } from '@sim/components/PendingCarAttach';
import { UNIT_DEFS } from '@sim/data/UnitData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { getHQStubCell, attachOrphansAndPendingToEngine, DIR_DX, DIR_DZ } from '@sim/logistics/TrainSpawner';

const TEAM_COLORS = [0x4488ff, 0xff4444];

export class ProductionSystem implements System {
  readonly name = 'ProductionSystem';

  constructor(private resources: ResourceState, private terrainData: TerrainData) {}

  update(world: World, dt: number): void {
    const producers = world.query(PRODUCTION_QUEUE, TEAM, POSITION);

    for (const e of producers) {
      // Skip unpowered producers
      const powerNode = world.getComponent<PowerNodeComponent>(e, POWER_NODE);
      if (powerNode && !powerNode.powered) continue;

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
        const isDroneFactory = world.hasComponent(e, BUILDING)
          && world.getComponent<BuildingComponent>(e, BUILDING)!.buildingType === BuildingType.DroneFactory;

        const isFactoryAerial = isDroneFactory && def.category === UnitCategory.AerialDrone;
        const spawnInside = isHQ || isDroneFactory;
        // Aerial drones from factory spawn at building center (aligned with roof hatch)
        // Ground units spawn offset toward the +Z side door
        const spawnX = spawnInside ? bldgPos.x : bldgPos.x + 4;
        const spawnZ = isFactoryAerial ? bldgPos.z : (spawnInside ? bldgPos.z + 0.5 : bldgPos.z + 4);
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

        // Train engine produced at HQ: give it TrainLink + TrackFollower, spawn at HQ stub cell for immediate docking
        const isEngineSpawn = def.category === UnitCategory.TrainEngine && isHQ;
        if (isEngineSpawn) {
          // Reposition to HQ stub cell so TrackManagerSystem docks it immediately
          const stub = getHQStubCell(bldgPos.x, bldgPos.z);
          const stubY = this.terrainData.getHeight(stub.worldX, stub.worldZ) + 0.1;
          const ePos = world.getComponent<PositionComponent>(unit, POSITION)!;
          ePos.x = stub.worldX;
          ePos.z = stub.worldZ;
          ePos.y = stubY;
          ePos.prevX = stub.worldX;
          ePos.prevZ = stub.worldZ;
          ePos.prevY = stubY;
          ePos.rotation = Math.atan2(DIR_DX[stub.direction], DIR_DZ[stub.direction]);

          world.addComponent<TrainLinkComponent>(unit, TRAIN_LINK, {
            nextEntity: null,
            prevEntity: null,
            isEngine: true,
          });
          world.addComponent<TrackFollowerComponent>(unit, TRACK_FOLLOWER, {
            path: [],
            currentWaypointIndex: 0,
            distanceAlongSegment: 0,
            direction: 1,
            reconnectTarget: -1,
            halted: false,
            currentSpeed: 0,
          });

          // Gather any surviving cargo cars (orphans + pending) onto the new engine.
          attachOrphansAndPendingToEngine(
            world,
            team.team,
            unit,
            (x, z) => this.terrainData.getHeight(x, z),
            stub.direction,
          );
        }

        // Cargo cars produced at HQ: give them TrainLink + CargoStorage + PendingCarAttach
        // They wait at HQ until the train docks, then get appended to the chain
        const isCargoCarSpawn = def.category === UnitCategory.CargoCar && isHQ;
        if (isCargoCarSpawn) {
          world.addComponent<TrainLinkComponent>(unit, TRAIN_LINK, {
            nextEntity: null,
            prevEntity: null,
            isEngine: false,
          });
          world.addComponent<CargoStorageComponent>(unit, CARGO_STORAGE, {
            current: 0,
            capacity: 200,
            committedType: null,
          });
          world.addComponent<PendingCarAttachComponent>(unit, PENDING_CAR_ATTACH, {
            team: team.team,
          });
        }

        if (isHQ && !isEngineSpawn) {
          // HQ spawns (except train engines): predetermined straight-line exit through garage door
          world.addComponent<GarageExitComponent>(unit, GARAGE_EXIT, {
            exitZ: bldgPos.z + 2.5,
            rallyX: queue.rallyX,
            rallyZ: queue.rallyZ,
          });
        } else if (isDroneFactory) {
          if (def.category === UnitCategory.AerialDrone) {
            // Aerial units rise through the roof
            world.addComponent<RoofExitComponent>(unit, ROOF_EXIT, {
              exitY: 5.5, // AERIAL_HEIGHT — seamless handoff to MovementSystem
              rallyX: queue.rallyX,
              rallyZ: queue.rallyZ,
            });
          } else {
            // Ground units exit through the +Z factory door
            // Factory is 32 voxels deep, halfZ = 2.4 wu, exit past the face
            world.addComponent<GarageExitComponent>(unit, GARAGE_EXIT, {
              exitZ: bldgPos.z + 3.0,
              rallyX: queue.rallyX,
              rallyZ: queue.rallyZ,
            });
          }
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
