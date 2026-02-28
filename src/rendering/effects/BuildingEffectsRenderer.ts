import * as THREE from 'three';
import type { World } from '@core/ECS';
import { BUILDING, TEAM, CONSTRUCTION, POSITION } from '@sim/components/ComponentTypes';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import type { ParticleRenderer } from '@render/effects/ParticleRenderer';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const SMOKE_INTERVAL = 0.3; // seconds between smoke puffs
const SMOKE_PARTICLES = 3;
const GLOW_PULSE_SPEED = 2.0; // radians per second

interface SmokeTracker {
  entity: number;
  timer: number;
}

interface GlowTracker {
  entity: number;
  light: THREE.PointLight;
  phase: number;
}

export class BuildingEffectsRenderer {
  private smokeTrackers = new Map<number, SmokeTracker>();
  private glowTrackers = new Map<number, GlowTracker>();
  private particleRenderer: ParticleRenderer;
  private scene: THREE.Scene;
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;

  constructor(scene: THREE.Scene, particleRenderer: ParticleRenderer) {
    this.scene = scene;
    this.particleRenderer = particleRenderer;
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
        this.updateSmoke(e, pos, dt, visible);
      } else if (building.buildingType === BuildingType.EnergyExtractor) {
        activeEntities.add(e);
        this.updateGlow(e, pos, dt, visible);
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
      // Glow orb at top of extractor: voxel model orb is at grid y=13-16 in 10x17x10 grid
      // World offset: ~(15*0.15) = 2.25
      const light = new THREE.PointLight(0x66ccff, 1.0, 8);
      light.position.set(pos.x, pos.y + 2.3, pos.z);
      this.scene.add(light);
      tracker = { entity, light, phase: Math.random() * Math.PI * 2 };
      this.glowTrackers.set(entity, tracker);
    }

    tracker.phase += GLOW_PULSE_SPEED * dt;
    // Pulse intensity between 0.5 and 1.5
    tracker.light.intensity = visible ? 1.0 + 0.5 * Math.sin(tracker.phase) : 0;
    // Keep position synced in case building was moved (unlikely but safe)
    tracker.light.position.set(pos.x, pos.y + 2.3, pos.z);
  }

  dispose(): void {
    for (const [, tracker] of this.glowTrackers) {
      this.scene.remove(tracker.light);
      tracker.light.dispose();
    }
    this.glowTrackers.clear();
    this.smokeTrackers.clear();
  }
}
