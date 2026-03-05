import type { World } from '@core/ECS';
import { SELECTABLE, UNIT_TYPE, BUILDING, TEAM, PRODUCTION_QUEUE, CONSTRUCTION } from '@sim/components/ComponentTypes';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { ConstructionComponent } from '@sim/components/Construction';
import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import type { ResourceState } from '@sim/economy/ResourceState';

const BUILD_BUTTONS: { type: BuildingType; label: string }[] = [
  { type: BuildingType.EnergyExtractor, label: 'Energy Extractor' },
  { type: BuildingType.MatterPlant, label: 'Matter Plant' },
  { type: BuildingType.SupplyDepot, label: 'Supply Depot' },
  { type: BuildingType.DroneFactory, label: 'Drone Factory' },
  { type: BuildingType.Wall, label: 'Wall' },
];

const FACTORY_TRAIN_BUTTONS: { unitType: UnitCategory; label: string }[] = [
  { unitType: UnitCategory.CombatDrone, label: 'Combat Drone' },
  { unitType: UnitCategory.AssaultPlatform, label: 'Assault Platform' },
  { unitType: UnitCategory.AerialDrone, label: 'Aerial Drone' },
];

const DEMOLISH_REFUND_RATE = 0.7; // 70% matter refund

type BarMode = 'hidden' | 'worker' | 'hq' | 'factory' | 'construction' | 'building';

export class ActionBar {
  private container: HTMLDivElement;
  private buttonsDiv: HTMLDivElement;
  private progressDiv: HTMLDivElement;
  private onBuild: ((type: BuildingType) => void) | null = null;
  private onTrain: ((unitType: string) => void) | null = null;
  private onDemolish: ((entity: number) => void) | null = null;

  // Cached state to avoid rebuilding DOM every frame
  private currentMode: BarMode = 'hidden';
  private buttonElements: Map<string, HTMLButtonElement> = new Map();
  private buttonAffordable: Map<string, boolean> = new Map();

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 8px 12px;
      display: none;
      gap: 6px;
      flex-direction: row;
      align-items: center;
      z-index: 20;
      pointer-events: auto;
    `;

    this.buttonsDiv = document.createElement('div');
    this.buttonsDiv.style.cssText = 'display:flex;gap:6px;';
    this.container.appendChild(this.buttonsDiv);

    this.progressDiv = document.createElement('div');
    this.progressDiv.style.cssText = 'margin-left:8px;color:#ddd;font-family:monospace;font-size:12px;';
    this.container.appendChild(this.progressDiv);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  onBuildRequest(cb: (type: BuildingType) => void): void {
    this.onBuild = cb;
  }

  onTrainRequest(cb: (unitType: string) => void): void {
    this.onTrain = cb;
  }

  onDemolishRequest(cb: (entity: number) => void): void {
    this.onDemolish = cb;
  }

  update(world: World, resources: ResourceState, playerTeam: number): void {
    const entities = world.query(SELECTABLE);
    let workerSelected = false;
    let hqSelected = false;
    let hqEntity = -1;
    let factorySelected = false;
    let factoryEntity = -1;
    let constructionSelected = false;
    let constructionProgress = 0;
    let buildingSelected = false;
    let buildingEntity = -1;
    let buildingType: BuildingType | null = null;

    for (const e of entities) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;

      const team = world.getComponent<TeamComponent>(e, TEAM);
      if (team && team.team !== playerTeam) continue;

      const unit = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      if (unit && unit.category === UnitCategory.WorkerDrone) {
        workerSelected = true;
      }

      const building = world.getComponent<BuildingComponent>(e, BUILDING);
      if (building) {
        if (building.buildingType === BuildingType.HQ) {
          hqSelected = true;
          hqEntity = e;
        } else if (building.buildingType === BuildingType.DroneFactory && !world.hasComponent(e, CONSTRUCTION)) {
          factorySelected = true;
          factoryEntity = e;
        }
        // Track any non-HQ completed building for demolish
        if (building.buildingType !== BuildingType.HQ && !world.hasComponent(e, CONSTRUCTION)) {
          buildingSelected = true;
          buildingEntity = e;
          buildingType = building.buildingType;
        }
      }

      const construction = world.getComponent<ConstructionComponent>(e, CONSTRUCTION);
      if (construction) {
        constructionSelected = true;
        constructionProgress = construction.progress;
      }
    }

    // Determine target mode
    let targetMode: BarMode = 'hidden';
    if (constructionSelected) targetMode = 'construction';
    else if (workerSelected) targetMode = 'worker';
    else if (factorySelected) targetMode = 'factory';
    else if (hqSelected) targetMode = 'hq';
    else if (buildingSelected) targetMode = 'building';

    const totalMatter = resources.get(playerTeam).matter;

    // Rebuild buttons only when mode changes
    if (targetMode !== this.currentMode) {
      this.currentMode = targetMode;
      this.buttonElements.clear();
      this.buttonAffordable.clear();
      this.buttonsDiv.innerHTML = '';
      this.progressDiv.innerHTML = '';

      if (targetMode === 'hidden') {
        this.container.style.display = 'none';
        return;
      }

      this.container.style.display = 'flex';

      if (targetMode === 'worker') {
        for (const btn of BUILD_BUTTONS) {
          const def = BUILDING_DEFS[btn.type];
          if (!def) continue;
          const affordable = resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
          const button = this.createButton(
            btn.type,
            btn.label,
            `${def.energyCost}e ${def.matterCost}m`,
            affordable,
            () => this.onBuild?.(btn.type),
          );
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set(btn.type, button);
          this.buttonAffordable.set(btn.type, affordable);
        }
      } else if (targetMode === 'hq') {
        const workerDef = UNIT_DEFS[UnitCategory.WorkerDrone];
        if (workerDef) {
          const affordable = resources.canAfford(playerTeam, workerDef.energyCost) && totalMatter >= workerDef.matterCost;
          const button = this.createButton(
            'train_worker',
            'Train Worker',
            `${workerDef.energyCost}e ${workerDef.matterCost}m`,
            affordable,
            () => this.onTrain?.(UnitCategory.WorkerDrone),
          );
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set('train_worker', button);
          this.buttonAffordable.set('train_worker', affordable);
        }
      } else if (targetMode === 'factory') {
        for (const btn of FACTORY_TRAIN_BUTTONS) {
          const def = UNIT_DEFS[btn.unitType];
          if (!def) continue;
          const affordable = resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
          const key = `train_${btn.unitType}`;
          const button = this.createButton(
            key,
            btn.label,
            `${def.energyCost}e ${def.matterCost}m`,
            affordable,
            () => this.onTrain?.(btn.unitType),
          );
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set(key, button);
          this.buttonAffordable.set(key, affordable);
        }
        // Demolish button for factory
        {
          const factoryDef = BUILDING_DEFS[BuildingType.DroneFactory];
          const refund = factoryDef ? Math.floor(factoryDef.matterCost * DEMOLISH_REFUND_RATE) : 0;
          const capturedEntity = factoryEntity;
          const button = this.createButton(
            'demolish',
            'Demolish',
            `+${refund}m`,
            true,
            () => this.onDemolish?.(capturedEntity),
          );
          button.style.background = 'rgba(180, 60, 60, 0.3)';
          button.style.borderColor = 'rgba(180, 60, 60, 0.6)';
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set('demolish', button);
          this.buttonAffordable.set('demolish', true);
        }
      } else if (targetMode === 'building') {
        // Demolish button for non-HQ completed buildings
        if (buildingType) {
          const def = BUILDING_DEFS[buildingType];
          const refund = def ? Math.floor(def.matterCost * DEMOLISH_REFUND_RATE) : 0;
          const capturedEntity = buildingEntity;
          const button = this.createButton(
            'demolish',
            'Demolish',
            `+${refund}m`,
            true,
            () => this.onDemolish?.(capturedEntity),
          );
          // Style as destructive action
          button.style.background = 'rgba(180, 60, 60, 0.3)';
          button.style.borderColor = 'rgba(180, 60, 60, 0.6)';
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set('demolish', button);
          this.buttonAffordable.set('demolish', true);
        }
      }
    }

    // Update dynamic content without rebuilding buttons
    if (targetMode === 'hidden') {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'flex';

    if (targetMode === 'construction') {
      const pct = Math.floor(constructionProgress * 100);
      this.progressDiv.innerHTML = `Building... ${pct}%<br>` + this.barHtml(constructionProgress * 100, '#4af');
    } else if (targetMode === 'worker') {
      // Update affordability styling without replacing elements
      for (const btn of BUILD_BUTTONS) {
        const def = BUILDING_DEFS[btn.type];
        if (!def) continue;
        const affordable = resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
        if (affordable !== this.buttonAffordable.get(btn.type)) {
          this.buttonAffordable.set(btn.type, affordable);
          const el = this.buttonElements.get(btn.type);
          if (el) this.updateButtonStyle(el, btn.label, `${def.energyCost}e ${def.matterCost}m`, affordable);
        }
      }
    } else if (targetMode === 'hq') {
      const workerDef = UNIT_DEFS[UnitCategory.WorkerDrone];
      if (workerDef) {
        const affordable = resources.canAfford(playerTeam, workerDef.energyCost) && totalMatter >= workerDef.matterCost;
        if (affordable !== this.buttonAffordable.get('train_worker')) {
          this.buttonAffordable.set('train_worker', affordable);
          const el = this.buttonElements.get('train_worker');
          if (el) this.updateButtonStyle(el, 'Train Worker', `${workerDef.energyCost}e ${workerDef.matterCost}m`, affordable);
        }
      }

      // Show production progress
      const pq = world.getComponent<ProductionQueueComponent>(hqEntity, PRODUCTION_QUEUE);
      if (pq && pq.queue.length > 0) {
        const item = pq.queue[0];
        const pct = Math.max(0, (1 - item.timeRemaining / item.totalTime) * 100);
        this.progressDiv.innerHTML = `Training... ${Math.floor(pct)}%<br>` + this.barHtml(pct, '#4c4');
      } else {
        this.progressDiv.innerHTML = '';
      }
    } else if (targetMode === 'factory') {
      for (const btn of FACTORY_TRAIN_BUTTONS) {
        const def = UNIT_DEFS[btn.unitType];
        if (!def) continue;
        const key = `train_${btn.unitType}`;
        const affordable = resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
        if (affordable !== this.buttonAffordable.get(key)) {
          this.buttonAffordable.set(key, affordable);
          const el = this.buttonElements.get(key);
          if (el) this.updateButtonStyle(el, btn.label, `${def.energyCost}e ${def.matterCost}m`, affordable);
        }
      }

      // Show production progress
      const pq = world.getComponent<ProductionQueueComponent>(factoryEntity, PRODUCTION_QUEUE);
      if (pq && pq.queue.length > 0) {
        const item = pq.queue[0];
        const pct = Math.max(0, (1 - item.timeRemaining / item.totalTime) * 100);
        this.progressDiv.innerHTML = `Training... ${Math.floor(pct)}%<br>` + this.barHtml(pct, '#4c4');
      } else {
        this.progressDiv.innerHTML = '';
      }
    }
  }

  private createButton(key: string, label: string, costText: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    this.applyButtonStyle(btn, label, costText, enabled);
    btn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick();
    });
    btn.addEventListener('mouseenter', () => {
      if (this.buttonAffordable.get(key)) {
        btn.style.background = 'rgba(68, 136, 255, 0.5)';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (this.buttonAffordable.get(key)) {
        btn.style.background = 'rgba(68, 136, 255, 0.3)';
      }
    });
    return btn;
  }

  private applyButtonStyle(btn: HTMLButtonElement, label: string, costText: string, enabled: boolean): void {
    btn.style.cssText = `
      background: ${enabled ? 'rgba(68, 136, 255, 0.3)' : 'rgba(100, 100, 100, 0.3)'};
      border: 1px solid ${enabled ? 'rgba(68, 136, 255, 0.6)' : 'rgba(100, 100, 100, 0.4)'};
      border-radius: 4px;
      color: ${enabled ? '#ddd' : '#777'};
      font-family: monospace;
      font-size: 11px;
      padding: 6px 10px;
      cursor: ${enabled ? 'pointer' : 'not-allowed'};
      min-width: 100px;
      text-align: center;
    `;
    btn.innerHTML = `${label}<br><span style="font-size:10px;color:${enabled ? '#aaa' : '#555'}">${costText}</span>`;
  }

  private updateButtonStyle(btn: HTMLButtonElement, label: string, costText: string, enabled: boolean): void {
    this.applyButtonStyle(btn, label, costText, enabled);
  }

  private barHtml(pct: number, color: string): string {
    return `<div style="background:rgba(255,255,255,0.1);border-radius:2px;height:6px;width:120px;overflow:hidden">` +
      `<div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div></div>`;
  }
}
