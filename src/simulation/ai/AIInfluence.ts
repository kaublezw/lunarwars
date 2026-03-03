import { POSITION, UNIT_TYPE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { UnitTypeComponent } from '@sim/components/UnitType';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState } from '@sim/ai/AITypes';
import {
  INFLUENCE_GRID, INFLUENCE_CELL, THREAT_WEIGHT, THREAT_DECAY_PER_TICK,
} from '@sim/ai/AITypes';

function toCell(wx: number, wz: number): [number, number] {
  const G = INFLUENCE_GRID;
  const C = INFLUENCE_CELL;
  return [
    Math.min(G - 1, Math.max(0, Math.floor(wx / C))),
    Math.min(G - 1, Math.max(0, Math.floor(wz / C))),
  ];
}

function unitThreatWeight(cat: UnitCategory | null): number {
  switch (cat) {
    case UnitCategory.CombatDrone: return 1;
    case UnitCategory.AssaultPlatform: return 3;
    case UnitCategory.AerialDrone: return 0.5;
    default: return 0;
  }
}

function buildingValueWeight(bt: BuildingType | null): number {
  switch (bt) {
    case BuildingType.HQ: return 5;
    case BuildingType.DroneFactory: return 3;
    case BuildingType.SupplyDepot: return 2.5;
    case BuildingType.MatterPlant: return 2;
    case BuildingType.EnergyExtractor: return 1.5;
    default: return 0;
  }
}

export function updateInfluenceGrid(
  grid: Float32Array,
  ctx: AIContext,
  state: AIWorldState,
): void {
  grid.fill(0);
  const G = INFLUENCE_GRID;

  // Visible enemy units -> threat
  for (const unit of state.knownEnemyUnits) {
    const [cx, cz] = toCell(unit.x, unit.z);
    grid[(cz * G + cx) * 3] += unitThreatWeight(unit.category);
  }

  // Visible enemy buildings -> value
  for (const bldg of state.knownEnemyBuildings) {
    const [cx, cz] = toCell(bldg.x, bldg.z);
    grid[(cz * G + cx) * 3 + 1] += buildingValueWeight(bldg.type);
  }

  // Remembered enemy units -> decayed threat
  for (const entry of state.rememberedEnemyUnits) {
    const [cx, cz] = toCell(entry.x, entry.z);
    const decay = Math.max(0, 1 - (ctx.totalTicks - entry.lastSeenTick) * THREAT_DECAY_PER_TICK);
    grid[(cz * G + cx) * 3] += unitThreatWeight(entry.unitCategory) * decay;
  }

  // Remembered enemy buildings -> decayed value
  for (const entry of state.rememberedEnemyBuildings) {
    const [cx, cz] = toCell(entry.x, entry.z);
    const decay = Math.max(0, 1 - (ctx.totalTicks - entry.lastSeenTick) * THREAT_DECAY_PER_TICK);
    grid[(cz * G + cx) * 3 + 1] += buildingValueWeight(entry.buildingType) * decay;
  }

  // Own units -> ownPresence
  for (const unitId of [...state.myCombat, ...state.myAerial]) {
    const pos = ctx.world.getComponent<PositionComponent>(unitId, POSITION);
    if (!pos) continue;
    const [cx, cz] = toCell(pos.x, pos.z);
    const ut = ctx.world.getComponent<UnitTypeComponent>(unitId, UNIT_TYPE);
    grid[(cz * G + cx) * 3 + 2] += ut ? unitThreatWeight(ut.category) : 1;
  }

  // Bleed threat to 8 neighbors at 50%
  const threatCopy = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    threatCopy[i] = grid[i * 3];
  }
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      const t = threatCopy[z * G + x];
      if (t <= 0) continue;
      const bleed = t * 0.5;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nx >= G || nz < 0 || nz >= G) continue;
          grid[(nz * G + nx) * 3] += bleed;
        }
      }
    }
  }
}

export function findInfluenceAwarePath(
  grid: Float32Array,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): { x: number; z: number }[] {
  const G = INFLUENCE_GRID;
  const C = INFLUENCE_CELL;
  const SQRT2 = 1.414;

  const sc = Math.min(G - 1, Math.max(0, Math.floor(fromX / C)));
  const sr = Math.min(G - 1, Math.max(0, Math.floor(fromZ / C)));
  const ec = Math.min(G - 1, Math.max(0, Math.floor(toX / C)));
  const er = Math.min(G - 1, Math.max(0, Math.floor(toZ / C)));

  if (sc === ec && sr === er) return [{ x: toX, z: toZ }];

  const dirs = [
    { dx: 1, dz: 0, c: 1 }, { dx: -1, dz: 0, c: 1 },
    { dx: 0, dz: 1, c: 1 }, { dx: 0, dz: -1, c: 1 },
    { dx: 1, dz: 1, c: SQRT2 }, { dx: -1, dz: 1, c: SQRT2 },
    { dx: 1, dz: -1, c: SQRT2 }, { dx: -1, dz: -1, c: SQRT2 },
  ];

  const N = G * G;
  const gScore = new Float32Array(N).fill(Infinity);
  const fScore = new Float32Array(N).fill(Infinity);
  const cameFrom = new Int16Array(N).fill(-1);
  const closed = new Uint8Array(N);

  const sIdx = sr * G + sc;
  const eIdx = er * G + ec;

  gScore[sIdx] = 0;
  const h = (col: number, row: number) => {
    const dx = Math.abs(col - ec);
    const dz = Math.abs(row - er);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  };
  fScore[sIdx] = h(sc, sr);

  const open = new Set<number>();
  open.add(sIdx);

  while (open.size > 0) {
    let cur = -1;
    let bestF = Infinity;
    for (const idx of open) {
      if (fScore[idx] < bestF) { bestF = fScore[idx]; cur = idx; }
    }

    if (cur === eIdx) {
      const path: { x: number; z: number }[] = [];
      let n = cur;
      while (n !== sIdx) {
        const r = Math.floor(n / G);
        const c = n % G;
        path.unshift({ x: c * C + C / 2, z: r * C + C / 2 });
        n = cameFrom[n];
        if (n < 0) break;
      }
      if (path.length > 0) path[path.length - 1] = { x: toX, z: toZ };
      else path.push({ x: toX, z: toZ });
      return path;
    }

    open.delete(cur);
    closed[cur] = 1;
    const cr = Math.floor(cur / G);
    const cc = cur % G;

    for (const d of dirs) {
      const nx = cc + d.dx;
      const nz = cr + d.dz;
      if (nx < 0 || nx >= G || nz < 0 || nz >= G) continue;
      const nIdx = nz * G + nx;
      if (closed[nIdx]) continue;
      const threat = grid[nIdx * 3];
      const tentG = gScore[cur] + d.c + threat * THREAT_WEIGHT;
      if (tentG < gScore[nIdx]) {
        cameFrom[nIdx] = cur;
        gScore[nIdx] = tentG;
        fScore[nIdx] = tentG + h(nx, nz);
        open.add(nIdx);
      }
    }
  }

  return [{ x: toX, z: toZ }];
}

export function getInfluenceThreat(grid: Float32Array, x: number, z: number): number {
  const G = INFLUENCE_GRID;
  const C = INFLUENCE_CELL;
  const cx = Math.min(G - 1, Math.max(0, Math.floor(x / C)));
  const cz = Math.min(G - 1, Math.max(0, Math.floor(z / C)));
  return grid[(cz * G + cx) * 3];
}

export function getInfluenceValue(grid: Float32Array, x: number, z: number): number {
  const G = INFLUENCE_GRID;
  const C = INFLUENCE_CELL;
  const cx = Math.min(G - 1, Math.max(0, Math.floor(x / C)));
  const cz = Math.min(G - 1, Math.max(0, Math.floor(z / C)));
  return grid[(cz * G + cx) * 3 + 1];
}
