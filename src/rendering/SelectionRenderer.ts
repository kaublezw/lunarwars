import * as THREE from 'three';
import type { Entity, World } from '@core/ECS';
import { POSITION, SELECTABLE, UNIT_TYPE, TEAM } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { TeamComponent } from '@sim/components/Team';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

export class SelectionRenderer {
  private rings = new Map<Entity, THREE.Mesh>();
  private ringGeometries = new Map<number, THREE.RingGeometry>();
  private material: THREE.MeshBasicMaterial;
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  constructor(private scene: THREE.Scene) {
    this.material = new THREE.MeshBasicMaterial({
      color: 0x44ff44,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
  }

  sync(world: World, alpha: number): void {
    const entities = world.query(POSITION, SELECTABLE);
    const activeEntities = new Set<Entity>();

    for (const e of entities) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;

      // Skip fogged enemy entities (safety net)
      if (this.fogState) {
        const team = world.getComponent<TeamComponent>(e, TEAM);
        if (team && team.team !== this.playerTeam) {
          const pos = world.getComponent<PositionComponent>(e, POSITION)!;
          if (!this.fogState.isVisible(this.playerTeam, pos.x, pos.z)) continue;
        }
      }

      activeEntities.add(e);
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const unitType = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      const radius = unitType?.radius ?? 0.25;
      const ringRadius = Math.max(radius * 1.5, 0.6);

      let ring = this.rings.get(e);
      if (!ring) {
        const geo = this.getRingGeometry(ringRadius);
        ring = new THREE.Mesh(geo, this.material);
        ring.renderOrder = -1;
        ring.rotation.x = -Math.PI / 2; // Lay flat on ground
        this.scene.add(ring);
        this.rings.set(e, ring);
      }

      // Interpolate position
      const x = pos.prevX + (pos.x - pos.prevX) * alpha;
      const y = pos.prevY + (pos.y - pos.prevY) * alpha;
      const z = pos.prevZ + (pos.z - pos.prevZ) * alpha;
      ring.position.set(x, y - 0.3, z);
    }

    // Remove rings for deselected or destroyed entities
    for (const [e, ring] of this.rings) {
      if (!activeEntities.has(e)) {
        this.scene.remove(ring);
        this.rings.delete(e);
      }
    }
  }

  private getRingGeometry(radius: number): THREE.RingGeometry {
    // Quantize radius to avoid too many unique geometries
    const key = Math.round(radius * 10);
    let geo = this.ringGeometries.get(key);
    if (!geo) {
      geo = new THREE.RingGeometry(radius * 0.8, radius, 24);
      this.ringGeometries.set(key, geo);
    }
    return geo;
  }
}
