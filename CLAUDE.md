# Lunar Wars

Free, zero-barrier, web-based RTS game set on the Moon. Competing human factions fight for a foothold on harsh lunar terrain — mountains, craters, flat regolith. All units are autonomous drones; no organic life.

**Guiding idea**: "An RTS where designing, protecting, and disrupting supply lines is just as important as commanding armies."

## Game Design

### Core Differentiator: Explicit Logistics

The defining mechanic is supply chain management:
- **Global matter pool** per team — Matter Plants produce directly to the team's global pool
- **Worker ferry system** — Workers shuttle matter from HQ to Supply Depots (select worker, right-click depot)
- **Supply Depots** have local MATTER_STORAGE; combat units auto-resupply (ammo + repair) at depots
- **No ammo = no firing** — units must return to depots when empty, creating natural front-line logistics
- **Future (Phase 6)**: Player-drawn supply lines with visible, capacity-limited, attackable routes
- This shifts gameplay from "biggest army wins" to "who controls terrain, logistics, and supply integrity"

### Economy

- **Energy** — Mined from fixed energy nodes via Extractors (+5e/s each). Powers production and matter synthesis.
- **Matter** — Manufactured by Matter Plants (+2m/s each, costs 2e/s). Global pool per team. Used for buildings, repairs, ammo, and unit training.
- **Build anywhere** — No build radius restriction for building placement.
- Building/training costs deducted from global matter pool.
- Economy limits unit spam, encourages expansion and forward staging, makes logistics essential.

### Units (All Drones)

| Type | Role | Traits |
|------|------|--------|
| Combat Drone | Marine-like ground unit | 100hp, speed 3, range 8, 38 ammo |
| Heavy Assault Platform | Tank-like | 300hp, speed 1.5, range 12, 22 ammo |
| Aerial Drone | Flyer/scout | 60hp, speed 6, range 6, 30 ammo |

- Units consume ammo — **no ammo = no firing** (suppression mechanic)
- Units gain veterancy (3/7/15 kills): +10% damage, +10% fire rate, +5% speed per level
- Veterans are stronger but never immortal (max level 3)

### Buildings

| Building | Cost | Function |
|----------|------|----------|
| HQ | Free at start | 2000hp, win/lose condition |
| Energy Extractor | 50 matter | +5 energy/s, must be on energy node |
| Matter Plant | 100 energy | +2 matter/s |
| Supply Depot | 50e + 50m | Stores matter locally (filled by worker ferries), auto-resupplies nearby combat units (ammo + repair) |
| Drone Factory | 150e + 100m | Trains units |

### Starting Loadout (Per Player)

- 1 HQ (free, pre-placed at team spawn flat zone)
- 1 Worker Drone (spawns near HQ)
- 100 energy — enough for 1 Matter Plant
- 100 matter — enough for 2 Energy Extractors

### Terrain & Strategy

- Terrain affects movement, line of sight, and supply line routing
- Mountains create chokepoints; craters create ambush/slowdown zones
- Terrain matters primarily because it affects logistics, not just combat
- 2-4 flat zones for base building, 8-12 energy nodes at flat spots

### AI Philosophy

- AI is a normal player: same commands, rules, fog-of-war, and supply constraints
- **No cheating** — AI reads only its own fog-of-war visible state
- Difficulty tuned via reaction time, decision quality, and awareness
- Scouts with aerial drones like a player would

### Design Philosophy

- Free to play, zero barrier to entry
- Readable, learnable systems
- Logistics over micromanagement
- Strategic depth without overwhelming complexity

## Tech Stack

- **TypeScript** (strict mode), **Three.js**, **Vite**, custom ECS (no library)
- No frameworks for UI — plain HTML/CSS overlays on canvas
- MVP is fully client-side; future multiplayer uses authoritative server
- Simulation layer is server-ready by design (no rendering deps)

## Commands

- `npm run dev` — Vite dev server (localhost:5173, HMR)
- `npm run build` — TypeScript check + Vite production bundle
- `npm run preview` — Serve production build locally

## Architecture

```
main.ts (bootstrap & wiring)
├── Input Layer     (src/input/)     — DOM events, camera control
├── UI Layer        (src/ui/)        — HTML overlays (future)
├── Rendering Layer (src/rendering/) — Three.js scene, meshes, effects
│   └── RenderSync                   — Bridge: reads ECS → updates Three.js
├── Core            (src/core/)      — ECS engine, GameLoop, EventBus
└── Simulation      (src/simulation/)— Pure game logic, systems, components
```

### Hard Rule

**Nothing in `src/simulation/` may import from `three`, `src/rendering/`, or `src/ui/`.** The simulation layer is pure game logic — server-ready, no rendering dependencies. RenderSync is the one-way bridge from ECS state to Three.js scene objects.

### Path Aliases

| Alias | Path |
|-------|------|
| `@core/*` | `src/core/*` |
| `@sim/*` | `src/simulation/*` |
| `@render/*` | `src/rendering/*` |
| `@ui/*` | `src/ui/*` |
| `@input/*` | `src/input/*` |

## ECS Pattern

Entities are numeric IDs. Components are plain data objects keyed by string constants. Systems implement `{ name: string; update(world: World, dt: number): void }`.

```typescript
// Spawning an entity
const e = world.createEntity();
world.addComponent(e, POSITION, { x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, rotation: 0 });
world.addComponent(e, RENDERABLE, { meshType: 'cube', color: 0xff4444, scale: 1.0 });

// Querying in a system
const entities = world.query(POSITION, VELOCITY);
for (const e of entities) {
  const pos = world.getComponent<PositionComponent>(e, POSITION)!;
  // ...
}
```

- Component type constants live in `src/simulation/components/ComponentTypes.ts`
- Component interfaces live in individual files under `src/simulation/components/`
- `destroyEntity()` is deferred — safe to call during system iteration

## Key Files

| File | Purpose |
|------|---------|
| `src/core/ECS.ts` | Entity-Component-System engine (World, Entity, System) |
| `src/core/GameLoop.ts` | Fixed 1/60s timestep with interpolation alpha |
| `src/core/EventBus.ts` | Simple pub/sub (wired but unused so far) |
| `src/rendering/RenderSync.ts` | Reads ECS state, creates/updates/removes Three.js meshes |
| `src/rendering/IsometricCamera.ts` | Orthographic camera along (1,1,1), pan/zoom |
| `src/rendering/SceneManager.ts` | Scene, directional + ambient lights |
| `src/rendering/GhostBuildingRenderer.ts` | Semi-transparent placement preview mesh |
| `src/simulation/systems/MovementSystem.ts` | Moves entities, bounces off 256x256 bounds |
| `src/simulation/systems/EconomySystem.ts` | Ticks extractors (+5e/s); plants produce matter to global pool (+2m/s) |
| `src/simulation/systems/SupplySystem.ts` | Worker ferry: workers with SUPPLY_ROUTE shuttle matter from global pool to depot MATTER_STORAGE |
| `src/simulation/systems/ResupplySystem.ts` | Auto-resupply: combat units with ammo=0 seek nearest depot for instant ammo refill + gradual repair (20 HP/s) |
| `src/simulation/systems/GameOverSystem.ts` | Checks HQ health; fires onGameOver callback when an HQ is destroyed |
| `src/simulation/systems/BuildSystem.ts` | Worker build orders: move to site, increment progress, complete building |
| `src/simulation/systems/ProductionSystem.ts` | Ticks production queues, spawns units on completion |
| `src/simulation/systems/AISystem.ts` | AI opponent (team 1), 30-tick decision cycle, build orders, army control, smart depot placement, ferry assignment |
| `src/simulation/economy/ResourceState.ts` | Per-team energy/matter state (canAfford, spend, rates) |
| `src/simulation/data/BuildingData.ts` | BUILDING_DEFS: costs, build times, HP for all building types |
| `src/simulation/data/UnitData.ts` | UNIT_DEFS: costs, train times for WorkerDrone, CombatDrone, AssaultPlatform, AerialDrone |
| `src/simulation/economy/DepotUtils.ts` | findNearestDepot utility + resupply constants (AMMO_MATTER_COST, REPAIR_MATTER_COST, REPAIR_RATE) |
| `src/rendering/effects/BuildingEffectsRenderer.ts` | Smoke particles for Matter Plants, glow lights for Extractors |
| `src/input/InputManager.ts` | Mouse/keyboard event handling |
| `src/input/CameraController.ts` | Right-drag pan, scroll zoom, WASD keys |
| `src/input/SelectionController.ts` | Click/box select, right-click move, formation movement |
| `src/input/PlacementController.ts` | Building placement mode: ghost cursor, validation, energy node snap, no build radius restriction |
| `src/ui/ActionBar.ts` | Context-sensitive build/train buttons at bottom center |
| `src/ui/ResourceDisplay.ts` | Top-left HUD showing energy/matter with rates |
| `src/main.ts` | Bootstraps everything, spawns HQs + workers, wires systems and UI |

## World Coordinates

- Map is 256x256 units on the XZ plane (Y is up)
- Ground plane centered at (128, 0, 128)
- Entity positions range 0–256 on X and Z

## Game Loop

Fixed timestep simulation at 1/60s with accumulator pattern. Render callback receives an `alpha` (0–1) for interpolating between previous and current positions — this is why all Position components track `prevX/prevY/prevZ`.

## Current State (Phases 0–8 + Supply Overhaul Complete)

- Project scaffolding with Vite + Three.js
- Isometric camera with pan/zoom input
- ECS engine, game loop
- Procedural terrain (simplex noise, craters, flat zones, minimap, starfield)
- Units: selection, A* pathfinding, formation movement, combat drones, assault platforms, aerial drones, worker drones
- Combat: turret system, ammo, health, particle effects (muzzle flash, impact sparks)
- Fog of war: per-team visibility, explored/visible/unexplored states
- Buildings + economy: HQ, Energy Extractor, Matter Plant, Supply Depot, Drone Factory
- Distinct building shapes: compound THREE.Group meshes (HQ tower+antenna, Extractor hex+orb, Plant box+chimney, Depot platform+crates, Factory body+tower+dish)
- Building effects: Matter Plant smoke particles, Energy Extractor pulsing glow lights
- Worker building: placement mode with ghost preview, energy node snapping, build-over-time, no build radius restriction
- HQ production: train workers via production queue
- Resource system: global matter pool per team, energy with per-second rates, cost gating
- Matter Plants produce directly to global pool (+2m/s, costs 2e/s)
- Worker ferry system: select worker, right-click depot to shuttle matter from HQ to depot MATTER_STORAGE (10 matter/trip, 2s load/unload)
- Auto-resupply: combat units with ammo=0 auto-seek nearest depot for instant ammo refill + gradual repair (20 HP/s), costs matter from depot
- Game over detection: HQ destruction triggers win/loss
- AI opponent: build orders, smart forward depot placement, army control, scouting, ferry worker assignment, supply-aware economy

### System Execution Order

Pathfinding -> CollisionAvoidance -> Movement -> FogOfWar -> Turret -> Resupply -> GameOver -> Health -> Economy -> Supply -> Build -> Production -> AI

### Building Y-Position Convention

Compound building groups (created by `createBuildingGroup()` in RenderSync) use local `y=0` as ground level — child meshes are positioned upward from there. Entity positions for buildings should use `y = terrainHeight` (not offset). Construction sites use `y = terrainHeight + 0.25`; BuildSystem resets Y on completion.

RenderSync tracks meshType per entity and recreates the Three.js object when meshType changes (e.g. construction_site -> final building).

## Upcoming Phases

- Phase 6: Supply lines (player-drawn routes, capacity limits, visibility)
- Phase 9: UI/HUD + game flow

## Conventions

- Systems: PascalCase class implementing `System` interface
- Components: PascalCase interface (`PositionComponent`), string key constant (`POSITION`)
- Imports: Use path aliases (`@core/ECS`, `@sim/components/Position`)
- Input callbacks: `onMouseDown((x, y, button) => ...)`, `onWheel((deltaY, x, y) => ...)`
- No emojis in code or comments
- Prefer editing existing files over creating new ones
- **AI parity**: Whenever game rules change (economy, building mechanics, unit behavior, etc.), the AI (`AISystem.ts`) must be updated to follow the same rules. The AI never cheats — it obeys the same constraints as the player.
