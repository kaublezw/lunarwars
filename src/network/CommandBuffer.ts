import type { GameCommandPayload, TickTaggedCommand } from '@network/Protocol';

interface TickSlot {
  commands: TickTaggedCommand[];
  confirmed: [boolean, boolean]; // [player0, player1]
}

export class CommandBuffer {
  private localPlayerId: number;
  private inputDelay: number;
  private slots = new Map<number, TickSlot>();
  // Track the set of ticks we've already sent confirms for
  private confirmedTicks = new Set<number>();

  constructor(localPlayerId: number, inputDelay: number) {
    this.localPlayerId = localPlayerId;
    this.inputDelay = inputDelay;
  }

  /** Local player issued a command. Returns the tick-tagged command to send to server. */
  addLocalCommand(currentTick: number, payload: GameCommandPayload): TickTaggedCommand {
    const targetTick = currentTick + this.inputDelay;
    const cmd: TickTaggedCommand = {
      tick: targetTick,
      playerId: this.localPlayerId,
      payload,
    };
    // Don't buffer locally — wait for server relay (canonical ordering)
    return cmd;
  }

  /** Received a command from the server relay (could be own or opponent's). */
  addRemoteCommand(cmd: TickTaggedCommand): void {
    const slot = this.getOrCreateSlot(cmd.tick);
    slot.commands.push(cmd);
  }

  /** Received a tick confirm from the server relay. */
  addTickConfirm(playerId: number, tick: number): void {
    const slot = this.getOrCreateSlot(tick);
    slot.confirmed[playerId] = true;
  }

  /** Mark that local player has no more commands for a future tick. */
  confirmLocalTick(tick: number): void {
    if (this.confirmedTicks.has(tick)) return;
    this.confirmedTicks.add(tick);
    const slot = this.getOrCreateSlot(tick);
    slot.confirmed[this.localPlayerId] = true;
  }

  /** Check if both players have confirmed a tick (all commands received). */
  canAdvanceTick(tick: number): boolean {
    const slot = this.slots.get(tick);
    if (!slot) return false;
    return slot.confirmed[0] && slot.confirmed[1];
  }

  /**
   * Get all commands for a tick, sorted by playerId (player 0 first).
   * Returns null if not ready. Prunes the slot after consumption.
   */
  getCommandsForTick(tick: number): GameCommandPayload[] | null {
    if (!this.canAdvanceTick(tick)) return null;
    const slot = this.slots.get(tick)!;
    // Sort by playerId for deterministic ordering
    slot.commands.sort((a, b) => a.playerId - b.playerId);
    const payloads = slot.commands.map(c => c.payload);
    this.slots.delete(tick);
    this.confirmedTicks.delete(tick);
    return payloads;
  }

  /** Pre-create slots for initial ticks (before game starts, both sides confirm). */
  initializeForGameStart(startTick: number): void {
    // Pre-confirm all ticks before the first input-delayed tick
    for (let t = startTick; t < startTick + this.inputDelay; t++) {
      const slot = this.getOrCreateSlot(t);
      slot.confirmed[0] = true;
      slot.confirmed[1] = true;
    }
  }

  getInputDelay(): number {
    return this.inputDelay;
  }

  private getOrCreateSlot(tick: number): TickSlot {
    let slot = this.slots.get(tick);
    if (!slot) {
      slot = { commands: [], confirmed: [false, false] };
      this.slots.set(tick, slot);
    }
    return slot;
  }
}
