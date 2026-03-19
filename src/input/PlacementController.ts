import type { InputManager } from './InputManager';
import type { IsometricCamera } from '@render/IsometricCamera';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { World } from '@core/ECS';
import type { EnergyNode, OreDeposit } from '@sim/terrain/MapFeatures';
import { BUILDING, POSITION, CONSTRUCTION, RENDERABLE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import { BuildingType, type BuildingComponent } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';


const ENERGY_NODE_SNAP_RANGE = 5;
const ORE_DEPOSIT_SNAP_RANGE = 5;
const BUILDING_MIN_SPACING = 5;

const WALL_SEGMENT_LENGTH = 3.0; // 20 voxels * 0.15 wu
const WALL_CORNER_SIZE = 0.75; // 5 voxels * 0.15 wu
const WALL_JUNCTION_OFFSET = WALL_SEGMENT_LENGTH / 2 + WALL_CORNER_SIZE / 2; // 1.875 wu — center-to-center from last wall to corner
const WALL_OVERLAP_DIST_SQ = 1.5 * 1.5; // min center-to-center distance for wall overlap

export interface WallSegment {
  x: number;
  z: number;
  meshType: string;
  valid: boolean;
}

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

  // Wall placement state
  private wallMode = false;
  private wallCorners: { x: number; z: number }[] = []; // corner points (first = anchor)
  private wallAxis: 'x' | 'z' | null = null; // current leg direction
  private wallSegments: WallSegment[] = [];
  private wallDragPhase: 'idle' | 'dragging' | 'preview' = 'idle';
  private wallMaxSegments: () => number = () => Infinity;
  private onWallConfirm: ((segments: { x: number; z: number; meshType: string }[]) => void) | null = null;
  private onWallCancel: (() => void) | null = null;
  private onWallUpdate: ((segments: WallSegment[]) => void) | null = null;

  constructor(
    private input: InputManager,
    private camera: IsometricCamera,
    private terrainData: TerrainData,
    private world: World,
    private energyNodes: EnergyNode[],
    private oreDeposits: OreDeposit[],
    private playerTeam: number,
  ) {
    input.onMouseMove((x, y) => {
      if (!this.active) return;

      if (this.wallMode) {
        if (this.wallDragPhase === 'dragging') {
          this.updateWallCursor(x, y);
        }
        return;
      }

      this.hasMoved = true;
      this.updateCursor(x, y);
    });

    input.onMouseDown((x, y, button) => {
      if (!this.active) return;

      if (this.wallMode) {
        if (button === 0) {
          if (this.wallDragPhase === 'idle') {
            const worldPos = this.camera.screenToWorld(x, y);
            if (worldPos) {
              const snap = this.snapToExistingWall(worldPos.x, worldPos.z);
              this.wallCorners = [{ x: snap.x, z: snap.z }];
              this.wallAxis = snap.axis;
              this.wallDragPhase = 'dragging';
              this.updateWallCursor(x, y);
            }
          } else if (this.wallDragPhase === 'preview') {
            // Confirm placement
            const validSegments = this.wallSegments.filter(s => s.valid);
            if (validSegments.length > 0) {
              const segments = validSegments.map(s => ({ x: s.x, z: s.z, meshType: s.meshType }));
              this.deactivateWall();
              this.onWallConfirm?.(segments);
            }
          }
        } else if (button === 2) {
          this.deactivateWall();
          this.onWallCancel?.();
        }
        return;
      }

      if (button === 0) {
        this.mouseDownX = x;
        this.mouseDownY = y;
      }
    });

    input.onMouseUp((x, y, button) => {
      if (!this.active) return;

      if (this.wallMode) {
        if (button === 0 && this.wallDragPhase === 'dragging') {
          if (this.wallSegments.length > 0) {
            this.wallDragPhase = 'preview';
          } else {
            this.deactivateWall();
            this.onWallCancel?.();
          }
        }
        return;
      }

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
        if (this.wallMode) {
          this.deactivateWall();
          this.onWallCancel?.();
        } else {
          this.deactivate();
          this.onCancel?.();
        }
      }
    });
  }

  private updateCursor(sx: number, sy: number): void {
    const worldPos = this.camera.screenToWorld(sx, sy);
    if (!worldPos) return;

    // Snap to integer grid (1 world unit = 1 terrain tile)
    let wx = Math.round(worldPos.x);
    let wz = Math.round(worldPos.z);

    // Snap to energy node or ore deposit if building requires one (overrides grid)
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

  // --- Wall placement methods ---

  enterWallPlacementMode(): void {
    this.wallMode = true;
    this.active = true;
    this.wallCorners = [];
    this.wallAxis = null;
    this.wallSegments = [];
    this.wallDragPhase = 'idle';
  }

  onWallPlacementConfirmed(cb: (segments: { x: number; z: number; meshType: string }[]) => void): void {
    this.onWallConfirm = cb;
  }

  onWallPlacementCancelled(cb: () => void): void {
    this.onWallCancel = cb;
  }

  onWallPlacementUpdate(cb: (segments: WallSegment[]) => void): void {
    this.onWallUpdate = cb;
  }

  setWallMaxSegments(fn: () => number): void {
    this.wallMaxSegments = fn;
  }

  private deactivateWall(): void {
    this.wallMode = false;
    this.active = false;
    this.wallCorners = [];
    this.wallAxis = null;
    this.wallSegments = [];
    this.wallDragPhase = 'idle';
    this.onWallUpdate?.([]);
  }

  private updateWallCursor(sx: number, sy: number): void {
    const worldPos = this.camera.screenToWorld(sx, sy);
    if (!worldPos || this.wallCorners.length === 0) return;

    // Detect direction changes and add corners
    this.processWallTurns(worldPos.x, worldPos.z);

    // Build all segments from corners + current leg to cursor
    this.wallSegments = this.buildWallSegments(worldPos.x, worldPos.z);
    this.onWallUpdate?.(this.wallSegments);
  }

  private processWallTurns(cursorX: number, cursorZ: number): void {
    const TURN_THRESHOLD = WALL_SEGMENT_LENGTH * 0.7;
    const SEG = WALL_SEGMENT_LENGTH;
    const J = WALL_JUNCTION_OFFSET; // 1.875

    for (let iter = 0; iter < 20; iter++) {
      if (this.wallCorners.length === 0) return;
      const last = this.wallCorners[this.wallCorners.length - 1];
      const dx = cursorX - last.x;
      const dz = cursorZ - last.z;

      // Determine initial axis from first significant movement
      if (this.wallAxis === null) {
        if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) >= SEG * 0.5) {
          this.wallAxis = 'x';
        } else if (Math.abs(dz) >= SEG * 0.5) {
          this.wallAxis = 'z';
        }
        return;
      }

      // Check for backtracking: cursor moved significantly back past the last corner
      if (this.wallCorners.length >= 2) {
        const prev = this.wallCorners[this.wallCorners.length - 2];
        const incomingAxis = (Math.abs(last.x - prev.x) >= Math.abs(last.z - prev.z)) ? 'x' : 'z';
        const incomingDir = incomingAxis === 'x'
          ? Math.sign(last.x - prev.x)
          : Math.sign(last.z - prev.z);
        const backDisp = incomingAxis === 'x' ? (cursorX - last.x) : (cursorZ - last.z);

        if (incomingDir !== 0 && Math.sign(backDisp) === -incomingDir && Math.abs(backDisp) > SEG * 0.5) {
          // Cursor moved backward past this corner — pop it
          this.wallCorners.pop();
          this.wallAxis = incomingAxis;
          continue;
        }
      }

      // Check for direction change (turn)
      const isFirstLeg = this.wallCorners.length === 1;
      const axisDisp = this.wallAxis === 'x' ? dx : dz;
      const crossDisp = this.wallAxis === 'x' ? dz : dx;

      if (Math.abs(crossDisp) > TURN_THRESHOLD) {
        const dir = Math.sign(axisDisp) || 1;

        // Compute how many wall segments fit + the corner piece
        let n: number;
        let cornerAxisVal: number;
        if (isFirstLeg) {
          // From anchor: walls at anchor, anchor+SEG, ...
          // Corner at: anchor + (n-1)*SEG + J  (flush with last wall edge)
          // Need: (n-1)*SEG + J <= |axisDisp|
          if (Math.abs(axisDisp) < J) break; // not enough room
          n = Math.floor((Math.abs(axisDisp) - J) / SEG) + 1;
          const anchorVal = this.wallAxis === 'x' ? last.x : last.z;
          cornerAxisVal = anchorVal + ((n - 1) * SEG + J) * dir;
        } else {
          // From a corner: first wall at corner + J, then +SEG each
          // Next corner at: corner + J + (n-1)*SEG + J = corner + 2J + (n-1)*SEG
          // Need: 2J + (n-1)*SEG <= |axisDisp|
          if (Math.abs(axisDisp) < 2 * J) break; // not enough room
          n = Math.floor((Math.abs(axisDisp) - 2 * J) / SEG) + 1;
          const cornerVal = this.wallAxis === 'x' ? last.x : last.z;
          cornerAxisVal = cornerVal + (2 * J + (n - 1) * SEG) * dir;
        }

        if (n > 0) {
          if (this.wallAxis === 'x') {
            this.wallCorners.push({ x: cornerAxisVal, z: last.z });
          } else {
            this.wallCorners.push({ x: last.x, z: cornerAxisVal });
          }
          this.wallAxis = this.wallAxis === 'x' ? 'z' : 'x';
          continue;
        }
      }
      break;
    }
  }

  private buildWallSegments(cursorX: number, cursorZ: number): WallSegment[] {
    const segments: WallSegment[] = [];
    const SEG = WALL_SEGMENT_LENGTH;
    const J = WALL_JUNCTION_OFFSET; // 1.875
    const maxSegs = this.wallMaxSegments();

    // Build segments for completed legs (between consecutive corners)
    for (let c = 0; c < this.wallCorners.length - 1; c++) {
      const from = this.wallCorners[c];
      const to = this.wallCorners[c + 1];
      const isFirstLeg = c === 0;
      const legDx = to.x - from.x;
      const legDz = to.z - from.z;
      const axis: 'x' | 'z' = Math.abs(legDx) >= Math.abs(legDz) ? 'x' : 'z';
      const dir = axis === 'x' ? (legDx > 0 ? 1 : -1) : (legDz > 0 ? 1 : -1);
      const meshType = axis === 'x' ? 'wall_x' : 'wall_z';

      // Compute wall start position and count
      let wallStart: number; // center of first wall on this leg
      let n: number; // number of wall segments
      if (isFirstLeg) {
        wallStart = axis === 'x' ? from.x : from.z;
        const totalDist = Math.abs(axis === 'x' ? legDx : legDz);
        n = Math.round((totalDist - J) / SEG) + 1;
      } else {
        wallStart = (axis === 'x' ? from.x : from.z) + J * dir;
        const totalDist = Math.abs(axis === 'x' ? legDx : legDz);
        n = Math.round((totalDist - 2 * J) / SEG) + 1;
      }

      // Place wall segments
      for (let i = 0; i < n && segments.length < maxSegs; i++) {
        const val = wallStart + i * SEG * dir;
        const wx = axis === 'x' ? val : from.x;
        const wz = axis === 'z' ? val : from.z;
        segments.push({ x: wx, z: wz, meshType, valid: this.validateWallSegment(wx, wz) });
      }

      // Corner piece at the turn point
      if (segments.length < maxSegs) {
        segments.push({ x: to.x, z: to.z, meshType: 'wall_corner', valid: this.validateWallSegment(to.x, to.z) });
      }
    }

    // Current (unfinished) leg from last corner/anchor to cursor
    if (segments.length < maxSegs) {
      const last = this.wallCorners[this.wallCorners.length - 1];
      const isFirstLeg = this.wallCorners.length === 1;
      const dx = cursorX - last.x;
      const dz = cursorZ - last.z;
      const axis = this.wallAxis ?? (Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z');
      const disp = axis === 'x' ? dx : dz;
      const dir = Math.sign(disp) || 1;
      const meshType = axis === 'x' ? 'wall_x' : 'wall_z';

      let wallStart: number;
      if (isFirstLeg) {
        wallStart = axis === 'x' ? last.x : last.z;
      } else {
        wallStart = (axis === 'x' ? last.x : last.z) + J * dir;
      }

      // How many walls fit from wallStart to cursor
      const dispFromStart = (axis === 'x' ? cursorX : cursorZ) - wallStart;
      const forwardDisp = dispFromStart * dir; // positive = forward
      if (forwardDisp >= 0) {
        const n = Math.floor(forwardDisp / SEG) + 1;
        for (let i = 0; i < n && segments.length < maxSegs; i++) {
          const val = wallStart + i * SEG * dir;
          const wx = axis === 'x' ? val : last.x;
          const wz = axis === 'z' ? val : last.z;
          segments.push({ x: wx, z: wz, meshType, valid: this.validateWallSegment(wx, wz) });
        }
      }
    }

    return segments;
  }

  private snapToExistingWall(wx: number, wz: number): { x: number; z: number; axis: 'x' | 'z' | null } {
    const SNAP_RANGE = 2.5;
    const SEG = WALL_SEGMENT_LENGTH;
    const C = WALL_CORNER_SIZE;

    let bestDist = SNAP_RANGE;
    let bestSnap: { x: number; z: number; axis: 'x' | 'z' } | null = null;

    // Check all wall buildings (completed and under construction)
    const entities = this.world.query(BUILDING, POSITION);
    for (const e of entities) {
      const building = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.Wall) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const renderable = this.world.getComponent<RenderableComponent>(e, RENDERABLE);
      const meshType = renderable?.meshType ?? 'wall_x';

      // Compute attachment ends: edge midpoints where a new wall could connect
      const ends: { ex: number; ez: number; axis: 'x' | 'z'; dir: number }[] = [];
      if (meshType === 'wall_x') {
        ends.push({ ex: pos.x + SEG / 2, ez: pos.z, axis: 'x', dir: 1 });
        ends.push({ ex: pos.x - SEG / 2, ez: pos.z, axis: 'x', dir: -1 });
      } else if (meshType === 'wall_z') {
        ends.push({ ex: pos.x, ez: pos.z + SEG / 2, axis: 'z', dir: 1 });
        ends.push({ ex: pos.x, ez: pos.z - SEG / 2, axis: 'z', dir: -1 });
      } else if (meshType === 'wall_corner') {
        ends.push({ ex: pos.x + C / 2, ez: pos.z, axis: 'x', dir: 1 });
        ends.push({ ex: pos.x - C / 2, ez: pos.z, axis: 'x', dir: -1 });
        ends.push({ ex: pos.x, ez: pos.z + C / 2, axis: 'z', dir: 1 });
        ends.push({ ex: pos.x, ez: pos.z - C / 2, axis: 'z', dir: -1 });
      }

      for (const end of ends) {
        const dx = wx - end.ex;
        const dz = wz - end.ez;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < bestDist) {
          bestDist = dist;
          // Snap anchor = center of first new wall segment, flush with this end
          if (end.axis === 'x') {
            bestSnap = { x: end.ex + (SEG / 2) * end.dir, z: end.ez, axis: 'x' };
          } else {
            bestSnap = { x: end.ex, z: end.ez + (SEG / 2) * end.dir, axis: 'z' };
          }
        }
      }
    }

    return bestSnap ?? { x: wx, z: wz, axis: null };
  }

  private validateWallSegment(x: number, z: number): boolean {
    if (x < 2 || x > 254 || z < 2 || z > 254) return false;
    if (!this.terrainData.isPassable(x, z)) return false;

    // Check overlap with existing buildings/construction sites
    const buildings = this.world.query(BUILDING, POSITION);
    for (const e of buildings) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const ddx = pos.x - x;
      const ddz = pos.z - z;
      if (ddx * ddx + ddz * ddz < WALL_OVERLAP_DIST_SQ) return false;
    }

    const sites = this.world.query(CONSTRUCTION, POSITION);
    for (const e of sites) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const ddx = pos.x - x;
      const ddz = pos.z - z;
      if (ddx * ddx + ddz * ddz < WALL_OVERLAP_DIST_SQ) return false;
    }

    return true;
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
