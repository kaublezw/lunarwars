import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, HEALTH, RESOURCE_SILO, POSITION, BEAM_UPGRADE, DEPOT_RADIUS, PRODUCTION_QUEUE } from '@sim/components/ComponentTypes';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
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
import { deductFromBuildingSilos, getBuildingSiloTotal } from '@sim/economy/SiloUtils';

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
  /** Round-robin depot index per team for energy beaming */
  private energyDepotIndex = new Map<number, number>();

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

    // Collect alive depots per team (used for round-robin beam targeting)
    const depotsPerTeam = new Map<number, number[]>();
    for (let t = 0; t < this.teamCount; t++) {
      depotsPerTeam.set(t, []);
    }
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.SupplyDepot) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      depotsPerTeam.get(team.team)!.push(e);
    }

    // Extractors: produce energy into local silos, beam to depots at beam rate
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.EnergyExtractor) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      energyRates[team.team] += EXTRACTOR_RATE;
      activeExtractors.add(e);

      // Accumulate energy in local silos
      if (this.siloSystem) {
        const silo = this.siloSystem.findOrSpawnSilo(world, e, 'energy', team.team);
        if (silo !== null) {
          const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
          siloComp.stored += EXTRACTOR_RATE * dt;
        }
      }

      // Periodically beam energy to depots (carries real energy from local silos)
      this.updateExtractorBeam(world, e, team.team, dt, depotsPerTeam.get(team.team)!);
    }

    // Clean up timers for destroyed extractors
    for (const [entity] of this.beamTimers) {
      if (!activeExtractors.has(entity)) {
        this.beamTimers.delete(entity);
      }
    }

    // Matter plants: produce matter into local silos (ferries move it to depots)
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

  /** Periodically fire a beam from extractor to depot, carrying real energy.
   *  Energy is deducted from the extractor's local silos and delivered on arrival. */
  private updateExtractorBeam(
    world: World, extractorEntity: number, team: number, dt: number,
    depots: number[],
  ): void {
    const interval = this.getBeamInterval(world, team);
    let timer = this.beamTimers.get(extractorEntity) ?? interval;
    timer += dt;

    if (timer < interval) {
      this.beamTimers.set(extractorEntity, timer);
      return;
    }

    // Find beam target: prefer depots (round-robin), fall back to active producers
    let target: number | null = null;
    if (depots.length > 0) {
      const depotIdx = (this.energyDepotIndex.get(team) ?? 0) % depots.length;
      target = depots[depotIdx];
      this.energyDepotIndex.set(team, depotIdx + 1);
    } else {
      target = this.findActiveProducer(world, extractorEntity, team);
    }

    if (target === null) {
      this.beamTimers.set(extractorEntity, interval);
      return;
    }

    // Deduct energy from extractor's local silos — beam carries what was available
    const localEnergy = getBuildingSiloTotal(world, extractorEntity, 'energy');
    if (localEnergy <= 0) {
      this.beamTimers.set(extractorEntity, interval);
      return;
    }
    const deducted = deductFromBuildingSilos(world, extractorEntity, 'energy', localEnergy);

    timer = 0;
    spawnEnergyBeam(world, extractorEntity, target, team, deducted);
    this.beamTimers.set(extractorEntity, timer);
  }

  /** Find nearest HQ or Factory that is actively training (fallback beam target). */
  private findActiveProducer(world: World, extractorEntity: number, team: number): number | null {
    const extPos = world.getComponent<PositionComponent>(extractorEntity, POSITION);
    if (!extPos) return null;

    let bestEntity: number | null = null;
    let bestDistSq = Infinity;

    const buildings = world.query(BUILDING, TEAM, POSITION, HEALTH);
    for (const e of buildings) {
      if (e === extractorEntity) continue;
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const bTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (bTeam.team !== team) continue;
      const bHealth = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (bHealth.dead) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ && building.buildingType !== BuildingType.DroneFactory) continue;

      const pq = world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE);
      if (!pq || pq.queue.length === 0) continue;

      const bPos = world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = bPos.x - extPos.x;
      const dz = bPos.z - extPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    return bestEntity;
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
