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

  setCallback(cb: (losingTeam: number) => void): void {
    this.onGameOver = cb;
  }

  update(world: World, _dt: number): void {
    if (this.gameOver) return;

    const entities = world.query(BUILDING, TEAM, HEALTH);
    for (const e of entities) {
      const building = world.getComponent<BuildingComponent>(e, BUILDING)!;
      if (building.buildingType !== BuildingType.HQ) continue;

      const health = world.getComponent<HealthComponent>(e, HEALTH)!;
      if (health.dead) {
        const team = world.getComponent<TeamComponent>(e, TEAM)!;
        this.gameOver = true;
        if (this.onGameOver) {
          this.onGameOver(team.team);
        }
        return;
      }
    }
  }
}
