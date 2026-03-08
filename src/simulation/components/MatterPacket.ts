export interface MatterPacketComponent {
  sourceEntity: number;  // Plant entity ID
  targetEntity: number;  // HQ entity ID
  matterAmount: number;  // 20 matter per packet
  team: number;
}
