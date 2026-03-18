import type { World } from '@core/ECS';
import { RESOURCE_SILO, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import type { ResourceSiloComponent } from '@sim/components/ResourceSilo';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';

export interface TeamResources {
  energy: number;
  matter: number;
  energyRate: number;
  matterRate: number;
}

export class ResourceState {
  private teams: TeamResources[];
  private world: World | null = null;

  constructor(teamCount: number) {
    this.teams = [];
    for (let i = 0; i < teamCount; i++) {
      this.teams.push({ energy: 0, matter: 0, energyRate: 0, matterRate: 0 });
    }
  }

  setWorld(world: World): void {
    this.world = world;
  }

  /** Recalculate team totals from all physical silo entities.
   *  Global pool = sum of all RESOURCE_SILO stored amounts.
   *  Called once per tick before any system reads resources. */
  recalculate(): void {
    if (!this.world) return;
    const world = this.world;

    for (const t of this.teams) {
      t.energy = 0;
      t.matter = 0;
    }

    const silos = world.query(RESOURCE_SILO, TEAM);
    for (const e of silos) {
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team < 0 || team.team >= this.teams.length) continue;
      if (silo.resourceType === 'energy') {
        this.teams[team.team].energy += silo.stored;
      } else {
        this.teams[team.team].matter += silo.stored;
      }
    }
  }

  get(team: number): TeamResources {
    return this.teams[team];
  }

  canAfford(team: number, energy: number): boolean {
    const t = this.teams[team];
    if (!t) return false;
    return t.energy >= energy;
  }

  /** Spend energy. Returns the source silo entity ID, or -1 on failure. */
  spend(team: number, energy: number): boolean {
    if (!this.canAfford(team, energy)) return false;
    if (!this.world) return false;
    this.lastSourceSilo = this.deductFromSilos(this.world, team, 'energy', energy);
    this.teams[team].energy -= energy;
    return true;
  }

  /** Entity ID of the silo most recently deducted from (for beam visuals). */
  lastSourceSilo = -1;

  canAffordMatter(team: number, amount: number): boolean {
    const t = this.teams[team];
    if (!t) return false;
    return t.matter >= amount;
  }

  /** Spend matter. Sets lastSourceSilo to the silo deducted from. */
  spendMatter(team: number, amount: number): boolean {
    if (!this.canAffordMatter(team, amount)) return false;
    if (!this.world) return false;
    this.lastSourceSilo = this.deductFromSilos(this.world, team, 'matter', amount);
    this.teams[team].matter -= amount;
    return true;
  }

  /** Add energy to an existing silo. Falls back to cached total if no world/silo. */
  addEnergy(team: number, amount: number): void {
    if (this.world) {
      this.depositToSilo(this.world, team, 'energy', amount);
    } else {
      const t = this.teams[team];
      if (t) t.energy += amount;
    }
  }

  /** Add matter to an existing silo. Falls back to cached total if no world/silo. */
  addMatter(team: number, amount: number): void {
    if (this.world) {
      this.depositToSilo(this.world, team, 'matter', amount);
    } else {
      const t = this.teams[team];
      if (t) t.matter += amount;
    }
  }

  setRates(team: number, energyRate: number, matterRate: number): void {
    const t = this.teams[team];
    if (t) {
      t.energyRate = energyRate;
      t.matterRate = matterRate;
    }
  }

  serialize(): TeamResources[] {
    return this.teams.map(t => ({ ...t }));
  }

  deserialize(data: TeamResources[]): void {
    this.teams = data.map(t => ({ ...t }));
  }

  /** Deduct from silos. Returns the entity ID of the first silo deducted from (-1 if none). */
  private deductFromSilos(world: World, team: number, type: 'energy' | 'matter', amount: number): number {
    let remaining = amount;
    let firstSilo = -1;
    const silos = world.query(RESOURCE_SILO, TEAM);
    for (const e of silos) {
      if (remaining <= 0) break;
      const sTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (sTeam.team !== team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      if (silo.resourceType !== type) continue;
      const take = Math.min(silo.stored, remaining);
      if (take > 0) {
        silo.stored -= take;
        remaining -= take;
        if (firstSilo === -1) firstSilo = e;
      }
    }
    return firstSilo;
  }

  private depositToSilo(world: World, team: number, type: 'energy' | 'matter', amount: number): void {
    let remaining = amount;
    const silos = world.query(RESOURCE_SILO, TEAM);
    for (const e of silos) {
      if (remaining <= 0) break;
      const sTeam = world.getComponent<TeamComponent>(e, TEAM)!;
      if (sTeam.team !== team) continue;
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;
      const silo = world.getComponent<ResourceSiloComponent>(e, RESOURCE_SILO)!;
      if (silo.resourceType !== type) continue;
      const space = silo.capacity - silo.stored;
      const deposit = Math.min(space, remaining);
      silo.stored += deposit;
      remaining -= deposit;
    }
    // If remaining, it's lost (no available silo with space)
  }
}
