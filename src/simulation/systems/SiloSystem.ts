import type { System, World } from '@core/ECS';
import {
  RESOURCE_SILO, POSITION, TEAM, HEALTH, BUILDING, CONSTRUCTION,
  RENDERABLE, SELECTABLE, VISION, VOXEL_STATE,
} from '@sim/components/ComponentTypes';
import type { ResourceSiloComponent, SiloResourceType } from '@sim/components/ResourceSilo';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VisionComponent } from '@sim/components/Vision';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

export const SILO_CAPACITY = 200;
export const SILO_HP = 100;
/** Local storage capacity for production buildings (extractors/plants) */
export const BUILDING_STORAGE_CAPACITY = 50;
const SILO_VISION = 5;

// Spacing: silos spawn at least this far from each other and buildings
const SILO_MIN_SPACING = 3;

// Search radius for finding clear adjacent tiles for new silos
const SILO_SEARCH_RADIUS = 12;

// Offsets to try for adjacent tile placement (sorted by distance)
const ADJACENT_OFFSETS: { dx: number; dz: number }[] = [];
for (let r = 1; r <= SILO_SEARCH_RADIUS; r++) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= r - 0.5 && dist < r + 0.5) {
        ADJACENT_OFFSETS.push({ dx, dz });
      }
    }
  }
}
ADJACENT_OFFSETS.sort((a, b) => {
  const dA = a.dx * a.dx + a.dz * a.dz;
  const dB = b.dx * b.dx + b.dz * b.dz;
  return dA - dB;
});

export class SiloSystem implements System {
  readonly name = 'SiloSystem';

  constructor(
    private terrainData: TerrainData,
  ) {}

  update(world: World, _dt: number): void {
    this.handleOverflow(world);
  }

  /** Find or spawn a silo adjacent to a building. Used by EconomySystem and SupplySystem.
   *  Returns silo entity or null if no space available. */
  findOrSpawnSilo(
    world: World,
    buildingEntity: number,
    resourceType: SiloResourceType,
    team: number,
  ): number | null {
    // Find existing silo with space for this building
    const silos = world.query(RESOURCE_SILO, POSITION, HEALTH, TEAM);
    let bestSilo: number | null = null;
    let bestDistSq = Infinity;

    const buildingPos = world.getComponent<PositionComponent>(buildingEntity, POSITION);
    if (!buildingPos) return null;

    for (const e of silos) {
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      if (silo.resourceType !== resourceType) continue;
      if (silo.parentBuilding !== buildingEntity) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      if (silo.stored >= silo.capacity) continue;

      const siloPos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = siloPos.x - buildingPos.x;
      const dz = siloPos.z - buildingPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestSilo = e;
      }
    }

    if (bestSilo !== null) return bestSilo;

    // Spawn new silo
    return this.spawnSilo(world, buildingPos, resourceType, team, buildingEntity);
  }

  /** When a production building's local RESOURCE_SILO is full, spawn a new silo nearby. */
  private handleOverflow(world: World): void {
    const entities = world.query(RESOURCE_SILO, POSITION, TEAM, HEALTH);
    for (const e of entities) {
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      if (silo.stored <= silo.capacity) continue;

      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      // Overflow: try to move excess into an existing nearby silo or spawn a new one
      const overflow = silo.stored - silo.capacity;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      // Find existing silo with space owned by the same parent (or this building)
      const parentId = silo.parentBuilding === -1 ? e : silo.parentBuilding;
      let target = this.findSiloWithSpace(world, parentId, silo.resourceType, e);

      if (target === null) {
        // Spawn new silo relative to parent building so silos radiate circularly
        const parentPos = world.getComponent<PositionComponent>(parentId, POSITION);
        if (parentPos) {
          target = this.spawnSilo(world, parentPos, silo.resourceType, team.team, parentId);
        }
      }

      if (target !== null) {
        const targetSilo = world.getComponent<ResourceSiloComponent>(target, RESOURCE_SILO)!;
        const space = targetSilo.capacity - targetSilo.stored;
        const transfer = Math.min(overflow, space);
        targetSilo.stored += transfer;
        silo.stored -= transfer;
      }
      // If no target found (no space anywhere, can't spawn), stored stays over capacity.
      // Production will halt naturally since EconomySystem checks capacity.
    }
  }

  /** Find an existing silo (not excludeEntity) with space for the given parent building. */
  private findSiloWithSpace(
    world: World,
    parentEntity: number,
    resourceType: SiloResourceType,
    excludeEntity: number,
  ): number | null {
    const silos = world.query(RESOURCE_SILO, POSITION, HEALTH, TEAM);
    let bestSilo: number | null = null;
    let bestDistSq = Infinity;

    const parentPos = world.getComponent<PositionComponent>(parentEntity, POSITION);
    if (!parentPos) return null;

    for (const e of silos) {
      if (e === excludeEntity) continue;
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      if (silo.resourceType !== resourceType) continue;
      if (silo.parentBuilding !== parentEntity) continue;

      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      if (silo.stored < silo.capacity) {
        const siloPos = world.getComponent<PositionComponent>(e, POSITION)!;
        const dx = siloPos.x - parentPos.x;
        const dz = siloPos.z - parentPos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestSilo = e;
        }
      }
    }

    return bestSilo;
  }

  /** Spawn a new silo entity adjacent to the parent building. */
  private spawnSilo(
    world: World,
    nearPos: PositionComponent,
    resourceType: SiloResourceType,
    team: number,
    parentEntity: number,
  ): number | null {
    // Collect positions of all buildings and silos for spacing checks
    const occupiedPositions: { x: number; z: number }[] = [];
    const buildings = world.query(BUILDING, POSITION);
    for (const e of buildings) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      occupiedPositions.push({ x: pos.x, z: pos.z });
    }
    const existingSilos = world.query(RESOURCE_SILO, POSITION);
    for (const e of existingSilos) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      occupiedPositions.push({ x: pos.x, z: pos.z });
    }

    // Try adjacent offsets to find a clear tile
    for (const offset of ADJACENT_OFFSETS) {
      const tx = nearPos.x + offset.dx * SILO_MIN_SPACING;
      const tz = nearPos.z + offset.dz * SILO_MIN_SPACING;

      // Bounds check
      if (tx < 2 || tx > 254 || tz < 2 || tz > 254) continue;

      // Must be on flat terrain
      if (!this.terrainData.isPassable(tx, tz)) continue;

      // Check spacing from existing buildings and silos
      let tooClose = false;
      for (const occ of occupiedPositions) {
        const dx = occ.x - tx;
        const dz = occ.z - tz;
        if (dx * dx + dz * dz < SILO_MIN_SPACING * SILO_MIN_SPACING) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      // Found a valid position -- spawn the silo entity
      return this.createSiloEntity(world, tx, tz, parentEntity, resourceType, team);
    }

    // No valid position found
    return null;
  }

  private createSiloEntity(
    world: World,
    x: number,
    z: number,
    parentEntity: number,
    resourceType: SiloResourceType,
    team: number,
  ): number {
    const meshType = resourceType === 'energy' ? 'energy_silo' : 'matter_silo';
    const color = resourceType === 'energy' ? 0x66ccff : 0x554433;
    const y = this.terrainData.getHeight(x, z);

    const e = world.createEntity();

    world.addComponent<PositionComponent>(e, POSITION, {
      x, y, z, prevX: x, prevY: y, prevZ: z, rotation: 0,
    });
    world.addComponent<RenderableComponent>(e, RENDERABLE, {
      meshType, color, scale: 1.0,
    });
    world.addComponent<HealthComponent>(e, HEALTH, {
      current: SILO_HP, max: SILO_HP, dead: false,
    });
    world.addComponent<TeamComponent>(e, TEAM, { team });
    world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
    world.addComponent<VisionComponent>(e, VISION, { range: SILO_VISION });
    world.addComponent<ResourceSiloComponent>(e, RESOURCE_SILO, {
      resourceType,
      stored: 0,
      capacity: SILO_CAPACITY,
      parentBuilding: parentEntity,
    });

    const voxelModel = VOXEL_MODELS[meshType];
    if (voxelModel) {
      world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
        modelId: meshType,
        totalVoxels: voxelModel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }

    return e;
  }
}
