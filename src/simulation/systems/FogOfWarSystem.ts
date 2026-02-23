import type { World } from '@core/ECS';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

export class FogOfWarSystem {
  readonly name = 'FogOfWarSystem';

  constructor(private fogState: FogOfWarState) {}

  update(world: World, _dt: number): void {
    this.fogState.update(world);
  }
}
