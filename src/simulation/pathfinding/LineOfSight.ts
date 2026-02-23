/**
 * Bresenham line walk checking every tile for walkability.
 * Returns true if every tile from (x0,z0) to (x1,z1) is walkable.
 */
export function hasLineOfSight(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  isWalkable: (tx: number, tz: number) => boolean,
): boolean {
  let dx = Math.abs(x1 - x0);
  let dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;

  while (true) {
    if (!isWalkable(x0, z0)) return false;
    if (x0 === x1 && z0 === z1) break;

    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      z0 += sz;
    }
  }

  return true;
}
