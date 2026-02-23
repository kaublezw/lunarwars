export type SupplyRouteState = 'to_source' | 'loading' | 'to_dest' | 'unloading' | 'idle';

export interface SupplyRouteComponent {
  sourceEntity: number;
  destEntity: number;
  state: SupplyRouteState;
  timer: number;
  carried: number;
  carryCapacity: number;
}
