import * as THREE from 'three';
import type { World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION, HEALTH, PRODUCTION_QUEUE, BUILD_COMMAND, REPAIR_COMMAND, POWER_NODE } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { RepairCommandComponent } from '@sim/components/RepairCommand';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import type { ParticleRenderer } from '@render/effects/ParticleRenderer';
import type { DebrisRenderer } from '@render/effects/DebrisRenderer';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const SMOKE_INTERVAL = 0.3; // seconds between smoke puffs
const SMOKE_PARTICLES = 3;
const CHARGE_DURATION = 10; // seconds — matches PACKET_INTERVAL in EconomySystem
const FADE_DURATION = 2.0;  // seconds for HQ glow to fade after receiving
const MAX_GLOW_INTENSITY = 50.0;
const TOWER_GLOW_Y = 5.5;  // wu above building base (HQ antenna height / PACKET_ELEVATION)
// Extractor window pulse constants
const EXTRACTOR_PULSE_BASE = 4.0;
const EXTRACTOR_PULSE_AMP = 8.0;
const EXTRACTOR_PULSE_DISTANCE = 8.0;
const EXTRACTOR_GLOW_Y = 2.4;   // wu above building base (blue glow cap on energy pod housing)
const EXTRACTOR_GLOW_X = 0;     // centered on building
const EXTRACTOR_GLOW_Z = 0;     // centered on building
// Extractor cooling tower smoke constants
const EXTRACTOR_SMOKE_INTERVAL = 0.3; // seconds between smoke puffs (matches matter plant)
// Tower center world offset: grid (4,15) in 20x22x20 model
const EXTRACTOR_SMOKE_X = -0.825; // (4.5*0.15) - (20/2*0.15)
const EXTRACTOR_SMOKE_Y = 3.3;    // 22*0.15
const EXTRACTOR_SMOKE_Z = 0.825;  // (15.5*0.15) - (20/2*0.15)
const PRODUCTION_LIGHT_COLOR = 0xff8833;  // warm orange — welding sparks
const PRODUCTION_LIGHT_INTENSITY = 15.0;
const PRODUCTION_LIGHT_DISTANCE = 8.0;
const PRODUCTION_LIGHT_Y_OFFSET = 1.5;   // inside building
const BUILD_SPARK_INTERVAL = 0.08;        // seconds between spark bursts (~12/sec)
const BUILD_SPARK_COUNT = 2;              // sparks per burst
const BUILD_SPARK_COLOR = 0xffaa44;       // warm welding yellow-orange
const BUILD_GLOW_COLOR = 0xff8833;        // welding glow orange
const BUILD_GLOW_INTENSITY = 12.0;
const BUILD_GLOW_DISTANCE = 6.0;

interface SmokeTracker {
  entity: number;
  timer: number;
}

interface GlowTracker {
  entity: number;
  light: THREE.PointLight;
  chargeTimer: number; // counts up 0 -> CHARGE_DURATION (extractor charging)
  fadeTimer: number;   // counts down FADE_DURATION -> 0 (HQ fading)
}

interface ExtractorPulseTracker {
  entity: number;
  light: THREE.PointLight;
  phase: number;      // single phase offset per building
  frequency: number;  // single frequency per building
  time: number;
  smokeTimer: number; // timer for voxel smoke spawning
}

interface ProductionGlowTracker {
  entity: number;
  light: THREE.PointLight;
  time: number;
}

interface BuildSparkTracker {
  entity: number;
  sparkTimer: number;
  time: number;
  glowLight: THREE.PointLight;
}

export class BuildingEffectsRenderer {
  private smokeTrackers = new Map<number, SmokeTracker>();
  private extractorPulseTrackers = new Map<number, ExtractorPulseTracker>();
  private hqGlowTrackers = new Map<number, GlowTracker>();
  private productionGlowTrackers = new Map<number, ProductionGlowTracker>();
  private buildSparkTrackers = new Map<number, BuildSparkTracker>();
  private particleRenderer: ParticleRenderer;
  private debrisRenderer: DebrisRenderer;
  private scene: THREE.Scene;
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;

  constructor(scene: THREE.Scene, particleRenderer: ParticleRenderer, debrisRenderer: DebrisRenderer) {
    this.scene = scene;
    this.particleRenderer = particleRenderer;
    this.debrisRenderer = debrisRenderer;
  }

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  update(world: World, dt: number): void {
    const buildings = world.query(BUILDING, TEAM, POSITION);
    const activeEntities = new Set<number>();

    for (const e of buildings) {
      // Skip buildings under construction
      if (world.hasComponent(e, CONSTRUCTION)) continue;

      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Check fog visibility (playerTeam < 0 = spectator, always visible)
      const visible = !this.fogState || this.playerTeam < 0 || this.fogState.isVisible(this.playerTeam, pos.x, pos.z);

      if (building.buildingType === BuildingType.MatterPlant) {
        activeEntities.add(e);
        const powerNode = world.getComponent<PowerNodeComponent>(e, POWER_NODE);
        const powered = powerNode ? powerNode.powered : true;
        if (powered) {
          this.updateSmoke(e, pos, dt, visible);
        }
      } else if (building.buildingType === BuildingType.EnergyExtractor) {
        activeEntities.add(e);
        const powerNode = world.getComponent<PowerNodeComponent>(e, POWER_NODE);
        const powered = powerNode ? powerNode.powered : true;
        this.updateExtractorPulse(e, pos, dt, visible, powered);
      } else if (building.buildingType === BuildingType.HQ) {
        activeEntities.add(e);
        this.updateHQGlow(e, pos, dt, visible);
      } else if (building.buildingType === BuildingType.DroneFactory) {
        activeEntities.add(e);
      }

      // Production flicker lights for HQ and DroneFactory
      if (building.buildingType === BuildingType.HQ || building.buildingType === BuildingType.DroneFactory) {
        this.updateProductionGlow(e, pos, dt, visible, world);
      }
    }

    // Clean up destroyed buildings
    for (const [entity] of this.smokeTrackers) {
      if (!activeEntities.has(entity)) {
        this.smokeTrackers.delete(entity);
      }
    }

    for (const [entity, tracker] of this.extractorPulseTrackers) {
      if (!activeEntities.has(entity)) {
        this.scene.remove(tracker.light);
        tracker.light.dispose();
        this.extractorPulseTrackers.delete(entity);
      }
    }

    for (const [entity, tracker] of this.hqGlowTrackers) {
      if (!activeEntities.has(entity)) {
        this.scene.remove(tracker.light);
        tracker.light.dispose();
        this.hqGlowTrackers.delete(entity);
      }
    }

    for (const [entity, tracker] of this.productionGlowTrackers) {
      if (!activeEntities.has(entity)) {
        this.scene.remove(tracker.light);
        tracker.light.dispose();
        this.productionGlowTrackers.delete(entity);
      }
    }

    // Construction welding sparks
    this.updateBuildSparks(world, dt);
  }

  private updateSmoke(entity: number, pos: PositionComponent, dt: number, visible: boolean): void {
    let tracker = this.smokeTrackers.get(entity);
    if (!tracker) {
      tracker = { entity, timer: 0 };
      this.smokeTrackers.set(entity, tracker);
    }

    tracker.timer += dt;
    if (tracker.timer >= SMOKE_INTERVAL && visible) {
      tracker.timer = 0;
      // Chimney top: voxel model chimney is at grid (15-19, 0-13, 15-19) in a 20x14x20 grid
      // World offset: ((17.5*0.15)-1.5, 14*0.15, (17.5*0.15)-1.5) = (1.125, 2.1, 1.125)
      const smokeX = pos.x + 1.1;
      const smokeY = pos.y + 2.2;
      const smokeZ = pos.z + 1.1;

      this.particleRenderer.spawnBurst(
        smokeX, smokeY, smokeZ,
        0, 1, // direction: upward
        0x888888,
        SMOKE_PARTICLES,
        {
          speed: 1.5,
          gravity: -0.3, // negative = floats up
          lifetime: 2.0,
          spread: 0.5,
        },
      );
    }
  }

  private updateExtractorPulse(entity: number, pos: PositionComponent, dt: number, visible: boolean, powered: boolean): void {
    let tracker = this.extractorPulseTrackers.get(entity);
    if (!tracker) {
      const light = new THREE.PointLight(0x66ccff, 0, EXTRACTOR_PULSE_DISTANCE);
      light.position.set(pos.x + EXTRACTOR_GLOW_X, pos.y + EXTRACTOR_GLOW_Y, pos.z + EXTRACTOR_GLOW_Z);
      this.scene.add(light);
      // Single phase/frequency per building, varied between buildings
      const phase = ((entity * 7919) % 1000) / 1000 * Math.PI * 2;
      const frequency = 0.3 + ((entity * 3571) % 1000) / 1000 * 0.2;
      tracker = { entity, light, phase, frequency, time: 0, smokeTimer: 0 };
      this.extractorPulseTrackers.set(entity, tracker);
    }

    tracker.time += dt;

    const pulse = Math.sin(tracker.time * Math.PI * 2 * tracker.frequency + tracker.phase);
    tracker.light.intensity = (visible && powered) ? EXTRACTOR_PULSE_BASE + EXTRACTOR_PULSE_AMP * (pulse * 0.5 + 0.5) : 0;

    // Spawn particle smoke from cooling tower when powered and visible
    if (powered) {
      tracker.smokeTimer += dt;
      if (tracker.smokeTimer >= EXTRACTOR_SMOKE_INTERVAL && visible) {
        tracker.smokeTimer = 0;
        const smokeX = pos.x + EXTRACTOR_SMOKE_X;
        const smokeY = pos.y + EXTRACTOR_SMOKE_Y;
        const smokeZ = pos.z + EXTRACTOR_SMOKE_Z;
        this.particleRenderer.spawnBurst(
          smokeX, smokeY, smokeZ,
          0, 1, // direction: upward
          0x888888,
          SMOKE_PARTICLES,
          {
            speed: 1.5,
            gravity: -0.3,
            lifetime: 2.0,
            spread: 0.5,
          },
        );
      }
    }
  }

  private updateHQGlow(entity: number, pos: PositionComponent, dt: number, visible: boolean): void {
    let tracker = this.hqGlowTrackers.get(entity);
    if (!tracker) {
      const light = new THREE.PointLight(0x66ccff, 0, 14);
      light.position.set(pos.x, pos.y + TOWER_GLOW_Y, pos.z);
      this.scene.add(light);
      tracker = { entity, light, chargeTimer: 0, fadeTimer: 0 };
      this.hqGlowTrackers.set(entity, tracker);
    }

    // Instant flash on arrival, slow linear fade to dark
    if (tracker.fadeTimer > 0) {
      tracker.fadeTimer = Math.max(0, tracker.fadeTimer - dt);
      const intensity = (tracker.fadeTimer / FADE_DURATION) * MAX_GLOW_INTENSITY;
      tracker.light.intensity = visible ? intensity : 0;
      tracker.light.distance = 6 + 14 * (tracker.fadeTimer / FADE_DURATION);
    } else {
      tracker.light.intensity = 0;
    }

    tracker.light.position.set(pos.x, pos.y + TOWER_GLOW_Y, pos.z);
  }

  private updateProductionGlow(entity: number, pos: PositionComponent, dt: number, visible: boolean, world: World): void {
    const queue = world.getComponent<ProductionQueueComponent>(entity, PRODUCTION_QUEUE);
    const isProducing = queue && queue.queue.length > 0 && queue.queue[0].timeRemaining > 0;

    if (!isProducing) {
      const existing = this.productionGlowTrackers.get(entity);
      if (existing) {
        this.scene.remove(existing.light);
        existing.light.dispose();
        this.productionGlowTrackers.delete(entity);
      }
      return;
    }

    let tracker = this.productionGlowTrackers.get(entity);
    if (!tracker) {
      const light = new THREE.PointLight(PRODUCTION_LIGHT_COLOR, 0, PRODUCTION_LIGHT_DISTANCE);
      this.scene.add(light);
      tracker = { entity, light, time: 0 };
      this.productionGlowTrackers.set(entity, tracker);
    }

    tracker.time += dt;

    // Welding flicker: sinusoidal base + random noise
    const sin1 = Math.sin(tracker.time * 12.0) * 0.3;
    const sin2 = Math.sin(tracker.time * 5.3) * 0.2;
    const noise = (Math.random() - 0.5) * 0.4;
    const flicker = Math.max(0, 0.5 + sin1 + sin2 + noise);
    const intensity = flicker * PRODUCTION_LIGHT_INTENSITY;

    tracker.light.intensity = visible ? intensity : 0;
    tracker.light.position.set(pos.x, pos.y + PRODUCTION_LIGHT_Y_OFFSET, pos.z);
  }

  private updateBuildSparks(world: World, dt: number): void {
    const activeWorkers = new Set<number>();

    // Collect active workers: building construction sites
    const builders = world.query(BUILD_COMMAND, POSITION);
    for (const e of builders) {
      const cmd = world.getComponent<BuildCommandComponent>(e, BUILD_COMMAND)!;
      if (cmd.state !== 'building') continue;
      const sitePos = world.getComponent<PositionComponent>(cmd.siteEntity, POSITION);
      if (!sitePos) continue;
      activeWorkers.add(e);
      this.emitWorkerSparks(e, cmd.siteEntity, world, dt);
    }

    // Collect active workers: repairing buildings
    const repairers = world.query(REPAIR_COMMAND, POSITION);
    for (const e of repairers) {
      const repair = world.getComponent<RepairCommandComponent>(e, REPAIR_COMMAND)!;
      if (repair.state !== 'repairing') continue;
      const targetPos = world.getComponent<PositionComponent>(repair.targetEntity, POSITION);
      if (!targetPos) continue;
      activeWorkers.add(e);
      this.emitWorkerSparks(e, repair.targetEntity, world, dt);
    }

    // Clean up workers no longer building or repairing
    for (const [entity, tracker] of this.buildSparkTrackers) {
      if (!activeWorkers.has(entity)) {
        this.scene.remove(tracker.glowLight);
        tracker.glowLight.dispose();
        this.buildSparkTrackers.delete(entity);
      }
    }
  }

  private emitWorkerSparks(workerEntity: number, targetEntity: number, world: World, dt: number): void {
    const workerPos = world.getComponent<PositionComponent>(workerEntity, POSITION)!;
    const targetPos = world.getComponent<PositionComponent>(targetEntity, POSITION)!;

    const visible = !this.fogState || this.playerTeam < 0 ||
      this.fogState.isVisible(this.playerTeam, workerPos.x, workerPos.z);

    let tracker = this.buildSparkTrackers.get(workerEntity);
    if (!tracker) {
      const light = new THREE.PointLight(BUILD_GLOW_COLOR, 0, BUILD_GLOW_DISTANCE);
      this.scene.add(light);
      tracker = { entity: workerEntity, sparkTimer: 0, time: 0, glowLight: light };
      this.buildSparkTrackers.set(workerEntity, tracker);
    }

    // Spark origin: midway between worker and target, slightly above ground
    const sparkX = (workerPos.x + targetPos.x) * 0.5;
    const sparkY = Math.max(workerPos.y, targetPos.y) + 0.5;
    const sparkZ = (workerPos.z + targetPos.z) * 0.5;

    // Welding flicker light
    tracker.time += dt;
    const sin1 = Math.sin(tracker.time * 15.0) * 0.3;
    const sin2 = Math.sin(tracker.time * 7.3) * 0.2;
    const noise = (Math.random() - 0.5) * 0.4;
    const flicker = Math.max(0, 0.5 + sin1 + sin2 + noise);
    tracker.glowLight.intensity = visible ? flicker * BUILD_GLOW_INTENSITY : 0;
    tracker.glowLight.position.set(sparkX, sparkY, sparkZ);

    // Spawn glowing voxel sparks
    tracker.sparkTimer += dt;
    if (tracker.sparkTimer >= BUILD_SPARK_INTERVAL && visible) {
      tracker.sparkTimer -= BUILD_SPARK_INTERVAL;
      for (let i = 0; i < BUILD_SPARK_COUNT; i++) {
        const dx = (Math.random() - 0.5) * 0.3;
        const dy = Math.random() * 0.3;
        const dz = (Math.random() - 0.5) * 0.3;
        this.debrisRenderer.spawn(
          sparkX, sparkY, sparkZ,
          dx, dy, dz,
          BUILD_SPARK_COLOR, 1.0, BUILD_SPARK_COLOR, true,
        );
      }
    }
  }

  /** Remove all tracked effects but keep the renderer alive (for world revert). */
  clearAll(): void {
    for (const [, tracker] of this.extractorPulseTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    for (const [, tracker] of this.hqGlowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    for (const [, tracker] of this.productionGlowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    for (const [, tracker] of this.buildSparkTrackers) {
      this.scene.remove(tracker.glowLight);
      tracker.glowLight.dispose();
    }
    this.extractorPulseTrackers.clear();
    this.hqGlowTrackers.clear();
    this.productionGlowTrackers.clear();
    this.buildSparkTrackers.clear();
    this.smokeTrackers.clear();
  }

  dispose(): void {
    this.clearAll();
  }
}
