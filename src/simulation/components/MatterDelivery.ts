/** Temporary ferry that carries matter from a source silo to a destination.
 *  Spawns free at the source, travels to destination, disappears on arrival.
 *  Visual only — matter is already deducted from the global pool. */
export interface MatterDeliveryComponent {
  destEntity: number;
  destX: number;
  destZ: number;
  speed: number;
}
