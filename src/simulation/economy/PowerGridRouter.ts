import type { World } from '@core/ECS';
import { POSITION, RENDERABLE, HEALTH, TEAM, BUILDING, SELECTABLE, VISION, VOXEL_STATE, POWER_NODE, POWER_POLE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VisionComponent } from '@sim/components/Vision';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { PowerPoleComponent } from '@sim/components/PowerPole';
import type { PowerGridState } from './PowerGridState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import type { TrackState } from '@sim/logistics/TrackState';
import { MACRO_GRID_SIZE } from '@sim/components/ComponentTypes';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';
import { BUILDING_DEFS } from '@sim/data/BuildingData';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const POLE_SPACING = 2; // grid cells between poles (8 wu)

/**
 * Auto-route power poles from a newly completed building to the nearest powered node.
 * Poles are spawned fully built (free, instant). Returns new pole entity IDs.
 */
export function routePowerConnection(
  world: World,
  team: number,
  fromEntity: number,
  gridState: PowerGridState,
  terrainData: TerrainData,
  occupancy: BuildingOccupancy | null,
  trackState?: TrackState | null,
): number[] {
  const fromPos = world.getComponent<PositionComponent>(fromEntity, POSITION)!;

  // Find nearest existing powered POWER_NODE entity
  const target = findNearestPoweredNode(world, team, fromPos.x, fromPos.z, fromEntity);
  if (target === null) {
    // No powered node found — this building is isolated (shouldn't happen if HQ exists)
    return [];
  }

  const targetPos = world.getComponent<PositionComponent>(target, POSITION)!;

  // Convert positions to grid coordinates
  const fromGX = Math.round(fromPos.x / MACRO_GRID_SIZE);
  const fromGZ = Math.round(fromPos.z / MACRO_GRID_SIZE);
  const toGX = Math.round(targetPos.x / MACRO_GRID_SIZE);
  const toGZ = Math.round(targetPos.z / MACRO_GRID_SIZE);

  // Walk the grid using Bresenham's line algorithm
  const gridPath = bresenhamLine(fromGX, fromGZ, toGX, toGZ);

  // Place poles at intervals, reusing existing nodes where possible
  const newPoles: number[] = [];
  let prevNode = fromEntity;
  let stepsSinceLast = 0;

  for (let i = 1; i < gridPath.length; i++) {
    const [gx, gz] = gridPath[i];
    stepsSinceLast++;

    const isLastCell = i === gridPath.length - 1;
    const shouldPlace = stepsSinceLast >= POLE_SPACING || isLastCell;

    if (!shouldPlace) continue;

    // Check if there's an existing POWER_NODE at this grid position
    const existing = findNodeAtGrid(world, team, gx, gz);
    if (existing !== null) {
      // Reuse existing node — just add edge
      gridState.addEdge(team, prevNode, existing);
      prevNode = existing;
      stepsSinceLast = 0;
      continue;
    }

    // If last cell and it's the target, connect directly
    if (isLastCell) {
      gridState.addEdge(team, prevNode, target);
      break;
    }

    // Check if grid cell is blocked by a building
    const worldX = gx * MACRO_GRID_SIZE;
    const worldZ = gz * MACRO_GRID_SIZE;
    if (occupancy && occupancy.isBlocked(Math.floor(worldX), Math.floor(worldZ))) {
      // Skip — try next cell
      continue;
    }

    // Offset pole away from track if it would overlap
    let finalGx = gx;
    let finalGz = gz;
    if (trackState && trackState.hasAnyTrackAtGrid(gx, gz)) {
      const offset = findOffsetCell(gx, gz, terrainData, occupancy, trackState);
      if (offset) {
        [finalGx, finalGz] = offset;
      } else {
        continue; // no valid offset — skip this pole position
      }
    }

    // Check if an existing node already occupies the (possibly offset) cell
    if (finalGx !== gx || finalGz !== gz) {
      const existingAtOffset = findNodeAtGrid(world, team, finalGx, finalGz);
      if (existingAtOffset !== null) {
        gridState.addEdge(team, prevNode, existingAtOffset);
        prevNode = existingAtOffset;
        stepsSinceLast = 0;
        continue;
      }
    }

    // Spawn a new pole at the (possibly offset) position
    const finalWorldX = finalGx * MACRO_GRID_SIZE;
    const finalWorldZ = finalGz * MACRO_GRID_SIZE;
    const pole = spawnPole(world, team, finalWorldX, finalWorldZ, terrainData, gridState);
    newPoles.push(pole);
    gridState.addEdge(team, prevNode, pole);
    prevNode = pole;
    stepsSinceLast = 0;
  }

  // Ensure final connection to target if we haven't reached it
  if (prevNode !== target) {
    gridState.addEdge(team, prevNode, target);
  }

  gridState.markDirty(team);
  return newPoles;
}

function findNearestPoweredNode(
  world: World,
  team: number,
  x: number,
  z: number,
  excludeEntity: number,
): number | null {
  const nodes = world.query(POWER_NODE, TEAM, POSITION);
  let bestEntity: number | null = null;
  let bestDistSq = Infinity;

  for (const e of nodes) {
    if (e === excludeEntity) continue;
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const pn = world.getComponent<PowerNodeComponent>(e, POWER_NODE)!;
    if (!pn.powered) continue;
    const health = world.getComponent<HealthComponent>(e, HEALTH);
    if (health && health.dead) continue;

    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    const dx = pos.x - x;
    const dz = pos.z - z;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestEntity = e;
    }
  }

  return bestEntity;
}

export function findNodeAtGrid(
  world: World,
  team: number,
  gridX: number,
  gridZ: number,
): number | null {
  const worldX = gridX * MACRO_GRID_SIZE;
  const worldZ = gridZ * MACRO_GRID_SIZE;
  const tolerance = MACRO_GRID_SIZE * 0.25;

  const nodes = world.query(POWER_NODE, TEAM, POSITION);
  for (const e of nodes) {
    const t = world.getComponent<TeamComponent>(e, TEAM)!;
    if (t.team !== team) continue;
    const health = world.getComponent<HealthComponent>(e, HEALTH);
    if (health && health.dead) continue;

    const pos = world.getComponent<PositionComponent>(e, POSITION)!;
    if (Math.abs(pos.x - worldX) < tolerance && Math.abs(pos.z - worldZ) < tolerance) {
      return e;
    }
  }
  return null;
}

function spawnPole(
  world: World,
  team: number,
  x: number,
  z: number,
  terrainData: TerrainData,
  gridState: PowerGridState,
): number {
  const y = terrainData.getHeight(x, z);
  const def = BUILDING_DEFS[BuildingType.PowerPole];
  const gridX = Math.round(x / MACRO_GRID_SIZE);
  const gridZ = Math.round(z / MACRO_GRID_SIZE);

  const e = world.createEntity();

  world.addComponent<PositionComponent>(e, POSITION, {
    x, y, z, prevX: x, prevY: y, prevZ: z, rotation: 0,
  });
  world.addComponent<RenderableComponent>(e, RENDERABLE, {
    meshType: 'power_pole',
    color: TEAM_COLORS[team] ?? 0xffffff,
    scale: 1.0,
  });
  world.addComponent<HealthComponent>(e, HEALTH, {
    current: def.hp, max: def.hp, dead: false,
  });
  world.addComponent<TeamComponent>(e, TEAM, { team });
  world.addComponent<BuildingComponent>(e, BUILDING, { buildingType: BuildingType.PowerPole });
  world.addComponent<SelectableComponent>(e, SELECTABLE, { selected: false });
  world.addComponent<VisionComponent>(e, VISION, { range: def.visionRange });

  const voxelModel = VOXEL_MODELS['power_pole'];
  if (voxelModel) {
    world.addComponent<VoxelStateComponent>(e, VOXEL_STATE, {
      modelId: 'power_pole',
      totalVoxels: voxelModel.totalSolid,
      destroyedCount: 0,
      destroyed: new Uint8Array(Math.ceil(voxelModel.totalSolid / 8)),
      dirty: true,
      pendingDebris: [],
      pendingScorch: [],
    });
  }

  world.addComponent<PowerNodeComponent>(e, POWER_NODE, {
    powered: false, // will be set by BFS
    nodeId: gridState.allocateNodeId(),
  });
  world.addComponent<PowerPoleComponent>(e, POWER_POLE, { gridX, gridZ });

  return e;
}

/**
 * Given a grid cell that overlaps track, find the nearest adjacent cell
 * that is passable, unoccupied, and not on any track.
 */
function findOffsetCell(
  gx: number, gz: number,
  terrainData: TerrainData,
  occupancy: BuildingOccupancy | null,
  trackState: TrackState,
): [number, number] | null {
  const offsets: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of offsets) {
    const nx = gx + dx;
    const nz = gz + dz;
    const wx = nx * MACRO_GRID_SIZE;
    const wz = nz * MACRO_GRID_SIZE;
    if (wx < 4 || wx > 252 || wz < 4 || wz > 252) continue;
    if (!terrainData.isPassable(wx, wz)) continue;
    if (occupancy && occupancy.isBlocked(Math.floor(wx), Math.floor(wz))) continue;
    if (trackState.hasAnyTrackAtGrid(nx, nz)) continue;
    return [nx, nz];
  }
  return null;
}

/**
 * Bresenham's line algorithm on integer grid coordinates.
 * Returns array of [gridX, gridZ] from (x0,z0) to (x1,z1) inclusive.
 */
function bresenhamLine(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const result: [number, number][] = [];
  let dx = Math.abs(x1 - x0);
  let dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;

  let x = x0;
  let z = z0;

  while (true) {
    result.push([x, z]);
    if (x === x1 && z === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
    }
  }

  return result;
}
