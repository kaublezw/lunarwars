import * as THREE from 'three';
import type { Entity, World } from '@core/ECS';
import { POSITION, CARGO_STORAGE, HEALTH, TRAIN_LINK } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { CargoStorageComponent } from '@sim/components/CargoStorage';
import type { HealthComponent } from '@sim/components/Health';

const ENERGY_COLOR = 0x66ccff;  // cyan
const MATTER_COLOR = 0xff8833;  // orange
const EMPTY_COLOR = 0x333333;   // dark grey

// Cargo indicator dimensions (world units)
const INDICATOR_WIDTH = 0.6;
const INDICATOR_DEPTH = 0.6;
const INDICATOR_MAX_HEIGHT = 0.8;
const INDICATOR_Y_OFFSET = 0.5; // above car base

/**
 * Renders a colored box on each cargo car indicating resource type and fill level.
 * - Cyan for energy, orange for matter, dark grey when empty
 * - Box height scales with fill percentage
 */
export class CargoIndicatorRenderer {
  private scene: THREE.Scene;
  private indicators = new Map<Entity, THREE.Mesh>();
  private geometry = new THREE.BoxGeometry(1, 1, 1);
  private materials = new Map<string, THREE.MeshBasicMaterial>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.materials.set('energy', new THREE.MeshBasicMaterial({
      color: ENERGY_COLOR,
      transparent: true,
      opacity: 0.85,
    }));
    this.materials.set('matter', new THREE.MeshBasicMaterial({
      color: MATTER_COLOR,
      transparent: true,
      opacity: 0.85,
    }));
    this.materials.set('empty', new THREE.MeshBasicMaterial({
      color: EMPTY_COLOR,
      transparent: true,
      opacity: 0.4,
    }));
  }

  sync(world: World): void {
    const cars = world.query(CARGO_STORAGE, POSITION, TRAIN_LINK);
    const activeCars = new Set<Entity>();

    for (const e of cars) {
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;

      const cargo = world.getComponent<CargoStorageComponent>(e, CARGO_STORAGE)!;
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      activeCars.add(e);

      let mesh = this.indicators.get(e);
      if (!mesh) {
        mesh = new THREE.Mesh(this.geometry, this.materials.get('empty')!);
        this.scene.add(mesh);
        this.indicators.set(e, mesh);
      }

      // Pick material based on committed type
      const matKey = cargo.committedType ?? 'empty';
      const mat = this.materials.get(matKey) ?? this.materials.get('empty')!;
      if (mesh.material !== mat) {
        mesh.material = mat;
      }

      // Scale height by fill percentage (min 10% so empty cars show a sliver)
      const fillPct = cargo.capacity > 0 ? cargo.current / cargo.capacity : 0;
      const height = INDICATOR_MAX_HEIGHT * Math.max(0.1, fillPct);

      mesh.scale.set(INDICATOR_WIDTH, height, INDICATOR_DEPTH);
      mesh.position.set(
        pos.x,
        pos.y + INDICATOR_Y_OFFSET + height * 0.5,
        pos.z,
      );
      mesh.rotation.y = pos.rotation;
    }

    // Clean up indicators for dead/removed cars
    for (const [e, mesh] of this.indicators) {
      if (!activeCars.has(e)) {
        this.scene.remove(mesh);
        this.indicators.delete(e);
      }
    }
  }

  dispose(): void {
    for (const [, mesh] of this.indicators) {
      this.scene.remove(mesh);
    }
    this.indicators.clear();
    this.geometry.dispose();
    for (const [, mat] of this.materials) {
      mat.dispose();
    }
    this.materials.clear();
  }
}
