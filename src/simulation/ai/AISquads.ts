import {
  POSITION, UNIT_TYPE, HEALTH, MOVE_COMMAND, RESUPPLY_SEEK,
} from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { UnitTypeComponent } from '@sim/components/UnitType';
import type { HealthComponent } from '@sim/components/Health';
import type { MoveCommandComponent } from '@sim/components/MoveCommand';

import { UnitCategory } from '@sim/components/UnitType';
import { BuildingType } from '@sim/components/Building';

import type { AIContext, AIWorldState, Squad, AttackState } from '@sim/ai/AITypes';
import {
  DEFENSE_SQUAD_SIZE, HARASS_SQUAD_SIZE, MIN_MAIN_ARMY_FOR_HARASS,
  DEFENSE_RADIUS, ATTACK_THRESHOLD, REATTACK_THRESHOLD,
  REATTACK_COOLDOWN_TICKS, FORCE_ATTACK_TICKS, STAGING_RADIUS,
  STAGING_READY_FRACTION,
} from '@sim/ai/AITypes';
import { issueMove, sendSquadTo, retreatWounded, pickAttackTarget } from '@sim/ai/AIActions';
import { findInfluenceAwarePath, getInfluenceThreat, getInfluenceValue } from '@sim/ai/AIInfluence';

export function getSquadCentroid(ctx: AIContext, squad: Squad): { x: number; z: number } {
  let sx = 0, sz = 0, count = 0;
  for (const id of squad.unitIds) {
    const pos = ctx.world.getComponent<PositionComponent>(id, POSITION);
    if (!pos) continue;
    sx += pos.x;
    sz += pos.z;
    count++;
  }
  if (count === 0) return { x: ctx.baseX, z: ctx.baseZ };
  return { x: sx / count, z: sz / count };
}

export function findHarassTarget(
  state: AIWorldState,
  influenceGrid: Float32Array,
): { x: number; z: number } | null {
  const allTargets: { x: number; z: number; type: BuildingType }[] = [];
  for (const b of state.knownEnemyBuildings) {
    allTargets.push({ x: b.x, z: b.z, type: b.type });
  }
  for (const entry of state.rememberedEnemyBuildings) {
    if (entry.buildingType) {
      allTargets.push({ x: entry.x, z: entry.z, type: entry.buildingType });
    }
  }
  if (allTargets.length === 0) return null;

  let bestTarget: { x: number; z: number } | null = null;
  let bestScore = -Infinity;

  for (const t of allTargets) {
    if (t.type !== BuildingType.EnergyExtractor && t.type !== BuildingType.MatterPlant) continue;
    const value = getInfluenceValue(influenceGrid, t.x, t.z);
    const threat = getInfluenceThreat(influenceGrid, t.x, t.z);
    let score = value - threat * 2;
    // Prefer extractors over matter plants
    if (t.type === BuildingType.EnergyExtractor) score += 3.0;
    if (score > bestScore) {
      bestScore = score;
      bestTarget = { x: t.x, z: t.z };
    }
  }

  return bestTarget;
}

export interface SquadUpdateResult {
  squads: Squad[];
  nextSquadId: number;
}

export function updateSquads(
  ctx: AIContext,
  state: AIWorldState,
  squads: Squad[],
  nextSquadId: number,
): SquadUpdateResult {
  let currentSquads = [...squads];
  let currentNextId = nextSquadId;

  // 1. Prune dead units from squads
  for (const squad of currentSquads) {
    squad.unitIds = squad.unitIds.filter(id => {
      const hp = ctx.world.getComponent<HealthComponent>(id, HEALTH);
      return hp && !hp.dead;
    });
  }

  // 2. Remove empty squads (keep main even if empty)
  currentSquads = currentSquads.filter(s => s.unitIds.length > 0 || s.type === 'main');

  // Build set of units already in squads
  const assigned = new Set<number>();
  for (const squad of currentSquads) {
    for (const id of squad.unitIds) assigned.add(id);
  }

  // Aerial units beyond the 2 scouts are army-eligible
  const armyAerial = state.myAerial.slice(2);

  // 3. Ensure defense squad exists (if total army >= 6)
  let defenseSquad = currentSquads.find(s => s.type === 'defense');
  if (state.totalArmySize >= 6 && !defenseSquad) {
    defenseSquad = {
      id: currentNextId++, type: 'defense', mission: 'defend',
      unitIds: [], targetX: ctx.baseX, targetZ: ctx.baseZ,
      state: 'idle', stagingTimer: 0, waypoints: [], waypointIdx: 0,
    };
    currentSquads.push(defenseSquad);
  }

  // Scale defense squad with remote extractors
  const extractorCount = (state.myBuildings.get(BuildingType.EnergyExtractor) ?? []).length;
  const remoteExtractors = Math.max(0, extractorCount - 1);
  const dynamicDefenseSize = Math.min(8, DEFENSE_SQUAD_SIZE + Math.floor(remoteExtractors / 2));

  // Fill defense squad up to dynamic size with combat drones close to base
  if (defenseSquad && defenseSquad.unitIds.length < dynamicDefenseSize) {
    const candidates = state.myCombat
      .filter(id => !assigned.has(id) && !ctx.world.hasComponent(id, RESUPPLY_SEEK))
      .filter(id => {
        const ut = ctx.world.getComponent<UnitTypeComponent>(id, UNIT_TYPE);
        return ut && ut.category === UnitCategory.CombatDrone;
      })
      .map(id => {
        const pos = ctx.world.getComponent<PositionComponent>(id, POSITION);
        const dx = pos ? pos.x - ctx.baseX : 999;
        const dz = pos ? pos.z - ctx.baseZ : 999;
        return { id, dist: dx * dx + dz * dz };
      })
      .sort((a, b) => a.dist - b.dist);

    const needed = dynamicDefenseSize - defenseSquad.unitIds.length;
    for (let i = 0; i < Math.min(needed, candidates.length); i++) {
      defenseSquad.unitIds.push(candidates[i].id);
      assigned.add(candidates[i].id);
    }
  }

  // Dissolve defense squad if army shrinks below 6
  if (defenseSquad && state.totalArmySize < 6) {
    currentSquads = currentSquads.filter(s => s !== defenseSquad);
    defenseSquad = undefined;
  }

  // 4. Ensure harass squad (if army >= MIN_MAIN_ARMY_FOR_HARASS)
  let harassSquad = currentSquads.find(s => s.type === 'harass');
  if (state.totalArmySize >= MIN_MAIN_ARMY_FOR_HARASS && !harassSquad) {
    harassSquad = {
      id: currentNextId++, type: 'harass', mission: 'harass',
      unitIds: [], targetX: -1, targetZ: -1,
      state: 'idle', stagingTimer: 0, waypoints: [], waypointIdx: 0,
    };
    currentSquads.push(harassSquad);
  }

  // Fill harass squad: prefer aerial drones, then combat drones
  if (harassSquad && harassSquad.unitIds.length < HARASS_SQUAD_SIZE) {
    const aerials = armyAerial.filter(id => !assigned.has(id) && !ctx.world.hasComponent(id, RESUPPLY_SEEK));
    const combats = state.myCombat.filter(id => !assigned.has(id) && !ctx.world.hasComponent(id, RESUPPLY_SEEK));
    const pool = [...aerials, ...combats];

    const needed = HARASS_SQUAD_SIZE - harassSquad.unitIds.length;
    for (let i = 0; i < Math.min(needed, pool.length); i++) {
      harassSquad.unitIds.push(pool[i]);
      assigned.add(pool[i]);
    }
  }

  // Dissolve harass squad if too small
  if (harassSquad && harassSquad.unitIds.length < 2) {
    currentSquads = currentSquads.filter(s => s !== harassSquad);
    harassSquad = undefined;
  }

  // 5. Main army: ensure exists, assign all remaining
  let mainSquad = currentSquads.find(s => s.type === 'main');
  if (!mainSquad) {
    mainSquad = {
      id: currentNextId++, type: 'main', mission: 'idle',
      unitIds: [], targetX: ctx.rallyX, targetZ: ctx.rallyZ,
      state: 'idle', stagingTimer: 0, waypoints: [], waypointIdx: 0,
    };
    currentSquads.push(mainSquad);
  }

  // Collect IDs in other squads
  const otherSquadUnits = new Set<number>();
  for (const s of currentSquads) {
    if (s === mainSquad) continue;
    for (const id of s.unitIds) otherSquadUnits.add(id);
  }

  // Add unassigned combat/aerial to main
  const remaining = [...state.myCombat, ...armyAerial].filter(
    id => !assigned.has(id) && !otherSquadUnits.has(id) && !ctx.world.hasComponent(id, RESUPPLY_SEEK)
  );
  for (const id of remaining) {
    if (!mainSquad.unitIds.includes(id)) {
      mainSquad.unitIds.push(id);
    }
  }

  // Prune main squad: remove units claimed by other squads or dead
  mainSquad.unitIds = mainSquad.unitIds.filter(id => {
    if (otherSquadUnits.has(id)) return false;
    const hp = ctx.world.getComponent<HealthComponent>(id, HEALTH);
    return hp && !hp.dead;
  });

  return { squads: currentSquads, nextSquadId: currentNextId };
}

export function executeSquadOrders(
  ctx: AIContext,
  state: AIWorldState,
  squads: Squad[],
  influenceGrid: Float32Array,
  attackState: AttackState,
): void {
  for (const squad of squads) {
    switch (squad.type) {
      case 'defense': executeDefenseOrders(ctx, state, squad); break;
      case 'harass': executeHarassOrders(ctx, state, squad, influenceGrid); break;
      case 'main': executeMainOrders(ctx, state, squad, squads, influenceGrid, attackState); break;
    }
  }
}

function executeDefenseOrders(ctx: AIContext, state: AIWorldState, squad: Squad): void {
  // Priority 1: Defend base
  if (state.enemiesNearBase.length > 0) {
    const avgX = state.enemiesNearBase.reduce((s, e) => s + e.x, 0) / state.enemiesNearBase.length;
    const avgZ = state.enemiesNearBase.reduce((s, e) => s + e.z, 0) / state.enemiesNearBase.length;
    squad.state = 'engaged';
    sendSquadTo(ctx, squad, avgX, avgZ);
    return;
  }

  // Priority 2: Defend threatened extractors
  if (state.enemiesNearExtractors.length > 0) {
    // Find closest threatened extractor to squad centroid
    const centroid = getSquadCentroid(ctx, squad);
    let bestDistSq = Infinity;
    let targetX = state.enemiesNearExtractors[0].extractorX;
    let targetZ = state.enemiesNearExtractors[0].extractorZ;
    for (const threat of state.enemiesNearExtractors) {
      const dx = threat.extractorX - centroid.x;
      const dz = threat.extractorZ - centroid.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        targetX = threat.x;
        targetZ = threat.z;
      }
    }
    squad.state = 'engaged';
    sendSquadTo(ctx, squad, targetX, targetZ);
    return;
  }

  // Idle: patrol between extractors (or rally point if none)
  squad.state = 'idle';

  const extractorEntities = state.myBuildings.get(BuildingType.EnergyExtractor) ?? [];
  if (extractorEntities.length > 0) {
    // Build list of extractor positions
    const extractorPositions: { x: number; z: number }[] = [];
    for (const eid of extractorEntities) {
      const epos = ctx.world.getComponent<PositionComponent>(eid, POSITION);
      if (epos) extractorPositions.push({ x: epos.x, z: epos.z });
    }

    if (extractorPositions.length > 0) {
      // Clamp waypointIdx to valid range
      if (squad.waypointIdx >= extractorPositions.length) squad.waypointIdx = 0;
      const patrolTarget = extractorPositions[squad.waypointIdx];

      // Check if centroid is near the current patrol target
      const centroid = getSquadCentroid(ctx, squad);
      const pdx = centroid.x - patrolTarget.x;
      const pdz = centroid.z - patrolTarget.z;
      if (pdx * pdx + pdz * pdz < 10 * 10) {
        squad.waypointIdx = (squad.waypointIdx + 1) % extractorPositions.length;
      }

      const dest = extractorPositions[squad.waypointIdx];
      sendSquadTo(ctx, squad, dest.x, dest.z);
      return;
    }
  }

  // Fallback: rally point
  for (const unitId of squad.unitIds) {
    if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
    if (ctx.world.hasComponent(unitId, MOVE_COMMAND)) continue;
    const pos = ctx.world.getComponent<PositionComponent>(unitId, POSITION);
    if (!pos) continue;
    const dx = pos.x - ctx.rallyX;
    const dz = pos.z - ctx.rallyZ;
    if (dx * dx + dz * dz > DEFENSE_RADIUS * DEFENSE_RADIUS) {
      issueMove(ctx, unitId, ctx.rallyX, ctx.rallyZ);
    }
  }
}

function executeHarassOrders(
  ctx: AIContext,
  state: AIWorldState,
  squad: Squad,
  influenceGrid: Float32Array,
): void {
  if (squad.targetX < 0 || squad.state === 'idle') {
    const target = findHarassTarget(state, influenceGrid);
    if (target) {
      squad.targetX = target.x;
      squad.targetZ = target.z;
      squad.state = 'moving';
      const centroid = getSquadCentroid(ctx, squad);
      squad.waypoints = findInfluenceAwarePath(influenceGrid, centroid.x, centroid.z, target.x, target.z);
      squad.waypointIdx = 0;
    } else {
      for (const unitId of squad.unitIds) {
        if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
        if (ctx.world.hasComponent(unitId, MOVE_COMMAND)) continue;
        issueMove(ctx, unitId, ctx.rallyX, ctx.rallyZ);
      }
      return;
    }
  }

  if (squad.waypoints.length > 0 && squad.waypointIdx < squad.waypoints.length) {
    const centroid = getSquadCentroid(ctx, squad);
    const wp = squad.waypoints[squad.waypointIdx];
    const dx = centroid.x - wp.x;
    const dz = centroid.z - wp.z;
    if (dx * dx + dz * dz < 100) {
      squad.waypointIdx++;
    }
    if (squad.waypointIdx < squad.waypoints.length) {
      sendSquadTo(ctx, squad, squad.waypoints[squad.waypointIdx].x, squad.waypoints[squad.waypointIdx].z);
    } else {
      squad.state = 'engaged';
      sendSquadTo(ctx, squad, squad.targetX, squad.targetZ);
    }
  } else {
    sendSquadTo(ctx, squad, squad.targetX, squad.targetZ);
  }

  if (squad.state === 'engaged') {
    const centroid = getSquadCentroid(ctx, squad);
    const dx = centroid.x - squad.targetX;
    const dz = centroid.z - squad.targetZ;
    if (dx * dx + dz * dz < 100) {
      squad.state = 'idle';
      squad.targetX = -1;
      squad.targetZ = -1;
    }
  }
}

function executeMainOrders(
  ctx: AIContext,
  state: AIWorldState,
  squad: Squad,
  allSquads: Squad[],
  influenceGrid: Float32Array,
  attack: AttackState,
): void {
  if (attack.reattackTimer > 0) attack.reattackTimer--;

  // If defense squad exists, main army does NOT abort for base defense
  const defenseSquad = allSquads.find(s => s.type === 'defense');
  if (!defenseSquad && state.enemiesNearBase.length > 0) {
    attack.attackPhase = 'idle';
    const avgX = state.enemiesNearBase.reduce((s, e) => s + e.x, 0) / state.enemiesNearBase.length;
    const avgZ = state.enemiesNearBase.reduce((s, e) => s + e.z, 0) / state.enemiesNearBase.length;
    sendSquadTo(ctx, squad, avgX, avgZ);
    return;
  }

  const armySize = squad.unitIds.length;

  // Trickle fix: abort attack if army decimated
  if (attack.attackPhase !== 'idle' && armySize < 5) {
    attack.attackPhase = 'idle';
    attack.reattackTimer = REATTACK_COOLDOWN_TICKS;
  }

  // Staging phase
  if (attack.attackPhase === 'staging' && armySize > 0) {
    attack.stagingTimer++;
    let nearStaging = 0;
    let totalActive = 0;

    for (const unitId of squad.unitIds) {
      if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
      totalActive++;
      const pos = ctx.world.getComponent<PositionComponent>(unitId, POSITION);
      if (!pos) continue;
      const dx = pos.x - attack.stagingX;
      const dz = pos.z - attack.stagingZ;
      if (dx * dx + dz * dz < STAGING_RADIUS * STAGING_RADIUS) nearStaging++;
    }

    const readyFraction = totalActive > 0 ? nearStaging / totalActive : 0;
    if (readyFraction >= STAGING_READY_FRACTION || attack.stagingTimer >= 60) {
      attack.attackPhase = 'attacking';
      const centroid = getSquadCentroid(ctx, squad);
      squad.waypoints = findInfluenceAwarePath(influenceGrid, centroid.x, centroid.z, attack.attackTargetX, attack.attackTargetZ);
      squad.waypointIdx = 0;
      retreatWounded(ctx, squad);
      return;
    }

    sendSquadTo(ctx, squad, attack.stagingX, attack.stagingZ);
    return;
  }

  // Continue attack
  if (attack.attackPhase === 'attacking' && armySize > 0) {
    const hasVisibleTargets = state.knownEnemyBuildings.length > 0 || state.knownEnemyUnits.length > 0;
    if (hasVisibleTargets) {
      const target = pickAttackTarget(ctx, state);
      if (target) {
        attack.attackTargetX = target.x;
        attack.attackTargetZ = target.z;
      }
    }

    if (squad.waypoints.length > 0 && squad.waypointIdx < squad.waypoints.length) {
      const centroid = getSquadCentroid(ctx, squad);
      const wp = squad.waypoints[squad.waypointIdx];
      const dx = centroid.x - wp.x;
      const dz = centroid.z - wp.z;
      if (dx * dx + dz * dz < 225) {
        squad.waypointIdx++;
      }
      if (squad.waypointIdx < squad.waypoints.length) {
        sendSquadTo(ctx, squad, squad.waypoints[squad.waypointIdx].x, squad.waypoints[squad.waypointIdx].z);
      } else {
        sendSquadTo(ctx, squad, attack.attackTargetX, attack.attackTargetZ);
      }
    } else {
      sendSquadTo(ctx, squad, attack.attackTargetX, attack.attackTargetZ);
    }

    retreatWounded(ctx, squad);
    return;
  }

  // Launch attack
  const effectiveThreshold = attack.reattackTimer === 0 ? REATTACK_THRESHOLD : ATTACK_THRESHOLD;
  const forceAttack = attack.forceAttackTimer >= FORCE_ATTACK_TICKS && armySize > 0;

  if (armySize >= effectiveThreshold || forceAttack) {
    const target = pickAttackTarget(ctx, state);
    const fallback = ctx.team === 0 ? 192 : 64;
    const targetX = target ? target.x : fallback;
    const targetZ = target ? target.z : fallback;

    attack.attackTargetX = targetX;
    attack.attackTargetZ = targetZ;
    attack.reattackTimer = -1;
    attack.forceAttackTimer = 0;

    // Staging point: 70% of the way from centroid to target
    const centroid = getSquadCentroid(ctx, squad);
    const dx = targetX - centroid.x;
    const dz = targetZ - centroid.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const angle = Math.atan2(dz, dx);
    const stagingDist = dist * 0.7;

    let proposedX = centroid.x + Math.cos(angle) * stagingDist;
    let proposedZ = centroid.z + Math.sin(angle) * stagingDist;
    proposedX = Math.max(20, Math.min(236, proposedX));
    proposedZ = Math.max(20, Math.min(236, proposedZ));

    if (!ctx.terrain.isPassable(Math.round(proposedX), Math.round(proposedZ))) {
      proposedX -= Math.cos(angle) * 15;
      proposedZ -= Math.sin(angle) * 15;
    }

    attack.stagingX = proposedX;
    attack.stagingZ = proposedZ;
    attack.stagingTimer = 0;
    attack.attackPhase = 'staging';

    sendSquadTo(ctx, squad, attack.stagingX, attack.stagingZ);
    return;
  }

  // Rally idle units near base
  for (const unitId of squad.unitIds) {
    if (ctx.world.hasComponent(unitId, RESUPPLY_SEEK)) continue;
    if (ctx.world.hasComponent(unitId, MOVE_COMMAND)) continue;

    const pos = ctx.world.getComponent<PositionComponent>(unitId, POSITION);
    if (!pos) continue;

    const dx = pos.x - ctx.rallyX;
    const dz = pos.z - ctx.rallyZ;
    if (dx * dx + dz * dz > 100) {
      issueMove(ctx, unitId, ctx.rallyX, ctx.rallyZ);
    }
  }
}
