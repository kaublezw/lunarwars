export interface EnergyPacketComponent {
  sourceEntity: number;  // Source building entity ID
  targetEntity: number;  // Destination building entity ID
  targetX: number;
  targetY: number;
  targetZ: number;
  speed: number;         // ~12 wu/s
  energyAmount: number;  // 0 = visual only
  team: number;
  /** When true, packet hovers above a construction site until building completes */
  hovering: boolean;
}
