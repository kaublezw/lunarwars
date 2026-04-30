import type { System, World } from '@core/ECS';
import { POWER_NODE, POWER_POLE, HEALTH, TEAM, POSITION, BUILDING, RENDERABLE, SELECTABLE, POWER_POLE_RUIN, VOXEL_STATE, MACRO_GRID_SIZE } from '@sim/components/ComponentTypes';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { PowerPoleComponent } from '@sim/components/PowerPole';
import type { PowerPoleRuinComponent } from '@sim/components/PowerPoleRuin';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import type { PowerGridState } from '@sim/economy/PowerGridState';
import { routePowerConnection } from '@sim/economy/PowerGridRouter';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import type { TrackState } from '@sim/logistics/TrackState';
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

const TEAM_COLORS = [0x4488ff, 0xff4444];

export class PowerGridSystem implements System {
  readonly name = 'PowerGridSystem';

  constructor(
    private gridState: PowerGridState,
    private teamCount: number,
    private terrainData?: TerrainData,
    private occupancy?: BuildingOccupancy,
    private trackState?: TrackState,
  ) {}

  update(world: World, _dt: number): void {
    // Two-pass dead pole processing: capture neighbors BEFORE removing any edges
    const powerNodes = world.query(POWER_NODE, HEALTH, TEAM);

    // Pass 1: Collect dead nodes and capture neighbor grid positions
    const deadNodes: { entity: number; team: number; isPole: boolean }[] = [];
    const neighborInfoMap = new Map<number, [number, number][]>();

    for (const e of powerNodes) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (!health.dead) continue;

      const teamComp = world.getComponent<TeamComponent>(e, TEAM)!;
      const team = teamComp.team;
      const isPole = world.hasComponent(e, POWER_POLE);

      deadNodes.push({ entity: e, team, isPole });

      if (isPole) {
        const neighbors = this.gridState.getNeighbors(team, e);
        const gridPositions: [number, number][] = [];
        for (const n of neighbors) {
          const nPos = world.getComponent<PositionComponent>(n, POSITION);
          if (nPos) {
            gridPositions.push([
              Math.round(nPos.x / MACRO_GRID_SIZE),
              Math.round(nPos.z / MACRO_GRID_SIZE),
            ]);
          }
        }
        neighborInfoMap.set(e, gridPositions);
      }
    }

    // Pass 2: Remove edges, spawn ruins with topology info, clean up
    for (const { entity: e, team, isPole } of deadNodes) {
      this.gridState.removeEdgesForNode(team, e);

      if (isPole) {
        const pole = world.getComponent<PowerPoleComponent>(e, POWER_POLE)!;
        const pos = world.getComponent<PositionComponent>(e, POSITION)!;
        const neighborGridPositions = neighborInfoMap.get(e) ?? [];
        this.spawnRuin(world, team, pos.x, pos.y, pos.z, pole.gridX, pole.gridZ, neighborGridPositions);
      }

      world.removeComponent(e, POWER_NODE);
    }

    // Recompute connectivity via BFS for dirty teams
    for (let team = 0; team < this.teamCount; team++) {
      if (!this.gridState.isDirty(team)) continue;
      this.runBFS(world, team);
      // Only heal gaps after construction (not after destruction)
      if (this.gridState.isHealPending(team)) {
        this.gridState.clearHealPending(team);
        this.healDisconnectedNodes(world, team);
      }
    }
  }

  private runBFS(world: World, team: number): void {
    const powered = new Set<number>();

    // Find all HQ entities for this team as BFS roots
    const roots: number[] = [];
    const allNodes = world.query(POWER_NODE, TEAM);
    for (const e of allNodes) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;

      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;

      if (world.hasComponent(e, BUILDING)) {
        const bldg = world.getComponent<BuildingComponent>(e, BUILDING)!;
        if (bldg.buildingType === BuildingType.HQ) {
          roots.push(e);
        }
      }
    }

    // BFS from HQ(s)
    const queue = [...roots];
    for (const r of roots) powered.add(r);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = this.gridState.getNeighbors(team, current);
      for (const neighbor of neighbors) {
        if (powered.has(neighbor)) continue;
        if (!world.hasComponent(neighbor, POWER_NODE)) continue;
        const nh = world.getComponent<HealthComponent>(neighbor, HEALTH);
        if (nh && nh.dead) continue;
        powered.add(neighbor);
        queue.push(neighbor);
      }
    }

    // Update powered flag on all power node entities for this team
    this.gridState.setPoweredNodes(team, powered);
    for (const e of allNodes) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const pn = world.getComponent<PowerNodeComponent>(e, POWER_NODE);
      if (pn) {
        pn.powered = powered.has(e);
      }
    }
  }

  /**
   * After BFS, reconnect any unpowered nodes by routing new poles to the nearest powered node.
   * This heals gaps caused by destroyed intermediaries or missing stored neighbors.
   */
  private healDisconnectedNodes(world: World, team: number): void {
    if (!this.terrainData || !this.occupancy) return;

    const allNodes = world.query(POWER_NODE, TEAM);
    const unpowered: number[] = [];
    const powered = this.gridState.getPoweredNodes(team);

    for (const e of allNodes) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      if (!powered.has(e)) {
        unpowered.push(e);
      }
    }

    if (unpowered.length === 0) return;

    // Route each unpowered node to the nearest powered node (spawns poles if needed)
    for (const entity of unpowered) {
      // Skip if it became powered from a previous iteration's routing
      if (this.gridState.getPoweredNodes(team).has(entity)) continue;
      routePowerConnection(world, team, entity, this.gridState, this.terrainData, this.occupancy, this.trackState);
      // Re-run BFS so subsequent nodes can find the newly powered chain
      this.runBFS(world, team);
    }
  }

  private spawnRuin(
    world: World,
    team: number,
    x: number, y: number, z: number,
    gridX: number, gridZ: number,
    neighborGridPositions: [number, number][],
  ): void {
    const ruin = world.createEntity();
    world.addComponent<PositionComponent>(ruin, POSITION, {
      x, y, z,
      prevX: x, prevY: y, prevZ: z,
      rotation: 0,
    });
    world.addComponent<RenderableComponent>(ruin, RENDERABLE, {
      meshType: 'power_pole_ruin',
      color: TEAM_COLORS[team] ?? 0xffffff,
      scale: 1.0,
    });
    world.addComponent<TeamComponent>(ruin, TEAM, { team });
    world.addComponent<SelectableComponent>(ruin, SELECTABLE, { selected: false });
    world.addComponent<PowerPoleRuinComponent>(ruin, POWER_POLE_RUIN, {
      gridX,
      gridZ,
      neighborGridPositions,
    });

    // Voxel state for ruin model
    const ruinModel = VOXEL_MODELS['power_pole_ruin'];
    if (ruinModel) {
      world.addComponent<VoxelStateComponent>(ruin, VOXEL_STATE, {
        modelId: 'power_pole_ruin',
        totalVoxels: ruinModel.totalSolid,
        destroyedCount: 0,
        destroyed: new Uint8Array(Math.ceil(ruinModel.totalSolid / 8)),
        dirty: true,
        pendingDebris: [],
        pendingScorch: [],
      });
    }
  }
}
