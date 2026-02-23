export interface MoveCommandComponent {
  path: { x: number; z: number }[];
  currentWaypoint: number;
  destX: number;
  destZ: number;
}
