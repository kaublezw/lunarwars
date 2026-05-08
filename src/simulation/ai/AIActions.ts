import {
  POSITION, HEALTH, TEAM,
  BUILDING, BUILD_COMMAND, MOVE_COMMAND,
  RESUPPLY_SEEK, REPAIR_COMMAND, DEPOT_RADIUS,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';
import type { TeamComponent } from '@sim/components/Team';
import type { BuildingComponent } from '@sim/components/Building';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';
import type { RepairCommandComponent } from '@sim/components/RepairCommand';

import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState, Squad } from '@sim/ai/AITypes';
import {
  RETREAT_HP_FRACTION, OVERWHELMING_ARMY,
  MEMORY_DECAY_TICKS,
  INFLUENCE_GRID, INFLUENCE_CELL, CASUALTY_TARGET_WEIGHT,
} from '@sim/ai/AITypes';

export function issueMove(ctx: AIContext, entity: number, x: number, z: number): void {
  x = Math.max(4, Math.min(252, x));
  z = Math.max(4, Math.min(252, z));

  if (ctx.world.hasComponent(entity, MOVE_COMMAND)) {
    ctx.world.removeComponent(entity, MOVE_COMMAND);
  }

  ctx.world.addComponent<MoveCommandComponent>(entity, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: x,
    destZ: z,
  });
}

export function sendSquadTo(ctx: AIContext, squad: Squad, x: number, z: number): void {
  for (const unitId of squad.unitIds) {
    if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
    const existing = ctx.world.getComponent<MoveCommandComponent>(unitId, MOVE_COMMAND);
    if (existing) {
      const dx = existing.destX - x;
      const dz = existing.destZ - z;
      if (dx * dx + dz * dz < 25) continue;
    }
    issueMove(ctx, unitId, x, z);
  }
}

export function retreatWounded(ctx: AIContext, squad: Squad): void {
  const depotEntities: number[] = [];

  const buildings = ctx.world.query(DEPOT_RADIUS, BUILDING, TEAM, POSITION, HEALTH);
  for (const e of buildings) {
    const team = ctx.world.getComponent<TeamComponent>(e, TEAM)!;
    if (team.team !== ctx.team) continue;
    const health = ctx.world.getComponent<HealthComponent>(e, HEALTH)!;
    if (health.dead) continue;
    depotEntities.push(e);
  }

  for (const unitId of squad.unitIds) {
    if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
    const health = ctx.world.getComponent<HealthComponent>(unitId, HEALTH);
    if (!health) continue;
    if (health.current / health.max < RETREAT_HP_FRACTION) {
      if (depotEntities.length > 0) {
        const pos = ctx.world.getComponent<PositionComponent>(unitId, POSITION);
        if (!pos) continue;
        let bestDepot = depotEntities[0];
        let bestDistSq = Infinity;
        for (const depot of depotEntities) {
          const depotPos = ctx.world.getComponent<PositionComponent>(depot, POSITION);
          if (!depotPos) continue;
          const dx = depotPos.x - pos.x;
          const dz = depotPos.z - pos.z;
          const distSq = dx * dx + dz * dz;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestDepot = depot;
          }
        }
        const depotPos = ctx.world.getComponent<PositionComponent>(bestDepot, POSITION);
        if (depotPos) {
          issueMove(ctx, unitId, depotPos.x, depotPos.z);
          continue;
        }
      }
      issueMove(ctx, unitId, ctx.baseX, ctx.baseZ);
    }
  }
}

function buildingTypeWeight(bt: BuildingType): number {
  switch (bt) {
    case BuildingType.HQ: return 6;
    case BuildingType.EnergyExtractor: return 10;
    case BuildingType.SupplyDepot: return 8;
    case BuildingType.DroneFactory: return 5;
    case BuildingType.MatterPlant: return 4;
    default: return 1;
  }
}

function casualtyAtPoint(casualtyGrid: Float32Array | undefined, x: number, z: number): number {
  if (!casualtyGrid) return 0;
  const G = INFLUENCE_GRID;
  const C = INFLUENCE_CELL;
  const cx = Math.min(G - 1, Math.max(0, Math.floor(x / C)));
  const cz = Math.min(G - 1, Math.max(0, Math.floor(z / C)));
  return casualtyGrid[cz * G + cx];
}

export function pickAttackTarget(
  ctx: AIContext,
  state: AIWorldState,
  casualtyGrid?: Float32Array,
): { x: number; z: number } | null {
  // Overwhelming army: still beeline for HQ if visible
  if (state.totalArmySize >= OVERWHELMING_ARMY) {
    for (const bldg of state.knownEnemyBuildings) {
      if (bldg.type === BuildingType.HQ) return { x: bldg.x, z: bldg.z };
    }
  }

  // Build scored candidate pool from all known visible enemies
  type Candidate = { x: number; z: number; score: number };
  const candidates: Candidate[] = [];

  const scoreCandidate = (x: number, z: number, typeWeight: number): number => {
    const dx = x - ctx.baseX;
    const dz = z - ctx.baseZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const proximity = 1 / (1 + dist / 100);
    const danger = casualtyAtPoint(casualtyGrid, x, z);
    return (typeWeight * proximity) / (1 + danger * CASUALTY_TARGET_WEIGHT);
  };

  for (const bldg of state.knownEnemyBuildings) {
    if (bldg.type === BuildingType.HQ) continue; // HQ only via overwhelming
    candidates.push({ x: bldg.x, z: bldg.z, score: scoreCandidate(bldg.x, bldg.z, buildingTypeWeight(bldg.type)) });
  }

  // Worker ferries (visible enemy units) — disruption priority
  for (const unit of state.knownEnemyUnits) {
    candidates.push({ x: unit.x, z: unit.z, score: scoreCandidate(unit.x, unit.z, 7) });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const topK = candidates.slice(0, Math.min(4, candidates.length));
    return weightedPick(ctx, topK);
  }

  // Fall back to remembered buildings (out of sight) scored by typeScore * freshness, with casualty penalty
  if (state.rememberedEnemyBuildings.length > 0) {
    type MemCandidate = { x: number; z: number; score: number };
    const memCandidates: MemCandidate[] = [];
    for (const entry of state.rememberedEnemyBuildings) {
      if (!entry.buildingType) continue;
      const freshness = Math.max(0, 1 - (ctx.totalTicks - entry.lastSeenTick) / MEMORY_DECAY_TICKS);
      if (freshness <= 0) continue;
      const danger = casualtyAtPoint(casualtyGrid, entry.x, entry.z);
      const score = (buildingTypeWeight(entry.buildingType) * freshness) / (1 + danger * CASUALTY_TARGET_WEIGHT);
      memCandidates.push({ x: entry.x, z: entry.z, score });
    }
    if (memCandidates.length > 0) {
      memCandidates.sort((a, b) => b.score - a.score);
      const topK = memCandidates.slice(0, Math.min(3, memCandidates.length));
      return weightedPick(ctx, topK);
    }
  }

  return null;
}

function weightedPick(
  ctx: AIContext,
  candidates: { x: number; z: number; score: number }[],
): { x: number; z: number } {
  let total = 0;
  for (const c of candidates) total += Math.max(0, c.score);
  if (total <= 0) return { x: candidates[0].x, z: candidates[0].z };
  let r = ctx.rng.next() * total;
  for (const c of candidates) {
    r -= Math.max(0, c.score);
    if (r <= 0) return { x: c.x, z: c.z };
  }
  return { x: candidates[candidates.length - 1].x, z: candidates[candidates.length - 1].z };
}

export function assignRepair(ctx: AIContext, worker: number, buildingEntity: number): void {
  // Cancel existing commands
  if (ctx.world.hasComponent(worker, BUILD_COMMAND)) {
    ctx.world.removeComponent(worker, BUILD_COMMAND);
  }
  if (ctx.world.hasComponent(worker, RESUPPLY_SEEK)) {
    ctx.world.removeComponent(worker, RESUPPLY_SEEK);
  }
  if (ctx.world.hasComponent(worker, REPAIR_COMMAND)) {
    ctx.world.removeComponent(worker, REPAIR_COMMAND);
  }

  const buildingPos = ctx.world.getComponent<PositionComponent>(buildingEntity, POSITION)!;

  ctx.world.addComponent<RepairCommandComponent>(worker, REPAIR_COMMAND, {
    targetEntity: buildingEntity,
    state: 'moving',
  });

  if (ctx.world.hasComponent(worker, MOVE_COMMAND)) {
    ctx.world.removeComponent(worker, MOVE_COMMAND);
  }
  ctx.world.addComponent<MoveCommandComponent>(worker, MOVE_COMMAND, {
    path: [],
    currentWaypoint: 0,
    destX: buildingPos.x,
    destZ: buildingPos.z,
  });
}
