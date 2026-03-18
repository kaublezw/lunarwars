/** Tracks the beam rate upgrade level on a Supply Depot.
 *  Level 0 = default (10s interval), each level halves the interval. Max level 3. */
export interface BeamUpgradeComponent {
  level: number;
}

/** Cost per upgrade level: [level1, level2, level3] */
export const BEAM_UPGRADE_COSTS: { energy: number; matter: number }[] = [
  { energy: 75, matter: 50 },   // Level 0 -> 1 (10s -> 5s)
  { energy: 150, matter: 100 },  // Level 1 -> 2 (5s -> 2.5s)
  { energy: 300, matter: 200 },  // Level 2 -> 3 (2.5s -> 1.25s)
];

export const BEAM_UPGRADE_MAX_LEVEL = 3;
