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
import { BUILDING_STORAGE_CAPACITY } from './SiloSystem';
import { spawnEnergyBeam } from '@sim/economy/EnergyBeam';
import { spawnProductionShuttle } from '@sim/economy/MatterFerry';
import type { TerrainData } from '@sim/terrain/TerrainData';

// Legacy: kept for EnergyPacketSystem import compatibility
export const PACKET_ELEVATION = 5.5;

const EXTRACTOR_RATE = 5;    // +5 energy/s
const PLANT_MATTER_RATE = 2;  // +2 matter/s

/** Default beam interval in seconds (1 visual beam per 5s per extractor) */
const DEFAULT_BEAM_INTERVAL = 5;

/** How often matter plants dispatch a shuttle to a depot (seconds) */
const SHUTTLE_INTERVAL = 3;

export class EconomySystem implements System {
  readonly name = 'EconomySystem';

  private siloSystem: SiloSystem | null = null;
  private terrain: TerrainData | null = null;
  /** Per-extractor beam timer: entity -> seconds since last beam */
  private beamTimers = new Map<number, number>();
  /** Per-plant shuttle timer: entity -> seconds since last shuttle dispatch */
  private shuttleTimers = new Map<number, number>();
  /** Round-robin depot index per team for energy */
  private energyDepotIndex = new Map<number, number>();
  /** Round-robin depot index per team for matter */
  private matterDepotIndex = new Map<number, number>();

  constructor(
    private resources: ResourceState,
    private teamCount: number,
  ) {}

  setSiloSystem(siloSystem: SiloSystem): void {
    this.siloSystem = siloSystem;
  }

  setTerrain(terrain: TerrainData): void {
    this.terrain = terrain;
  }

  update(world: World, dt: number): void {
    // Recalculate global pool from physical stores at start of each tick
    this.resources.recalculate();

    const entities = world.query(BUILDING, TEAM);

    const energyRates = new Float32Array(this.teamCount);
    const matterRates = new Float32Array(this.teamCount);

    const activeExtractors = new Set<number>();
    const activePlants = new Set<number>();

    // Collect alive depots per team (used for round-robin distribution)
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

    // Extractors: produce energy, beam to depots (round-robin), fallback to local silo
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
        const depots = depotsPerTeam.get(team.team)!;
        const produced = EXTRACTOR_RATE * dt;

        if (depots.length > 0) {
          // Deposit energy directly into next depot's energy silo (instant beam transfer)
          const depotIdx = (this.energyDepotIndex.get(team.team) ?? 0) % depots.length;
          const depot = depots[depotIdx];
          this.energyDepotIndex.set(team.team, depotIdx + 1);

          const silo = this.siloSystem.findOrSpawnSilo(world, depot, 'energy', team.team);
          if (silo !== null) {
            const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
            siloComp.stored += produced;
          }
        } else {
          // No depots yet — store locally at extractor (early game fallback)
          const silo = this.siloSystem.findOrSpawnSilo(world, e, 'energy', team.team);
          if (silo !== null) {
            const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
            siloComp.stored += produced;
          }
        }
      }

      // Visual beam to depot (or HQ/Factory when training)
      this.updateExtractorBeam(world, e, team.team, dt, depotsPerTeam.get(team.team)!);
    }

    // Clean up timers for destroyed extractors
    for (const [entity] of this.beamTimers) {
      if (!activeExtractors.has(entity)) {
        this.beamTimers.delete(entity);
      }
    }

    // Matter plants: produce into local buffer, dispatch shuttles to depots (round-robin)
    for (const e of entities) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.MatterPlant) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;

      matterRates[team.team] += PLANT_MATTER_RATE;
      activePlants.add(e);

      if (this.siloSystem) {
        const depots = depotsPerTeam.get(team.team)!;

        if (depots.length > 0) {
          // Accumulate matter in local buffer silo
          const silo = this.siloSystem.findOrSpawnSilo(world, e, 'matter', team.team);
          if (silo !== null) {
            const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
            siloComp.stored += PLANT_MATTER_RATE * dt;

            // Periodically dispatch a shuttle carrying accumulated matter to next depot
            this.updatePlantShuttle(world, e, team.team, dt, silo, siloComp, depots);
          }
        } else {
          // No depots yet — just store locally (early game fallback)
          const silo = this.siloSystem.findOrSpawnSilo(world, e, 'matter', team.team);
          if (silo !== null) {
            const siloComp = world.getComponent<ResourceSiloComponent>(silo, RESOURCE_SILO)!;
            siloComp.stored += PLANT_MATTER_RATE * dt;
          }
        }
      }
    }

    // Clean up shuttle timers for destroyed plants
    for (const [entity] of this.shuttleTimers) {
      if (!activePlants.has(entity)) {
        this.shuttleTimers.delete(entity);
      }
    }

    // Update display rates
    for (let t = 0; t < this.teamCount; t++) {
      this.resources.setRates(t, energyRates[t], matterRates[t]);
    }
  }

  /** Periodically spawn a visual beam from extractor to its round-robin depot target. */
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
    } else {
      target = this.findActiveProducer(world, extractorEntity, team);
    }

    if (target === null) {
      this.beamTimers.set(extractorEntity, interval);
      return;
    }

    timer = 0;
    spawnEnergyBeam(world, extractorEntity, target, team);
    this.beamTimers.set(extractorEntity, timer);
  }

  /** Dispatch matter shuttle from plant to depot when local buffer has resources. */
  private updatePlantShuttle(
    world: World, plantEntity: number, team: number, dt: number,
    siloEntity: number, siloComp: ResourceSiloComponent,
    depots: number[],
  ): void {
    let timer = this.shuttleTimers.get(plantEntity) ?? 0;
    timer += dt;

    if (timer < SHUTTLE_INTERVAL) {
      this.shuttleTimers.set(plantEntity, timer);
      return;
    }

    // Take all accumulated matter from local buffer
    const amount = siloComp.stored;
    if (amount <= 0) {
      this.shuttleTimers.set(plantEntity, timer);
      return;
    }

    // Pick next depot (round-robin)
    const depotIdx = (this.matterDepotIndex.get(team) ?? 0) % depots.length;
    const depot = depots[depotIdx];
    this.matterDepotIndex.set(team, depotIdx + 1);

    // Deduct from local silo and spawn shuttle carrying real matter
    siloComp.stored = 0;
    timer = 0;
    this.shuttleTimers.set(plantEntity, timer);

    if (this.terrain) {
      spawnProductionShuttle(world, siloEntity, depot, team, this.terrain, amount);
    }
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
