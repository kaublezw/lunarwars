import * as THREE from 'three';
import type { World } from '@core/ECS';
import type { PowerGridState } from '@sim/economy/PowerGridState';
import { POSITION, POWER_NODE, TEAM } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const TEAM_COLORS = [0x4488ff, 0xff4444];
const LINE_OPACITY = 0.6;
const LINE_Y_OFFSET = 1.5; // at pole cross-arm height
const DROOP_AMOUNT = 0.2;  // catenary droop at midpoint
const SEGMENTS_PER_EDGE = 4; // for catenary curve

export class PowerLineRenderer {
  private scene: THREE.Scene;
  private lineSegments = new Map<number, THREE.LineSegments>();
  private materials = new Map<number, THREE.LineBasicMaterial>();
  private playerTeam = 0;
  private fogState: FogOfWarState | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  setFogState(fogState: FogOfWarState): void {
    this.fogState = fogState;
  }

  sync(world: World, gridState: PowerGridState, teamCount: number): void {
    for (let team = 0; team < teamCount; team++) {
      const edges = gridState.getTeamEdges(team);
      if (edges.length === 0) {
        this.removeLine(team);
        continue;
      }

      this.rebuildLines(team, world, gridState);
    }
  }

  private rebuildLines(team: number, world: World, gridState: PowerGridState): void {
    const edges = gridState.getTeamEdges(team);
    const positions: number[] = [];

    for (const edge of edges) {
      const posA = world.getComponent<PositionComponent>(edge.nodeA, POSITION);
      const posB = world.getComponent<PositionComponent>(edge.nodeB, POSITION);
      if (!posA || !posB) continue;

      // Fog of war: skip if both endpoints are outside visible range
      if (this.fogState && this.playerTeam >= 0) {
        const visA = this.fogState.isVisible(this.playerTeam, posA.x, posA.z);
        const visB = this.fogState.isVisible(this.playerTeam, posB.x, posB.z);
        if (!visA && !visB) continue;
      }

      // Draw catenary-drooped line with multiple segments
      const ax = posA.x, az = posA.z;
      const bx = posB.x, bz = posB.z;
      const ayBase = posA.y + LINE_Y_OFFSET;
      const byBase = posB.y + LINE_Y_OFFSET;

      for (let i = 0; i < SEGMENTS_PER_EDGE; i++) {
        const t0 = i / SEGMENTS_PER_EDGE;
        const t1 = (i + 1) / SEGMENTS_PER_EDGE;

        // Catenary droop: parabolic sag (maximum at t=0.5)
        const droop0 = -4 * DROOP_AMOUNT * t0 * (1 - t0);
        const droop1 = -4 * DROOP_AMOUNT * t1 * (1 - t1);

        const x0 = ax + (bx - ax) * t0;
        const y0 = ayBase + (byBase - ayBase) * t0 + droop0;
        const z0 = az + (bz - az) * t0;

        const x1 = ax + (bx - ax) * t1;
        const y1 = ayBase + (byBase - ayBase) * t1 + droop1;
        const z1 = az + (bz - az) * t1;

        positions.push(x0, y0, z0, x1, y1, z1);
      }
    }

    if (positions.length === 0) {
      this.removeLine(team);
      return;
    }

    let material = this.materials.get(team);
    if (!material) {
      material = new THREE.LineBasicMaterial({
        color: TEAM_COLORS[team] ?? 0xffffff,
        transparent: true,
        opacity: LINE_OPACITY,
        depthTest: true,
      });
      this.materials.set(team, material);
    }

    const posArray = new Float32Array(positions);
    let lineObj = this.lineSegments.get(team);

    if (lineObj) {
      const geo = lineObj.geometry;
      geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      geo.setDrawRange(0, posArray.length / 3);
      geo.computeBoundingSphere();
    } else {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      lineObj = new THREE.LineSegments(geometry, material);
      lineObj.renderOrder = -1;
      lineObj.frustumCulled = false;
      this.scene.add(lineObj);
      this.lineSegments.set(team, lineObj);
    }
  }

  private removeLine(team: number): void {
    const existing = this.lineSegments.get(team);
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      this.lineSegments.delete(team);
    }
  }

  dispose(): void {
    for (const [team] of this.lineSegments) {
      this.removeLine(team);
    }
    for (const [, mat] of this.materials) {
      mat.dispose();
    }
    this.materials.clear();
  }
}
