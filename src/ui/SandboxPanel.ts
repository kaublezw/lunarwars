import * as THREE from 'three';
import type { InputManager } from '@input/InputManager';
import type { IsometricCamera } from '@render/IsometricCamera';
import type { World, Entity } from '@core/ECS';
import type { TerrainData } from '@sim/terrain/TerrainData';
import { POSITION, SELECTABLE, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';

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

  // Callbacks set by main.ts
  onPlay?: () => void;
  onPause?: () => void;
  onSpeedChange?: (scale: number) => void;
  onSelectAll?: () => void;
  onClearAll?: () => void;
  onReset?: () => void;

  constructor(
    private world: World,
    private terrainData: TerrainData,
    private isoCamera: IsometricCamera,
    private inputManager: InputManager,
    private spawnUnit: (x: number, z: number, team: number, category: UnitCategory) => number,
    private spawnBuilding: (x: number, z: number, team: number, type: BuildingType) => number,
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
    const tmpVec = new THREE.Vector3();

    this.inputManager.onMouseDown((x, y, button) => {
      if (this.mode !== 'editor') return;

      // Ignore clicks on the panel itself
      if (this.isOverPanel(x, y)) return;

      if (button === 0) {
        if (this.selectedPalette) {
          // Place entity
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
          // Pick entity for dragging
          const picked = this.pickEntity(x, y);
          if (picked !== null) {
            this.draggingEntity = picked;
          }
        }
      } else if (button === 2) {
        // Cancel palette selection
        this.selectedPalette = null;
        this.highlightPalette();
      }
    });

    this.inputManager.onMouseMove((x, y) => {
      if (this.mode !== 'editor') return;
      if (this.draggingEntity === null) return;

      // Check entity still exists
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
      // Match prev to avoid interpolation glitch
      pos.prevX = pos.x;
      pos.prevY = pos.y;
      pos.prevZ = pos.z;
    });

    this.inputManager.onMouseUp((_x, _y, button) => {
      if (button === 0) {
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

      // Escape: cancel palette selection
      if (e.key === 'Escape') {
        this.selectedPalette = null;
        this.highlightPalette();
      }
    });
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

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  dispose(): void {
    this.container.remove();
  }

  getMode(): SandboxMode {
    return this.mode;
  }
}
