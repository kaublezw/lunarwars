type Callback = (...args: unknown[]) => void;

export class EventBus {
  private listeners = new Map<string, Set<Callback>>();

  on(event: string, callback: Callback): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: string, callback: Callback): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        cb(...args);
      }
    }
  }
}
