import type { InputManager } from './InputManager';
import type { IsometricCamera } from '@render/IsometricCamera';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { World } from '@core/ECS';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import type { TrackState } from '@sim/logistics/TrackState';
import { BUILDING, POSITION, CONSTRUCTION, TEAM, MACRO_GRID_SIZE } from '@sim/components/ComponentTypes';
import type { TeamComponent } from '@sim/components/Team';
import type { PositionComponent } from '@sim/components/Position';
import { BuildingType, type BuildingComponent } from '@sim/components/Building';
import type { ConstructionComponent } from '@sim/components/Construction';
import { BUILDING_DEFS } from '@sim/data/BuildingData';


const ENERGY_NODE_SNAP_RANGE = 5;
const ORE_DEPOSIT_SNAP_RANGE = 5;
const BUILDING_MIN_SPACING = 5;

export class PlacementController {
  private active = false;
  private buildingType: string | null = null;
  private cursorX = 0;
  private cursorZ = 0;
  private valid = false;
  private hasMoved = false; // require at least one mouse move before confirming
  private touchGhostPlaced = false; // touch two-phase: first tap places, second confirms
  private mouseDownX = 0;
  private mouseDownY = 0;
  private onConfirm: ((type: string, x: number, z: number) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private onUpdate: ((x: number, z: number, valid: boolean) => void) | null = null;

  constructor(
    private input: InputManager,
    private camera: IsometricCamera,
    private terrainData: TerrainData,
    private world: World,
    private energyNodes: EnergyNode[],
    private oreDeposits: OreDeposit[],
    private playerTeam: number,
    private trackState?: TrackState,
  ) {
    input.onMouseMove((x, y) => {
      if (!this.active) return;

      this.hasMoved = true;
      this.updateCursor(x, y);
    });

    input.onMouseDown((x, y, button) => {
      if (!this.active) return;

      if (button === 0) {
        this.mouseDownX = x;
        this.mouseDownY = y;
      }
    });

    input.onMouseUp((x, y, button) => {
      if (!this.active) return;

      // Ignore the mouseUp that corresponds to the button click that activated us
      if (!this.hasMoved) return;
      if (button === 0 && this.valid) {
        // On touch, check if this was a drag-end (don't confirm on drag-end)
        if (this.input.isLastInputTouch()) {
          const dx = x - this.mouseDownX;
          const dy = y - this.mouseDownY;
          const wasDrag = Math.sqrt(dx * dx + dy * dy) > 10;
          if (wasDrag) return;

          // Two-phase touch: first tap places ghost, second tap confirms
          if (!this.touchGhostPlaced) {
            this.touchGhostPlaced = true;
            return;
          }
        }

        const type = this.buildingType!;
        const cx = this.cursorX;
        const cz = this.cursorZ;
        this.deactivate();
        this.onConfirm?.(type, cx, cz);
      } else if (button === 2) {
        this.deactivate();
        this.onCancel?.();
      }
    });

    input.onKeyDown((key) => {
      if (this.active && key === 'escape') {
        this.deactivate();
        this.onCancel?.();
      }
    });
  }

  private updateCursor(sx: number, sy: number): void {
    const worldPos = this.camera.screenToWorld(sx, sy);
    if (!worldPos) return;

    let wx = worldPos.x;
    let wz = worldPos.z;

    // Snap to energy node or ore deposit if building requires one
    const def = this.buildingType ? BUILDING_DEFS[this.buildingType] : null;
    if (def?.needsEnergyNode) {
      const closest = this.findClosestEnergyNode(wx, wz);
      if (closest && closest.dist < ENERGY_NODE_SNAP_RANGE) {
        wx = closest.node.x;
        wz = closest.node.z;
      }
    }
    if (def?.needsOreDeposit) {
      const closest = this.findClosestOreDeposit(wx, wz);
      if (closest && closest.dist < ORE_DEPOSIT_SNAP_RANGE) {
        wx = closest.deposit.x;
        wz = closest.deposit.z;
      }
    }

    // Snap to macro grid for unified spatial alignment
    wx = Math.round(wx / MACRO_GRID_SIZE) * MACRO_GRID_SIZE;
    wz = Math.round(wz / MACRO_GRID_SIZE) * MACRO_GRID_SIZE;

    this.cursorX = wx;
    this.cursorZ = wz;
    this.valid = this.validate(wx, wz);
    this.onUpdate?.(wx, wz, this.valid);
  }

  enterPlacementMode(type: string): void {
    this.buildingType = type;
    this.active = true;
    this.valid = false;
    this.hasMoved = false;
    this.touchGhostPlaced = false;

    // Show ghost immediately at current mouse position
    const mousePos = this.input.getMousePosition();
    this.updateCursor(mousePos.x, mousePos.y);
  }

  isActive(): boolean {
    return this.active;
  }

  getPosition(): { x: number; z: number } {
    return { x: this.cursorX, z: this.cursorZ };
  }

  isValid(): boolean {
    return this.valid;
  }

  getBuildingType(): string | null {
    return this.buildingType;
  }

  onPlacementConfirmed(cb: (type: string, x: number, z: number) => void): void {
    this.onConfirm = cb;
  }

  onPlacementCancelled(cb: () => void): void {
    this.onCancel = cb;
  }

  onPlacementUpdate(cb: (x: number, z: number, valid: boolean) => void): void {
    this.onUpdate = cb;
  }

  private deactivate(): void {
    this.active = false;
    this.buildingType = null;
    this.onUpdate?.(0, 0, false);
  }

  private validate(x: number, z: number): boolean {
    // Out of bounds
    if (x < 2 || x > 254 || z < 2 || z > 254) return false;

    // Must be on passable (flat) terrain
    if (!this.terrainData.isPassable(x, z)) return false;

    // Check building overlap
    const buildings = this.world.query(BUILDING, POSITION);
    for (const e of buildings) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      if (dx * dx + dz * dz < BUILDING_MIN_SPACING * BUILDING_MIN_SPACING) {
        return false;
      }
    }

    // Also check construction sites
    const sites = this.world.query(CONSTRUCTION, POSITION);
    for (const e of sites) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const dx = pos.x - x;
      const dz = pos.z - z;
      if (dx * dx + dz * dz < BUILDING_MIN_SPACING * BUILDING_MIN_SPACING) {
        return false;
      }
    }

    // Energy extractors must be near an energy node
    const def = this.buildingType ? BUILDING_DEFS[this.buildingType] : null;
    if (def?.needsEnergyNode) {
      const closest = this.findClosestEnergyNode(x, z);
      if (!closest || closest.dist > ENERGY_NODE_SNAP_RANGE) {
        return false;
      }
    }

    // Matter plants must be near an ore deposit
    if (def?.needsOreDeposit) {
      const closest = this.findClosestOreDeposit(x, z);
      if (!closest || closest.dist > ORE_DEPOSIT_SNAP_RANGE) {
        return false;
      }
    }

    // Supply depots: limit 1 per player
    if (this.buildingType === BuildingType.SupplyDepot) {
      let depotCount = 0;
      const allBuildings = this.world.query(BUILDING, TEAM);
      for (const e of allBuildings) {
        const t = this.world.getComponent<TeamComponent>(e, TEAM)!;
        if (t.team !== this.playerTeam) continue;
        const b = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
        if (b.buildingType === BuildingType.SupplyDepot) depotCount++;
      }
      const allSites = this.world.query(CONSTRUCTION, TEAM);
      for (const e of allSites) {
        const t = this.world.getComponent<TeamComponent>(e, TEAM)!;
        if (t.team !== this.playerTeam) continue;
        const c = this.world.getComponent<ConstructionComponent>(e, CONSTRUCTION)!;
        if (c.buildingType === BuildingType.SupplyDepot) depotCount++;
      }
      if (depotCount >= 1) return false;
    }

    // Can't build on enemy train track
    if (this.trackState) {
      const gx = Math.round(x / MACRO_GRID_SIZE);
      const gz = Math.round(z / MACRO_GRID_SIZE);
      if (this.trackState.hasEnemyTrackAtGrid(this.playerTeam, gx, gz)) return false;
    }

    return true;
  }

  private findClosestEnergyNode(x: number, z: number): { node: EnergyNode; dist: number } | null {
    // Collect occupied positions so we skip nodes that already have a building
    const buildings = this.world.query(BUILDING, POSITION);
    const occupiedSet = new Set<string>();
    for (const e of buildings) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      // Round to match energy node coords
      occupiedSet.add(`${Math.round(pos.x)},${Math.round(pos.z)}`);
    }

    let best: EnergyNode | null = null;
    let bestDist = Infinity;
    for (const node of this.energyNodes) {
      // Skip nodes that already have a building on them
      if (occupiedSet.has(`${Math.round(node.x)},${Math.round(node.z)}`)) continue;

      const dx = node.x - x;
      const dz = node.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    return best ? { node: best, dist: bestDist } : null;
  }

  private findClosestOreDeposit(x: number, z: number): { deposit: OreDeposit; dist: number } | null {
    const buildings = this.world.query(BUILDING, POSITION);
    const occupiedSet = new Set<string>();
    for (const e of buildings) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      occupiedSet.add(`${Math.round(pos.x)},${Math.round(pos.z)}`);
    }

    let best: OreDeposit | null = null;
    let bestDist = Infinity;
    for (const deposit of this.oreDeposits) {
      if (occupiedSet.has(`${Math.round(deposit.x)},${Math.round(deposit.z)}`)) continue;

      const dx = deposit.x - x;
      const dz = deposit.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        best = deposit;
      }
    }
    return best ? { deposit: best, dist: bestDist } : null;
  }
}
