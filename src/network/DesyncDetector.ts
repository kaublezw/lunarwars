import type { World } from '@core/ECS';
import type { ResourceState } from '@sim/economy/ResourceState';
import { POSITION, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { HealthComponent } from '@sim/components/Health';

const CHECK_INTERVAL = 300; // ticks (~5 seconds at 60Hz)

// FNV-1a hash
function fnv1a(data: number[]): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export class DesyncDetector {
  private lastCheckTick = 0;
  private sendChecksum: ((tick: number, checksum: number) => void) | null = null;
  private remoteChecksums = new Map<number, number>();

  onDesyncDetected: ((tick: number, local: number, remote: number) => void) | null = null;

  setSendFn(fn: (tick: number, checksum: number) => void): void {
    this.sendChecksum = fn;
  }

  addRemoteChecksum(tick: number, checksum: number): void {
    this.remoteChecksums.set(tick, checksum);
  }

  /** Call each tick. Computes + sends checksum every CHECK_INTERVAL ticks. */
  update(tick: number, world: World, resources: ResourceState): void {
    if (tick - this.lastCheckTick < CHECK_INTERVAL) return;
    this.lastCheckTick = tick;

    const checksum = this.computeChecksum(world, resources, tick);
    this.sendChecksum?.(tick, checksum);

    // Check for remote checksum at this tick
    const remote = this.remoteChecksums.get(tick);
    if (remote !== undefined) {
      if (remote !== checksum) {
        console.warn(`DESYNC at tick ${tick}: local=${checksum}, remote=${remote}`);
        this.onDesyncDetected?.(tick, checksum, remote);
      }
      this.remoteChecksums.delete(tick);
    }

    // Prune old remote checksums
    for (const [t] of this.remoteChecksums) {
      if (t < tick - CHECK_INTERVAL * 2) this.remoteChecksums.delete(t);
    }
  }

  private computeChecksum(world: World, resources: ResourceState, tick: number): number {
    const data: number[] = [tick];

    // Hash entity positions and health
    const entities = world.query(POSITION, HEALTH);
    for (const e of entities) {
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      const hp = world.getComponent<HealthComponent>(e, HEALTH)!;
      // Truncate to 2 decimal places to reduce floating point noise
      data.push(e);
      data.push(Math.round(pos.x * 100));
      data.push(Math.round(pos.z * 100));
      data.push(Math.round(hp.current));
    }

    // Hash resource state
    for (let team = 0; team < 2; team++) {
      const rs = resources.get(team);
      data.push(Math.round(rs.energy));
      data.push(Math.round(rs.matter));
    }

    return fnv1a(data);
  }
}
