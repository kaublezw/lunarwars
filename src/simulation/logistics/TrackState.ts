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
  /** Grid cells occupied by the active track route ("gx,gz" keys). */
  activeTrackCells: Set<string>;
  /** Grid cells occupied by the pending track route ("gx,gz" keys). */
  pendingTrackCells: Set<string>;
  /** Predetermined HQ adjacent grid cell for the stub track. Set at game start, used by computeCircuit. */
  hqStubCell: { gx: number; gz: number; direction: number } | null;
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
        activeTrackCells: new Set(),
        pendingTrackCells: new Set(),
        hqStubCell: null,
      });
    }
  }

  get(team: number): TeamTrackState {
    return this.teams[team];
  }

  /** Check whether a grid cell is occupied by another team's active or pending track.
   *  Own-team track is excluded because it will auto-reroute around new buildings. */
  hasEnemyTrackAtGrid(team: number, gx: number, gz: number): boolean {
    const key = `${gx},${gz}`;
    for (let i = 0; i < this.teams.length; i++) {
      if (i === team) continue;
      const ts = this.teams[i];
      if (ts.activeTrackCells.has(key) || ts.pendingTrackCells.has(key)) return true;
    }
    return false;
  }

  /** Check whether a grid cell overlaps ANY team's active or pending track cells. */
  hasAnyTrackAtGrid(gx: number, gz: number): boolean {
    const key = `${gx},${gz}`;
    for (let i = 0; i < this.teams.length; i++) {
      const ts = this.teams[i];
      if (ts.activeTrackCells.has(key) || ts.pendingTrackCells.has(key)) return true;
    }
    return false;
  }

  /** Check whether a grid cell overlaps any team's active track (used for recompute triggers). */
  hasActiveTrackAtGrid(team: number, gx: number, gz: number): boolean {
    const ts = this.teams[team];
    return ts.activeTrackCells.has(`${gx},${gz}`);
  }

  /** Promote the pending route to active (called when engine docks at HQ). */
  applyPendingRoute(team: number): boolean {
    const ts = this.teams[team];
    if (!ts.pendingRoute) return false;
    ts.activeRoute = ts.pendingRoute;
    ts.activePlantSnapshot = [...ts.pendingPlantSnapshot];
    ts.activeTrackCells = ts.pendingTrackCells;
    ts.pendingRoute = null;
    ts.pendingPlantSnapshot = [];
    ts.pendingTrackCells = new Set();
    return true;
  }

  /** Store a newly computed route as pending. */
  setPendingRoute(team: number, route: TrackWaypoint[], plantSnapshot: number[], trackCells?: Set<string>): void {
    const ts = this.teams[team];
    ts.pendingRoute = route;
    ts.pendingPlantSnapshot = [...plantSnapshot];
    ts.pendingTrackCells = trackCells ?? new Set();
  }

  /** Store the predetermined HQ stub grid cell for a team. */
  setHQStubCell(team: number, gx: number, gz: number, direction: number): void {
    this.teams[team].hqStubCell = { gx, gz, direction };
  }

  /** Directly set the active route (for initial route when no train exists yet). */
  setActiveRoute(team: number, route: TrackWaypoint[], plantSnapshot: number[], trackCells?: Set<string>): void {
    const ts = this.teams[team];
    ts.activeRoute = route;
    ts.activePlantSnapshot = [...plantSnapshot];
    ts.activeTrackCells = trackCells ?? new Set();
    ts.pendingRoute = null;
    ts.pendingPlantSnapshot = [];
    ts.pendingTrackCells = new Set();
  }

  serialize(): Record<string, unknown>[] {
    return this.teams.map(t => ({
      activeRoute: t.activeRoute.map(w => ({ ...w })),
      pendingRoute: t.pendingRoute ? t.pendingRoute.map(w => ({ ...w })) : null,
      pendingPlantSnapshot: [...t.pendingPlantSnapshot],
      activePlantSnapshot: [...t.activePlantSnapshot],
      activeTrackCells: [...t.activeTrackCells],
      pendingTrackCells: [...t.pendingTrackCells],
      hqStubCell: t.hqStubCell ? { ...t.hqStubCell } : null,
    }));
  }

  deserialize(data: Record<string, unknown>[]): void {
    this.teams = data.map(t => {
      const d = t as {
        activeRoute: TrackWaypoint[];
        pendingRoute: TrackWaypoint[] | null;
        pendingPlantSnapshot: number[];
        activePlantSnapshot: number[];
        activeTrackCells?: string[];
        pendingTrackCells?: string[];
        hqStubCell?: { gx: number; gz: number; direction?: number } | null;
      };
      return {
        activeRoute: d.activeRoute.map(w => ({ ...w })),
        pendingRoute: d.pendingRoute ? d.pendingRoute.map(w => ({ ...w })) : null,
        pendingPlantSnapshot: [...d.pendingPlantSnapshot],
        activePlantSnapshot: [...d.activePlantSnapshot],
        activeTrackCells: new Set(d.activeTrackCells ?? []),
        pendingTrackCells: new Set(d.pendingTrackCells ?? []),
        hqStubCell: d.hqStubCell ? { gx: d.hqStubCell.gx, gz: d.hqStubCell.gz, direction: d.hqStubCell.direction ?? 0 } : null,
      };
    });
  }
}
