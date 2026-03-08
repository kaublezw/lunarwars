import type { System, World } from '@core/ECS';
import { BUILDING, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import { BuildingType } from '@sim/components/Building';
import type { BuildingComponent } from '@sim/components/Building';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';

export class GameOverSystem implements System {
  readonly name = 'GameOverSystem';
  private gameOver = false;
  private onGameOver: ((losingTeam: number) => void) | null = null;
  private deathTimer = 0;
  private losingTeam = -1;

  setCallback(cb: (losingTeam: number) => void): void {
    this.onGameOver = cb;
  }

  update(world: World, dt: number): void {
    if (this.gameOver) return;

    // If a dead HQ was already detected, count down the delay
    if (this.losingTeam >= 0) {
      this.deathTimer += dt;
      if (this.deathTimer >= 5.0) {
        this.gameOver = true;
        if (this.onGameOver) {
          this.onGameOver(this.losingTeam);
        }
      }
      return;
    }

    const entities = world.query(BUILDING, TEAM, HEALTH);
    for (const e of entities) {
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;

      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) {
        const team = world.getComponent<TeamComponent>(e, TEAM)!;
        this.losingTeam = team.team;
        this.deathTimer = 0;
        return;
      }
    }
  }
}
