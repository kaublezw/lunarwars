import * as THREE from 'three';
import type { InputManager } from './InputManager';
import type { IsometricCamera } from '@render/IsometricCamera';
import type { World, Entity } from '@core/ECS';
import type { EventBus } from '@core/EventBus';
import {
  POSITION, SELECTABLE, MOVE_COMMAND, UNIT_TYPE, TEAM, RESUPPLY_SEEK,
  BUILDING, CONSTRUCTION, HEALTH, MATTER_STORAGE, SUPPLY_ROUTE, BUILD_COMMAND,
  TURRET, ATTACK_TARGET, PRODUCTION_QUEUE,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import { BuildingType } from '@sim/components/Building';
import type { HealthComponent } from '@sim/components/Health';
import type { SupplyRouteComponent } from '@sim/components/SupplyRoute';
import type { AttackTargetComponent } from '@sim/components/AttackTarget';
import type { ConstructionComponent } from '@sim/components/Construction';
import type { BuildCommandComponent } from '@sim/components/BuildCommand';
import type { ProductionQueueComponent } from '@sim/components/ProductionQueue';
import { UnitCategory } from '@sim/components/UnitType';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const DRAG_THRESHOLD = 5; // pixels

/** Generate positions in concentric hex rings around (0,0). */
function computeFormationOffsets(count: number, spacing: number): { x: number; z: number }[] {
  const offsets: { x: number; z: number }[] = [];
  // Ring 0: center
  offsets.push({ x: 0, z: 0 });
  let ring = 1;
  while (offsets.length < count) {
    const slotsInRing = 6 * ring;
    const radius = ring * spacing;
    for (let i = 0; i < slotsInRing && offsets.length < count; i++) {
      const angle = (2 * Math.PI * i) / slotsInRing;
      offsets.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
    }
    ring++;
  }
  return offsets;
}

export class SelectionController {
  private leftDownPos: { x: number; y: number } | null = null;
  private rightDownPos: { x: number; y: number } | null = null;
  private isDragging = false;
  private dragBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;
  private placementCheck: (() => boolean) | null = null;

  // Callbacks for box select rendering
  onBoxSelectStart?: () => void;
  onBoxSelectUpdate?: (x0: number, y0: number, x1: number, y1: number) => void;
  onBoxSelectEnd?: () => void;

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  setPlacementCheck(fn: () => boolean): void {
    this.placementCheck = fn;
  }

  constructor(
    private input: InputManager,
    private camera: IsometricCamera,
    private world: World,
    private events: EventBus,
  ) {
    input.onMouseDown((x, y, button) => {
      if (button === 0) {
        this.leftDownPos = { x, y };
        this.isDragging = false;
      } else if (button === 2) {
        this.rightDownPos = { x, y };
      }
    });

    input.onMouseMove((x, y, _dx, _dy) => {
      if (this.leftDownPos) {
        const dx = x - this.leftDownPos.x;
        const dy = y - this.leftDownPos.y;
        if (!this.isDragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
          this.isDragging = true;
          this.onBoxSelectStart?.();
        }
        if (this.isDragging) {
          this.dragBox = {
            x0: Math.min(this.leftDownPos.x, x),
            y0: Math.min(this.leftDownPos.y, y),
            x1: Math.max(this.leftDownPos.x, x),
            y1: Math.max(this.leftDownPos.y, y),
          };
          this.onBoxSelectUpdate?.(this.dragBox.x0, this.dragBox.y0, this.dragBox.x1, this.dragBox.y1);
        }
      }
    });

    input.onMouseUp((x, y, button) => {
      if (button === 0) {
        if (this.isDragging && this.dragBox) {
          this.handleBoxSelect(this.dragBox);
          this.onBoxSelectEnd?.();
        } else if (this.leftDownPos) {
          this.handleClick(x, y);
        }
        this.leftDownPos = null;
        this.isDragging = false;
        this.dragBox = null;
      } else if (button === 2 && this.rightDownPos) {
        const dx = x - this.rightDownPos.x;
        const dy = y - this.rightDownPos.y;
        if (Math.sqrt(dx * dx + dy * dy) <= DRAG_THRESHOLD) {
          this.handleRightClick(x, y);
        }
        this.rightDownPos = null;
      }
    });
  }

  private handleClick(sx: number, sy: number): void {
    if (this.placementCheck?.()) return;
    const shift = this.input.isKeyDown('shift');

    const selectables = this.world.query(POSITION, SELECTABLE);
    let bestEntity: Entity | null = null;
    const pickRadiusPx = 30; // screen-space pick radius in pixels
    let bestDistSq = pickRadiusPx * pickRadiusPx;

    const tmpVec = new THREE.Vector3();
    for (const e of selectables) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;

      // Skip enemy entities in fog
      if (this.fogState) {
        const team = this.world.getComponent<TeamComponent>(e, TEAM);
        if (team && team.team !== this.playerTeam && !this.fogState.isVisible(this.playerTeam, pos.x, pos.z)) {
          continue;
        }
      }

      tmpVec.set(pos.x, pos.y, pos.z);
      const screenPos = this.camera.worldToScreen(tmpVec);
      const dx = screenPos.x - sx;
      const dy = screenPos.y - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    if (bestEntity !== null) {
      // Check if we clicked on a friendly completed Supply Depot while a worker is selected
      if (!shift && this.tryAssignWorkerToDepot(bestEntity)) {
        return;
      }

      const sel = this.world.getComponent<SelectableComponent>(bestEntity, SELECTABLE)!;
      if (shift) {
        sel.selected = !sel.selected;
      } else {
        this.deselectAll();
        sel.selected = true;
      }
    } else if (!shift) {
      this.deselectAll();
    }
  }

  private handleBoxSelect(box: { x0: number; y0: number; x1: number; y1: number }): void {
    if (this.placementCheck?.()) return;
    const shift = this.input.isKeyDown('shift');
    if (!shift) this.deselectAll();

    const tmpVec = new THREE.Vector3();
    const selectables = this.world.query(POSITION, SELECTABLE);
    for (const e of selectables) {
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;

      // Skip enemy entities in fog
      if (this.fogState) {
        const team = this.world.getComponent<TeamComponent>(e, TEAM);
        if (team && team.team !== this.playerTeam && !this.fogState.isVisible(this.playerTeam, pos.x, pos.z)) {
          continue;
        }
      }

      tmpVec.set(pos.x, pos.y, pos.z);
      const screenPos = this.camera.worldToScreen(tmpVec);

      if (
        screenPos.x >= box.x0 && screenPos.x <= box.x1 &&
        screenPos.y >= box.y0 && screenPos.y <= box.y1
      ) {
        const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
        sel.selected = true;
      }
    }
  }

  private handleRightClick(sx: number, sy: number): void {
    if (this.placementCheck?.()) return;
    const worldPos = this.camera.screenToWorld(sx, sy);
    if (!worldPos) return;

    const destX = worldPos.x;
    const destZ = worldPos.z;

    // Collect selected units
    const selected: { entity: Entity; pos: PositionComponent; radius: number }[] = [];
    const selectables = this.world.query(POSITION, SELECTABLE);
    let maxRadius = 0;

    let centroidX = 0;
    let centroidZ = 0;

    for (const e of selectables) {
      const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;

      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const ut = this.world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      const radius = ut ? ut.radius : 0.5;

      if (radius > maxRadius) maxRadius = radius;

      centroidX += pos.x;
      centroidZ += pos.z;

      selected.push({ entity: e, pos, radius });
    }

    if (selected.length === 0) return;

    // Set rally point on any selected production buildings (factory, HQ)
    const mobileUnits: typeof selected = [];
    let setRally = false;
    for (const s of selected) {
      if (
        this.world.hasComponent(s.entity, PRODUCTION_QUEUE) &&
        this.world.hasComponent(s.entity, BUILDING) &&
        !this.world.hasComponent(s.entity, CONSTRUCTION)
      ) {
        const queue = this.world.getComponent<ProductionQueueComponent>(s.entity, PRODUCTION_QUEUE)!;
        queue.rallyX = destX;
        queue.rallyZ = destZ;
        setRally = true;
      } else {
        mobileUnits.push(s);
      }
    }

    // If only production buildings selected (no mobile units), emit rally event and return
    if (setRally && mobileUnits.length === 0) {
      this.events.emit('command:rally', destX, destZ);
      return;
    }

    // Check if right-clicked on an allied construction site (reassign worker)
    const constructionSite = this.findConstructionSiteAtScreen(sx, sy);
    if (constructionSite !== null) {
      const workers: typeof mobileUnits = [];
      const nonWorkers: typeof mobileUnits = [];

      for (const s of mobileUnits) {
        const ut = this.world.getComponent<UnitTypeComponent>(s.entity, UNIT_TYPE);
        if (ut && ut.category === UnitCategory.WorkerDrone) {
          workers.push(s);
        } else {
          nonWorkers.push(s);
        }
      }

      if (workers.length > 0) {
        const sitePos = this.world.getComponent<PositionComponent>(constructionSite, POSITION)!;
        const construction = this.world.getComponent<ConstructionComponent>(constructionSite, CONSTRUCTION)!;

        // Assign first worker to build the site
        const w = workers[0];
        if (this.world.hasComponent(w.entity, BUILD_COMMAND)) {
          this.world.removeComponent(w.entity, BUILD_COMMAND);
        }
        if (this.world.hasComponent(w.entity, SUPPLY_ROUTE)) {
          this.world.removeComponent(w.entity, SUPPLY_ROUTE);
        }
        if (this.world.hasComponent(w.entity, RESUPPLY_SEEK)) {
          this.world.removeComponent(w.entity, RESUPPLY_SEEK);
        }

        construction.builderEntity = w.entity;

        this.world.addComponent<BuildCommandComponent>(w.entity, BUILD_COMMAND, {
          buildingType: construction.buildingType,
          targetX: sitePos.x,
          targetZ: sitePos.z,
          state: 'moving',
          siteEntity: constructionSite,
        });

        if (this.world.hasComponent(w.entity, MOVE_COMMAND)) {
          this.world.removeComponent(w.entity, MOVE_COMMAND);
        }
        this.world.addComponent<MoveCommandComponent>(w.entity, MOVE_COMMAND, {
          path: [],
          currentWaypoint: 0,
          destX: sitePos.x,
          destZ: sitePos.z,
        });

        // Remaining workers + non-workers get normal move
        const others = [...workers.slice(1), ...nonWorkers];
        for (const s of others) {
          if (this.world.hasComponent(s.entity, RESUPPLY_SEEK)) {
            this.world.removeComponent(s.entity, RESUPPLY_SEEK);
          }
          if (this.world.hasComponent(s.entity, ATTACK_TARGET)) {
            this.world.removeComponent(s.entity, ATTACK_TARGET);
          }
          if (this.world.hasComponent(s.entity, MOVE_COMMAND)) {
            this.world.removeComponent(s.entity, MOVE_COMMAND);
          }
          this.world.addComponent<MoveCommandComponent>(s.entity, MOVE_COMMAND, {
            path: [],
            currentWaypoint: 0,
            destX,
            destZ,
          });
        }

        this.events.emit('command:move', destX, destZ);
        return;
      }
    }

    // Check if right-clicked on an enemy entity (focus-fire)
    const enemy = this.findEnemyAtScreen(sx, sy);
    if (enemy !== null) {
      // Check if any selected unit has a turret (combat unit)
      const hasCombat = selected.some(s => this.world.hasComponent(s.entity, TURRET));
      if (hasCombat) {
        const enemyPos = this.world.getComponent<PositionComponent>(enemy, POSITION)!;
        for (const s of selected) {
          // Cancel ferry and resupply
          if (this.world.hasComponent(s.entity, SUPPLY_ROUTE)) {
            this.world.removeComponent(s.entity, SUPPLY_ROUTE);
          }
          if (this.world.hasComponent(s.entity, RESUPPLY_SEEK)) {
            this.world.removeComponent(s.entity, RESUPPLY_SEEK);
          }

          if (this.world.hasComponent(s.entity, TURRET)) {
            // Combat unit: pin attack target
            if (this.world.hasComponent(s.entity, ATTACK_TARGET)) {
              this.world.removeComponent(s.entity, ATTACK_TARGET);
            }
            this.world.addComponent<AttackTargetComponent>(s.entity, ATTACK_TARGET, {
              entity: enemy,
            });
          }

          // Move all selected units toward enemy position
          if (this.world.hasComponent(s.entity, MOVE_COMMAND)) {
            this.world.removeComponent(s.entity, MOVE_COMMAND);
          }
          this.world.addComponent<MoveCommandComponent>(s.entity, MOVE_COMMAND, {
            path: [],
            currentWaypoint: 0,
            destX: enemyPos.x,
            destZ: enemyPos.z,
          });
        }
        this.events.emit('command:move', enemyPos.x, enemyPos.z);
        return;
      }
    }

    // Check if right-clicked on an allied completed Supply Depot (screen-space pick)
    const depot = this.findDepotAtScreen(sx, sy);
    const hq = depot !== null ? this.findHQ() : null;

    if (depot !== null && hq !== null) {
      // Separate workers and non-workers
      const workers: typeof selected = [];
      const nonWorkers: typeof selected = [];

      for (const s of selected) {
        const ut = this.world.getComponent<UnitTypeComponent>(s.entity, UNIT_TYPE);
        if (ut && ut.category === UnitCategory.WorkerDrone) {
          workers.push(s);
        } else {
          nonWorkers.push(s);
        }
      }

      if (workers.length > 0) {
        const hqPos = this.world.getComponent<PositionComponent>(hq, POSITION)!;

        // Assign each worker to ferry
        for (const w of workers) {
          // Cancel existing commands
          if (this.world.hasComponent(w.entity, BUILD_COMMAND)) {
            this.world.removeComponent(w.entity, BUILD_COMMAND);
          }
          if (this.world.hasComponent(w.entity, SUPPLY_ROUTE)) {
            this.world.removeComponent(w.entity, SUPPLY_ROUTE);
          }
          if (this.world.hasComponent(w.entity, RESUPPLY_SEEK)) {
            this.world.removeComponent(w.entity, RESUPPLY_SEEK);
          }

          // Add ferry route
          this.world.addComponent<SupplyRouteComponent>(w.entity, SUPPLY_ROUTE, {
            sourceEntity: hq,
            destEntity: depot,
            state: 'to_source',
            timer: 0,
            carried: 0,
            carryCapacity: 10,
          });

          // Move toward HQ approach point (not center, which is inside blocked tiles)
          const approachDist = 3.5; // HQ footprint(2) + margin(1.5)
          const adx = w.pos.x - hqPos.x;
          const adz = w.pos.z - hqPos.z;
          const aDist = Math.sqrt(adx * adx + adz * adz);
          let apX = hqPos.x + approachDist;
          let apZ = hqPos.z;
          if (aDist > 0.01) {
            apX = hqPos.x + (adx / aDist) * approachDist;
            apZ = hqPos.z + (adz / aDist) * approachDist;
          }

          if (this.world.hasComponent(w.entity, MOVE_COMMAND)) {
            this.world.removeComponent(w.entity, MOVE_COMMAND);
          }
          this.world.addComponent<MoveCommandComponent>(w.entity, MOVE_COMMAND, {
            path: [],
            currentWaypoint: 0,
            destX: apX,
            destZ: apZ,
          });
        }

        // Non-workers get normal move (clear attack target too)
        if (nonWorkers.length > 0) {
          for (const s of nonWorkers) {
            if (this.world.hasComponent(s.entity, RESUPPLY_SEEK)) {
              this.world.removeComponent(s.entity, RESUPPLY_SEEK);
            }
            if (this.world.hasComponent(s.entity, ATTACK_TARGET)) {
              this.world.removeComponent(s.entity, ATTACK_TARGET);
            }
            this.world.addComponent<MoveCommandComponent>(s.entity, MOVE_COMMAND, {
              path: [],
              currentWaypoint: 0,
              destX,
              destZ,
            });
          }
        }

        this.events.emit('command:move', destX, destZ);
        return;
      }
    }

    // Normal move - cancel ferry and attack target for all selected units
    for (const s of selected) {
      if (this.world.hasComponent(s.entity, SUPPLY_ROUTE)) {
        this.world.removeComponent(s.entity, SUPPLY_ROUTE);
      }
      if (this.world.hasComponent(s.entity, ATTACK_TARGET)) {
        this.world.removeComponent(s.entity, ATTACK_TARGET);
      }
    }

    if (selected.length === 1) {
      // Cancel auto-resupply if active
      if (this.world.hasComponent(selected[0].entity, RESUPPLY_SEEK)) {
        this.world.removeComponent(selected[0].entity, RESUPPLY_SEEK);
      }
      const cmd: MoveCommandComponent = { path: [], currentWaypoint: 0, destX, destZ };
      this.world.addComponent(selected[0].entity, MOVE_COMMAND, cmd);
      this.events.emit('command:move', destX, destZ);
      return;
    }

    centroidX /= selected.length;
    centroidZ /= selected.length;

    // Sort by distance to their CURRENT centroid
    selected.sort((a, b) => {
      const da = (a.pos.x - centroidX) ** 2 + (a.pos.z - centroidZ) ** 2;
      const db = (b.pos.x - centroidX) ** 2 + (b.pos.z - centroidZ) ** 2;
      return da - db;
    });

    const spacing = Math.max(maxRadius * 3, 1.5);
    const offsets = computeFormationOffsets(selected.length, spacing);

    const jitterMax = maxRadius * 0.4;

    for (let i = 0; i < selected.length; i++) {
      // Cancel auto-resupply if active
      if (this.world.hasComponent(selected[i].entity, RESUPPLY_SEEK)) {
        this.world.removeComponent(selected[i].entity, RESUPPLY_SEEK);
      }

      const jitterX = (Math.random() - 0.5) * jitterMax;
      const jitterZ = (Math.random() - 0.5) * jitterMax;

      const cmd: MoveCommandComponent = {
        path: [],
        currentWaypoint: 0,
        destX: destX + offsets[i].x + jitterX,
        destZ: destZ + offsets[i].z + jitterZ,
      };
      this.world.addComponent(selected[i].entity, MOVE_COMMAND, cmd);
    }

    this.events.emit('command:move', destX, destZ);
  }

  /** If a worker is selected and clickedEntity is a friendly Supply Depot, assign the ferry. */
  private tryAssignWorkerToDepot(clickedEntity: Entity): boolean {
    // Is the clicked entity a friendly completed Supply Depot?
    const building = this.world.getComponent<BuildingComponent>(clickedEntity, BUILDING);
    if (!building || building.buildingType !== BuildingType.SupplyDepot) return false;
    if (this.world.hasComponent(clickedEntity, CONSTRUCTION)) return false;
    const depotTeam = this.world.getComponent<TeamComponent>(clickedEntity, TEAM);
    if (!depotTeam || depotTeam.team !== this.playerTeam) return false;
    const depotHealth = this.world.getComponent<HealthComponent>(clickedEntity, HEALTH);
    if (!depotHealth || depotHealth.dead) return false;

    // Collect currently selected workers
    const selectables = this.world.query(POSITION, SELECTABLE, UNIT_TYPE);
    const workers: { entity: Entity; pos: PositionComponent }[] = [];
    for (const e of selectables) {
      const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;
      const ut = this.world.getComponent<UnitTypeComponent>(e, UNIT_TYPE)!;
      if (ut.category !== UnitCategory.WorkerDrone) continue;
      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      workers.push({ entity: e, pos });
    }

    if (workers.length === 0) return false;

    // Find HQ
    const hq = this.findHQ();
    if (hq === null) return false;
    const hqPos = this.world.getComponent<PositionComponent>(hq, POSITION)!;

    // Assign each worker to ferry
    for (const w of workers) {
      // Cancel existing commands
      if (this.world.hasComponent(w.entity, BUILD_COMMAND)) {
        this.world.removeComponent(w.entity, BUILD_COMMAND);
      }
      if (this.world.hasComponent(w.entity, SUPPLY_ROUTE)) {
        this.world.removeComponent(w.entity, SUPPLY_ROUTE);
      }
      if (this.world.hasComponent(w.entity, RESUPPLY_SEEK)) {
        this.world.removeComponent(w.entity, RESUPPLY_SEEK);
      }

      // Add ferry route
      this.world.addComponent<SupplyRouteComponent>(w.entity, SUPPLY_ROUTE, {
        sourceEntity: hq,
        destEntity: clickedEntity,
        state: 'to_source',
        timer: 0,
        carried: 0,
        carryCapacity: 10,
      });

      // Move toward HQ approach point
      const approachDist = 3.5;
      const adx = w.pos.x - hqPos.x;
      const adz = w.pos.z - hqPos.z;
      const aDist = Math.sqrt(adx * adx + adz * adz);
      let apX = hqPos.x + approachDist;
      let apZ = hqPos.z;
      if (aDist > 0.01) {
        apX = hqPos.x + (adx / aDist) * approachDist;
        apZ = hqPos.z + (adz / aDist) * approachDist;
      }

      if (this.world.hasComponent(w.entity, MOVE_COMMAND)) {
        this.world.removeComponent(w.entity, MOVE_COMMAND);
      }
      this.world.addComponent<MoveCommandComponent>(w.entity, MOVE_COMMAND, {
        path: [],
        currentWaypoint: 0,
        destX: apX,
        destZ: apZ,
      });
    }

    // Deselect the workers and select the depot
    this.deselectAll();
    const depotSel = this.world.getComponent<SelectableComponent>(clickedEntity, SELECTABLE);
    if (depotSel) depotSel.selected = true;

    return true;
  }

  private findEnemyAtScreen(sx: number, sy: number): Entity | null {
    const entities = this.world.query(POSITION, HEALTH, TEAM);
    let bestEntity: Entity | null = null;
    const pickRadiusPx = 30;
    let bestDistSq = pickRadiusPx * pickRadiusPx;

    const tmpVec = new THREE.Vector3();
    for (const e of entities) {
      const team = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team === this.playerTeam) continue;

      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;

      // Must be visible in fog
      if (this.fogState && !this.fogState.isVisible(this.playerTeam, pos.x, pos.z)) continue;

      tmpVec.set(pos.x, pos.y, pos.z);
      const screenPos = this.camera.worldToScreen(tmpVec);
      const dx = screenPos.x - sx;
      const dy = screenPos.y - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    return bestEntity;
  }

  private findDepotAtScreen(sx: number, sy: number): Entity | null {
    const buildings = this.world.query(BUILDING, TEAM, POSITION, HEALTH, MATTER_STORAGE);
    let bestEntity: Entity | null = null;
    const pickRadiusPx = 40; // screen-space pick radius in pixels
    let bestDistSq = pickRadiusPx * pickRadiusPx;

    const tmpVec = new THREE.Vector3();
    for (const e of buildings) {
      if (this.world.hasComponent(e, CONSTRUCTION)) continue;
      const team = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.playerTeam) continue;
      const building = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.SupplyDepot) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      tmpVec.set(pos.x, pos.y, pos.z);
      const screenPos = this.camera.worldToScreen(tmpVec);
      const dx = screenPos.x - sx;
      const dy = screenPos.y - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    return bestEntity;
  }

  private findConstructionSiteAtScreen(sx: number, sy: number): Entity | null {
    const sites = this.world.query(CONSTRUCTION, TEAM, POSITION, HEALTH);
    let bestEntity: Entity | null = null;
    const pickRadiusPx = 40;
    let bestDistSq = pickRadiusPx * pickRadiusPx;

    const tmpVec = new THREE.Vector3();
    for (const e of sites) {
      const team = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.playerTeam) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;

      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      tmpVec.set(pos.x, pos.y, pos.z);
      const screenPos = this.camera.worldToScreen(tmpVec);
      const dx = screenPos.x - sx;
      const dy = screenPos.y - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEntity = e;
      }
    }

    return bestEntity;
  }

  private findHQ(): Entity | null {
    const buildings = this.world.query(BUILDING, TEAM, HEALTH);
    for (const e of buildings) {
      const team = this.world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.playerTeam) continue;
      const building = this.world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;
      const health = this.world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) continue;
      return e;
    }
    return null;
  }

  issueMoveTo(destX: number, destZ: number): void {
    const selectables = this.world.query(POSITION, SELECTABLE);
    const mobile: { entity: Entity; pos: PositionComponent; radius: number }[] = [];
    let maxRadius = 0;
    let centroidX = 0;
    let centroidZ = 0;

    for (const e of selectables) {
      const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;

      // Set rally point on production buildings
      if (
        this.world.hasComponent(e, PRODUCTION_QUEUE) &&
        this.world.hasComponent(e, BUILDING) &&
        !this.world.hasComponent(e, CONSTRUCTION)
      ) {
        const queue = this.world.getComponent<ProductionQueueComponent>(e, PRODUCTION_QUEUE)!;
        queue.rallyX = destX;
        queue.rallyZ = destZ;
        continue;
      }

      // Skip buildings/construction sites
      if (this.world.hasComponent(e, BUILDING)) continue;

      const pos = this.world.getComponent<PositionComponent>(e, POSITION)!;
      const ut = this.world.getComponent<UnitTypeComponent>(e, UNIT_TYPE);
      const radius = ut ? ut.radius : 0.5;
      if (radius > maxRadius) maxRadius = radius;
      centroidX += pos.x;
      centroidZ += pos.z;
      mobile.push({ entity: e, pos, radius });
    }

    if (mobile.length === 0) return;

    for (const s of mobile) {
      if (this.world.hasComponent(s.entity, SUPPLY_ROUTE)) {
        this.world.removeComponent(s.entity, SUPPLY_ROUTE);
      }
      if (this.world.hasComponent(s.entity, ATTACK_TARGET)) {
        this.world.removeComponent(s.entity, ATTACK_TARGET);
      }
      if (this.world.hasComponent(s.entity, RESUPPLY_SEEK)) {
        this.world.removeComponent(s.entity, RESUPPLY_SEEK);
      }
    }

    if (mobile.length === 1) {
      this.world.addComponent<MoveCommandComponent>(mobile[0].entity, MOVE_COMMAND, {
        path: [], currentWaypoint: 0, destX, destZ,
      });
      this.events.emit('command:move', destX, destZ);
      return;
    }

    centroidX /= mobile.length;
    centroidZ /= mobile.length;

    mobile.sort((a, b) => {
      const da = (a.pos.x - centroidX) ** 2 + (a.pos.z - centroidZ) ** 2;
      const db = (b.pos.x - centroidX) ** 2 + (b.pos.z - centroidZ) ** 2;
      return da - db;
    });

    const spacing = Math.max(maxRadius * 3, 1.5);
    const offsets = computeFormationOffsets(mobile.length, spacing);
    const jitterMax = maxRadius * 0.4;

    for (let i = 0; i < mobile.length; i++) {
      const jitterX = (Math.random() - 0.5) * jitterMax;
      const jitterZ = (Math.random() - 0.5) * jitterMax;
      this.world.addComponent<MoveCommandComponent>(mobile[i].entity, MOVE_COMMAND, {
        path: [],
        currentWaypoint: 0,
        destX: destX + offsets[i].x + jitterX,
        destZ: destZ + offsets[i].z + jitterZ,
      });
    }

    this.events.emit('command:move', destX, destZ);
  }

  private deselectAll(): void {
    const selectables = this.world.query(SELECTABLE);
    for (const e of selectables) {
      const sel = this.world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      sel.selected = false;
    }
  }
}
