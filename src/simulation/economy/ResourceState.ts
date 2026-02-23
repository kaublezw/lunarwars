export interface TeamResources {
  energy: number;
  matter: number;
  energyRate: number;
  matterRate: number;
}

export class ResourceState {
  private teams: TeamResources[];

  constructor(teamCount: number) {
    this.teams = [];
    for (let i = 0; i < teamCount; i++) {
      this.teams.push({ energy: 100, matter: 100, energyRate: 0, matterRate: 0 });
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

  spend(team: number, energy: number): boolean {
    if (!this.canAfford(team, energy)) return false;
    const t = this.teams[team];
    t.energy -= energy;
    return true;
  }

  addEnergy(team: number, amount: number): void {
    const t = this.teams[team];
    if (t) t.energy += amount;
  }

  addMatter(team: number, amount: number): void {
    const t = this.teams[team];
    if (t) t.matter += amount;
  }

  canAffordMatter(team: number, amount: number): boolean {
    const t = this.teams[team];
    if (!t) return false;
    return t.matter >= amount;
  }

  spendMatter(team: number, amount: number): boolean {
    if (!this.canAffordMatter(team, amount)) return false;
    const t = this.teams[team];
    t.matter -= amount;
    return true;
  }

  serialize(): TeamResources[] {
    return this.teams.map(t => ({ ...t }));
  }

  deserialize(data: TeamResources[]): void {
    this.teams = data.map(t => ({ ...t }));
  }

  setRates(team: number, energyRate: number, matterRate: number): void {
    const t = this.teams[team];
    if (t) {
      t.energyRate = energyRate;
      t.matterRate = matterRate;
    }
  }
}
