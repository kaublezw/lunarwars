import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, HEALTH, RESOURCE_SILO, POSITION, BEAM_UPGRADE, DEPOT_RADIUS } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import type { PositionComponent } from '@sim/components/Position';
import type { BeamUpgradeComponent } from '@sim/components/BeamUpgrade';
import type { ResourceState } from '@sim/economy/ResourceState';
import type { SiloSystem } from './SiloSystem';
import { spawnEnergyBeam } from '@sim/economy/EnergyBeam';

// Legacy: kept for EnergyPacketSystem import compatibility
export const PACKET_ELEVATION = 5.5;

const EXTRACTOR_RATE = 5;    // +5 energy/s
const PLANT_MATTER_RATE = 2;  // +2 matter/s

/** Default beam interval in seconds (1 beam per 5s per extractor) */
const DEFAULT_BEAM_INTERVAL = 5;

export class EconomySystem implements System {
  readonly name = 'EconomySystem';

  private siloSystem: SiloSystem | null = null;
  /** Per-extractor beam timer: entity -> seconds since last beam */
  private beamTimers = new Map<number, number>();

  constructor(
    private resources: ResourceState,
    private teamCount: number,
  ) {}

  setSiloSystem(siloSystem: SiloSystem): void {
    this.siloSystem = siloSystem;
  }

  update(world: World, dt: number): void {
    // Recalculate global pool from physical stores at start of each tick
    this.resources.recalculate();

    const entities = world.query(BUILDING, TEAM);

    const energyRates = new Float32Array(this.teamCount);
    const matterRates = new Float32Array(this.teamCount);

    const activeExtractors = new Set<number>();

    // Extractors: produce energy into adjacent silos
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.EnergyExtractor) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      energyRates[team.team] += EXTRACTOR_RATE;
      activeExtractors.add(e);

      if (this.siloSystem) {
        const silo = this.siloSystem.findOrSpawnSilo(world, e, 'energy', team.team);
        if (silo !== null) {
          const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
          siloComp.stored += EXTRACTOR_RATE * dt;
          // Overflow handled by SiloSystem.handleOverflow
        }
      }

      // Continuous beam to nearest depot (or HQ)
      this.updateExtractorBeam(world, e, team.team, dt);
    }

    // Clean up timers for destroyed extractors
    for (const [entity] of this.beamTimers) {
      if (!activeExtractors.has(entity)) {
        this.beamTimers.delete(entity);
      }
    }

    // Matter plants: produce matter into adjacent silos (no energy cost)
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.MatterPlant) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      matterRates[team.team] += PLANT_MATTER_RATE;

      if (this.siloSystem) {
        const silo = this.siloSystem.findOrSpawnSilo(world, e, 'matter', team.team);
        if (silo !== null) {
          const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
          siloComp.stored += PLANT_MATTER_RATE * dt;
        }
      }
    }

    // Update display rates
    for (let t = 0; t < this.teamCount; t++) {
      this.resources.setRates(t, energyRates[t], matterRates[t]);
    }
  }

  /** Periodically spawn a beam from this extractor to nearest depot (or HQ).
   *  Beam interval is reduced by the best depot upgrade in the network. */
  private updateExtractorBeam(world: World, extractorEntity: number, team: number, dt: number): void {
    // Initialize timer at a high value so the first beam fires immediately
    let timer = this.beamTimers.get(extractorEntity) ?? 999;
    timer += dt;

    // Find the nearest depot or HQ to beam to
    const target = this.findNearestBeamTarget(world, extractorEntity, team);
    if (target === null) {
      this.beamTimers.set(extractorEntity, timer);
      return;
    }

    // Get beam interval (reduced by depot upgrades)
    const interval = this.getBeamInterval(world, team);

    if (timer >= interval) {
      timer -= interval;
      spawnEnergyBeam(world, extractorEntity, target, team);
    }

    this.beamTimers.set(extractorEntity, timer);
  }

  /** Find nearest depot or HQ for energy beaming. Prefers depots over HQ. */
  private findNearestBeamTarget(world: World, extractorEntity: number, team: number): number | null {
    const extPos = world.getComponent<PositionComponent>(extractorEntity, POSITION);
    if (!extPos) return null;

    let bestDepot: number | null = null;
    let bestDepotDistSq = Infinity;
    let hqEntity: number | null = null;

    const buildings = world.query(BUILDING, TEAM, POSITION, HEALTH);
    for (const e of buildings) {
      if (e === extractorEntity) continue;
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const bTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (bTeam.team !== team) continue;
      const bHealth = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (bHealth.dead) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const bPos = world.getComponent<PositionComponent>(e, POSITION)!;

      if (building.buildingType === BuildingType.SupplyDepot) {
        const dx = bPos.x - extPos.x;
        const dz = bPos.z - extPos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDepotDistSq) {
          bestDepotDistSq = distSq;
          bestDepot = e;
        }
      } else if (building.buildingType === BuildingType.HQ && hqEntity === null) {
        hqEntity = e;
      }
    }

    // Prefer depot; fall back to HQ
    return bestDepot ?? hqEntity;
  }

  /** Get beam interval for a team based on best depot upgrade level. */
  private getBeamInterval(world: World, team: number): number {
    let bestLevel = 0;
    const depots = world.query(BEAM_UPGRADE, TEAM);
    for (const e of depots) {
      const bTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (bTeam.team !== team) continue;
      const upgrade = world.getComponent<BeamUpgradeComponent>(e, BEAM_UPGRADE)!;
      if (upgrade.level > bestLevel) bestLevel = upgrade.level;
    }
    // Each level halves the interval: 10s, 5s, 2.5s
    return DEFAULT_BEAM_INTERVAL / Math.pow(2, bestLevel);
  }
}
