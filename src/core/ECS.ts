export type Entity = number;

export interface System {
  readonly name: string;
  update(world: World, dt: number): void;
}

export class World {
  private nextId = 0;
  private stores = new Map<string, Map<Entity, unknown>>();
  private systems: System[] = [];
  private destroyQueue: Entity[] = [];
  private livingEntities = new Set<Entity>();

  createEntity(): Entity {
    const id = this.nextId++;
    this.livingEntities.add(id);
    return id;
  }

  destroyEntity(e: Entity): void {
    this.destroyQueue.push(e);
  }

  addComponent<T>(e: Entity, type: string, data: T): void {
    let store = this.stores.get(type);
    if (!store) {
      store = new Map();
      this.stores.set(type, store);
    }
    store.set(e, data);
  }

  removeComponent(e: Entity, type: string): void {
    this.stores.get(type)?.delete(e);
  }

  getComponent<T>(e: Entity, type: string): T | undefined {
    return this.stores.get(type)?.get(e) as T | undefined;
  }

  hasComponent(e: Entity, type: string): boolean {
    return this.stores.get(type)?.has(e) ?? false;
  }

  query(...types: string[]): Entity[] {
    if (types.length === 0) return [];

    // Find the smallest store to iterate over
    let smallest: Map<Entity, unknown> | undefined;
    let smallestSize = Infinity;
    for (const type of types) {
      const store = this.stores.get(type);
      if (!store) return []; // No entities have this component
      if (store.size < smallestSize) {
        smallestSize = store.size;
        smallest = store;
      }
    }

    if (!smallest) return [];

    const result: Entity[] = [];
    for (const entity of smallest.keys()) {
      if (!this.livingEntities.has(entity)) continue;
      let hasAll = true;
      for (const type of types) {
        if (!this.stores.get(type)!.has(entity)) {
          hasAll = false;
          break;
        }
      }
      if (hasAll) result.push(entity);
    }
    return result;
  }

  getEntities(): Entity[] {
    return Array.from(this.livingEntities);
  }

  addSystem(system: System): void {
    this.systems.push(system);
  }

  serialize(): { nextId: number; entities: { id: number; components: Record<string, unknown> }[] } {
    const entities: { id: number; components: Record<string, unknown> }[] = [];
    for (const id of this.livingEntities) {
      const components: Record<string, unknown> = {};
      for (const [type, store] of this.stores) {
        if (store.has(id)) {
          components[type] = store.get(id);
        }
      }
      entities.push({ id, components });
    }
    return { nextId: this.nextId, entities };
  }

  deserialize(data: { nextId: number; entities: { id: number; components: Record<string, unknown> }[] }): void {
    // Clear existing state (but NOT systems)
    this.stores.clear();
    this.livingEntities.clear();
    this.destroyQueue.length = 0;
    this.nextId = data.nextId;

    for (const entry of data.entities) {
      this.livingEntities.add(entry.id);
      for (const [type, compData] of Object.entries(entry.components)) {
        let store = this.stores.get(type);
        if (!store) {
          store = new Map();
          this.stores.set(type, store);
        }
        store.set(entry.id, compData);
      }
    }
  }

  update(dt: number): void {
    for (const system of this.systems) {
      system.update(this, dt);
    }
    this.flushDestroyQueue();
  }

  private flushDestroyQueue(): void {
    for (const e of this.destroyQueue) {
      this.livingEntities.delete(e);
      for (const store of this.stores.values()) {
        store.delete(e);
      }
    }
    this.destroyQueue.length = 0;
  }
}
