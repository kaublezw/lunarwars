# Lunar Wars

Free, zero-barrier, web-based RTS game set in a voxel arena. Competing factions of autonomous drones fight for control of terrain and resources. All units are drones; no organic life.

**Guiding idea**: "An RTS where designing, protecting, and disrupting supply lines is just as important as commanding armies."

## Game Design

### Core Differentiator: Explicit Logistics

The defining mechanic is supply chain management:
- **Global matter pool** per team — Matter Plants produce directly to the team's global pool
- **Ferry drone system** — Ferry Drones (trained at Supply Depots) shuttle matter from HQ to depots automatically
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
| Ferry Drone | Supply carrier | 60hp, speed 2.4, trained at Supply Depot, auto-shuttles matter HQ→depot |

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
- 100 energy — enough for 1 Matter Plant
- 100 matter — enough for 2 Energy Extractors

### Terrain & Strategy

- Voxel arena with flat floor, rectangular mountain blocks, and vertical border walls
- Terrain is rendered as chunked greedy-meshed voxel cubes (same VOXEL_SIZE as units/buildings)
- Mountains are axis-aligned rectangular blocks with flat tops — no slopes
- Mountains create chokepoints and obstruct movement/line of sight
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
- `npm run convert-vox` — Convert `.vox` files in `assets/vox/` to `GeneratedVoxelModels.ts`
- `npm run headless` — Run AI vs AI headless game (no browser/rendering)
- `npm run rl` — Start ZMQ RL environment server for training agents

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
- `src/headless/HeadlessEngine.ts` — Engine: creates world, runs simulation loop (AI vs AI mode + RL mode with reset/step)
- `src/headless/types.ts` — HeadlessConfig (unified AI vs AI + RL mode) and GameResult interfaces
- `scripts/run-headless.ts` — CLI entry point
- `src/simulation/utils/SeededRandom.ts` — Deterministic PRNG

## RL Environment

ZeroMQ-based reinforcement learning server. The RL agent controls team 1; the built-in AI controls team 0. Observations are fog-of-war filtered (agent only sees what its units see).

**Usage:**
```bash
npm run rl                                # Default: port 5555, random seed
PORT=5556 npm run rl                      # Custom port
SEED=42 MAX_TICKS=3000 npm run rl         # Deterministic seed + tick limit
TICKS_PER_STEP=30 npm run rl             # Ticks per RL step (default 30)
```

**Environment variables:**
- `PORT` — ZMQ server port. Default 5555.
- `SEED` — Unsigned 32-bit integer for deterministic replay. Random if omitted.
- `MAX_TICKS` — Episode tick limit. Default 3,000 (50s game time at 60 ticks/s).
- `TICKS_PER_STEP` — Simulation ticks per `step` call. Default 30.

**Protocol:** ZMQ REQ/REP on `tcp://127.0.0.1:<PORT>`. All messages are JSON.

**Commands:**

| Command | Request | Response |
|---------|---------|----------|
| `reset` | `{ "command": "reset" }` | `{ "observation": {...}, "info": { "seed": ... } }` |
| `step` | `{ "command": "step", "action": [{...}, ...] }` | `{ "observation": {...}, "reward": float, "done": bool, "truncated": bool, "info": {...} }` |
| `close` | `{ "command": "close" }` | `{ "status": "closed" }` |

**Action format (array of up to 4 actions per step):**
```typescript
[
  {
    actionType: number,  // RLActionType enum
    sourceX: number,     // Source world X (nearest-entity spatial query)
    sourceZ: number,     // Source world Z (nearest-entity spatial query)
    targetX: number,     // Target X coordinate (destination or build site)
    targetZ: number,     // Target Z coordinate (destination or build site)
    param: number        // Unit category (TrainUnit) or building type (BuildStructure)
  },
  // ... up to 4 actions
]
```

| RLActionType | Value | sourceX/Z | targetX/Z | param |
|--------------|-------|-----------|-----------|-------|
| NoOp | 0 | ignored | ignored | ignored |
| MoveUnit | 1 | near unit | destination | ignored |
| AttackMove | 2 | near unit | destination | ignored |
| TrainUnit | 3 | near building | ignored | unit category (0-4) |
| BuildStructure | 4 | near worker | build site | building type (1-5) |

**Unit category indices** (for TrainUnit `param`):

| Index | Unit |
|-------|------|
| 0 | WorkerDrone |
| 1 | CombatDrone |
| 2 | AssaultPlatform |
| 3 | AerialDrone |
| 4 | FerryDrone |

**Building type indices** (for BuildStructure `param`):

| Index | Building |
|-------|----------|
| 0 | (unused) |
| 1 | EnergyExtractor |
| 2 | MatterPlant |
| 3 | SupplyDepot |
| 4 | DroneFactory |
| 5 | Wall |

**Observation format:**
```typescript
{
  resources: [energy, matter, energyRate, matterRate],  // 4 floats
  mapGrid: number[],      // 32x32 flattened terrain (0=passable, 1=obstacle), cached
  energyGrid: number[],   // 32x32 energy node locations (0/1), cached
  oreGrid: number[],      // 32x32 ore deposit locations (0/1), cached
  unitData: number[],     // 100 units x 9 features, own-first, zero-padded: [entityId, team, categoryIdx, posX, posZ, hp, maxHp, ammo, maxAmmo]
  buildingData: number[], // 100 buildings x 8 features, own-first, zero-padded: [entityId, team, typeIdx, posX, posZ, hp, maxHp, constructionProgress]
  gameState: number[],    // 12 binary features: [canAffordExtractor, canAffordPlant, canAffordDepot, canAffordFactory, canAffordWall, canAffordWorker, canAffordCombat, canAffordAssault, canAffordAerial, canAffordFerry, hasWorkers, hasProductionBuilding]
  actionMask: number[],   // 32x32 grid: 0=nothing, 1=unclaimed energy node, 2=unclaimed ore deposit
  tick: number            // Current simulation tick
}
```

**Reward signal weights:**

| Event | Weight |
|-------|--------|
| Income rate (energy + matter rate per step) | +0.0005 per unit |
| Resource building placed (Extractor/Plant) | +0.15 each |
| Own unit produced | +0.05 |
| Own building completed | +0.1 |
| Enemy unit killed | +0.1 |
| Enemy building destroyed | +0.15 |
| Own unit lost | -0.05 |
| Own building lost | -0.1 |
| Own HQ damage taken | -0.5 * (damage / 2000) |
| Enemy HQ damage dealt | +0.5 * (damage / 2000) |
| Win | +10.0 |
| Lose | -10.0 |

**Key files:**
- `scripts/run-rl-server.ts` — ZMQ server entry point
- `src/headless/RLTypes.ts` — RLActionType, AIAction, ObservationData, StepResult
- `src/headless/RLObservation.ts` — Observation extraction (units, buildings, map grid, fog filtering)
- `src/headless/RLReward.ts` — Reward calculation from state deltas

**Python usage example:**
```python
import zmq, json

ctx = zmq.Context()
sock = ctx.socket(zmq.REQ)
sock.connect("tcp://127.0.0.1:5555")

# Reset
sock.send_json({"command": "reset"})
resp = sock.recv_json()
obs = resp["observation"]

# Step (multi-action: up to 4 actions per step, spatial source/target)
sock.send_json({"command": "step", "action": [
    {"actionType": 0, "sourceX": 0, "sourceZ": 0, "targetX": 0, "targetZ": 0, "param": 0},
    {"actionType": 0, "sourceX": 0, "sourceZ": 0, "targetX": 0, "targetZ": 0, "param": 0},
    {"actionType": 0, "sourceX": 0, "sourceZ": 0, "targetX": 0, "targetZ": 0, "param": 0},
    {"actionType": 0, "sourceX": 0, "sourceZ": 0, "targetX": 0, "targetZ": 0, "param": 0},
]})
resp = sock.recv_json()
obs, reward, done = resp["observation"], resp["reward"], resp["done"]

# Close
sock.send_json({"command": "close"})
sock.recv_json()
```

## PPO Training (RL Agent)

Train an RL agent to play as team 1 against the built-in AI (team 0) using PPO.

**Local training:**
```bash
pip install -r training/requirements.txt
python training/train.py                           # 500k steps, auto-starts game server
python training/train.py --timesteps 1000000       # More steps
python training/train.py --resume training/checkpoints/lunar_wars_ppo_500000_steps  # Resume
```

**Modal.com GPU training:**
```bash
pip install modal
modal setup                                        # One-time auth
modal run training/modal_train.py                  # Default 500k steps on T4 GPU
modal run training/modal_train.py --timesteps 1000000
```

**Key files:**
- `training/lunar_wars_env.py` — Gymnasium wrapper (obs/action space, ZMQ bridge)
- `training/train.py` — Local PPO training with SB3
- `training/modal_train.py` — Modal.com GPU deployment
- `training/requirements.txt` — Python dependencies

**Observation space:** Fixed 5813-float array (4 resources + 1024*3 grids [terrain/energy/ore] + 900 unit data + 800 building data + 12 game state + 1024 action mask + 1 tick), normalized.

**Action space:** MultiDiscrete([5, 32, 32, 32, 32, 6] * 4) = 4 sub-actions of [actionType, srcGridX, srcGridZ, tgtGridX, tgtGridZ, param]. Shape (24,). 30 ticks/step default (0.5s game time per decision).

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
| `src/simulation/systems/EconomySystem.ts` | Ticks extractors (+5e/s); plants produce matter to global pool (+2m/s) |
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
| `src/simulation/ai/PlacementValidator.ts` | Shared building placement validation (used by AI + RL) |
| `src/headless/RLTypes.ts` | RL type definitions: actions, observations |
| `src/headless/RLObservation.ts` | Observation extraction with fog-of-war filtering |
| `src/headless/RLReward.ts` | Reward calculation from state deltas |
| `scripts/run-rl-server.ts` | ZMQ RL server entry point |
| `training/lunar_wars_env.py` | Gymnasium wrapper for RL training |
| `training/train.py` | Local PPO training script (SB3) |
| `src/simulation/systems/RLAISystem.ts` | PPO model inference for RL-trained agent (team 1) |
| `src/simulation/ai/RLInference.ts` | MLP forward pass for PPO policy network |
| `training/modal_train.py` | Modal.com GPU training deployment |

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
- Matter Plants produce directly to global pool (+2m/s, costs 2e/s)
- Ferry drone system: Ferry Drones trained at Supply Depots auto-shuttle matter from HQ to depot MATTER_STORAGE (10 matter/trip, 2s load/unload)
- Auto-resupply: combat units with ammo=0 auto-seek nearest depot for instant ammo refill + gradual repair (20 HP/s), costs matter from depot
- Game over detection: HQ destruction triggers win/loss
- AI opponent: build orders, smart forward depot placement, army control, scouting, ferry drone training at depots, supply-aware economy

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
