# Lunar Wars

Free, zero-barrier, web-based RTS game set in a voxel arena. Competing factions of autonomous drones fight for control of terrain and resources. All units are drones; no organic life.

**Guiding idea**: "An RTS where designing, protecting, and disrupting supply lines is just as important as commanding armies."

## Game Design

### Core Differentiator: Explicit Logistics

The defining mechanic is supply chain management:
- **Train-based economy** — A physical train (1 engine + cargo cars) circuits between HQ and resource buildings, collecting and delivering resources in bursty deliveries
- **PlantStorage accumulation** — Extractors and Matter Plants accumulate resources locally; the train picks them up on each pass
- **Discrete grid track** — Train tracks are built from exactly 6 piece types: 2 straights (N-S, E-W) and 4 quarter-circle curves. All pieces snap to `MACRO_GRID_SIZE` (4 wu) grid. Tracks are visual-only (no collision)
- **Vulnerable supply chain** — Destroying cargo cars denies resource delivery; destroying the engine halts the economy. Enemy units on the track are instakilled; friendly units are pushed aside
- **Supply Depots** have local MATTER_STORAGE; combat units auto-resupply (ammo + repair) at depots
- **No ammo = no firing** — units must return to depots when empty, creating natural front-line logistics
- This shifts gameplay from "biggest army wins" to "who controls terrain, logistics, and supply integrity"

### Economy

- **Energy** — Mined from fixed energy nodes via Extractors (+5e/s each). Accumulates in local `PlantStorage`; collected by train.
- **Matter** — Manufactured by Matter Plants (+2m/s each). Accumulates in local `PlantStorage`; collected by train.
- **Bursty delivery** — Resources only enter the global pool when the train unloads at HQ. No continuous income.
- **Build anywhere** — No build radius restriction. All buildings and resource nodes snap to `MACRO_GRID_SIZE` (4 wu) grid.
- Building/training costs deducted from global matter pool.
- Economy limits unit spam, encourages expansion and forward staging, makes logistics essential.

### Units (All Drones)

| Type | Role | Traits |
|------|------|--------|
| Combat Drone | Marine-like ground unit | 100hp, speed 3, range 8, 38 ammo |
| Heavy Assault Platform | Tank-like | 300hp, speed 1.5, range 12, 22 ammo |
| Aerial Drone | Flyer/scout | 60hp, speed 6, range 6, 30 ammo |
| Ferry Drone | Supply carrier | 60hp, speed 2.4, trained at Supply Depot, auto-shuttles matter HQ→depot |
| Train Engine | Locomotive | 500hp, speed 4, 1 per team (free at start), follows track circuit |
| Cargo Car | Resource hauler | 150hp, speed 4, 200 capacity, trained at HQ (50e/75m), auto-links to train |

- Units consume ammo — **no ammo = no firing** (suppression mechanic)
- Units gain veterancy (3/7/15 kills): +10% damage, +10% fire rate, +5% speed per level
- Veterans are stronger but never immortal (max level 3)

### Buildings

| Building | Cost | Function |
|----------|------|----------|
| HQ | Free at start | 2000hp, win/lose condition |
| Energy Extractor | 50 matter | +5 energy/s, must be on energy node |
| Matter Plant | 100 energy | +2 matter/s |
| Supply Depot | 50e + 50m | Stores matter locally (filled by ferry drones), auto-resupplies nearby combat units (ammo + repair), trains Ferry Drones |
| Drone Factory | 150e + 100m | Trains units |

### Starting Loadout (Per Player)

- 1 HQ (free, pre-placed at team spawn flat zone)
- 1 Worker Drone (spawns near HQ)
- 1 Train Engine + 2 Cargo Cars (free, at HQ)
- 100 energy — enough for 1 Matter Plant
- 100 matter — enough for 2 Energy Extractors

### Terrain & Strategy

- Voxel arena with flat floor, rectangular mountain blocks, and vertical border walls
- Terrain is rendered as chunked greedy-meshed voxel cubes (same VOXEL_SIZE as units/buildings)
- Mountains are axis-aligned rectangular blocks with flat tops — no slopes
- Mountains create chokepoints and obstruct movement/line of sight
- Terrain matters primarily because it affects logistics, not just combat
- 2-4 flat zones for base building, 8-12 energy nodes at flat spots

### Train Logistics System

The train is the sole resource delivery mechanism. No packets or direct income — all energy and matter flow through the physical train.

**Track Routing (TrackManagerSystem):**
- A* state-space pathfinder on the `MACRO_GRID_SIZE` (4 wu) grid
- State = (gridX, gridZ, facing direction 0-3)
- 3 moves: Straight (cost 1.0), Curve Right (cost 2.5), Curve Left (cost 2.5)
- Curve moves go forward 1 + sideways 1 grid cell (diagonal), changing direction by 90 degrees
- Building center cells are blocked; arc collision check prevents curves from clipping building footprints
- Track targets are adjacent grid cells (1 cell from building center)
- Two-pass loop building: pass 1 discovers return momentum, pass 2 rebuilds with correct starting direction for seamless loop closure
- Nearest-neighbor TSP determines stop order; momentum chains between segments

**Track Pieces (6 types only):**
- 2 straight pieces: N-S and E-W grid-aligned lines
- 4 curve pieces: quarter-circle arcs (NE, NW, SE, SW quadrants)
- Every junction is tangential — no discrete angle changes anywhere
- `nodesToWaypoints()` emits grid centers for straights, 8-sample arcs for curves
- Arc pivot: R perpendicular to incoming direction on the turn side
- Arc sweep: right turn = CCW (+PI/2), left turn = CW (-PI/2) from pivot perspective

**Train Movement (TrainMovementSystem):**
- Engine follows TrackFollower.path waypoints at 4 wu/s
- Rotation = atan2 toward next waypoint (smooth with dense arc samples)
- Halts at stop waypoints (entityId or isHQ) for logistics
- Cargo cars trail via TrainLink chain at CAR_SPACING (2.5 wu)
- Enemy units on track instakilled; friendly units pushed sideways
- Broken chain detection: engine reverses to reconnect orphaned cars

**Resource Flow (TrainLogisticsSystem):**
- At plant waypoints: transfers PlantStorage → CargoStorage (fills all compatible cars)
- At HQ waypoints: dumps CargoStorage → ResourceState (addEnergy/addMatter)
- Cars lock committedType ('energy' | 'matter') when loaded, cleared on unload

**Unified Grid (MACRO_GRID_SIZE = 4.0 wu):**
- Exported from `ComponentTypes.ts`, used by tracks, buildings, and resource nodes
- Energy nodes and ore deposits snap to grid in `MapFeatures.ts`
- Player placement snaps in `PlacementController.ts`
- AI placement snaps in `PlacementValidator.ts`
- Debug grid visible as yellow lines via `GridRenderer.ts`

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
- `npm run convert-vox` — Convert `.vox` files in `assets/vox/` to `GeneratedVoxelModels.ts`
- `npm run headless` — Run AI vs AI headless game (no browser/rendering)

## Headless Engine

Runs a complete AI vs AI game without browser or Three.js dependencies. Useful for testing AI changes and training.

**Usage:**
```bash
npm run headless                          # Random seed, 72,000 tick max
SEED=12345 npm run headless               # Deterministic seed
MAX_TICKS=36000 npm run headless          # Limit to 36,000 ticks (10 min)
SEED=42 MAX_TICKS=72000 npm run headless  # Both
```

**Environment variables:**
- `SEED` — Unsigned 32-bit integer for deterministic replay. Random if omitted.
- `MAX_TICKS` — Tick limit. Default 72,000 (20 min game time at 60 ticks/s).

**Output:**
```
Starting headless game (seed: 987654321, max ticks: 72000)...
Seed: 987654321
Winner: Team 0 in 38421 ticks (640.4s game time)
Real time: 8.34s
```

**Determinism:** Same seed always produces identical results (winner + tick count). Uses `SeededRandom` (xorshift32 PRNG). Three systems take the RNG: CollisionAvoidanceSystem, TurretSystem, VoxelDamageSystem.

**Browser replay:** `?replay=<seed>` URL param runs spectator mode with that seed.

**Key files:**
- `src/headless/HeadlessEngine.ts` — Engine: creates world, runs AI vs AI simulation loop
- `src/headless/types.ts` — HeadlessConfig and GameResult interfaces
- `scripts/run-headless.ts` — CLI entry point
- `src/simulation/utils/SeededRandom.ts` — Deterministic PRNG

## Voxel Model Authoring (.vox workflow)

Models can be authored visually in [MagicaVoxel](https://ephtracy.github.io/) (free) and imported at build time.

**Palette conventions in MagicaVoxel:**
- Slot **254** = team primary color (resolved to team color at render)
- Slot **253** = team accent color (resolved to team color at render)
- Slots 1–252 = custom colors stored verbatim in the model palette
- Slot **0** = empty/transparent (do not paint with it)

**Axis convention:** MagicaVoxel is Z-up; the game is Y-up. The script handles the swap automatically (`mv_x→gx`, `mv_z→gy`, `mv_y→gz`). Design your model with MagicaVoxel's Z as the up axis.

**Adding a new .vox model:**
1. Export the model from MagicaVoxel to `assets/vox/your_model.vox`
2. Add an entry to `assets/vox/models.json`:
   ```json
   "your_model.vox": { "meshType": "combat_drone", "turretMinY": 6 }
   ```
   - `meshType` — key used in `VOXEL_MODELS` and `RENDERABLE` components (replaces hand-authored model of the same key)
   - `turretMinY` — voxels at `y >= turretMinY` rotate independently with the turret; omit if no turret
   - `turretMaxY` — optional upper bound for the turret layer range
3. Run `npm run convert-vox`
4. Vite HMR picks up the generated `GeneratedVoxelModels.ts` automatically

**Pipeline internals:**
- `scripts/convert-vox.ts` — self-contained `.vox` binary parser + codegen script
- `src/simulation/data/GeneratedVoxelModels.ts` — auto-generated output; do not edit manually
- Generated models take precedence over hand-authored models in `VoxelModels.ts`
- All downstream systems (VoxelGeometryBuilder, VoxelMeshManager, VoxelDamageSystem) work unchanged

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
| `src/simulation/systems/EconomySystem.ts` | Ticks extractors/plants: accumulates PlantStorage (+5e/s, +2m/s); auto-fills HQ matter storage |
| `src/simulation/systems/TrackManagerSystem.ts` | A* grid-based track routing: computes optimal circuit through buildings with discrete track pieces |
| `src/simulation/systems/TrainMovementSystem.ts` | Moves train along TrackFollower path; drags cargo cars; handles blocking units and chain reconnection |
| `src/simulation/systems/TrainLogisticsSystem.ts` | Load/unload state machine: PlantStorage → CargoStorage at plants, CargoStorage → ResourceState at HQ |
| `src/simulation/logistics/TrackState.ts` | Per-team track circuit state: activeRoute, pendingRoute, waypoints with entityId/isHQ |
| `src/simulation/logistics/TrainSpawner.ts` | Spawns train sets (engine + cars with TrainLink chain); appendCarToTrain, teamHasEngine helpers |
| `src/simulation/systems/SupplySystem.ts` | Ferry system: units with SUPPLY_ROUTE shuttle matter from global pool to depot MATTER_STORAGE |
| `src/simulation/systems/ResupplySystem.ts` | Auto-resupply: combat units with ammo=0 seek nearest depot for instant ammo refill + gradual repair (20 HP/s) |
| `src/simulation/systems/GameOverSystem.ts` | Checks HQ health; fires onGameOver callback when an HQ is destroyed |
| `src/simulation/systems/BuildSystem.ts` | Worker build orders: move to site, increment progress, complete building |
| `src/simulation/systems/ProductionSystem.ts` | Ticks production queues, spawns units on completion |
| `src/simulation/systems/AISystem.ts` | AI opponent (team 1), 30-tick decision cycle, build orders, army control, smart depot placement, ferry drone training |
| `src/simulation/economy/ResourceState.ts` | Per-team energy/matter state (canAfford, spend, rates) |
| `src/simulation/data/BuildingData.ts` | BUILDING_DEFS: costs, build times, HP for all building types |
| `src/simulation/data/UnitData.ts` | UNIT_DEFS: costs, train times for WorkerDrone, CombatDrone, AssaultPlatform, AerialDrone, FerryDrone |
| `src/simulation/economy/DepotUtils.ts` | findNearestDepot utility + resupply constants (AMMO_MATTER_COST, REPAIR_MATTER_COST, REPAIR_RATE) |
| `src/rendering/effects/BuildingEffectsRenderer.ts` | Smoke particles for Matter Plants, glow lights for Extractors |
| `src/input/InputManager.ts` | Mouse/keyboard event handling |
| `src/input/CameraController.ts` | Right-drag pan, scroll zoom, WASD keys |
| `src/input/SelectionController.ts` | Click/box select, right-click move, formation movement |
| `src/input/PlacementController.ts` | Building placement mode: ghost cursor, validation, energy node snap, no build radius restriction |
| `src/ui/ActionBar.ts` | Context-sensitive build/train buttons at bottom center |
| `src/ui/ResourceDisplay.ts` | Top-left HUD showing energy/matter with rates |
| `src/main.ts` | Bootstraps everything, spawns HQs + workers, wires systems and UI |
| `src/simulation/ai/PlacementValidator.ts` | Shared building placement validation |

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
- Voxel terrain (rectangular mountain blocks, border walls, flat zones, minimap, starfield)
- Units: selection, A* pathfinding, formation movement, combat drones, assault platforms, aerial drones, worker drones
- Combat: turret system, ammo, health, particle effects (muzzle flash, impact sparks)
- Fog of war: per-team visibility, explored/visible/unexplored states
- Buildings + economy: HQ, Energy Extractor, Matter Plant, Supply Depot, Drone Factory
- Distinct building shapes: compound THREE.Group meshes (HQ tower+antenna, Extractor hex+orb, Plant box+chimney, Depot platform+crates, Factory body+tower+dish)
- Building effects: Matter Plant smoke particles, Energy Extractor pulsing glow lights
- Worker building: placement mode with ghost preview, energy node snapping, build-over-time, no build radius restriction
- HQ production: train workers via production queue
- Resource system: global matter pool per team, energy with per-second rates, cost gating
- Train logistics: physical train circuit collects from PlantStorage, delivers to HQ in bursts
- Grid-based discrete track routing: A* pathfinder with 6 track piece types (2 straights + 4 quarter-circle curves)
- Unified MACRO_GRID_SIZE (4 wu): tracks, buildings, energy nodes, ore deposits all snap to same grid
- Single engine rule (1 per team), cargo cars trainable at HQ, auto-link on dock
- Train instakills enemies on track, pushes friendly units aside
- Auto-resupply: combat units with ammo=0 auto-seek nearest depot for instant ammo refill + gradual repair (20 HP/s), costs matter from depot
- Game over detection: HQ destruction triggers win/loss
- AI opponent: build orders, smart forward depot placement, army control, scouting, supply-aware economy

### System Execution Order

Pathfinding -> CollisionAvoidance -> Movement -> TrainMovement -> TrainLogistics -> FogOfWar -> Turret -> Projectile -> VoxelDamage -> Resupply -> Repair -> GameOver -> Health -> Economy -> Supply -> Build -> Production -> TrackManager -> AI

### Building Y-Position Convention

Compound building groups (created by `createBuildingGroup()` in RenderSync) use local `y=0` as ground level — child meshes are positioned upward from there. Entity positions for buildings should use `y = terrainHeight` (not offset). Construction sites use `y = terrainHeight + 0.25`; BuildSystem resets Y on completion.

RenderSync tracks meshType per entity and recreates the Three.js object when meshType changes (e.g. construction_site -> final building).

## Upcoming Phases

- Phase 9: UI/HUD + game flow
- Train visuals: voxel models for engine/cars, track tie rendering
- AI train awareness: economy manager needs to understand bursty train delivery

## Conventions

- Systems: PascalCase class implementing `System` interface
- Components: PascalCase interface (`PositionComponent`), string key constant (`POSITION`)
- Imports: Use path aliases (`@core/ECS`, `@sim/components/Position`)
- Input callbacks: `onMouseDown((x, y, button) => ...)`, `onWheel((deltaY, x, y) => ...)`
- No emojis in code or comments
- Prefer editing existing files over creating new ones
- **AI parity**: Whenever game rules change (economy, building mechanics, unit behavior, etc.), the AI (`AISystem.ts`) must be updated to follow the same rules. The AI never cheats — it obeys the same constraints as the player.
