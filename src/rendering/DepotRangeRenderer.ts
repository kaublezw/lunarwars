import * as THREE from 'three';
import type { Entity, World } from '@core/ECS';
import { BUILDING, TEAM, POSITION, HEALTH, CONSTRUCTION, MATTER_STORAGE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import { RESUPPLY_RANGE } from '@sim/economy/DepotUtils';

export class DepotRangeRenderer {
  private circles = new Map<Entity, THREE.Mesh>();
  private geometry: THREE.RingGeometry;
  private material: THREE.MeshBasicMaterial;
  private playerTeam = 0;

  constructor(private scene: THREE.Scene) {
    this.geometry = new THREE.RingGeometry(RESUPPLY_RANGE - 0.1, RESUPPLY_RANGE, 48);
    this.material = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.25,
      depthTest: false,
    });
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  sync(world: World): void {
    const depots = world.query(BUILDING, TEAM, POSITION, HEALTH, MATTER_STORAGE);
    const activeDepots = new Set<Entity>();

    for (const e of depots) {
      if (world.hasComponent(e, CONSTRUCTION)) continue;
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.SupplyDepot) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (this.playerTeam >= 0 && team.team !== this.playerTeam) continue;

      const storage = world.getComponent<MatterStorageComponent>(e, MATTER_STORAGE)!;
      activeDepots.add(e);

      let mesh = this.circles.get(e);
      if (!mesh) {
        mesh = new THREE.Mesh(this.geometry, this.material);
        mesh.rotation.x = -Math.PI / 2;
        this.scene.add(mesh);
        this.circles.set(e, mesh);
      }

      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      mesh.position.set(pos.x, pos.y + 0.15, pos.z);
      mesh.visible = storage.stored > 0;
    }

    for (const [e, mesh] of this.circles) {
      if (!activeDepots.has(e)) {
        this.scene.remove(mesh);
        this.circles.delete(e);
      }
    }
  }

  dispose(): void {
    for (const [, mesh] of this.circles) {
      this.scene.remove(mesh);
    }
    this.circles.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
