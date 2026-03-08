import * as THREE from 'three';
import type { World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION, ENERGY_PACKET, HEALTH } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { EnergyPacketComponent } from '@sim/components/EnergyPacket';
import type { ParticleRenderer } from '@render/effects/ParticleRenderer';
import type { DebrisRenderer } from '@render/effects/DebrisRenderer';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const SMOKE_INTERVAL = 0.3; // seconds between smoke puffs
const SMOKE_PARTICLES = 3;
const CHARGE_DURATION = 10; // seconds — matches PACKET_INTERVAL in EconomySystem
const FADE_DURATION = 2.0;  // seconds for HQ glow to fade after receiving
const MAX_GLOW_INTENSITY = 50.0;
const TOWER_GLOW_Y = 5.5;  // wu above building base (matches tower cap / PACKET_ELEVATION)
const ARRIVAL_CHECK_SQ = 4; // 2 wu squared — proximity to consider a packet "arrived"

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

interface PacketGlowTracker {
  entity: number;
  light: THREE.PointLight;
}

interface TrackedPacket {
  source: number;
  target: number;
  lastX: number;
  lastY: number;
  lastZ: number;
}

export class BuildingEffectsRenderer {
  private smokeTrackers = new Map<number, SmokeTracker>();
  private glowTrackers = new Map<number, GlowTracker>();
  private hqGlowTrackers = new Map<number, GlowTracker>();
  private packetGlowTrackers = new Map<number, PacketGlowTracker>();
  private matterPacketGlowTrackers = new Map<number, PacketGlowTracker>();
  private trackedPackets = new Map<number, TrackedPacket>();
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
    // Detect packet send/receive events before processing buildings
    this.detectPacketEvents(world);

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
        this.updateSmoke(e, pos, dt, visible);
      } else if (building.buildingType === BuildingType.EnergyExtractor) {
        activeEntities.add(e);
        this.updateGlow(e, pos, dt, visible);
      } else if (building.buildingType === BuildingType.HQ) {
        activeEntities.add(e);
        this.updateHQGlow(e, pos, dt, visible);
      }
    }

    // Clean up destroyed buildings
    for (const [entity] of this.smokeTrackers) {
      if (!activeEntities.has(entity)) {
        this.smokeTrackers.delete(entity);
      }
    }

    for (const [entity, tracker] of this.glowTrackers) {
      if (!activeEntities.has(entity)) {
        this.scene.remove(tracker.light);
        tracker.light.dispose();
        this.glowTrackers.delete(entity);
      }
    }

    for (const [entity, tracker] of this.hqGlowTrackers) {
      if (!activeEntities.has(entity)) {
        this.scene.remove(tracker.light);
        tracker.light.dispose();
        this.hqGlowTrackers.delete(entity);
      }
    }

    // Energy packet glow lights
    this.updatePacketGlows(world);

    // Matter packets: no glow (dark ore cubes)
    this.cleanupMatterPacketGlows();
  }

  private detectPacketEvents(world: World): void {
    const packets = world.query(ENERGY_PACKET, POSITION);
    const currentPackets = new Set<number>();

    for (const e of packets) {
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;

      currentPackets.add(e);
      const packet = world.getComponent<EnergyPacketComponent>(e, ENERGY_PACKET)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      if (!this.trackedPackets.has(e)) {
        // New packet spawned — reset extractor charge (instant cut to dark)
        this.trackedPackets.set(e, {
          source: packet.sourceEntity,
          target: packet.targetEntity,
          lastX: pos.x, lastY: pos.y, lastZ: pos.z,
        });
        const extTracker = this.glowTrackers.get(packet.sourceEntity);
        if (extTracker) extTracker.chargeTimer = 0;

        // Voxel spark burst at extractor tower top
        const extPos = world.getComponent<PositionComponent>(packet.sourceEntity, POSITION);
        if (extPos) {
          const visible = !this.fogState || this.playerTeam < 0 || this.fogState.isVisible(this.playerTeam, extPos.x, extPos.z);
          if (visible) {
            const sx = extPos.x;
            const sy = extPos.y + TOWER_GLOW_Y;
            const sz = extPos.z;
            for (let i = 0; i < 6; i++) {
              const dx = (Math.random() - 0.5) * 3;
              const dy = Math.random() * 3;
              const dz = (Math.random() - 0.5) * 3;
              this.debrisRenderer.spawn(sx, sy, sz, dx, dy, dz, 0x66ccff, 1.0, 0x66ccff, true);
            }
          }
        }
      } else {
        // Update last known position
        const info = this.trackedPackets.get(e)!;
        info.lastX = pos.x;
        info.lastY = pos.y;
        info.lastZ = pos.z;
      }
    }

    // Check for disappeared packets
    for (const [packetId, info] of this.trackedPackets) {
      if (!currentPackets.has(packetId)) {
        // Packet gone — check if it was near its target HQ (arrived vs killed)
        const hqPos = world.getComponent<PositionComponent>(info.target, POSITION);
        if (hqPos) {
          const dx = info.lastX - hqPos.x;
          const dz = info.lastZ - hqPos.z;
          if (dx * dx + dz * dz < ARRIVAL_CHECK_SQ) {
            const hqTracker = this.hqGlowTrackers.get(info.target);
            if (hqTracker) hqTracker.fadeTimer = FADE_DURATION;
          }
        }
        this.trackedPackets.delete(packetId);
      }
    }
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

  private updateGlow(entity: number, pos: PositionComponent, dt: number, visible: boolean): void {
    let tracker = this.glowTrackers.get(entity);
    if (!tracker) {
      const light = new THREE.PointLight(0x66ccff, 0, 14);
      light.position.set(pos.x, pos.y + TOWER_GLOW_Y, pos.z);
      this.scene.add(light);
      tracker = { entity, light, chargeTimer: 0, fadeTimer: 0 };
      this.glowTrackers.set(entity, tracker);
    }

    // Slow charge-up: ramps linearly over CHARGE_DURATION, resets to 0 on packet fire
    tracker.chargeTimer = Math.min(tracker.chargeTimer + dt, CHARGE_DURATION);
    const intensity = (tracker.chargeTimer / CHARGE_DURATION) * MAX_GLOW_INTENSITY;
    tracker.light.intensity = visible ? intensity : 0;
    tracker.light.distance = 6 + 14 * (tracker.chargeTimer / CHARGE_DURATION);

    tracker.light.position.set(pos.x, pos.y + TOWER_GLOW_Y, pos.z);
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

  private updatePacketGlows(world: World): void {
    const packets = world.query(ENERGY_PACKET, POSITION);
    const activePackets = new Set<number>();

    for (const e of packets) {
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;

      activePackets.add(e);
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const visible = !this.fogState || this.playerTeam < 0 || this.fogState.isVisible(this.playerTeam, pos.x, pos.z);

      let tracker = this.packetGlowTrackers.get(e);
      if (!tracker) {
        const light = new THREE.PointLight(0x66ccff, MAX_GLOW_INTENSITY, 20);
        light.position.set(pos.x, pos.y, pos.z);
        this.scene.add(light);
        tracker = { entity: e, light };
        this.packetGlowTrackers.set(e, tracker);
      }

      tracker.light.intensity = visible ? MAX_GLOW_INTENSITY : 0;
      tracker.light.position.set(pos.x, pos.y, pos.z);
    }

    // Clean up destroyed packets
    for (const [entity, tracker] of this.packetGlowTrackers) {
      if (!activePackets.has(entity)) {
        this.scene.remove(tracker.light);
        tracker.light.dispose();
        this.packetGlowTrackers.delete(entity);
      }
    }
  }

  private cleanupMatterPacketGlows(): void {
    // Remove any lingering matter packet lights (no new ones are created)
    for (const [entity, tracker] of this.matterPacketGlowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
      this.matterPacketGlowTrackers.delete(entity);
    }
  }

  /** Remove all tracked effects but keep the renderer alive (for world revert). */
  clearAll(): void {
    for (const [, tracker] of this.glowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    for (const [, tracker] of this.hqGlowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    for (const [, tracker] of this.packetGlowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    for (const [, tracker] of this.matterPacketGlowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    this.glowTrackers.clear();
    this.hqGlowTrackers.clear();
    this.packetGlowTrackers.clear();
    this.matterPacketGlowTrackers.clear();
    this.trackedPackets.clear();
    this.smokeTrackers.clear();
  }

  dispose(): void {
    this.clearAll();
  }
}
