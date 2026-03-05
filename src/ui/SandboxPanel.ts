import * as THREE from 'three';
import type { InputManager } from '@input/InputManager';
import type { IsometricCamera } from '@render/IsometricCamera';
import type { GhostBuildingRenderer } from '@render/GhostBuildingRenderer';
import type { WallSegment } from '@input/PlacementController';
import type { World, Entity } from '@core/ECS';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { POSITION, SELECTABLE, TEAM, HEALTH, VOXEL_STATE, BUILDING, RENDERABLE, CONSTRUCTION } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { RenderableComponent } from '@sim/components/Renderable';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { VoxelStateComponent } from '@sim/components/VoxelState';
import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType, type BuildingComponent } from '@sim/components/Building';

const WALL_SEGMENT_LENGTH = 3.0;
const WALL_CORNER_SIZE = 0.75;
const WALL_JUNCTION_OFFSET = WALL_SEGMENT_LENGTH / 2 + WALL_CORNER_SIZE / 2;
const WALL_OVERLAP_DIST_SQ = 1.5 * 1.5;

type SandboxMode = 'editor' | 'play';

interface PaletteItem {
  label: string;
  kind: 'unit' | 'building';
  unitCategory?: UnitCategory;
  buildingType?: BuildingType;
}

const PALETTE_UNITS: PaletteItem[] = [
  { label: 'Combat Drone', kind: 'unit', unitCategory: UnitCategory.CombatDrone },
  { label: 'Assault Platform', kind: 'unit', unitCategory: UnitCategory.AssaultPlatform },
  { label: 'Aerial Drone', kind: 'unit', unitCategory: UnitCategory.AerialDrone },
  { label: 'Worker Drone', kind: 'unit', unitCategory: UnitCategory.WorkerDrone },
];

const PALETTE_BUILDINGS: PaletteItem[] = [
  { label: 'HQ', kind: 'building', buildingType: BuildingType.HQ },
  { label: 'Energy Extractor', kind: 'building', buildingType: BuildingType.EnergyExtractor },
  { label: 'Matter Plant', kind: 'building', buildingType: BuildingType.MatterPlant },
  { label: 'Supply Depot', kind: 'building', buildingType: BuildingType.SupplyDepot },
  { label: 'Drone Factory', kind: 'building', buildingType: BuildingType.DroneFactory },
  { label: 'Wall', kind: 'building', buildingType: BuildingType.Wall },
];

export class SandboxPanel {
  private container: HTMLDivElement;
  private mode: SandboxMode = 'editor';
  private selectedTeam = 0;
  private selectedPalette: PaletteItem | null = null;
  private draggingEntity: Entity | null = null;

  // UI sections
  private editorSection: HTMLDivElement;
  private playSection: HTMLDivElement;
  private teamButtons: HTMLButtonElement[] = [];
  private paletteButtons: HTMLButtonElement[] = [];
  private speedButtons: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement | null = null;
  private currentSpeed = 1;

  // Tools section (always visible)
  private toolsSection: HTMLDivElement;

  // 3D helpers
  private axesGroup: THREE.Group | null = null;
  private lightHelper: THREE.DirectionalLightHelper | null = null;

  // Light parameters (spherical coords around map center)
  private lightAzimuth = 167;
  private lightElevation = 51;
  private lightDistance = 94;

  // Wall drag state
  private wallDragging = false;
  private wallAnchor: { x: number; z: number } | null = null;
  private wallLegAxis: 'x' | 'z' | null = null;
  private wallLegDir: 1 | -1 = 1;
  private wallCommitted: WallSegment[] = [];
  private wallLive: WallSegment[] = [];

  // Callbacks set by main.ts
  onPlay?: () => void;
  onPause?: () => void;
  onSpeedChange?: (scale: number) => void;
  onSelectAll?: () => void;
  onClearAll?: () => void;
  onReset?: () => void;
  onGiveResources?: () => void;
  onSpawnWallSegments?: (segments: { x: number; z: number; meshType: string }[], team: number) => void;

  constructor(
    private world: World,
    private terrainData: TerrainData,
    private isoCamera: IsometricCamera,
    private inputManager: InputManager,
    private spawnUnit: (x: number, z: number, team: number, category: UnitCategory) => number,
    private spawnBuilding: (x: number, z: number, team: number, type: BuildingType) => number,
    private ghostRenderer: GhostBuildingRenderer,
    private scene: THREE.Scene,
    private dirLight: THREE.DirectionalLight,
    private ambientLight: THREE.AmbientLight,
  ) {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      top: 10px;
      left: 10px;
      width: 200px;
      background: rgba(0, 0, 0, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      padding: 12px;
      color: #ddd;
      font-family: monospace;
      font-size: 13px;
      z-index: 30;
      pointer-events: auto;
      user-select: none;
      max-height: calc(100vh - 20px);
      overflow-y: auto;
    `;

    // Editor section
    this.editorSection = document.createElement('div');
    this.buildEditorUI();
    this.container.appendChild(this.editorSection);

    // Play section (hidden initially)
    this.playSection = document.createElement('div');
    this.playSection.style.display = 'none';
    this.buildPlayUI();
    this.container.appendChild(this.playSection);

    // Tools section (always visible, below mode-specific sections)
    this.toolsSection = document.createElement('div');
    this.buildToolsUI();
    this.container.appendChild(this.toolsSection);

    // 3D axis helper + light direction helper
    this.setupAxes();
    this.setupLightHelper();

    // Wire mouse input for editor
    this.wireEditorInput();
    this.wireKeyboardInput();
  }

  private buildEditorUI(): void {
    // Title
    const title = document.createElement('div');
    title.textContent = 'SANDBOX EDITOR';
    title.style.cssText = 'text-align:center;font-weight:bold;margin-bottom:10px;color:#fff;font-size:14px;letter-spacing:1px;';
    this.editorSection.appendChild(title);

    // Team selector
    this.editorSection.appendChild(this.createLabel('Team'));
    const teamRow = document.createElement('div');
    teamRow.style.cssText = 'display:flex;gap:4px;margin-bottom:10px;';
    const teamLabels = ['Blue', 'Red'];
    const teamColors = ['#4488ff', '#ff4444'];
    for (let i = 0; i < 2; i++) {
      const btn = this.createPanelButton(teamLabels[i], () => {
        this.selectedTeam = i;
        this.highlightTeam();
      });
      btn.dataset.teamColor = teamColors[i];
      this.teamButtons.push(btn);
      teamRow.appendChild(btn);
    }
    this.editorSection.appendChild(teamRow);
    this.highlightTeam();

    // Units section
    this.editorSection.appendChild(this.createLabel('Units'));
    for (const item of PALETTE_UNITS) {
      const btn = this.createPanelButton(item.label, () => {
        this.selectPalette(item, btn);
      });
      btn.style.width = '100%';
      btn.style.marginBottom = '3px';
      this.paletteButtons.push(btn);
      this.editorSection.appendChild(btn);
    }

    // Buildings section
    this.editorSection.appendChild(this.createLabel('Buildings'));
    for (const item of PALETTE_BUILDINGS) {
      const btn = this.createPanelButton(item.label, () => {
        this.selectPalette(item, btn);
      });
      btn.style.width = '100%';
      btn.style.marginBottom = '3px';
      this.paletteButtons.push(btn);
      this.editorSection.appendChild(btn);
    }

    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:#555;margin:10px 0;';
    this.editorSection.appendChild(sep);

    // Controls row
    const controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';

    const playBtn = this.createPanelButton('> PLAY', () => {
      this.enterPlayMode();
    });
    playBtn.style.cssText += 'flex:1;background:#2a5a2a;color:#aaffaa;border-color:#4a8a4a;font-weight:bold;';
    playBtn.addEventListener('mouseenter', () => { playBtn.style.background = '#3a6a3a'; });
    playBtn.addEventListener('mouseleave', () => { playBtn.style.background = '#2a5a2a'; });
    controlRow.appendChild(playBtn);

    const selectAllBtn = this.createPanelButton('Select All', () => {
      this.onSelectAll?.();
    });
    selectAllBtn.style.flex = '1';
    controlRow.appendChild(selectAllBtn);

    this.editorSection.appendChild(controlRow);

    const clearBtn = this.createPanelButton('Clear All', () => {
      this.onClearAll?.();
    });
    clearBtn.style.cssText += 'width:100%;background:#5a2a2a;color:#ffaaaa;border-color:#8a4a4a;';
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.background = '#6a3a3a'; });
    clearBtn.addEventListener('mouseleave', () => { clearBtn.style.background = '#5a2a2a'; });
    this.editorSection.appendChild(clearBtn);
  }

  private buildPlayUI(): void {
    // Title
    const title = document.createElement('div');
    title.textContent = 'SANDBOX - PLAYING';
    title.style.cssText = 'text-align:center;font-weight:bold;margin-bottom:10px;color:#aaffaa;font-size:14px;letter-spacing:1px;';
    this.playSection.appendChild(title);

    // Speed controls
    this.playSection.appendChild(this.createLabel('Speed'));
    const speedRow = document.createElement('div');
    speedRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;';
    const speeds = [1, 2, 4, 8];
    for (const s of speeds) {
      const btn = this.createPanelButton(`${s}x`, () => {
        this.currentSpeed = s;
        this.highlightSpeed();
        this.onSpeedChange?.(s);
      });
      this.speedButtons.push(btn);
      speedRow.appendChild(btn);
    }
    this.playSection.appendChild(speedRow);
    this.highlightSpeed();

    // Tools row
    this.playSection.appendChild(this.createLabel('Tools'));
    const toolRow = document.createElement('div');
    toolRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;';

    const resBtn = this.createPanelButton('+Resources', () => {
      this.onGiveResources?.();
    });
    resBtn.style.cssText += 'flex:1;background:#2a4a5a;color:#aaddff;border-color:#4a7a8a;';
    resBtn.addEventListener('mouseenter', () => { resBtn.style.background = '#3a5a6a'; });
    resBtn.addEventListener('mouseleave', () => { resBtn.style.background = '#2a4a5a'; });
    toolRow.appendChild(resBtn);

    const dmgBtn = this.createPanelButton('Damage 50%', () => {
      this.damageSelected();
    });
    dmgBtn.style.cssText += 'flex:1;background:#5a3a2a;color:#ffbbaa;border-color:#8a5a4a;';
    dmgBtn.addEventListener('mouseenter', () => { dmgBtn.style.background = '#6a4a3a'; });
    dmgBtn.addEventListener('mouseleave', () => { dmgBtn.style.background = '#5a3a2a'; });
    toolRow.appendChild(dmgBtn);

    this.playSection.appendChild(toolRow);

    // Pause / Select All row
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';

    this.pauseBtn = this.createPanelButton('|| Pause', () => {
      this.onPause?.();
    });
    this.pauseBtn.style.flex = '1';
    row2.appendChild(this.pauseBtn);

    const selectAllBtn = this.createPanelButton('Select All', () => {
      this.onSelectAll?.();
    });
    selectAllBtn.style.flex = '1';
    row2.appendChild(selectAllBtn);

    this.playSection.appendChild(row2);

    // Reset button
    const resetBtn = this.createPanelButton('Reset', () => {
      this.onReset?.();
    });
    resetBtn.style.cssText += 'width:100%;background:#5a3a2a;color:#ffccaa;border-color:#8a5a4a;';
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.background = '#6a4a3a'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.background = '#5a3a2a'; });
    this.playSection.appendChild(resetBtn);
  }

  private selectPalette(item: PaletteItem, btn: HTMLButtonElement): void {
    if (this.selectedPalette === item) {
      // Deselect
      this.selectedPalette = null;
      this.highlightPalette();
      return;
    }
    this.selectedPalette = item;
    this.highlightPalette();
  }

  private highlightPalette(): void {
    const allItems = [...PALETTE_UNITS, ...PALETTE_BUILDINGS];
    for (let i = 0; i < this.paletteButtons.length; i++) {
      const btn = this.paletteButtons[i];
      const active = this.selectedPalette === allItems[i];
      btn.style.background = active ? '#3a5a8a' : '#333';
      btn.style.color = active ? '#fff' : '#ccc';
      btn.style.borderColor = active ? '#5a8acc' : '#555';
    }
  }

  private highlightTeam(): void {
    for (let i = 0; i < this.teamButtons.length; i++) {
      const active = i === this.selectedTeam;
      const btn = this.teamButtons[i];
      const color = btn.dataset.teamColor ?? '#fff';
      if (active) {
        btn.style.background = color;
        btn.style.color = '#fff';
        btn.style.borderColor = color;
      } else {
        btn.style.background = '#333';
        btn.style.color = color;
        btn.style.borderColor = '#555';
      }
    }
  }

  private highlightSpeed(): void {
    const speeds = [1, 2, 4, 8];
    for (let i = 0; i < this.speedButtons.length; i++) {
      const active = speeds[i] === this.currentSpeed;
      const btn = this.speedButtons[i];
      btn.style.background = active ? '#5a5' : '#333';
      btn.style.color = active ? '#fff' : '#ccc';
      btn.style.borderColor = active ? '#6b6' : '#555';
    }
  }

  private enterPlayMode(): void {
    this.mode = 'play';
    this.selectedPalette = null;
    this.draggingEntity = null;
    this.editorSection.style.display = 'none';
    this.playSection.style.display = 'block';
    this.onPlay?.();
  }

  private wireEditorInput(): void {
    this.inputManager.onMouseDown((x, y, button) => {
      if (this.mode !== 'editor') return;
      if (this.isOverPanel(x, y)) return;

      if (button === 0) {
        // Wall drag: start
        if (this.selectedPalette?.buildingType === BuildingType.Wall) {
          const worldPos = this.isoCamera.screenToWorld(x, y);
          if (!worldPos) return;
          const snap = this.snapToExistingWall(worldPos.x, worldPos.z);
          this.wallAnchor = { x: snap.x, z: snap.z };
          this.wallLegAxis = snap.axis;
          this.wallLegDir = 1;
          this.wallDragging = true;
          this.wallCommitted = [];
          this.wallLive = [];
          return;
        }

        if (this.selectedPalette) {
          const worldPos = this.isoCamera.screenToWorld(x, y);
          if (!worldPos) return;
          const wx = worldPos.x;
          const wz = worldPos.z;
          if (wx < 0 || wx > 256 || wz < 0 || wz > 256) return;

          if (this.selectedPalette.kind === 'unit' && this.selectedPalette.unitCategory) {
            this.spawnUnit(wx, wz, this.selectedTeam, this.selectedPalette.unitCategory);
          } else if (this.selectedPalette.kind === 'building' && this.selectedPalette.buildingType != null) {
            this.spawnBuilding(wx, wz, this.selectedTeam, this.selectedPalette.buildingType);
          }
        } else {
          const picked = this.pickEntity(x, y);
          if (picked !== null) {
            this.draggingEntity = picked;
          }
        }
      } else if (button === 2) {
        if (this.wallDragging) {
          this.wallDragging = false;
          this.wallAnchor = null;
          this.wallCommitted = [];
          this.wallLive = [];
          this.ghostRenderer.hideWall();
          return;
        }
        this.selectedPalette = null;
        this.highlightPalette();
      }
    });

    this.inputManager.onMouseMove((x, y) => {
      if (this.mode !== 'editor') return;

      if (this.wallDragging) {
        this.updateWallDrag(x, y);
        return;
      }

      if (this.draggingEntity === null) return;
      if (!this.world.hasComponent(this.draggingEntity, POSITION)) {
        this.draggingEntity = null;
        return;
      }

      const worldPos = this.isoCamera.screenToWorld(x, y);
      if (!worldPos) return;

      const pos = this.world.getComponent<PositionComponent>(this.draggingEntity, POSITION)!;
      pos.x = worldPos.x;
      pos.z = worldPos.z;
      pos.y = this.terrainData.getHeight(worldPos.x, worldPos.z) + 0.1;
      pos.prevX = pos.x;
      pos.prevY = pos.y;
      pos.prevZ = pos.z;
    });

    this.inputManager.onMouseUp((_x, _y, button) => {
      if (button === 0) {
        if (this.wallDragging) {
          this.wallDragging = false;
          const allSegments = [...this.wallCommitted, ...this.wallLive];
          const validSegments = allSegments.filter(s => s.valid);
          if (validSegments.length > 0) {
            this.onSpawnWallSegments?.(
              validSegments.map(s => ({ x: s.x, z: s.z, meshType: s.meshType })),
              this.selectedTeam,
            );
          }
          this.wallAnchor = null;
          this.wallCommitted = [];
          this.wallLive = [];
          this.ghostRenderer.hideWall();
          return;
        }
        this.draggingEntity = null;
      }
    });
  }

  private wireKeyboardInput(): void {
    // Listen for keyboard events via window (not through InputManager)
    // since InputManager lowercases keys and doesn't expose modifiers
    window.addEventListener('keydown', (e) => {
      // Ctrl+A: select all
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.onSelectAll?.();
        return;
      }

      // Delete: remove selected entities
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelected();
        return;
      }

      // Escape: cancel wall drag or palette selection
      if (e.key === 'Escape') {
        if (this.wallDragging) {
          this.wallDragging = false;
          this.wallAnchor = null;
          this.wallCommitted = [];
          this.wallLive = [];
          this.ghostRenderer.hideWall();
          return;
        }
        this.selectedPalette = null;
        this.highlightPalette();
      }
    });
  }

  private damageSelected(): void {
    const selectables = this.world.query(SELECTABLE, HEALTH);
    for (const e of selectables) {
      const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      health.current = Math.max(1, health.current * 0.5);

      // Update voxel destruction to match new HP
      const voxelState = this.world.getComponent<VoxelStateComponent>(e, VOXEL_STATE);
      if (voxelState) {
        const hpFraction = health.current / health.max;
        const targetDestroyed = Math.floor(voxelState.totalVoxels * (1 - hpFraction));
        if (targetDestroyed > voxelState.destroyedCount) {
          let toDestroy = targetDestroyed - voxelState.destroyedCount;
          for (let byteIdx = 0; byteIdx < voxelState.destroyed.length && toDestroy > 0; byteIdx++) {
            if (voxelState.destroyed[byteIdx] === 0xFF) continue;
            for (let bitIdx = 0; bitIdx < 8 && toDestroy > 0; bitIdx++) {
              if (!(voxelState.destroyed[byteIdx] & (1 << bitIdx))) {
                voxelState.destroyed[byteIdx] |= (1 << bitIdx);
                voxelState.destroyedCount++;
                toDestroy--;
              }
            }
          }
          voxelState.dirty = true;
        }
      }
    }
  }

  private deleteSelected(): void {
    const selectables = this.world.query(SELECTABLE);
    const toDelete: Entity[] = [];
    for (const e of selectables) {
      const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (sel.selected) {
        toDelete.push(e);
      }
    }
    for (const e of toDelete) {
      this.world.destroyEntity(e);
    }
  }

  // --- Wall placement helpers (mirrors PlacementController logic) ---

  private updateWallDrag(sx: number, sy: number): void {
    const worldPos = this.isoCamera.screenToWorld(sx, sy);
    if (!worldPos || !this.wallAnchor) return;

    const SEG = WALL_SEGMENT_LENGTH;
    const J = WALL_JUNCTION_OFFSET;
    const AXIS_LOCK_THRESHOLD = SEG * 0.3;
    const TURN_THRESHOLD = SEG; // must move a full segment width sideways to turn

    const anchor = this.wallAnchor;
    const dx = worldPos.x - anchor.x;
    const dz = worldPos.z - anchor.z;

    // Axis locking: determine axis from dominant displacement
    if (this.wallLegAxis === null) {
      if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) >= AXIS_LOCK_THRESHOLD) {
        this.wallLegAxis = 'x';
        this.wallLegDir = dx > 0 ? 1 : -1;
      } else if (Math.abs(dz) >= AXIS_LOCK_THRESHOLD) {
        this.wallLegAxis = 'z';
        this.wallLegDir = dz > 0 ? 1 : -1;
      } else {
        this.wallLive = [];
        this.ghostRenderer.updateWall([...this.wallCommitted]);
        return;
      }
    }

    const axis = this.wallLegAxis;
    const dir = this.wallLegDir;
    const forwardDisp = axis === 'x' ? dx * dir : dz * dir;
    const crossDisp = axis === 'x' ? dz : dx;

    // Turn detection: commit current leg and start new one
    // Cross must exceed a full segment width, AND either be dominant (early drag) or large enough absolutely (long drag)
    if (Math.abs(crossDisp) > TURN_THRESHOLD && (Math.abs(crossDisp) > Math.abs(forwardDisp) * 2 || Math.abs(crossDisp) > SEG * 2)) {
      if (forwardDisp >= J) {
        // Normal turn: enough forward room for junction
        this.commitCurrentLeg(forwardDisp);
      } else {
        // Not enough forward room — just switch axis at current anchor (no corner piece)
        // This handles the case where user drags mostly perpendicular immediately
      }
      // Start new leg from anchor/corner position
      const newDir: 1 | -1 = crossDisp > 0 ? 1 : -1;
      this.wallLegAxis = axis === 'x' ? 'z' : 'x';
      this.wallLegDir = newDir;
      // Recompute live from new anchor
      const newDx = worldPos.x - this.wallAnchor.x;
      const newDz = worldPos.z - this.wallAnchor.z;
      const newForward = this.wallLegAxis === 'x' ? newDx * this.wallLegDir : newDz * this.wallLegDir;
      this.wallLive = this.computeLiveSegments(newForward);
    } else {
      this.wallLive = this.computeLiveSegments(forwardDisp);
    }

    this.ghostRenderer.updateWall([...this.wallCommitted, ...this.wallLive]);
  }

  private commitCurrentLeg(forwardDisp: number): void {
    if (!this.wallAnchor || !this.wallLegAxis) return;

    const SEG = WALL_SEGMENT_LENGTH;
    const J = WALL_JUNCTION_OFFSET;
    const axis = this.wallLegAxis;
    const dir = this.wallLegDir;
    const anchor = this.wallAnchor;
    const isFirstLeg = this.wallCommitted.length === 0;
    const meshType = axis === 'x' ? 'wall_x' : 'wall_z';

    let wallStart: number;
    if (isFirstLeg) {
      wallStart = axis === 'x' ? anchor.x : anchor.z;
    } else {
      wallStart = (axis === 'x' ? anchor.x : anchor.z) + J * dir;
    }

    // Number of wall segments that fit before the corner
    const availableDist = forwardDisp - J;
    const n = isFirstLeg
      ? Math.floor(availableDist / SEG) + 1
      : Math.floor((forwardDisp - 2 * J) / SEG) + 1;

    for (let i = 0; i < Math.max(0, n); i++) {
      const val = wallStart + i * SEG * dir;
      const wx = axis === 'x' ? val : anchor.x;
      const wz = axis === 'z' ? val : anchor.z;
      this.wallCommitted.push({ x: wx, z: wz, meshType, valid: this.validateWallSegment(wx, wz) });
    }

    // Corner piece
    const cornerOffset = isFirstLeg
      ? ((Math.max(0, n) - 1) * SEG + J) * dir
      : (J + (Math.max(0, n) - 1) * SEG + J) * dir;
    const cornerVal = (axis === 'x' ? anchor.x : anchor.z) + cornerOffset;
    const cx = axis === 'x' ? cornerVal : anchor.x;
    const cz = axis === 'z' ? cornerVal : anchor.z;
    this.wallCommitted.push({ x: cx, z: cz, meshType: 'wall_corner', valid: this.validateWallSegment(cx, cz) });

    // Update anchor to corner position
    this.wallAnchor = { x: cx, z: cz };
  }

  private computeLiveSegments(forwardDisp: number): WallSegment[] {
    if (!this.wallAnchor || !this.wallLegAxis) return [];

    const SEG = WALL_SEGMENT_LENGTH;
    const J = WALL_JUNCTION_OFFSET;
    const axis = this.wallLegAxis;
    const dir = this.wallLegDir;
    const anchor = this.wallAnchor;
    const isFirstLeg = this.wallCommitted.length === 0;
    const meshType = axis === 'x' ? 'wall_x' : 'wall_z';

    if (forwardDisp < 0) return [];

    let wallStart: number;
    if (isFirstLeg) {
      wallStart = axis === 'x' ? anchor.x : anchor.z;
    } else {
      wallStart = (axis === 'x' ? anchor.x : anchor.z) + J * dir;
    }

    const dispFromStart = forwardDisp - (isFirstLeg ? 0 : J);
    if (dispFromStart < 0) return [];

    const n = Math.floor(dispFromStart / SEG) + 1;
    const segments: WallSegment[] = [];
    for (let i = 0; i < n; i++) {
      const val = wallStart + i * SEG * dir;
      const wx = axis === 'x' ? val : anchor.x;
      const wz = axis === 'z' ? val : anchor.z;
      segments.push({ x: wx, z: wz, meshType, valid: this.validateWallSegment(wx, wz) });
    }

    return segments;
  }

  private validateWallSegment(x: number, z: number): boolean {
    if (x < 2 || x > 254 || z < 2 || z > 254) return false;
    if (!this.terrainData.isPassable(x, z)) return false;

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

  private snapToExistingWall(wx: number, wz: number): { x: number; z: number; axis: 'x' | 'z' | null } {
    const SNAP_RANGE = 2.5;
    const SEG = WALL_SEGMENT_LENGTH;
    const C = WALL_CORNER_SIZE;

    let bestDist = SNAP_RANGE;
    let bestSnap: { x: number; z: number; axis: 'x' | 'z' } | null = null;

    const entities = this.world.query(BUILDING, POSITION);
    for (const e of entities) {
      const building = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.Wall) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const renderable = this.world.getComponent<RenderableComponent>(e, RENDERABLE);
      const mt = renderable?.meshType ?? 'wall_x';

      const ends: { ex: number; ez: number; axis: 'x' | 'z'; dir: number }[] = [];
      if (mt === 'wall_x') {
        ends.push({ ex: pos.x + SEG / 2, ez: pos.z, axis: 'x', dir: 1 });
        ends.push({ ex: pos.x - SEG / 2, ez: pos.z, axis: 'x', dir: -1 });
      } else if (mt === 'wall_z') {
        ends.push({ ex: pos.x, ez: pos.z + SEG / 2, axis: 'z', dir: 1 });
        ends.push({ ex: pos.x, ez: pos.z - SEG / 2, axis: 'z', dir: -1 });
      } else if (mt === 'wall_corner') {
        ends.push({ ex: pos.x + C / 2, ez: pos.z, axis: 'x', dir: 1 });
        ends.push({ ex: pos.x - C / 2, ez: pos.z, axis: 'x', dir: -1 });
        ends.push({ ex: pos.x, ez: pos.z + C / 2, axis: 'z', dir: 1 });
        ends.push({ ex: pos.x, ez: pos.z - C / 2, axis: 'z', dir: -1 });
      }

      for (const end of ends) {
        const ddx = wx - end.ex;
        const ddz = wz - end.ez;
        const dist = Math.sqrt(ddx * ddx + ddz * ddz);
        if (dist < bestDist) {
          bestDist = dist;
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

  private pickEntity(sx: number, sy: number): Entity | null {
    const selectables = this.world.query(POSITION, SELECTABLE);
    let bestEntity: Entity | null = null;
    let bestDistSq = 40 * 40; // 40px pick radius

    const tmpVec = new THREE.Vector3();
    for (const e of selectables) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      tmpVec.set(pos.x, pos.y, pos.z);
      const screenPos = this.isoCamera.worldToScreen(tmpVec);
      const dx = screenPos.x - sx;
      const dy = screenPos.y - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    // Select the picked entity
    if (bestEntity !== null) {
      // Deselect all first
      for (const e of selectables) {
        const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
        sel.selected = false;
      }
      const sel = this.world.getComponent<SelectableComponent>(bestEntity, SELECTABLE)!;
      sel.selected = true;
    }

    return bestEntity;
  }

  private isOverPanel(x: number, y: number): boolean {
    const rect = this.container.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private createLabel(text: string): HTMLDivElement {
    const lbl = document.createElement('div');
    lbl.textContent = text;
    lbl.style.cssText = 'color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:8px 0 4px;';
    return lbl;
  }

  private createPanelButton(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 5px 10px;
      background: #333;
      color: #ccc;
      border: 1px solid #555;
      border-radius: 3px;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;
      text-align: left;
    `;
    btn.addEventListener('mouseenter', () => {
      if (!btn.style.borderColor || btn.style.borderColor === '#555' || btn.style.borderColor === 'rgb(85, 85, 85)') {
        btn.style.background = '#444';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.style.borderColor || btn.style.borderColor === '#555' || btn.style.borderColor === 'rgb(85, 85, 85)') {
        btn.style.background = '#333';
      }
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private buildToolsUI(): void {
    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:#555;margin:10px 0;';
    this.toolsSection.appendChild(sep);

    const title = document.createElement('div');
    title.textContent = 'TOOLS';
    title.style.cssText = 'text-align:center;font-weight:bold;margin-bottom:8px;color:#ffcc66;font-size:12px;letter-spacing:1px;';
    this.toolsSection.appendChild(title);

    // Axes toggle
    const axesRow = document.createElement('div');
    axesRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';
    const axesCb = document.createElement('input');
    axesCb.type = 'checkbox';
    axesCb.checked = true;
    axesCb.style.cursor = 'pointer';
    const axesLbl = document.createElement('label');
    axesLbl.textContent = 'Show Axes';
    axesLbl.style.cssText = 'color:#aaa;font-size:12px;cursor:pointer;';
    axesCb.addEventListener('change', () => {
      if (this.axesGroup) this.axesGroup.visible = axesCb.checked;
    });
    axesLbl.addEventListener('click', () => { axesCb.click(); });
    axesRow.appendChild(axesCb);
    axesRow.appendChild(axesLbl);
    this.toolsSection.appendChild(axesRow);

    // Light helper toggle
    const lightRow = document.createElement('div');
    lightRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';
    const lightCb = document.createElement('input');
    lightCb.type = 'checkbox';
    lightCb.checked = true;
    lightCb.style.cursor = 'pointer';
    const lightLbl = document.createElement('label');
    lightLbl.textContent = 'Show Light Helper';
    lightLbl.style.cssText = 'color:#aaa;font-size:12px;cursor:pointer;';
    lightCb.addEventListener('change', () => {
      if (this.lightHelper) this.lightHelper.visible = lightCb.checked;
    });
    lightLbl.addEventListener('click', () => { lightCb.click(); });
    lightRow.appendChild(lightCb);
    lightRow.appendChild(lightLbl);
    this.toolsSection.appendChild(lightRow);

    // Directional light controls
    this.toolsSection.appendChild(this.createLabel('Directional Light'));

    this.toolsSection.appendChild(this.createSliderRow('Azimuth', 0, 360, this.lightAzimuth, 1, (v) => {
      this.lightAzimuth = v;
      this.updateLightPosition();
    }));

    this.toolsSection.appendChild(this.createSliderRow('Elevation', 5, 85, this.lightElevation, 1, (v) => {
      this.lightElevation = v;
      this.updateLightPosition();
    }));

    this.toolsSection.appendChild(this.createSliderRow('Distance', 20, 200, this.lightDistance, 1, (v) => {
      this.lightDistance = v;
      this.updateLightPosition();
    }));

    this.toolsSection.appendChild(this.createSliderRow('Intensity', 0, 3, this.dirLight.intensity, 0.1, (v) => {
      this.dirLight.intensity = v;
    }));

    // Ambient light
    this.toolsSection.appendChild(this.createLabel('Ambient Light'));

    this.toolsSection.appendChild(this.createSliderRow('Intensity', 0, 1, this.ambientLight.intensity, 0.05, (v) => {
      this.ambientLight.intensity = v;
    }));
  }

  private createSliderRow(
    label: string, min: number, max: number, value: number, step: number,
    onChange: (val: number) => void,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:6px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    labelSpan.style.color = '#888';
    header.appendChild(labelSpan);

    const decimals = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
    const valueSpan = document.createElement('span');
    valueSpan.textContent = value.toFixed(decimals);
    valueSpan.style.color = '#fff';
    header.appendChild(valueSpan);

    row.appendChild(header);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    slider.style.cssText = 'width:100%;margin:0;cursor:pointer;height:14px;';

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      valueSpan.textContent = v.toFixed(decimals);
      onChange(v);
    });

    row.appendChild(slider);
    return row;
  }

  private createTextSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 48px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(4, 2, 1);
    return sprite;
  }

  private setupAxes(): void {
    const SIZE = 15;
    this.axesGroup = new THREE.Group();
    this.axesGroup.position.set(128, 0, 128);

    const axes = new THREE.AxesHelper(SIZE);
    this.axesGroup.add(axes);

    // Labels at axis tips
    const xLabel = this.createTextSprite('+X', '#ff4444');
    xLabel.position.set(SIZE + 2, 0, 0);
    this.axesGroup.add(xLabel);

    const yLabel = this.createTextSprite('+Y', '#44ff44');
    yLabel.position.set(0, SIZE + 2, 0);
    this.axesGroup.add(yLabel);

    const zLabel = this.createTextSprite('+Z', '#4444ff');
    zLabel.position.set(0, 0, SIZE + 2);
    this.axesGroup.add(zLabel);

    this.scene.add(this.axesGroup);
  }

  private setupLightHelper(): void {
    this.lightHelper = new THREE.DirectionalLightHelper(this.dirLight, 5, 0xffff00);
    this.scene.add(this.lightHelper);
  }

  private updateLightPosition(): void {
    const azRad = this.lightAzimuth * Math.PI / 180;
    const elRad = this.lightElevation * Math.PI / 180;
    const d = this.lightDistance;

    const offsetX = d * Math.cos(elRad) * Math.cos(azRad);
    const offsetY = d * Math.sin(elRad);
    const offsetZ = d * Math.cos(elRad) * Math.sin(azRad);

    this.dirLight.position.set(128 + offsetX, offsetY, 128 + offsetZ);
    if (this.lightHelper) this.lightHelper.update();
  }

  update(): void {
    if (this.lightHelper) this.lightHelper.update();
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  dispose(): void {
    if (this.axesGroup) {
      this.scene.remove(this.axesGroup);
      this.axesGroup = null;
    }
    if (this.lightHelper) {
      this.scene.remove(this.lightHelper);
      this.lightHelper.dispose();
      this.lightHelper = null;
    }
    this.container.remove();
  }

  getMode(): SandboxMode {
    return this.mode;
  }
}
