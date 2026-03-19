import type { TerrainData } from './TerrainData';
import { snapToGrid } from './GridConstants';

export interface EnergyNode {
  x: number;
  z: number;
}

export interface OreDeposit {
  x: number;
  z: number;
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state >>> 0;
}

export function generateEnergyNodes(terrain: TerrainData, seed: number): EnergyNode[] {
  let rng = (seed * 6271) >>> 0 || 1;
  const next = (): number => {
    rng = xorshift32(rng);
    return rng / 0xffffffff;
  };

  const nodes: EnergyNode[] = [];
  const MIN_DIST = 20;
  const TARGET_COUNT = 8 + Math.floor(next() * 5); // 8-12

  const flatZones = terrain.getFlatZones();

  // Place nodes near flat zones first (offset 5-15 units from center)
  for (const zone of flatZones) {
    for (let attempt = 0; attempt < 20 && nodes.length < TARGET_COUNT; attempt++) {
      const angle = next() * Math.PI * 2;
      const dist = 5 + next() * 10; // 5-15 units from center
      const x = snapToGrid(zone.x + Math.cos(angle) * dist);
      const z = snapToGrid(zone.z + Math.sin(angle) * dist);

      if (x < 2 || x > 254 || z < 2 || z > 254) continue;
      if (!terrain.isFlatTile(Math.floor(x), Math.floor(z))) continue;
      if (!isFarEnough(nodes, x, z, MIN_DIST)) continue;

      nodes.push({ x, z });
      break; // One per flat zone per pass
    }
  }

  // Fill remaining with scattered positions (some on hilltops/crater rims)
  let globalAttempts = 0;
  while (nodes.length < TARGET_COUNT && globalAttempts < 200) {
    globalAttempts++;

    const x = snapToGrid(10 + next() * 236);
    const z = snapToGrid(10 + next() * 236);

    if (!terrain.isFlatTile(Math.floor(x), Math.floor(z))) continue;
    if (!isFarEnough(nodes, x, z, MIN_DIST)) continue;

    nodes.push({ x, z });
  }

  return nodes;
}

export function generateOreDeposits(terrain: TerrainData, seed: number, energyNodes: EnergyNode[]): OreDeposit[] {
  let rng = (seed * 8431) >>> 0 || 1;
  const next = (): number => {
    rng = xorshift32(rng);
    return rng / 0xffffffff;
  };

  const deposits: OreDeposit[] = [];
  const MIN_DIST = 20;
  const MIN_ENERGY_DIST = 10; // min distance from any energy node
  const TARGET_COUNT = 8 + Math.floor(next() * 5); // 8-12

  const flatZones = terrain.getFlatZones();

  const isFarFromEnergy = (x: number, z: number): boolean => {
    for (const node of energyNodes) {
      const dx = node.x - x;
      const dz = node.z - z;
      if (dx * dx + dz * dz < MIN_ENERGY_DIST * MIN_ENERGY_DIST) return false;
    }
    return true;
  };

  // Place deposits near flat zones first
  for (const zone of flatZones) {
    for (let attempt = 0; attempt < 20 && deposits.length < TARGET_COUNT; attempt++) {
      const angle = next() * Math.PI * 2;
      const dist = 5 + next() * 10;
      const x = snapToGrid(zone.x + Math.cos(angle) * dist);
      const z = snapToGrid(zone.z + Math.sin(angle) * dist);

      if (x < 2 || x > 254 || z < 2 || z > 254) continue;
      if (!terrain.isFlatTile(Math.floor(x), Math.floor(z))) continue;
      if (!isFarEnough(deposits, x, z, MIN_DIST)) continue;
      if (!isFarFromEnergy(x, z)) continue;

      deposits.push({ x, z });
      break;
    }
  }

  // Fill remaining with scattered positions
  let globalAttempts = 0;
  while (deposits.length < TARGET_COUNT && globalAttempts < 200) {
    globalAttempts++;
    const x = snapToGrid(10 + next() * 236);
    const z = snapToGrid(10 + next() * 236);

    if (!terrain.isFlatTile(Math.floor(x), Math.floor(z))) continue;
    if (!isFarEnough(deposits, x, z, MIN_DIST)) continue;
    if (!isFarFromEnergy(x, z)) continue;

    deposits.push({ x, z });
  }

  return deposits;
}

function isFarEnough(nodes: EnergyNode[], x: number, z: number, minDist: number): boolean {
  for (const node of nodes) {
    const dx = node.x - x;
    const dz = node.z - z;
    if (dx * dx + dz * dz < minDist * minDist) return false;
  }
  return true;
}
