/** Temporary ferry that carries matter from a source silo to a destination.
 *  Spawns free at the source, travels to destination, disappears on arrival.
 *  matterAmount > 0 means the ferry carries real matter to deposit at a depot on arrival.
 *  matterAmount = 0 means visual only (matter already deducted from the global pool). */
export interface MatterDeliveryComponent {
  destEntity: number;
  destX: number;
  destZ: number;
  speed: number;
  /** Actual matter carried. 0 = visual only (spend ferries). >0 = production shuttle. */
  matterAmount: number;
}
