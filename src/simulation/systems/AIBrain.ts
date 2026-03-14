import type { World, System } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { BuildingOccupancy } from '@sim/spatial/BuildingOccupancy';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import type { AIContext, AISerializedState } from '@sim/ai/AITypes';
import { TICK_INTERVAL, RALLY_OFFSET } from '@sim/ai/AITypes';
import { IntelligenceManager } from '@sim/ai/IntelligenceManager';
import { EconomyManager } from '@sim/ai/EconomyManager';
import { MilitaryManager } from '@sim/ai/MilitaryManager';
import { POSITION, TEAM, BUILDING, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { HealthComponent } from '@sim/components/Health';

export class AISystem implements System {
  readonly name = 'AISystem'; // save compatibility

  private team: number;
  private resources: ResourceState;
  private terrain: TerrainData;
  private fog: FogOfWarState;
  private energyNodes: EnergyNode[];
  private oreDeposits: OreDeposit[];
  private occupancy: BuildingOccupancy;

  private intel: IntelligenceManager;
  private economy: EconomyManager;
  private military: MilitaryManager;

  private tickCounter: number;
  private totalTicks = 0;

  constructor(
    team: number,
    resources: ResourceState,
    terrain: TerrainData,
    fog: FogOfWarState,
    energyNodes: EnergyNode[],
    oreDeposits: OreDeposit[],
    occupancy: BuildingOccupancy,
  ) {
    this.team = team;
    this.resources = resources;
    this.terrain = terrain;
    this.fog = fog;
    this.energyNodes = energyNodes;
    this.oreDeposits = oreDeposits;
    this.occupancy = occupancy;
    // Stagger AI ticks so teams don't always act on the same frame
    this.tickCounter = team * Math.floor(TICK_INTERVAL / 2);

    this.intel = new IntelligenceManager();
    this.economy = new EconomyManager();
    this.military = new MilitaryManager();
  }

  update(world: World, _dt: number): void {
    this.tickCounter++;
    if (this.tickCounter < TICK_INTERVAL) return;
    this.tickCounter = 0;
    this.totalTicks++;

    // Find HQ
    const hq = this.findHQ(world);
    if (hq === -1) return; // HQ destroyed, game over

    const hqPos = world.getComponent<PositionComponent>(hq, POSITION)!;
    const dir = this.team === 0 ? 1 : -1;

    // Build context
    const ctx: AIContext = {
      world,
      team: this.team,
      resources: this.resources,
      terrain: this.terrain,
      fog: this.fog,
      energyNodes: this.energyNodes,
      oreDeposits: this.oreDeposits,
      occupancy: this.occupancy,
      baseX: hqPos.x,
      baseZ: hqPos.z,
      rallyX: hqPos.x + RALLY_OFFSET * dir,
      rallyZ: hqPos.z + RALLY_OFFSET * dir,
      hqEntity: hq,
      totalTicks: this.totalTicks,
    };

    // Perceive -> Decide -> Act
    const report = this.intel.update(ctx);
    this.economy.update(ctx, report);
    this.military.update(ctx, report);
  }

  private findHQ(world: World): number {
    const buildings = world.query(BUILDING, TEAM, POSITION);
    for (const e of buildings) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== this.team) continue;
      const b = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (b.buildingType !== BuildingType.HQ) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      return e;
    }
    return -1;
  }

  // --- Serialization ---

  serialize(): AISerializedState {
    return {
      totalTicks: this.totalTicks,
      intel: this.intel.serialize(),
      economy: this.economy.serialize(),
      military: this.military.serialize(),
    };
  }

  deserialize(data: AISerializedState | Record<string, unknown>): void {
    // Support nested format
    if ('intel' in data && typeof data.intel === 'object' && data.intel !== null) {
      const nested = data as AISerializedState;
      this.totalTicks = (nested.totalTicks as number) ?? 0;
      this.intel.deserialize(nested.intel);
      this.economy.deserialize(nested.economy as Record<string, unknown>);
      this.military.deserialize(nested.military);
    }
    // Legacy flat format: ignore (start fresh)
  }
}
