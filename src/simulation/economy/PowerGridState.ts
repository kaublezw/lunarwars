export interface PowerEdge {
  nodeA: number;  // entity ID
  nodeB: number;  // entity ID
}

interface TeamPowerGrid {
  edges: PowerEdge[];
  poweredNodes: Set<number>;
  dirty: boolean;
}

export class PowerGridState {
  private teams: TeamPowerGrid[];
  private _nextNodeId = 0;

  constructor(teamCount: number) {
    this.teams = [];
    for (let i = 0; i < teamCount; i++) {
      this.teams.push({ edges: [], poweredNodes: new Set(), dirty: true });
    }
  }

  getTeamEdges(team: number): PowerEdge[] {
    return this.teams[team].edges;
  }

  getPoweredNodes(team: number): Set<number> {
    return this.teams[team].poweredNodes;
  }

  addEdge(team: number, nodeA: number, nodeB: number): void {
    const grid = this.teams[team];
    // Avoid duplicate edges
    for (const e of grid.edges) {
      if ((e.nodeA === nodeA && e.nodeB === nodeB) ||
          (e.nodeA === nodeB && e.nodeB === nodeA)) {
        return;
      }
    }
    grid.edges.push({ nodeA, nodeB });
    grid.dirty = true;
  }

  removeEdgesForNode(team: number, nodeEntity: number): void {
    const grid = this.teams[team];
    grid.edges = grid.edges.filter(
      e => e.nodeA !== nodeEntity && e.nodeB !== nodeEntity,
    );
    grid.poweredNodes.delete(nodeEntity);
    grid.dirty = true;
  }

  isPowered(team: number, entity: number): boolean {
    return this.teams[team].poweredNodes.has(entity);
  }

  markDirty(team: number): void {
    this.teams[team].dirty = true;
  }

  isDirty(team: number): boolean {
    return this.teams[team].dirty;
  }

  /** Set the powered nodes after BFS and clear dirty flag. */
  setPoweredNodes(team: number, nodes: Set<number>): void {
    this.teams[team].poweredNodes = nodes;
    this.teams[team].dirty = false;
  }

  allocateNodeId(): number {
    return this._nextNodeId++;
  }

  /** Get all unique node entity IDs in the team's edges. */
  getNodeEntities(team: number): Set<number> {
    const result = new Set<number>();
    for (const e of this.teams[team].edges) {
      result.add(e.nodeA);
      result.add(e.nodeB);
    }
    return result;
  }

  /** Get neighbors of a node in the graph. */
  getNeighbors(team: number, nodeEntity: number): number[] {
    const neighbors: number[] = [];
    for (const e of this.teams[team].edges) {
      if (e.nodeA === nodeEntity) neighbors.push(e.nodeB);
      else if (e.nodeB === nodeEntity) neighbors.push(e.nodeA);
    }
    return neighbors;
  }

  serialize(): { teams: { edges: PowerEdge[] }[]; nextNodeId: number } {
    return {
      teams: this.teams.map(t => ({ edges: [...t.edges] })),
      nextNodeId: this._nextNodeId,
    };
  }

  deserialize(data: { teams: { edges: PowerEdge[] }[]; nextNodeId: number }): void {
    for (let i = 0; i < data.teams.length && i < this.teams.length; i++) {
      this.teams[i].edges = [...data.teams[i].edges];
      this.teams[i].dirty = true;
    }
    this._nextNodeId = data.nextNodeId;
  }
}
