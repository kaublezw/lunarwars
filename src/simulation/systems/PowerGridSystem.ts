import type { System, World } from '@core/ECS';
import { POWER_NODE, POWER_POLE, HEALTH, TEAM, POSITION, BUILDING, RENDERABLE, SELECTABLE, POWER_POLE_RUIN, VOXEL_STATE } from '@sim/components/ComponentTypes';
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
import { VOXEL_MODELS } from '@sim/data/VoxelModels';

const TEAM_COLORS = [0x4488ff, 0xff4444];

export class PowerGridSystem implements System {
  readonly name = 'PowerGridSystem';

  constructor(
    private gridState: PowerGridState,
    private teamCount: number,
  ) {}

  update(world: World, _dt: number): void {
    // Detect destroyed power nodes and sever their edges
    const powerNodes = world.query(POWER_NODE, HEALTH, TEAM);
    for (const e of powerNodes) {
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (!health.dead) continue;

      const teamComp = world.getComponent<TeamComponent>(e, TEAM)!;
      const team = teamComp.team;

      // Sever all edges touching this node
      this.gridState.removeEdgesForNode(team, e);

      // Spawn a ruin ghost if this was a power pole (not a building)
      if (world.hasComponent(e, POWER_POLE)) {
        const pole = world.getComponent<PowerPoleComponent>(e, POWER_POLE)!;
        const pos = world.getComponent<PositionComponent>(e, POSITION)!;
        this.spawnRuin(world, team, pos.x, pos.y, pos.z, pole.gridX, pole.gridZ);
      }

      // Remove power node component from dead entity
      world.removeComponent(e, POWER_NODE);
    }

    // Recompute connectivity via BFS for dirty teams
    for (let team = 0; team < this.teamCount; team++) {
      if (!this.gridState.isDirty(team)) continue;

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
          // Verify neighbor entity still has POWER_NODE and is alive
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
  }

  private spawnRuin(
    world: World,
    team: number,
    x: number, y: number, z: number,
    gridX: number, gridZ: number,
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
