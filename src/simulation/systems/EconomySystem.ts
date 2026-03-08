import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION, RENDERABLE, HEALTH, SELECTABLE, VOXEL_STATE, ENERGY_PACKET, MATTER_PACKET, MATTER_STORAGE, VISION, VELOCITY, STEERING, MOVE_COMMAND } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VisionComponent } from '@sim/components/Vision';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { EnergyPacketComponent } from '@sim/components/EnergyPacket';
import type { MatterPacketComponent } from '@sim/components/MatterPacket';
import type { VelocityComponent } from '@sim/components/Velocity';
import type { SteeringComponent } from '@sim/components/Steering';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

const EXTRACTOR_RATE = 5;    // +5 energy/s (display rate)
const PLANT_MATTER_RATE = 2;  // +2 matter/s (display rate)

const PACKET_INTERVAL = 10;   // seconds between packets per extractor/plant
const PACKET_ENERGY = 50;     // energy per packet (5e/s * 10s = 50)
const PACKET_SPEED = 16;      // world units per second (energy packets)
const PACKET_HP = 20;
export const PACKET_ELEVATION = 5.5;   // wu above ground (matches tower cap height)

const MATTER_PACKET_AMOUNT = 20;  // matter per packet
const MATTER_PACKET_SPEED = 8;    // world units per second (ground)
const MATTER_PACKET_HP = 20;

export class EconomySystem implements System {
  readonly name = 'EconomySystem';

  private packetTimers = new Map<number, number>();
  private matterPacketTimers = new Map<number, number>();

  constructor(
    private resources: ResourceState,
    private teamCount: number,
    private terrainData: TerrainData,
  ) {}

  update(world: World, dt: number): void {
    const entities = world.query(BUILDING, TEAM);

    // Track per-team rates this tick
    const energyRates = new Float32Array(this.teamCount);
    const matterRates = new Float32Array(this.teamCount);

    // Find HQ per team (cache each tick)
    const teamHQs: (number | null)[] = [];
    for (let t = 0; t < this.teamCount; t++) teamHQs.push(null);
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (building.buildingType === BuildingType.HQ && health && !health.dead) {
        teamHQs[team.team] = e;
      }
    }

    // First pass: extractors spawn energy packets
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.EnergyExtractor) continue;

      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      energyRates[team.team] += EXTRACTOR_RATE;

      // Timer management
      let timer = this.packetTimers.get(e) ?? 0;
      timer += dt;

      if (timer >= PACKET_INTERVAL) {
        timer -= PACKET_INTERVAL;

        const hqEntity = teamHQs[team.team];
        if (hqEntity != null) {
          const pos = world.getComponent<PositionComponent>(e, POSITION)!;
          const hqPos = world.getComponent<PositionComponent>(hqEntity, POSITION)!;
          this.spawnPacket(world, e, hqEntity, pos, hqPos, team.team);
        }
      }

      this.packetTimers.set(e, timer);
    }

    // Clean up timers for destroyed extractors
    for (const [entity] of this.packetTimers) {
      if (!world.getComponent<BuildingComponent>(entity, BUILDING)) {
        this.packetTimers.delete(entity);
      }
    }

    // Second pass: matter plants spawn ground-based matter packets
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.MatterPlant) continue;

      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      matterRates[team.team] += PLANT_MATTER_RATE;

      // Timer management
      let timer = this.matterPacketTimers.get(e) ?? 0;
      timer += dt;

      if (timer >= PACKET_INTERVAL) {
        timer -= PACKET_INTERVAL;

        const hqEntity = teamHQs[team.team];
        if (hqEntity != null) {
          const pos = world.getComponent<PositionComponent>(e, POSITION)!;
          const hqPos = world.getComponent<PositionComponent>(hqEntity, POSITION)!;
          this.spawnMatterPacket(world, e, hqEntity, pos, hqPos, team.team);
        }
      }

      this.matterPacketTimers.set(e, timer);
    }

    // Clean up matter packet timers for destroyed plants
    for (const [entity] of this.matterPacketTimers) {
      if (!world.getComponent<BuildingComponent>(entity, BUILDING)) {
        this.matterPacketTimers.delete(entity);
      }
    }

    // Auto-fill HQ matter storage from global pool (HQ acts as fallback resupply point)
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const storage = world.getComponent<MatterStorageComponent>(e, MATTER_STORAGE);
      if (!storage) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      const available = this.resources.get(team.team).matter;
      const toFill = Math.min(storage.capacity - storage.stored, available);
      if (toFill > 0) {
        storage.stored += toFill;
        this.resources.spendMatter(team.team, toFill);
      }
    }

    // Update display rates
    for (let t = 0; t < this.teamCount; t++) {
      this.resources.setRates(t, energyRates[t], matterRates[t]);
    }
  }

  private spawnPacket(
    world: World,
    sourceEntity: number,
    hqEntity: number,
    srcPos: PositionComponent,
    hqPos: PositionComponent,
    team: number,
  ): void {
    const spawnY = srcPos.y + PACKET_ELEVATION;
    const targetY = hqPos.y + PACKET_ELEVATION;

    const e = world.createEntity();
    world.addComponent<PositionComponent>(e, POSITION, {
      x: srcPos.x, y: spawnY, z: srcPos.z,
      prevX: srcPos.x, prevY: spawnY, prevZ: srcPos.z,
      rotation: 0,
    });
    world.addComponent<RenderableComponent>(e, RENDERABLE, {
      meshType: 'energy_packet', color: 0x66ccff, scale: 1.0,
    });
    world.addComponent<HealthComponent>(e, HEALTH, {
      current: PACKET_HP, max: PACKET_HP, dead: false,
    });
    world.addComponent<TeamComponent>(e, TEAM, { team });
    world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
    world.addComponent<VisionComponent>(e, VISION, { range: 0 });

    const voxelModel = VOXEL_MODELS['energy_packet'];
    if (voxelModel) {
      world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
        modelId: 'energy_packet',
        totalVoxels: voxelModel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    world.addComponent<EnergyPacketComponent>(e, ENERGY_PACKET, {
      sourceEntity,
      targetEntity: hqEntity,
      targetX: hqPos.x,
      targetY: targetY,
      targetZ: hqPos.z,
      speed: PACKET_SPEED,
      energyAmount: PACKET_ENERGY,
      team,
    });
  }

  private spawnMatterPacket(
    world: World,
    sourceEntity: number,
    hqEntity: number,
    srcPos: PositionComponent,
    hqPos: PositionComponent,
    team: number,
  ): void {
    // Offset spawn 3 wu toward HQ so packet starts on walkable ground (not on plant's occupied tile)
    const dx = hqPos.x - srcPos.x;
    const dz = hqPos.z - srcPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const offsetDist = Math.min(3, dist * 0.5);
    const spawnX = dist > 0 ? Math.max(1, Math.min(255, srcPos.x + (dx / dist) * offsetDist)) : srcPos.x;
    const spawnZ = dist > 0 ? Math.max(1, Math.min(255, srcPos.z + (dz / dist) * offsetDist)) : srcPos.z;
    const spawnY = this.terrainData.getHeight(spawnX, spawnZ) + 0.2;

    const e = world.createEntity();
    world.addComponent<PositionComponent>(e, POSITION, {
      x: spawnX, y: spawnY, z: spawnZ,
      prevX: spawnX, prevY: spawnY, prevZ: spawnZ,
      rotation: 0,
    });
    world.addComponent<RenderableComponent>(e, RENDERABLE, {
      meshType: 'matter_packet', color: 0x333333, scale: 1.0,
    });
    world.addComponent<HealthComponent>(e, HEALTH, {
      current: MATTER_PACKET_HP, max: MATTER_PACKET_HP, dead: false,
    });
    world.addComponent<TeamComponent>(e, TEAM, { team });
    world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
    world.addComponent<VisionComponent>(e, VISION, { range: 0 });
    world.addComponent<VelocityComponent>(e, VELOCITY, { x: 0, z: 0, speed: MATTER_PACKET_SPEED });
    world.addComponent<SteeringComponent>(e, STEERING, { forceX: 0, forceZ: 0 });

    const voxelModel = VOXEL_MODELS['matter_packet'];
    if (voxelModel) {
      world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
        modelId: 'matter_packet',
        totalVoxels: voxelModel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    world.addComponent<MoveCommandComponent>(e, MOVE_COMMAND, {
      path: [],
      currentWaypoint: 0,
      destX: hqPos.x,
      destZ: hqPos.z,
    });

    world.addComponent<MatterPacketComponent>(e, MATTER_PACKET, {
      sourceEntity,
      targetEntity: hqEntity,
      matterAmount: MATTER_PACKET_AMOUNT,
      team,
    });
  }
}
