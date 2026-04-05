import * as THREE from 'three';
import type { TrackState } from '@sim/logistics/TrackState';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const TRACK_Y_OFFSET = 0.12; // slightly above ground to avoid z-fighting
const TEAM_COLORS = [0x4488ff, 0xff4444];
const TRACK_OPACITY = 0.5;
const RAIL_WIDTH = 0.3; // half-width of each rail line

/**
 * Renders track lines on the ground for each team's active train route.
 * Tracks are drawn as flat line strips between waypoints.
 */
export class TrackRenderer {
  private scene: THREE.Scene;
  private trackLines = new Map<number, THREE.Line>();
  private materials = new Map<number, THREE.LineBasicMaterial>();
  private playerTeam = 0;
  private fogState: FogOfWarState | null = null;
  /** Cache the route arrays to detect changes without rebuilding every frame. */
  private lastRouteLength = new Map<number, number>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  setFogState(fog: FogOfWarState, team: number): void {
    this.fogState = fog;
    this.playerTeam = team;
  }

  sync(trackState: TrackState, teamCount: number): void {
    for (let team = 0; team < teamCount; team++) {
      const ts = trackState.get(team);
      const route = ts.activeRoute;

      // Skip rendering enemy tracks in non-spectator mode
      if (this.playerTeam >= 0 && team !== this.playerTeam) {
        this.removeTrack(team);
        continue;
      }

      // Check if route changed (simple length check + first/last waypoint)
      const cachedLen = this.lastRouteLength.get(team) ?? -1;
      const routeChanged = route.length !== cachedLen;

      if (route.length < 2) {
        this.removeTrack(team);
        this.lastRouteLength.set(team, 0);
        continue;
      }

      if (routeChanged) {
        this.rebuildTrack(team, route);
        this.lastRouteLength.set(team, route.length);
      }
    }
  }

  private rebuildTrack(team: number, route: { x: number; y: number; z: number }[]): void {
    this.removeTrack(team);

    // Build a dual-rail line: two parallel lines offset from the center path
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < route.length; i++) {
      const wp = route[i];
      points.push(new THREE.Vector3(wp.x, wp.y + TRACK_Y_OFFSET, wp.z));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    let material = this.materials.get(team);
    if (!material) {
      material = new THREE.LineBasicMaterial({
        color: TEAM_COLORS[team] ?? 0xffffff,
        transparent: true,
        opacity: TRACK_OPACITY,
        depthTest: true,
        linewidth: 1, // Note: linewidth > 1 only works with Line2 in WebGL2
      });
      this.materials.set(team, material);
    }

    const line = new THREE.Line(geometry, material);
    line.renderOrder = -1; // render before most objects
    this.scene.add(line);
    this.trackLines.set(team, line);
  }

  private removeTrack(team: number): void {
    const existing = this.trackLines.get(team);
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      this.trackLines.delete(team);
    }
  }

  dispose(): void {
    for (const [team] of this.trackLines) {
      this.removeTrack(team);
    }
    for (const [, mat] of this.materials) {
      mat.dispose();
    }
    this.materials.clear();
  }
}
