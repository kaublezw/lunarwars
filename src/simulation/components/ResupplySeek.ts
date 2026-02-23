export interface ResupplySeekComponent {
  state: 'seeking' | 'moving' | 'resupplying';
  targetDepot: number;  // entity ID of depot/HQ
}
