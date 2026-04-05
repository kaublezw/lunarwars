/** Per-team track circuit state. Tracks are visual-only (no collision). */
export interface TrackWaypoint {
  x: number;
  y: number;
  z: number;
  /** Entity ID of the plant at this stop, or null for HQ/intermediate waypoints. */
  entityId: number | null;
  /** True only for HQ stop waypoints (first and last in the circuit). */
  isHQ: boolean;
}

export interface TeamTrackState {
  /** The live circuit the train is currently following. Empty = no route yet. */
  activeRoute: TrackWaypoint[];
  /** A freshly computed optimal circuit waiting to be swapped in when the engine docks at HQ. */
  pendingRoute: TrackWaypoint[] | null;
  /** Entity IDs of completed plants that contributed to the pending route calculation. */
  pendingPlantSnapshot: number[];
  /** Entity IDs of completed plants that contributed to the active route. */
  activePlantSnapshot: number[];
}

export class TrackState {
  private teams: TeamTrackState[];

  constructor(teamCount: number) {
    this.teams = [];
    for (let i = 0; i < teamCount; i++) {
      this.teams.push({
        activeRoute: [],
        pendingRoute: null,
        pendingPlantSnapshot: [],
        activePlantSnapshot: [],
      });
    }
  }

  get(team: number): TeamTrackState {
    return this.teams[team];
  }

  /** Promote the pending route to active (called when engine docks at HQ). */
  applyPendingRoute(team: number): boolean {
    const ts = this.teams[team];
    if (!ts.pendingRoute) return false;
    ts.activeRoute = ts.pendingRoute;
    ts.activePlantSnapshot = [...ts.pendingPlantSnapshot];
    ts.pendingRoute = null;
    ts.pendingPlantSnapshot = [];
    return true;
  }

  /** Store a newly computed route as pending. */
  setPendingRoute(team: number, route: TrackWaypoint[], plantSnapshot: number[]): void {
    const ts = this.teams[team];
    ts.pendingRoute = route;
    ts.pendingPlantSnapshot = [...plantSnapshot];
  }

  /** Directly set the active route (for initial route when no train exists yet). */
  setActiveRoute(team: number, route: TrackWaypoint[], plantSnapshot: number[]): void {
    const ts = this.teams[team];
    ts.activeRoute = route;
    ts.activePlantSnapshot = [...plantSnapshot];
    ts.pendingRoute = null;
    ts.pendingPlantSnapshot = [];
  }

  serialize(): TeamTrackState[] {
    return this.teams.map(t => ({
      activeRoute: t.activeRoute.map(w => ({ ...w })),
      pendingRoute: t.pendingRoute ? t.pendingRoute.map(w => ({ ...w })) : null,
      pendingPlantSnapshot: [...t.pendingPlantSnapshot],
      activePlantSnapshot: [...t.activePlantSnapshot],
    }));
  }

  deserialize(data: TeamTrackState[]): void {
    this.teams = data.map(t => ({
      activeRoute: t.activeRoute.map(w => ({ ...w })),
      pendingRoute: t.pendingRoute ? t.pendingRoute.map(w => ({ ...w })) : null,
      pendingPlantSnapshot: [...t.pendingPlantSnapshot],
      activePlantSnapshot: [...t.activePlantSnapshot],
    }));
  }
}
