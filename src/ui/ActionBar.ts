import type { World } from '@core/ECS';
import { SELECTABLE, UNIT_TYPE, BUILDING, TEAM, PRODUCTION_QUEUE, CONSTRUCTION, POWER_POLE_RUIN, PLANT_STORAGE, POWER_NODE } from '@sim/components/ComponentTypes';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { PlantStorageComponent } from '@sim/components/PlantStorage';
import type { PowerNodeComponent } from '@sim/components/PowerNode';
import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';
import { BUILDING_DEFS } from '@sim/data/BuildingData';
import { UNIT_DEFS } from '@sim/data/UnitData';
import type { ResourceState } from '@sim/economy/ResourceState';
import { teamHasEngine, engineInProduction } from '@sim/logistics/TrainSpawner';

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

type BarMode = 'hidden' | 'worker' | 'hq' | 'factory' | 'depot' | 'construction' | 'building';

export class ActionBar {
  private container: HTMLDivElement;
  private buttonsDiv: HTMLDivElement;
  private progressDiv: HTMLDivElement;
  private onBuild: ((type: BuildingType) => void) | null = null;
  private onTrain: ((unitType: string) => void) | null = null;
  private onDemolish: ((entity: number) => void) | null = null;
  private onRepairPoles: (() => void) | null = null;
  private onRebuildLines: (() => void) | null = null;

  // Cached state to avoid rebuilding DOM every frame
  private currentMode: BarMode = 'hidden';
  private buttonElements: Map<string, HTMLButtonElement> = new Map();
  private buttonAffordable: Map<string, boolean> = new Map();
  private labelElements: Map<string, HTMLSpanElement> = new Map();
  private badgeElements: Map<string, HTMLDivElement> = new Map();
  private progressBarElements: Map<string, HTMLDivElement> = new Map();

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

  onRepairPolesRequest(cb: () => void): void {
    this.onRepairPoles = cb;
  }

  onRebuildLinesRequest(cb: () => void): void {
    this.onRebuildLines = cb;
  }

  update(world: World, resources: ResourceState, playerTeam: number): void {
    const entities = world.query(SELECTABLE);
    let workerSelected = false;
    let hqSelected = false;
    let hqEntity = -1;
    let factorySelected = false;
    let factoryEntity = -1;
    let depotSelected = false;
    let depotEntity = -1;
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
        } else if (building.buildingType === BuildingType.SupplyDepot && !world.hasComponent(e, CONSTRUCTION)) {
          depotSelected = true;
          depotEntity = e;
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
    else if (depotSelected) targetMode = 'depot';
    else if (hqSelected) targetMode = 'hq';
    else if (buildingSelected) targetMode = 'building';

    const totalMatter = resources.get(playerTeam).matter;

    // Rebuild buttons only when mode changes
    if (targetMode !== this.currentMode) {
      this.currentMode = targetMode;
      this.buttonElements.clear();
      this.buttonAffordable.clear();
      this.labelElements.clear();
      this.badgeElements.clear();
      this.progressBarElements.clear();
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
        // Train Cargo Car button
        const carDef = UNIT_DEFS[UnitCategory.CargoCar];
        if (carDef) {
          const affordable = resources.canAfford(playerTeam, carDef.energyCost) && totalMatter >= carDef.matterCost;
          const button = this.createButton(
            'train_cargo_car',
            'Train Cargo Car',
            `${carDef.energyCost}e ${carDef.matterCost}m`,
            affordable,
            () => this.onTrain?.(UnitCategory.CargoCar),
          );
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set('train_cargo_car', button);
          this.buttonAffordable.set('train_cargo_car', affordable);
        }
        // Train Engine button (only when team has no engine and none in production)
        if (!teamHasEngine(world, playerTeam) && !engineInProduction(world, playerTeam)) {
          const engineDef = UNIT_DEFS[UnitCategory.TrainEngine];
          if (engineDef) {
            const affordable = resources.canAfford(playerTeam, engineDef.energyCost) && totalMatter >= engineDef.matterCost;
            const button = this.createButton(
              'train_engine',
              'Train Engine',
              `${engineDef.energyCost}e ${engineDef.matterCost}m`,
              affordable,
              () => this.onTrain?.(UnitCategory.TrainEngine),
            );
            this.buttonsDiv.appendChild(button);
            this.buttonElements.set('train_engine', button);
            this.buttonAffordable.set('train_engine', affordable);
          }
        }
        // Repair Poles button (only shown when ruins exist)
        const ruinCost = this.countPoleRuinCost(world, playerTeam);
        if (ruinCost.count > 0) {
          const affordable = resources.canAfford(playerTeam, ruinCost.energyCost) && totalMatter >= ruinCost.matterCost;
          const button = this.createButton(
            'repair_poles',
            `Repair Poles (${ruinCost.count})`,
            `${ruinCost.energyCost}e ${ruinCost.matterCost}m`,
            affordable,
            () => this.onRepairPoles?.(),
          );
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set('repair_poles', button);
          this.buttonAffordable.set('repair_poles', affordable);
        }
        // Rebuild Lines button (shown when unpowered nodes exist)
        if (this.hasUnpoweredNodes(world, playerTeam)) {
          const button = this.createButton(
            'rebuild_lines',
            'Rebuild Lines',
            'free',
            true,
            () => this.onRebuildLines?.(),
          );
          this.buttonsDiv.appendChild(button);
          this.buttonElements.set('rebuild_lines', button);
          this.buttonAffordable.set('rebuild_lines', true);
        }
      } else if (targetMode === 'factory') {
        const factoryPower = world.getComponent<PowerNodeComponent>(factoryEntity, POWER_NODE);
        const factoryPowered = factoryPower ? factoryPower.powered : true;
        for (const btn of FACTORY_TRAIN_BUTTONS) {
          const def = UNIT_DEFS[btn.unitType];
          if (!def) continue;
          const affordable = factoryPowered && resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
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
      } else if (targetMode === 'depot') {
        // Demolish button for depot
        {
          const depotDef = BUILDING_DEFS[BuildingType.SupplyDepot];
          const refund = depotDef ? Math.floor(depotDef.matterCost * DEMOLISH_REFUND_RATE) : 0;
          const capturedEntity = depotEntity;
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
      for (const btn of BUILD_BUTTONS) {
        const def = BUILDING_DEFS[btn.type];
        if (!def) continue;
        const affordable = resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
        if (affordable !== this.buttonAffordable.get(btn.type)) {
          this.buttonAffordable.set(btn.type, affordable);
          const el = this.buttonElements.get(btn.type);
          if (el) this.updateButtonStyle(el, btn.type, btn.label, `${def.energyCost}e ${def.matterCost}m`, affordable);
        }
      }
    } else if (targetMode === 'hq') {
      const workerDef = UNIT_DEFS[UnitCategory.WorkerDrone];
      if (workerDef) {
        const affordable = resources.canAfford(playerTeam, workerDef.energyCost) && totalMatter >= workerDef.matterCost;
        if (affordable !== this.buttonAffordable.get('train_worker')) {
          this.buttonAffordable.set('train_worker', affordable);
          const el = this.buttonElements.get('train_worker');
          if (el) this.updateButtonStyle(el, 'train_worker', 'Train Worker', `${workerDef.energyCost}e ${workerDef.matterCost}m`, affordable);
        }
      }
      const carDef = UNIT_DEFS[UnitCategory.CargoCar];
      if (carDef) {
        const affordable = resources.canAfford(playerTeam, carDef.energyCost) && totalMatter >= carDef.matterCost;
        if (affordable !== this.buttonAffordable.get('train_cargo_car')) {
          this.buttonAffordable.set('train_cargo_car', affordable);
          const el = this.buttonElements.get('train_cargo_car');
          if (el) this.updateButtonStyle(el, 'train_cargo_car', 'Train Cargo Car', `${carDef.energyCost}e ${carDef.matterCost}m`, affordable);
        }
      }

      // Dynamic train engine button: show/hide based on engine state
      const engineEl = this.buttonElements.get('train_engine');
      const needsEngine = !teamHasEngine(world, playerTeam) && !engineInProduction(world, playerTeam);
      if (needsEngine && !engineEl) {
        this.currentMode = 'hidden'; // force rebuild to show button
        return;
      } else if (!needsEngine && engineEl) {
        this.currentMode = 'hidden'; // force rebuild to hide button
        return;
      }

      // Dynamic repair poles button update
      const ruinCost = this.countPoleRuinCost(world, playerTeam);
      const repairEl = this.buttonElements.get('repair_poles');
      if (ruinCost.count > 0) {
        if (!repairEl) {
          // Ruins appeared — need to rebuild mode to show button
          this.currentMode = 'hidden'; // force rebuild on next frame
          return;
        }
        const affordable = resources.canAfford(playerTeam, ruinCost.energyCost) && totalMatter >= ruinCost.matterCost;
        const newLabel = `Repair Poles (${ruinCost.count})`;
        const newCost = `${ruinCost.energyCost}e ${ruinCost.matterCost}m`;
        if (affordable !== this.buttonAffordable.get('repair_poles')) {
          this.buttonAffordable.set('repair_poles', affordable);
          this.updateButtonStyle(repairEl, 'repair_poles', newLabel, newCost, affordable);
        } else {
          // Always update label (count may change)
          this.updateButtonStyle(repairEl, 'repair_poles', newLabel, newCost, affordable);
        }
      } else if (repairEl) {
        // No more ruins — force rebuild to remove button
        this.currentMode = 'hidden';
        return;
      }

      // Dynamic rebuild lines button update
      const hasOrphans = this.hasUnpoweredNodes(world, playerTeam);
      const rebuildEl = this.buttonElements.get('rebuild_lines');
      if (hasOrphans && !rebuildEl) {
        this.currentMode = 'hidden';
        return;
      } else if (!hasOrphans && rebuildEl) {
        this.currentMode = 'hidden';
        return;
      }

      const pq = world.getComponent<ProductionQueueComponent>(hqEntity, PRODUCTION_QUEUE);
      this.updateQueueBadgesAndProgress(pq, [
        { key: 'train_worker', unitType: UnitCategory.WorkerDrone },
        { key: 'train_cargo_car', unitType: UnitCategory.CargoCar },
        { key: 'train_engine', unitType: UnitCategory.TrainEngine },
      ]);
    } else if (targetMode === 'factory') {
      const trainButtons: { key: string; unitType: string }[] = [];
      for (const btn of FACTORY_TRAIN_BUTTONS) {
        const def = UNIT_DEFS[btn.unitType];
        if (!def) continue;
        const key = `train_${btn.unitType}`;
        trainButtons.push({ key, unitType: btn.unitType });
        const affordable = resources.canAfford(playerTeam, def.energyCost) && totalMatter >= def.matterCost;
        if (affordable !== this.buttonAffordable.get(key)) {
          this.buttonAffordable.set(key, affordable);
          const el = this.buttonElements.get(key);
          if (el) this.updateButtonStyle(el, key, btn.label, `${def.energyCost}e ${def.matterCost}m`, affordable);
        }
      }

      const pq = world.getComponent<ProductionQueueComponent>(factoryEntity, PRODUCTION_QUEUE);
      this.updateQueueBadgesAndProgress(pq, trainButtons);
    } else if (targetMode === 'building' && buildingType === BuildingType.MatterPlant) {
      // Show queued matter amount for selected Matter Plant
      const ps = world.getComponent<PlantStorageComponent>(buildingEntity, PLANT_STORAGE);
      if (ps) {
        this.progressDiv.innerHTML = `Stored: ${Math.floor(ps.amount)}m`;
      }
    }
  }

  private createButton(key: string, label: string, costText: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    this.applyButtonCss(btn, enabled);

    // Progress bar (behind label)
    const progressBar = document.createElement('div');
    progressBar.style.cssText = 'position:absolute;left:0;top:0;width:0%;height:100%;background:rgba(100,200,100,0.3);z-index:0;pointer-events:none;transition:width 0.1s linear;';
    btn.appendChild(progressBar);
    this.progressBarElements.set(key, progressBar);

    // Label span (above progress bar)
    const labelSpan = document.createElement('span');
    labelSpan.style.cssText = 'position:relative;z-index:1;display:block;';
    this.setLabelContent(labelSpan, label, costText, enabled);
    btn.appendChild(labelSpan);
    this.labelElements.set(key, labelSpan);

    // Badge (top-right corner)
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:#ff4444;color:#fff;font-weight:bold;font-size:11px;min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:50%;z-index:2;pointer-events:none;display:none;';
    btn.appendChild(badge);
    this.badgeElements.set(key, badge);

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

  private applyButtonCss(btn: HTMLButtonElement, enabled: boolean): void {
    btn.style.cssText = `
      position: relative;
      overflow: hidden;
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
  }

  private setLabelContent(labelSpan: HTMLSpanElement, label: string, costText: string, enabled: boolean): void {
    labelSpan.innerHTML = `${label}<br><span style="font-size:10px;color:${enabled ? '#aaa' : '#555'}">${costText}</span>`;
  }

  private updateButtonStyle(btn: HTMLButtonElement, key: string, label: string, costText: string, enabled: boolean): void {
    this.applyButtonCss(btn, enabled);
    const labelSpan = this.labelElements.get(key);
    if (labelSpan) this.setLabelContent(labelSpan, label, costText, enabled);
  }

  private updateQueueBadgesAndProgress(
    pq: ProductionQueueComponent | undefined,
    buttons: { key: string; unitType: string }[],
  ): void {
    // Count queued items per unit type
    const counts = new Map<string, number>();
    if (pq) {
      for (const item of pq.queue) {
        counts.set(item.unitType, (counts.get(item.unitType) || 0) + 1);
      }
    }

    // Find the active item's button key for progress bar
    const activeUnitType = pq && pq.queue.length > 0 ? pq.queue[0].unitType : null;

    for (const { key, unitType } of buttons) {
      const count = counts.get(unitType) || 0;
      const badge = this.badgeElements.get(key);
      const progressBar = this.progressBarElements.get(key);

      // Badge
      if (badge) {
        if (count > 0) {
          badge.style.display = 'block';
          badge.textContent = String(count);
        } else {
          badge.style.display = 'none';
        }
      }

      // Progress bar: only on the button whose unit type is actively building
      if (progressBar) {
        if (activeUnitType === unitType && pq && pq.queue.length > 0) {
          const item = pq.queue[0];
          const pct = Math.max(0, (1 - item.timeRemaining / item.totalTime) * 100);
          progressBar.style.width = `${pct}%`;
        } else {
          progressBar.style.width = '0%';
        }
      }
    }

    this.progressDiv.innerHTML = '';
  }

  private barHtml(pct: number, color: string): string {
    return `<div style="background:rgba(255,255,255,0.1);border-radius:2px;height:6px;width:120px;overflow:hidden">` +
      `<div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div></div>`;
  }

  private countPoleRuinCost(world: World, team: number): { count: number; energyCost: number; matterCost: number } {
    const def = BUILDING_DEFS[BuildingType.PowerPole];
    if (!def) return { count: 0, energyCost: 0, matterCost: 0 };
    const ruins = world.query(POWER_POLE_RUIN, TEAM);
    let count = 0;
    for (const e of ruins) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team === team) count++;
    }
    return { count, energyCost: count * def.energyCost, matterCost: count * def.matterCost };
  }

  private hasUnpoweredNodes(world: World, team: number): boolean {
    const nodes = world.query(POWER_NODE, TEAM);
    for (const e of nodes) {
      const t = world.getComponent<TeamComponent>(e, TEAM)!;
      if (t.team !== team) continue;
      const pn = world.getComponent<PowerNodeComponent>(e, POWER_NODE)!;
      if (!pn.powered) return true;
    }
    return false;
  }
}
