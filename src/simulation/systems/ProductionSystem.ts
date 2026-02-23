import type { System, World } from '@core/ECS';
import { PRODUCTION_QUEUE, TEAM, POSITION, VELOCITY, RENDERABLE, UNIT_TYPE, SELECTABLE, STEERING, HEALTH, VISION, MOVE_COMMAND, TURRET } from '@sim/components/ComponentTypes';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { SteeringComponent } from '@sim/components/Steering';
import type { HealthComponent } from '@sim/components/Health';
import type { VisionComponent } from '@sim/components/Vision';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { TurretComponent } from '@sim/components/Turret';
import { UNIT_DEFS } from '@sim/data/UnitData';
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

        const spawnX = bldgPos.x + 4;
        const spawnZ = bldgPos.z + 4;
        const spawnY = this.terrainData.getHeight(spawnX, spawnZ) + 0.5;

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
            rotateBodyToTarget: true,
          });
        }

        // Move to rally point
        if (queue.rallyX !== bldgPos.x || queue.rallyZ !== bldgPos.z) {
          world.addComponent<MoveCommandComponent>(unit, MOVE_COMMAND, {
            path: [], currentWaypoint: 0,
            destX: queue.rallyX, destZ: queue.rallyZ,
          });
        }

        queue.queue.shift();
      }
    }
  }
}
