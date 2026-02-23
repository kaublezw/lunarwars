import type { World } from '@core/ECS';
import { SELECTABLE, TURRET, HEALTH, UNIT_TYPE, BUILDING, MATTER_STORAGE } from '@sim/components/ComponentTypes';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { TurretComponent } from '@sim/components/Turret';
import type { HealthComponent } from '@sim/components/Health';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { BuildingComponent } from '@sim/components/Building';
import type { MatterStorageComponent } from '@sim/components/MatterStorage';

const LABEL_MAP: Record<string, string> = {
  combat_drone: 'Combat Drone',
  assault_platform: 'Assault Platform',
  aerial_drone: 'Aerial Drone',
  worker_drone: 'Worker Drone',
  hq: 'HQ',
  energy_extractor: 'Energy Extractor',
  matter_plant: 'Matter Plant',
  supply_depot: 'Supply Depot',
  drone_factory: 'Drone Factory',
};

export class UnitInfoPanel {
  private container: HTMLDivElement;
  private content: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 12px;
      left: 12px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 10px 14px;
      color: #ddd;
      font-family: monospace;
      font-size: 13px;
      pointer-events: none;
      min-width: 180px;
      display: none;
      z-index: 10;
    `;

    this.content = document.createElement('div');
    this.container.appendChild(this.content);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  update(world: World): void {
    const entities = world.query(SELECTABLE);
    const selected: number[] = [];
    for (const e of entities) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (sel.selected) selected.push(e);
    }

    if (selected.length === 0) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'block';

    if (selected.length === 1) {
      this.renderSingle(world, selected[0]);
    } else {
      this.renderGroup(world, selected);
    }
  }

  private renderSingle(world: World, e: number): void {
    const unit = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
    const building = world.getComponent<BuildingComponent>(e, BUILDING);
    const health = world.getComponent<HealthComponent>(e, HEALTH);
    const turret = world.getComponent<TurretComponent>(e, TURRET);
    const storage = world.getComponent<MatterStorageComponent>(e, MATTER_STORAGE);

    const key = unit ? unit.category : building ? building.buildingType : null;
    const name = key ? (LABEL_MAP[key] ?? key) : 'Unit';
    let html = `<div style="margin-bottom:6px;color:#fff;font-weight:bold">${name}</div>`;

    if (health) {
      const hpPct = Math.max(0, health.current / health.max * 100);
      const hpColor = hpPct > 50 ? '#4c4' : hpPct > 25 ? '#cc4' : '#c44';
      html += `<div style="margin-bottom:4px">HP ${health.current}/${health.max}</div>`;
      html += this.bar(hpPct, hpColor);
    }

    if (turret) {
      const ammoPct = turret.maxAmmo > 0 ? turret.ammo / turret.maxAmmo * 100 : 0;
      const ammoColor = ammoPct > 30 ? '#4af' : ammoPct > 10 ? '#ca4' : '#c44';
      html += `<div style="margin:6px 0 4px">Ammo ${turret.ammo}/${turret.maxAmmo}</div>`;
      html += this.bar(ammoPct, ammoColor);
    }

    if (storage) {
      html += `<div style="margin:6px 0 4px">Matter: ${Math.floor(storage.stored)}</div>`;
    }

    this.content.innerHTML = html;
  }

  private renderGroup(world: World, entities: number[]): void {
    // Tally units by type
    const counts = new Map<string, { total: number; alive: number; totalAmmo: number; maxAmmo: number }>();

    for (const e of entities) {
      const unit = world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      const bldg = world.getComponent<BuildingComponent>(e, BUILDING);
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      const turret = world.getComponent<TurretComponent>(e, TURRET);
      const key = unit ? unit.category : bldg ? bldg.buildingType : 'unknown';

      let entry = counts.get(key);
      if (!entry) {
        entry = { total: 0, alive: 0, totalAmmo: 0, maxAmmo: 0 };
        counts.set(key, entry);
      }
      entry.total++;
      if (!health || !health.dead) entry.alive++;
      if (turret) {
        entry.totalAmmo += turret.ammo;
        entry.maxAmmo += turret.maxAmmo;
      }
    }

    let html = `<div style="margin-bottom:6px;color:#fff;font-weight:bold">${entities.length} units selected</div>`;

    for (const [key, val] of counts) {
      const name = LABEL_MAP[key] ?? key;
      const ammoPct = val.maxAmmo > 0 ? val.totalAmmo / val.maxAmmo * 100 : 0;
      const ammoColor = ammoPct > 30 ? '#4af' : ammoPct > 10 ? '#ca4' : '#c44';
      html += `<div style="margin-top:4px">${val.alive}x ${name}</div>`;
      html += `<div style="font-size:11px;color:#999">Ammo ${val.totalAmmo}/${val.maxAmmo}</div>`;
      html += this.bar(ammoPct, ammoColor);
    }

    this.content.innerHTML = html;
  }

  private bar(pct: number, color: string): string {
    return `<div style="background:rgba(255,255,255,0.1);border-radius:2px;height:6px;margin-top:2px;overflow:hidden">` +
      `<div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div></div>`;
  }
}
