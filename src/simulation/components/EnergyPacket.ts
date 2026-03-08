export interface EnergyPacketComponent {
  sourceEntity: number;  // Extractor entity ID
  targetEntity: number;  // HQ entity ID
  targetX: number;
  targetY: number;
  targetZ: number;
  speed: number;         // ~8 wu/s
  energyAmount: number;  // 50 energy per packet
  team: number;
}
