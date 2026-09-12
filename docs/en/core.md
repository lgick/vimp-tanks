# Rust Game Core (core/)

`vimp-tanks-core` (cdylib+rlib, `core/`) implements this game's simulation
on top of the engine's generic framework crate,
[`vimp-engine-core`](https://github.com/lgick/vimp-engine/blob/main/docs/en/core.md)
(rlib, no wasm-bindgen): tanks, weapons, bots, and the wasm-bindgen ABI
(`GameCore`/`ClientCore`) live here. This is the only place in the stack
that knows about tanks, bombs, or hitscan — the engine crate stays
generic. The core runs on the browser host (`GameCore`, see the engine's
[host.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/host.md))
**and on every client** (`ClientCore` — client-side math: interpolation,
prediction, visual shot spawning, frame decoding).

The mandatory method set both exported classes must implement is fixed by
the engine as part of `ENGINE_API_VERSION` — see the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md#wasm-host-abi-v1).

**The core's boundary is simulation, not meta**: chat, votes, stats, the
panel, round orchestration, the participant registry, and auth stay in the
engine's JS. Meta drives the core with commands and feeds on its events.

## Layout

```
Cargo.toml                        # + wasm-bindgen, dependency on vimp-engine-core
src/
├── lib.rs                    # the public ABI (wasm-bindgen): GameCore + ClientCore
├── body_tag.rs                # BodyTag (Player/Shot body user_data) — game-only;
│                              #   reserves tag byte 1 for the engine's map-object tag
│                              #   (dynamic map bodies: a blast target without damage)
├── tanks.rs                   # TanksSim (impl GameSim), TanksGame, GameState alias
├── tank.rs                    # Tank — movement, turret, health/ammo/cooldowns
├── motion.rs                  # shared mass-free motion formulas: one code path for
│                              #   the authoritative side (Rapier impulses) and the predictor replica
├── bomb.rs                    # Bomb — the projectile body (detonation lives in tanks.rs)
├── config.rs                  # ModelConfig/WeaponConfig/TanksConfig/TanksClientConfig
├── level.rs                   # 2.5D level rules: ramps, ledges, falling, collision
│                              #   masks — pure functions over the engine's MapLevels
├── shot_levels.rs             # 2.5D shot ray split into single-level segments
│                              #   (shared by the authoritative hitscan and the client)
├── bots/
│   └── controller.rs         # BotBrain — bot AI (input is generated inside the core)
└── client/                    # the core's client mode: TanksClient (impl GameClientDef)
    ├── mod.rs                 # TanksClient — wires Predictor/ShotPredictor into the
    │                          #   engine's generic ClientState<TanksClient>
    ├── predictor.rs           # the motion replica built on motion.rs + the step's
    │                          #   contact pass (walls, predicted bodies)
    ├── predicted_set.rs       # the predicted-world framework: bodies in follow/
    │                          #   predicted mode, reconciliation, error decay
    ├── map_dynamics.rs        # map dynamics: box geometry, capture into
    │                          #   prediction, the render and the sim box
    ├── remote_tanks.rs        # remote tanks in contact: capture with lookahead,
    │                          #   extrapolation without damping
    └── shot.rs                # gates, dedup, the raycast world
tests/
└── sim.rs                     # integration simulation scenarios (cargo test)
pkg-web/                       # the browser/Worker build (generated, not in git)
pkg-node/                      # the Node.js/Vitest build (generated, not in git)
```

## Build

Requires the Rust toolchain (`rustup` + `wasm-pack`):

```bash
npm run core:build        # both targets (web + nodejs)
npm run core:build:web    # browser/Worker → core/pkg-web/
npm run core:build:node   # Node.js (tests) → core/pkg-node/
npm run core:test         # cargo test --workspace (this repo's crate)
```

`npm run build` includes `core:build:web`: the WASM binary is needed by
both the host's Worker and the client (a single asset in this plugin's
build, referenced by `GameManifest.entries.wasm`).

## ABI: commands, events, frames

Two classes are exported: **`GameCore`** (the host's authoritative
simulation) and **`ClientCore`** (client mode, see below). Init data is
passed as JSON strings, shaped `{engine: {...}, game: {...}}` — the engine
half (`vimp_engine_core::config::EngineConfig`) is generic, the game half
(`TanksConfig`) is parsed by this crate. The `GameCore` config is
assembled by the engine's `packages/engine/src/lib/coreConfig.js`
(`buildCoreConfig()`), and maps are exported to JSON via
`npm run build:assets` (a step shared with serving maps without a client
rebuild).

The wasm-bindgen boilerplate for both classes (mechanical 1:1 delegations
into the engine's generic `EngineSim<G>`/`ClientState<G>`) is generated by
two macros from `vimp-engine-core` — `export_game_core_abi!` and
`export_client_core_abi!` — the single source of truth for the required
method set. This crate calls each macro next to its own additional
methods (`try_fire`, `set_model`, `sync_panel`, `spawn_actor`'s custom
args); `new` (config parsing) and non-`#[wasm_bindgen]` test accessors
stay hand-written.

```js
import { buildCoreConfig } from 'vimp-engine/lib/coreConfig.js';
const { GameCore } = require('../core/pkg-node/vimp_tanks_core.js'); // nodejs target

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // scaling happens inside the core
```

### Commands

| Method | Purpose |
| --- | --- |
| `new GameCore(config_json)` | the Rapier world, weapons, models, keys, the snapshot-key registry |
| `load_map(map_json)` | map bodies + bots' nav graph; scale — the map's `scale` or the config's `mapScale` |
| `map_info()` | JSON: `setId`, `step`, dimensions, scaled `respawns` |
| `spawn_actor(id, model, teamId, x, y, angle°)` | a tank; emits `panelActive` + `panelSet(health)` |
| `remove_actor(id)` | removal + a null marker in the next frame |
| `reset_actor(id, teamId, x, y, angle°)` | respawn/team change (keys/throttle reset, health untouched) |
| `reset_all_vitals()` | health/ammo back to defaults (a new round) |
| `spawn_scripted_actor(id, model, teamId, x, y, angle°)` / `remove_scripted_actor(id)` | a tank + AI controller inside the core |
| `apply_input(id, seq, action, name)` | `'down'/'up'` input + key name; `seq` is confirmed in the player block |
| `step(dt)` | fixed physics steps + bot AI + the spatial grid |
| `clear()` | fully clears the world (a map change) |
| `remove_players_and_shots()` | a JSON array of names for clients to clear their canvas |
| `players_data()` | JSON `{ model: { id: [x,y,angle,gun,vx,vy,engineLoad,condition,size,team] } }` for the first frame (`FIRST_SHOT_DATA`); reads the cache, doesn't drain accumulators |
| `body_has_events()` | whether the last `pack_body()` carried event blocks (tracers/bombs/explosions/removals); the host's Worker uses it to classify the WebRTC channel (events → meta, positions → state) without changing `pack_body`'s signature |
| `serialize_state()` / `deserialize_state(dump)` | dumping/restoring the simulation for a Worker handoff; drain `pack_body()` before dumping |

### Events (`take_events()`)

A JSON array; the buffer clears on read. The standard engine dictionary
(Wasm Host ABI, `vimp_engine_core::events`) — `GameCoreAdapter._drainEvents`
(engine-side) routes it into meta by itself, with no game-side mediator:
`panelSet`/`panelActive` → Panel (`field` is this game's panel-schema key,
not tied to a specific weapon), `death` → RoundManager.reportKill,
`shake` → per-user camera shake in frame meta. `custom` is the only type
outside the dictionary, carrying game-specific meaning: the adapter drains
it as-is into `HostPlugin.onCoreEvent(data, services)` (this game doesn't
use it — `onCoreEvent` is left unset):

```json
[
  { "type": "death", "victim": 2, "killer": 1 },
  { "type": "panelSet", "id": 2, "field": "health", "value": 60.0 },
  { "type": "panelSet", "id": 1, "field": "w1", "value": 199.0 },
  { "type": "panelActive", "id": 1, "field": "w2" },
  { "type": "shake", "id": 2, "intensity": 20, "duration": 200 }
]
```

Health and ammo are **the source of truth in the core**: the JS panel is a
projection of these events.

### Frames (v5, byte-for-byte with the decoder)

- `pack_body()` — the broadcast body, once per frame sent; it **drains**
  the snapshot's event accumulators (shots/explosions/removals accumulate
  in the core between sends — the send-rate throttle, `SnapshotThrottle`,
  stays on the engine's JS side);
- `pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake, playerId)`
  — a per-user frame: header + camera + a player block (if `playerId >= 0`
  and the tank exists) + a copy of the body; returns its length;
- `frame_ptr()` — a pointer for zero-copy reads in the browser:
  `new Uint8Array(wasm.memory.buffer, ptr, len)` (memory comes from the
  web target's `init()`);
- `frame_bytes()` — a copy of the frame (the nodejs target doesn't expose
  its memory).

Frames are decoded by this crate's client core (`src/client/mod.rs` via
`vimp_engine_core::client::unpack`) — the packer and unpacker live in the
engine crate, so a layout mismatch is impossible by construction; the
shapes are locked in by round-trip tests (`#[cfg(test)]` in the engine's
`unpack.rs`, plus this repo's `tests/core/core.test.js` and
`tests/core/clientCore.test.js`).

### State queries

`is_alive(id)`, `position_of(id)` (rounded to 2 decimals),
`last_input_seq(id)`, `alive_players()` (a flat array `[id, teamId, x, y, ...]`).

## ClientCore — the core's client mode

A second wasm-bindgen class from the same binary; lives in the main thread
of a client tab (for the host player, a second WASM instance sits next to
the Worker). `ClientCore` wraps
`vimp_engine_core::client::game::ClientState<TanksClient>`: the engine
crate owns the network buffer (`Interpolator`), the event-frame queue and
the hot-buffer write (`ClientState<G>`); `TanksClient` (`src/client/mod.rs`)
implements the `GameClientDef` trait — `Predictor`/`ShotPredictor`
orchestration, own-tank tracking, and the predicted render overlay.
`export_client_core_abi!` generates the engine-minimum wasm-bindgen
methods below (all but `set_model`/`try_fire`/`cycle_weapon`/`sync_panel`,
which stay hand-written in `src/lib.rs` since their shape is game-specific;
inside the trait these hooks carry neutral names —
`try_action`/`cycle_item`). The trait's shape is validated by a fixture
second client (`TestClient`, tests in the engine's
`packages/engine/core/src/client/game.rs`) before any real second game
exists. Its config is assembled by the engine's
`packages/engine/src/lib/clientCoreConfig.js` from the
`prediction`/`interpolation` sections of CONFIG_DATA plus the bundled
`opcodes.js` registry; the `timeStepMs` field fixes the units (ms, unlike
`CoreConfig.timeStep` in seconds).

| Method | Purpose |
| --- | --- |
| `new ClientCore(config_json)` | models/weapons/keys + the snapshot-key registry + interpolation |
| `push_frame(bytes, localNow)` | decodes a frame, inserts into the buffer by `seq` (+dedup/late), reconciles the predictor from the player block; `false` — the frame was dropped (port/version/corrupt) |
| `my_game_id()` / `offset()` | one's own id from the player block (−1) / an EMA estimate of `serverTime − localNow` (NaN) |
| `sample(localNow)` | the entire render tick: emitting crossed frames (dedup filter → a JSON queue), interpolation, a predictor step; returns the hot buffer's length |
| `hot_ptr()` / `hot_values()` | a zero-copy pointer to the hot buffer (web) / a copy (nodejs) |
| `take_frames()` | event frames as a JSON string `[{game, camera}, …]` (the `applyShot` shape); the queue is cleared |
| `apply_input(action, key, localNow)` | records input into the predictor's history |
| `try_fire(localNow)` | a local visual shot; gates (cooldown/ammo/pending bomb/alive/active) are internal; returns spawn JSON or `undefined` |
| `cycle_weapon(back)` | a local weapon-cycle switch (authoritative confirmation comes via the panel) |
| `set_model(name)` / `set_active(bool)` / `set_map(json)` / `sync_panel(json)` / `reset()` | client port mirrors: auth, KEYSET, MAP_DATA, PANEL_DATA, CLEAR. `reset()` also drops the local tank's meta, so the prediction overlay disappears right away instead of waiting for the spectator keyset |
| `decode_frame(bytes)` | a plain v5 decode → the frame's JSON shape (tests/harness); `'null'` on a version mismatch |
| `map_dynamics_to_world(key, localX, localY)` | a body-local point → world in the render frame: `[x, y]`, or an empty array |
| `ramp_runs()` | the current map's ramp runs as a JSON array `{axis, sign, from, to, min, max, crossMin, crossMax, block, railMin, railMax}` in WORLD units (`railMin`/`railMax` — the side rails' bounds from `map::ramp_rail_span`, `null` when the run gets none) — the very `MapLevels::runs` the physics puts its ramp guards on; `[]` when there is no map or it is single-level. The renderer draws the wedge by it (the `rampRuns` service), so the picture and the physics cannot drift apart |

**Own-shot dedup (bombs).** A bomb planted locally appears on the canvas
immediately under a local id (`L1`, `L2`, …) while the request travels to
the host. When the authoritative entity arrives, `shot.rs` does **not**
swap one for the other: its id is recorded as an **alias** of the local one
(`bomb_aliases`) and the row itself is renamed to the local id instead of
being dropped. Everything that later arrives under the authoritative id —
first of all the detonation `null` — is renamed the same way, so the entity
lives under a single name from spawn to detonation. Deleting and recreating
it would restart its timer and cut off the one-shot "planted" sample. The
alias is removed by the detonation `null`; `BOMB_ALIAS_MAX_AGE` (60 s, well
above any sane `weapon.time`) is only a leak guard for a lost `null`.

**Bomb position.** The local spawn goes exactly to the predicted tank
position, with no velocity extrapolation: the client does not know its own
latency (the interpolator's `offset` is a clock difference between the
host's `Date.now` and the client's `performance.now`, not a network delay —
taking it for one throws the bomb out of the world as soon as the tank
moves). The offset from the host — which plants the bomb where the tank has
got to by the time the command arrives — is closed by the renamed
confirmation row: it reaches the canvas as an `update` of the existing
entity, so `Bomb.update` moves the sprite and its sample to the
authoritative point without recreating anything.

`set_active` (KEYSET) therefore resets only the *local* half of the
predictor (`ShotPredictor::reset_local`) and keeps the aliases: KEYSET
travels on the reliable `meta` channel and is applied on arrival, while the
detonation rides a state frame through the interpolation buffer and lands
~`interpolation.delay` later. Dropping the aliases on a keyset (which is
what a player's death sends) would leave the bomb sprite on the canvas
forever. Unconfirmed local bombs, in contrast, are buried on any reset: their
local ids go to `expired_local_bombs` and the next frame gets a `null` for
each. The full `reset()` (CLEAR) drops the aliases too — the canvas is
cleared wholesale and there is no one left to deliver a `null` to.

**Hot buffer layout** (flat, reusable Float32):
`[0]` — flags (`HOT_FLAGS` in the engine's `opcodes.js`: game/camera/
predicted/frames), `[1..2]` — camera x/y (already resolved by the core:
predicted position or interpolated), `[3]` — the tank count N, followed by
N×15 (`keyId, gameId, x, y, angle, gun, vx, vy, engineLoad, condition,
size, teamId, angvel, z, level`), then M dynamics × 8 (`keyId, index, x, y, angle,
vx, vy, angvel` — a resting body ships no velocities in the frame, but the
record is still full width: the missing tail decodes as zeros); the
local tank's predicted record comes last. This tail is written by the
engine verbatim from `GameClientDef::render_overlay`'s
`RenderOverlay.tail` — the engine only knows the camera
(`RenderOverlay.camera`) and the presence flag, not the tail's field
layout (`TanksClient::render_overlay` builds it as the same 15-value
shape). `keyId` — numeric ids from this game's snapshot schema
(`src/config/snapshot.js`); client JS reads the records generically off
the same schema (record width = 2 service fields + the key's `fields`
count). A field's `interp` mode lives in that schema alone — no copy of it
exists on either Rust side — but the engine's interpolator reads it BY
INDEX, and game behaviour can depend on it: `vz` is declared
`interp: 'discrete'` precisely so that the client's touchdown detector
(`src/client/landing.js`) still sees an exact zero on another player's
tank.

**motion.rs** — shared mass-free tick formulas for motion (turret,
throttle, lateral grip, thrust/braking, engine load, turning): the
authoritative side (`Tank::update`) multiplies them by mass/inertia for
Rapier impulses, while the predictor replica integrates manually (position
by velocity *before* damping → `v *= 1/(1+dt·d)` — an empirically matched
Rapier order). The replica can't diverge from the authoritative path on
formulas; integration parity is locked in by the cargo tests
`client::predictor::parity` (6 scenarios).
⚠️ **Any edit to motion in the core or `models.js` requires running
`npm run core:test`.**

**Prediction drift (level 1).** `TanksClient` implements both optional
`GameClientDef` methods the engine's divergence detector uses:
`predicted_state()` returns the replica's `TankState` in the player-block
layout (`x, y, angle, vx, vy, angvel, gunRotation, throttle` — the same
order `TankState::from_array` reads, so no conversion table exists to drift),
and `replayed_inputs()` reports the local-time window the last
reconciliation replayed. The engine samples them right before
`on_server_state` overwrites the prediction, so a report names the exact
component and delta instead of "movement feels wrong". Both are debug-only:
without the `divergence` section in the client config the engine never calls
them. Scenarios that watch drift: `tests/scenarios/` (see
[getting-started.md](getting-started.md#debug-scenarios-headless-match)).

**Predicted world (`predicted_set.rs`).** The local tank is drawn "now"
(the predictor), everything else with the interpolation delay. While bodies
do not touch, the difference is invisible; **in contact it shows at once**:
the drawn body lags behind the authoritative one and the tank legitimately
ends up inside it. The framework closes that gap: a set of bodies, each of
them either in `Follow` mode (the transform is led by interpolation) or in
`Predicted` (the body is owned by the same simulation as the local tank, in
the same time). `PredictedSet` carries the mechanics shared by every
subsystem — reconciliation (`begin_reconcile`/`finish_reconcile`), the
integration step, the accumulation and decay of the visual error, the
return to interpolation (`demote_idle`/`release_predicted`); the
`PredictedBodies` trait leaves a subsystem only what is genuinely its own:
`update` (how bodies are read from the interpolated game), `snapshot_bodies`
(how they are read from a raw frame), `capture` (the capture rule) and
`render_data` (the render block that overrides interpolation). The split
is not cosmetic: two subsystems with copies of the mechanics would drift
apart in behaviour on the first edit.

The set keeps no clock of its own: it is stepped by `Predictor`
(`integrate_predicted`, `decay_error`), so a contact with the local tank is
resolved within a single step and the reconciliation replay replays the
set's bodies too. `Predictor::resolve_world` is that step's contact pass —
the tank, the captured bodies and the wall blocks are separated once **per
pair** by the deepest point of their manifold and then run through
`SOLVER_ITERATIONS` (4) impulse passes over every point of every manifold,
using the engine's `client::collision`/`client::rigid_body` primitives.
Without a map and without subsystems the pass is a full no-op, and the
motion replica stays bit-for-bit what it was — the invariant the parity
tests rest on.

**The order of a step is Rapier's, not the obvious one.** Contacts are
solved **before** the position is integrated: `step_inner` applies the
input, calls `resolve_world(dt)` on the pose at the start of the step, and
only then moves the body and damps it. The contacts themselves are
collected with a gap — `motion::contact_prediction(width, height)`, the
very number `Tank::new` hands Rapier as `soft_ccd_prediction`, so the two
sides see a contact on the same step. Resolving after the integration let
the replica travel up to 1.24 units into a wall in one step at full speed
and react from the inside, with a lever the host never had; the manifold
and the accumulated impulses of the engine primitives do the rest.

**A falling tank is frozen input, not zero input.** `Tank::update` returns
early while `level_state.input_locked()`, before the turret, the throttle
and the thrust — the keys stay pressed and are picked up on landing. The
replica mirrors that early return exactly. Merely zeroing the key mask
would keep centring the turret, bleed the throttle off and brake with the
thrust, and the drift would accumulate on every fall.

`TanksClient` implements the three
`GameClientDef` hooks for bodies a game predicts itself and forwards them to
the sets registered in the predictor: `begin_reconcile(snapshot)` before the
input replay, `finish_reconcile()` right after it, and `render_rows()` —
the rows the engine appends to the hot buffer after the local tank's
predicted tail, where each of them overrides the interpolated row of the
same entity.

**Map dynamics (`map_dynamics.rs`).** The framework's first subsystem: a box
the local tank pushes is simulated in the same simulation and in the same
time as the tank — otherwise it is drawn where it was one interpolation
buffer ago and the hull drives into it before it starts moving. The scope is
deliberately narrow: bodies unrelated to the local tank stay in `Follow`.
Otherwise a box pushed by a *remote* tank would run ahead of that tank's
sprite, which looks like a push from a distance.

The geometry is set by MAP_DATA (`set_map`) alone and is replaced wholesale;
there is deliberately no reset method: CLEAR wipes the canvas, not the map,
and it also arrives at the start of a round **without** a MAP_DATA after it —
a reset on CLEAR would erase the boxes for good. Capture into prediction is
an overlap with the local tank's OBB inflated by `CAPTURE_MARGIN`, plus the
transitive closure over neighbours with the same margin (a stack of boxes
moves as a whole); the set is capped at 12 bodies, otherwise the 20-box wall
of `canopy` would be pulled into prediction in its entirety. A dynamics row
is addressed by the object's index in `physicsDynamic` (the body key `d0`,
`d1`, … is built from it), never by the body's position in the predicted
set — the two coincide only as long as no body leaves the set.

The coordinate convention: boxes are stored by their **centre**, while in the
snapshot `c1`/`c2` `[x, y, angle]` is the "object origin" (the position of
the Rapier body); the conversions are the engine's `box_center_from_origin`
and the subsystem's `origin_from_box_center`. There are two views of a box
and a consumer must take its own:

| View | Method | For whom | Why |
| --- | --- | --- | --- |
| render | `render_box` / `to_world` (plus `map_dynamics_to_world` across the WASM boundary) | the game's sprites and effects | where the box is **drawn** (state plus the smoothing error) |
| sim | `sim_box` / `sim_boxes` / `to_local` | the shot raycast | where the box is **on the host**; otherwise the local hit diverges from the server one |

The sim box of a `Follow` body comes from the last authoritative frame, not
from the interpolated transform: the latter lags by `interpolation.delay`,
and a ray would miss a moving box.

**Remote tanks (`remote_tanks.rs`).** The framework's second subsystem. The
local tank is drawn "now", the remote ones with the interpolation delay, and
a push shows the gap **on both sides at once**: the pusher drives into the
drawn hull (the client never resolved that contact at all), and the one being
pushed sees a gap — the pusher is drawn where it was 100 ms ago. Bodies are
read from the model block (`m1`), keyed `model:gameId`; the local tank is
excluded from the set (the predictor owns it), and a tank that disappeared
from its block is dropped — the interpolated sample carries no null markers.
The hull is `size×4 : size×3` with the mass properties of the model's
`fixture`, exactly as on the host.

Two decisions are deliberate and load-bearing:

- **the capture check runs ahead of the contact.** "The hulls already
  overlap" never fires here: on the pushed player's screen the remote tank is
  drawn where it was at `serverNow − delay`, i.e. it has **not arrived yet**.
  So the check uses the authoritative position shifted forward along its own
  velocity (`CAPTURE_LOOKAHEAD`, 0.2 s); capturing slightly early is harmless
  (the predicted body just follows the host exactly), being late is not.
  There is no transitive closure — a chain of tanks pushing tanks
  practically never happens, while extra predicted bodies mean extra jitter
  on other screens. The set is capped at 6 bodies.
- **the extrapolation runs without damping.** The remote player's input is
  unknown, and a driving tank keeps the throttle down, so its velocity over
  those 100 ms is roughly constant. Applying the model's damping would brake
  the remote tank for no reason (`linear: 3` eats ~23 % of the speed over
  100 ms) — hence a path of its own, separate from the local tank, whose
  damping is applied (`motion.rs`).

Wrecks (`condition 0`) are captured just like live tanks: the host does not
remove their body from the world (`remove_player` is called only when a
player leaves, switches teams or a new round starts), so they stay a pushable
obstacle. The render row repeats the model block in full, `angvel` included —
without the angular velocity (frame v5) the remote hull would not finish its
turn while in contact.

## The shot's raycast world

`shot.rs` owns none of the moving geometry: the tracer's ray is cast against
the map grid built once per MAP_DATA and shared (`Rc`) with the motion
predictor — `TanksClient::set_map` parses the config a single time, so "the
ray and the contact see one map" is a property of the construction rather
than a coincidence of two separate parses — plus the **predicted**
subsystems, which
`TanksClient::try_action` hands over for the duration of the shot
(`ShotWorld { dynamics, remote_tanks }`). Both are read through their **sim**
views (`MapDynamics::sim_boxes`, `RemoteTanks::sim_boxes`) — where the host
sees the world "now". The drawn transforms lag by `interpolation.delay`, and
a ray cast against them would miss a moving box or a driving tank, so the
local hit would disagree with the authoritative one. A remote tank the
`RemoteTanks` set does not hold (no contact, no prediction) falls back to its
row from the frame.

The ray is cast in the sim frame, but the tracer is *drawn* among the
interpolated sprites, so the end point is carried back into the render frame
of whatever was hit: `to_world` for a box, `to_render_point` for a hull.
Without that the tracer would end in mid-air, short of the box that is drawn
somewhere else.

**The hit anchor.** A hit into map dynamics adds a ninth element to the
tracer row — `[key, localX, localY]`, the impact point in the box's own
frame. It exists only in the locally predicted row: it is built in
`build_tracer`, travels as spawn JSON through `applyGameData`, and never
touches the frame schema (`w1` stays 8 fields), so authoritative tracers
arrive without it (`data[8] === undefined`). The consumer is
`ShotEffectController` (`src/client/parts/effects/shot/`): the box may drive
on during the 45–80 ms of the tracer animation, so the impact point is
recomputed from its **current** transform (the `mapDynamics` service over
`map_dynamics_to_world`) instead of the one captured at the shot — otherwise
the debris cloud lands behind the box that has moved away. After the spawn
the debris stays put: it does not follow the box (`ImpactEffect` works in
world coordinates).

## Tank body

`Tank::spawn` (`core/src/tank.rs`) builds a dynamic body sized `size×4 :
size×3` with damping from `models.js` and a cuboid collider that emits
collision events (the projectile hits are collected by `TanksSim`).

The hull tilt lives here too: `Tank` carries `pitch`/`roll` (radians) and
recomputes them every step in `Tank::update` — BEFORE the early return on
locked input, together with the turret, because tilt works in flight. The
target comes from `motion::tilt_target` (the longitudinal and lateral parts
of `slope_vec` under the hull's heading × `tiltGain`; in flight the nose
follows `vz` × `tiltAirGain`, all clamped by `tiltMax`), and the smoothing
from `motion::approach_tilt` (`tiltResponse`). A respawn levels the hull.
Both formulas live in `motion` because the replica (`Predictor::step_tilt`)
has to compute the tilt with the same functions in the same order; other
players' tanks take their tilt straight from the frame.

The body is created with `soft_ccd_prediction(width.min(height))` —
predictive contacts up to the hull's own thickness. Rapier's default
prediction distance, 0.002 units, is calibrated for a metre-scale world,
while a tank covers up to 2.2 units per `1/120` step: without prediction
the contact was born only once the hull already overlapped the obstacle
(the measured peak was 1.26 units in the frame of impact against 0.03 with
prediction), which looked like driving into a wall and being pushed back
out. Dynamic map objects get the same treatment on the engine side.

Because the contact is now honest, `brakingFactor` no longer has to
compensate for it — hence the low value in
[configuration.md](configuration.md#modelsjs).

## 2.5D levels (`core/src/level.rs`)

On a layered map (the engine's `levels`/`ramps` fields, see
[the engine docs][engine-map]) every tank carries a `LevelState`: the
discrete `level` (`0` — ground, `1..7` — overhead floors), the visual
height `z` (`0.0..N`), the previous step's cell `prev_cell`, the slope
vector `slope_vec` and the `Transit` it is in.

| `Transit` | When | Collision mask | Input |
| --- | --- | --- | --- |
| `Grounded` | standing on its own level | that level only | normal |
| `Ramp { climbing, low, high, run }` | the hull's centre is on a ramp tile | with `climbing` — **every** level of the run (`low..=high`), otherwise its own level only | normal |
| `Airborne { vz, from, to, peak }` | drove off a ledge or left a ramp's top end | map walls only — no bodies; above `from + jumpClearance` the mask is empty and the tank clears walls too | driving locked, turret and firing work |

`step_level()` is the single source of these rules for both sides: the
authoritative path (`TanksSim::update_levels`) and the client replica call
exactly it, so a level predicted on the client cannot silently drift from
the authoritative one.

- **Ramps.** `z` follows the ramp's progress; `level` is the nearest whole
  one (`z.round()` clamped to the run's ends), so a 0 → 2 ramp only hands
  out level 2 near its top instead of a third of the way up. The snap costs
  nothing physically — on a run the mask already contains every level of
  the run — it only makes the state defined once the tank leaves the ramp
  at either end. Only a LEGAL climb widens the mask: for a tank that came
  in from the side, or for one driving under the run's cells (a `1 → 2`
  ramp lives in the level-1 grid with ordinary ground beneath it), the run
  is a flat tile of its own level and the mask stays that level's group.
  Otherwise a ground tank under the run would take the bridge's levels and
  drive through the walls of its own. The entry gate is decided ONCE, on
  entering the run, and is kept in `Ramp { climbing, run }` — together with
  the run's NUMBER: moving into an adjacent run is a new entry, and the
  neighbour's verdict is not inherited. The ONE exception is a lane change
  on a wide ramp (`is_lane_change`): a rectangular block of ramp tiles is
  cut into parallel lane runs by `MapLevels::build_runs`, and the crate
  numbers the lanes of one hill with a shared `RampRun::block`, so a step
  into ANOTHER run of the SAME block carries the verdict over — without it
  every lane border would break the climb halfway up. The BLOCK NUMBER is
  the whole rule: the step's direction decides nothing, because a diagonal
  step changes both cells at once and a "straight across the axis" demand
  broke the climb in the middle of a wide hill. The number comes from the
  engine on purpose: the physics fences a block by the same field, and two
  definitions of one hill would drift apart. Lanes of DIFFERENT length fall
  into different blocks and the gate judges the move; so does an entry from
  an END of a lane, where the previous cell is no ramp at all. The entry is legal when the previous
  step's cell (`prev_cell`, written every step) lies outside this run and
  the ENTRY cell is an END cell matching the tank's level: the foot for the
  lower level, the top for the upper one. The direction of the entry is not
  judged at all — head-on, diagonal and sideways are equally legal, and the
  end is picked by the sign of the step along the axis (or, for a pure side
  entry, by the entry cell itself). A step ACROSS the axis adds two
  conditions so that an entry cannot become a lift: the body must stand at
  its own level's height, and the ramp's height at the entry point must be
  closer to it than `maxSideEntryRise` (`LevelRules::max_side_entry_rise`,
  half a level by default). The bound EXCLUDES its own value: a jump of
  exactly half a level is already illegal — on a run one cell long (which
  has no side rails at all) it produced a visible click of the hull and its
  shadow. A tank that came into
  the MIDDLE of a run, or ran into the top end from below (the passage under
  the bridge), keeps its level and treats the run as flat ground — if the
  run's guards let it in at all (see below; they do not close the foot
  cell). A spawn directly on a run has nothing to judge by: there the old
  half-of-the-run rule applies.
- **Grade.** On a ramp `slope_vec` is the uphill vector, and it is
  DIMENSIONLESS: the engine computes it as `rise * levelHeight / span`,
  where `levelHeight` is the map's level height in world units (the tile
  size by default). On the demo maps the grade runs from 0.11
  (`terraces.rampLong`) to 0.5 (`terraces.rampSteep`).
  `LevelState::grade(heading)` gives the longitudinal grade under the
  hull's heading, and `motion::drive_accel` subtracts `grade *
  climbGravity` from the thrust and trims the speed ceiling by
  `climbMaxSpeedFactor * grade`. Off a ramp the grade is exactly 0 and the
  formula is bit-for-bit the old one.
- **Ledges.** A tank on level `L >= 1` enters `Airborne` when its HULL has
  left the slab: support is judged by `level::has_support` — the hull's
  centre or any of its four corners over a floor tile of its own level.
  While a corner still rests on the slab the tank hangs over the void but
  stays `Grounded`, with its input free, so reversing at the very brink
  brings it back; the old centre-point test dropped it — irreversibly, as
  `Airborne` locks driving — with half the hull still on the slab. Host
  (`TanksSim::update_levels`, hull angle from the body) and replica
  (`Predictor::footprint`, angle from the predicted state) ask the same
  function; map bodies (crates) keep the engine's centre rule
  (`map::step_body_level`). A started fall is never cancelled: drifting
  back under the slab does not put the tank back on it. The landing level
  is chosen at the moment of the
  drop — `MapLevels::landing_level` (the nearest floor below with a surface
  in that cell) — so a tank falling off level 2 over a level 1 slab lands on
  that slab. The stored `to` only shapes the trajectory: the landing level
  is recomputed from the cell of TOUCHDOWN, otherwise drifting past the
  lower slab would sit the tank on a floor no longer under it. The flight is BALLISTIC: `vz -= g·dt`,
  `z += vz·dt` by the trapezoid rule (which is an exact sample of the
  parabola at every `n·dt`, so `v² = v0² − 2g·Δz` holds on every step).
  Gravity is not a config constant but derived from `fallTime`:
  `g = 2 / fallTime²`, so a drop of exactly one level still takes the same
  time and deals the same damage, while a two-level one comes out faster
  than twice that. DRIVING input is ignored throughout (held keys are picked
  up on landing) while the turret and the gun keep working, and the body
  carries the `STATIC_LEVEL_GROUP` mask while coasting on inertia: the walls
  of every level still stop it (at `maxForwardSpeed` a fall covers some
  seven tiles, and without them the tank would land inside a building),
  while tanks, crates, rays and blasts do not reach it. While `z` stays
  `jumpClearance` above the take-off level the mask is empty altogether — a
  jump clears obstacles (`LevelState::clear_walls`: the threshold comes from
  the rules and `collision_mask` cannot see them, so `step_layered` computes
  the flag and the mask only reads it). A slab ABOVE the take-off level is
  caught by a branch of its own, by CROSSING a whole level downwards —
  otherwise a tank that fell short of the slab would teleport onto it. The whole flight — integrating
  the arc, picking the touchdown cell and landing — lives in
  `level::step_airborne`, a function of its own: `step_layered` would
  otherwise hold three independent rules in a row (flight, the ramp run and
  leaving a slab). On
  landing the tank is on the level of the touchdown cell and takes
  `fallDamage` per level of height ABOVE `fallDamageFreeHeight` —
  `fallDamage · max(0, height − fallDamageFreeHeight)`, capped by
  `maxFallDamage`; the height is
  measured from the arc's PEAK rather than from the take-off level, so a
  tank thrown up by a jump pays for the climb too, while a hop onto its own
  slab, whose arc never leaves the dead zone, is free. A lethal landing emits
  `Death { victim, killer: victim }` — a suicide, so the engine's round
  meta awards no frag.
- **Ramp jumps.** A body that was legally climbing a run does not lose its
  vertical speed when it leaves it: `slope_vec · vel / levelHeight` (the
  grade is dimensionless, the velocity is in world units, and the level
  height converts them into levels per second) times `rampLaunchFactor`
  becomes the initial `vz`. The flight only starts if that exceeds
  `minLaunchVz` — otherwise rolling down a gentle ramp at walking pace would
  produce a micro-jump on every cell — and the take-off speed is capped by
  `maxLaunchVz` (`0` — no cap): without a ceiling `vz` depends on the grade
  and the speed alone, and a steep run throws the tank above any geometry
  the map has (measured on `terraces`: 9.2 levels/s, an arc of 2.6 levels).
  The ceiling is what keeps `clear_walls` unreachable — the arc it allows,
  `maxLaunchVz² / (2·g)`, stays below `jumpClearance`. The check runs BEFORE the ledge test:
  a tank leaving a ramp over the void would otherwise start falling with
  `vz = 0` and lose the jump. The target of such a flight is the tank's own
  slab (when there is one under it), and the arc starts exactly at the
  level's height: a run's top end stops a thousandth of a level below it,
  and the arc would otherwise start under the slab.
- **Flat maps** are untouched: `step_level` resets the state to level 0 and
  the mask stays the level-0 group, exactly what a tank had before levels
  existed.

Collision masks live on the hull collider (`Tank::collider`) and are
rewritten by `Tank::sync_collision_groups` only when the mask — or the
"driving up a run" flag — actually changes: a legal climber passes the
run's GUARDS straight through (`map::levels_interaction_on_ramp`), while
everyone else sees them. The guards are the run's sides and its "wrong"
end: separate engine colliders (`GameMap::create_ramp_guards`) that live in
no grid and fence a whole BLOCK of ramp lanes, never a single lane. The
client replica takes the very same geometry from the engine
(`map::ramp_guards`, computed once per map load by both the host and
`Predictor::set_map`) — one formula for both sides, a copy would drift
silently. The replica's "do I see the guards" rule is a single function as
well — `level::body_on_ramp`: only a body LEGALLY driving up a run passes
them through. The local tank's verdict comes from the gate
(`LevelState::on_ramp`); a map body never climbs at all (the host never
gives map bodies `levels_interaction_on_ramp`, so a crate shoved onto a run
runs into the rail); and a remote tank is judged by the height in its
snapshot row: having refused the gate, the host puts `z` exactly on the
level, while a legal climber gets a fractional one.

A remote tank's height arrives in FRAMES only (`RemoteTanks::begin_reconcile`
and `update`): between frames the replica moves the body itself and keeps
the previous `z`. The verdict therefore lags by exactly one frame, and only
on entry, where the height is still whole while the body already stands on a
run cell. That lag has nowhere to go wrong: the rails start one cell FARTHER
in than the foot (`map::ramp_rail_span`), and in one interpolation-buffer
frame the body does not reach them, while at the top there are no guards for
upper-level bodies at all. Predicting a remote tank's height would mean a
second gate in the replica, with its own cell history — a second copy of the
rule, free to drift silently.

Walls the replica
reads as the glued blocks of `MapLevels::static_blocks`
(`collect_block_contacts_into`), the very list the host puts its colliders
by.

The guards are invisible to a bot's obstacle-avoidance rays
(`bots::controller::avoid_obstacles` casts with
`map::levels_interaction_on_ramp`): a run is one tile wide, so the side rays
would hit its rails on every approach and turn the bot away from the foot.
Driving in from the side is held by the guards themselves and by the nav
graph, which routes no path through the cells of a run.

`TanksSim` keeps its own copy of the map's `MapLevels` (`spawn_actor` never
sees the map): it is refreshed in `on_fixed_step` whenever the map's
fingerprint — `setId` plus the level-0 grid dimensions — changes, and every
tank is then re-levelled by geometry. `on_fixed_step` runs in this order:

```
1. sync_levels(ctx)      # the levels copy follows the current map
2. update_levels(ctx)    # level, z, masks, fall damage — BEFORE input
3. tank.update(...)      # input -> impulses -> shot
4. process_shots_expired_by_time
```

Levels reach the client in the `m1` block as the `z`/`level` fields
(`src/config/snapshot.js`); the frame format itself did not change —
`PLAYER_STATE_LEN` is still 8.

### The level replica on the client (`core/src/client/predictor.rs`)

The client does not take `z`/`level` off the player block — they are not in
it. `Predictor` calls `step_level()` itself, over the same `MapLevels` it
builds from MAP_DATA and with the same `coreParams.levels` rules (they reach
the client core as `prediction.coreParams` in CONFIG_DATA), at the very
start of a step — before the input, exactly like `TanksSim::update_levels`;
a falling replica ignores input just as the host does. That is why
`PLAYER_STATE_LEN` was not widened: a value derived from the position costs
nothing on the wire and cannot fall out of sync with the position it is
derived from. `LevelEvent::Landed` is ignored on the client — the damage is
authoritative and arrives with the panel.

The frame is still the last word: `begin_reconcile` reads the local tank's
`z`/`level` off the **raw** frame — the very one the replay starts from,
rather than the interpolated sample, which lags by the buffer — and hands
the pair to `Predictor::correct_level`. The frame does **not** overwrite the
level by itself: `on_server_state` always follows `begin_reconcile`
(`ClientGame::push_frame` calls them together), and it rewinds the state to
the frame's step and replays the input — the level is recomputed there by
the same rules the host uses. The old "adopt the frame's level outside a
transition" correction broke the DESCENT: the frames in flight while a tank
falls still carry the upper level, so a replica that had already landed was
lifted back onto the bridge (`level = 1, z = 1`). Everything downstream then
ran on the wrong level: the collision mask banged the tank against railings
that do not exist for it on the host, and the renderer gave the hull the
scale and tint of the overpass. The flight, in contrast, is authoritative all
the way through: instead of dropping an unfinished `Airborne`, the
reconciliation takes it from the frame — both the height `z` and the
vertical speed `vz`. The phase cannot be recovered from the height alone:
under ballistics one `z` answers two points of the arc, the rise and the
descent (the inverse `fall_elapsed` only ever worked for a linear fall and
is gone). Height and speed come from ONE frame and therefore lie on one
parabola: the level state rewinds to the snapshot NO LATER than the frame
while the replay starts after it, so the replica's own vertical lags the
frame by exactly one step, and the pair "own speed + the frame's height"
throws the arc higher on every correction. Only what the frame does not
carry is kept from the replica's own state: the arc's peak (it is only
needed for damage, which the host computes) and the target chosen at
take-off. Otherwise the height of one's own tank would follow the length of
the replay rather than the host's flight — jerking on an RTT spike, and
finishing the flight early on a long replay.

A non-zero `vz` in the frame is a flight in itself, regardless of support
and height: that is a JUMP. At take-off `z` still equals the take-off level
and the slab is right under the tank, so by height a flight is
indistinguishable from driving — only `vz` gives it away. The replica aims
such a flight at its own slab (`z` no lower than the level and a floor under
the body) rather than at the ground: with the ground as the target the
replica sank through the slab and kept the input locked until a frame
reported the landing, losing throttle on every jump.

A height below the level is not enough to call it a fall, though. On a run
the level snaps to `z.round()`, so a frame taken on the upper half of any
ramp carries exactly that pair — and a fall locks the input, so reading it
as one would drop the throttle on half of every climb while the host held
it. The frame is read as a fall only for a body that is **not climbing a
run** and only where the geometry has no support of that level under the
tank's hull: the same two questions the host asks in `step_level` before it
starts one.

One correction does come straight from the frame: a level BELOW the
replica's own. A late frame can only lie in one direction — "still up
there" — because the host reports a lower level only once the descent has
actually happened. So a frame under the replica means the replica missed a
descent, and it adopts the frame's level and height (`Grounded`). Without
it the divergence is permanent: reversing at the very brink is applied by
the replay at the CLIENT's timing, so the hull comes back onto the slab and
the replica never falls, while the host — which receives that same reverse
when it is already falling — lands a level below, and nothing ever brings
the two back together. A run is excluded entirely: there the frame lags
downwards, by the replica's own state and by the map under the authoritative
position alike.

A level ABOVE the replica is never adopted on the spot (that is the
late-frame bug above), but it IS adopted on a PERSISTENT disagreement: once
the frame has held a level above the replica for `levelAdoptFrames` frames
in a row (`LevelRules::level_adopt_frames`, 8 by default — about 0.4 s at
~20 frames/s), the replica takes the frame's level and height. A frame lags
by the interpolation buffer, that is by tens of milliseconds, so a
disagreement that long cannot be lag any more. An agreement or a ramp run
resets the counter immediately.

Only a frame taken ON SUPPORT counts, that is one whose `z` sits exactly on
its own level (`level::LEVEL_EPSILON` — the same test that tells a body
standing on a run from one climbing it, `level::body_on_ramp`). This is not
a detail: for the whole duration of a fall the host holds `level` at the
level the body fell from and leads `z` down fractionally, so EVERY frame in
flight reads as "above the replica". Under a slab the `airborne` branch does
not catch them either — support at the upper level is right there overhead —
so counting them would collect `levelAdoptFrames` during the descent itself
and throw the already-landed replica back onto the bridge, which is exactly
the bug `plan/done/ramp-entry-descent.md` closed.

Without this branch a replica that ended up BELOW the host (a gate verdict
that drifted, a respawn on a slab without `camera.forceReset`, a level snap
on the host outside a respawn) would stay there forever.

The `LevelState` itself takes part in reconciliation too. The replay starts
from the authoritative position, and the level state is not a position: its
`prev_cell` and gate verdict would carry on from the end of the previous
replay, and on the run's entry cell the gate would fire on the client only.
So the predictor snapshots `LevelState` every step
(`Predictor::push_level_snapshot`, a history as deep as the input history)
and rewinds the state to the step the frame was taken on
(`rewind_level_state`) before replaying; everything predicted later is
recomputed by the replay. When the history does NOT cover the frame (after
a `reset()`, a map change, a long pause or an RTT spike) there is nothing to
rewind to, and the level and height are then taken from the frame itself
rather than left over from the prediction — `on_server_state` rebuilds the
fall phase out of them right away. `Predictor::set_map` clears the level
state, the history and the authoritative pair for the same reason: they
belong to the OLD geometry, and keeping them would judge the first entry
onto a run of the new map by a cell of the previous one. And when the frame
carries no row of one's own at all (the tank is destroyed, a partial CLEAR,
a `null` marker), `correct_level(None)` drops the authoritative pair instead
of leaving the previous frame's — the `airborne` and "lower level" branches
would otherwise act on stale data.

The exception is a frame with no prediction behind it yet: the **first**
frame carrying the local tank, and a **respawn**. The engine sets the
client's own `gameId` only after `begin_reconcile` (`client/game.rs`), so
there is nothing yet to look the local tank's row up by; and on a respawn
(`condition` 0 → alive) there is nothing to predict either, while
`Predictor::reset` runs on `camera.forceReset` alone. Both rows are read by
`track_frame` and handed to `Predictor::adopt_level` — the only path that
applies a frame as is: there is nothing to replay, and otherwise a tank
spawned on a slab (`overpass` has such respawns) would be predicted on the
ground for a whole frame. On that frame the sample lags by nothing: there is nothing to
interpolate between yet.

Map bodies are reconciled the same way. `MapDynamics::begin_reconcile()`
reads `level`/`z` off the same raw frame and, when the height is below the
level, rebuilds the fall phase with the host's own geometry
(`MapLevels::landing_level()` plus `FallModel::elapsed_at()`) before the
replay starts. The map config only seeds the level: a crate that fell while
the frame was in flight is replayed on the level it actually reached, not on
the one `physicsDynamic` declared.

Levels gate the predicted contact pass too. Every body of the step carries
its own mask — `LevelState::collision_mask()` for the tank (on a ramp, every
level of the run), `PredictedBody::collision_mask()` for a subsystem body
(the engine's `map::body_collision_mask()`: its own level on a floor,
`STATIC_LEVEL_GROUP` alone while falling).
Wall tiles are collected per level from that mask, and a pair of bodies
whose masks do not intersect never becomes a contact — a tank on the bridge
does not push a box below it. A falling tank keeps only `STATIC_LEVEL_GROUP`, so it
collects the walls and no bodies at all while the subsystems keep stepping.

`ShotPredictor` cuts its ray with the same `ray_segments()` the host uses,
and each segment sees only the walls, the boxes and the hulls of its own
level. A hull in transit is the exception: the host holds both level masks
for a tank on a ramp, so a row whose `z` differs from its `level` is offered
to the segments of both levels. The level of a remote hull is taken from the
predicted world (`RemoteTanks::sim_boxes()`) whenever the tank is predicted
there, and from the frame row only as a fallback — the same rule the OBB
already followed. The resulting `startLevel`/`endLevel` go into the local
tracer row, and the level of a locally planted bomb is decided by
`level::bomb_level()` — ONE function for the replica and the host
(`TanksSim::create_weapon_action` calls the same one). The rule: over a
cell with no slab of its own level, and for a falling tank (input locked),
the bomb settles on the nearest support BELOW (`MapLevels::landing_level`)
rather than straight on the ground; a map with no level geometry gives the
ground. Two copies of that rule drifted silently — the blast was drawn a
floor below the damage.

### Shooting and explosions across levels (`core/src/shot_levels.rs`)

`ray_segments()` cuts a shot ray into single-level segments, by the very
rules the player sees ([gameplay.md](gameplay.md#shooting-across-levels)).
Like `step_level`, this function must be the single one for both sides: the
authoritative `TanksSim::process_hitscan` and the client shot predictor call
exactly it.

- A ray keeps its level while the cell under it carries a floor of that
  level. In the first cell without one it drops to
  `landing_level(level, cell centre)` — the nearest level below that still
  has a floor — and carries on there. The drop repeats, so a shot from
  level 2 over a hole in its slab runs 2 → 1 → 0 in three segments; level 0
  is terminal (the ground is everywhere inside the map).
- In the first cell that carries a floor of the **nearest level above** the
  ray (unless that cell is a railing of that level) the ray gets a short
  **probe** of that level, spanning exactly that one cell — from where the
  ray enters it to where it leaves it, not a whole cell diagonal: a tank on
  an open ledge is reachable from below, a tank on the second slab cell is
  not. Only the nearest level above is probed, and only before the first
  drop. A shooter deep under the slab gets no probe — it is added only when
  the cell behind the ray has no floor of that level.
- The level segments overlap on purpose: `process_hitscan` casts a ray per
  segment and takes the **nearest** hit, so a ground wall in front of the
  ledge still beats the probe. Each segment is filtered with
  `level_interaction(segment.level)`; on a flat map no group filter is set
  at all and the shooting path stays exactly as it was.
- An explosion reads its target's level **from the target's collider masks**
  (`collision_groups().memberships`) rather than from the game tag: that way
  a tank and dynamic map geometry (which carries no tag) read the same.
- A bomb remembers its owner's level (`Bomb::level`, a sensor collider with
  `level_interaction`); dropped over a cell without a floor of that level —
  on a ramp, say — or dropped while falling, it lands on
  `landing_level()`: on a three-level map that is the slab below, not the
  ground.

The levels reach the client as `startLevel`/`endLevel` (`w1`) and `level`
(`w2`, `w2e`).

### Bots on the levels (`core/src/bots/controller.rs`)

`BotView` — the bot's view of the world — carries the map's layered
geometry in `levels: Option<&MapLevels>` (`None` on a flat map) plus
`tank_level()` / `tank_input_locked()`. From them the brain caches its own
`my_level` every frame, next to `my_position`.

- The path is a `Vec<PathPoint>` (the engine's point + level), built by
  `find_path_on()`, so ramps and ledges are ordinary graph edges. On a
  waypoint that changes the level the "reached it" threshold is doubled: on
  a ramp the tank cannot stand exactly in the node of the level it is
  driving to.
- A falling bot is skipped at the top of `update()`: keys released, the
  stuck timer zeroed — otherwise the 0.35 s of locked input would throw it
  into `ClearingObstacle` on flat ground.
- `level_at_distance()` (`shot_levels.rs`) answers "which level is my ray
  on at that distance": the upper segment wins where the ground segment and
  the ledge probe overlap. A bot holds fire unless that level equals its
  target's level, and keeps driving to it instead.
- The line of sight, the strafe point after a shot and the obstacle
  avoidance rays all run on the bot's own level
  (`has_obstacle_between_on`, `is_walkable_on`,
  `level_interaction(my_level)`); a flat map sets no group filter at all.

Levels moved the dump the same way: `LevelState` gained `prev_cell` and
`slope_vec`, and the `Transit` variants changed their fields
(`Ramp { climbing, low, high, run }`,
`Airborne { vz, from, to, peak }`), and `LevelState` itself gained
`clear_walls`.

`BotBrain` is `Serialize`/`Deserialize` (the handoff dump), so the path
type change moved the dump's shape — the dump is internal and unversioned,
and an old one no longer restores.

[engine-map]: https://github.com/lgick/vimp-engine/blob/main/docs/en/core.md

## Determinism

- `rapier2d` is built with `enhanced-determinism` (bit-for-bit across
  platforms given identical input);
- all randomness (weapon spread, bot decisions) goes through the engine's
  built-in SplitMix64 PRNG seeded from the config (`seed`), no
  `Math.random`;
- a handoff dump restores the simulation bit-for-bit (locked in by the
  `state_dump_restores_identical_simulation` tests in both Rust and JS).

## Tests

| Layer | Where | Covers |
| --- | --- | --- |
| Rust unit | `core/src/*` (`#[cfg(test)]`) | BodyTag, frame layout; level ballistics (`level.rs`: the fall time derived from `fallTime`, drift in flight, a jump back onto one's own level dealing no damage, clearing walls above `jumpClearance`), tilt (`motion.rs`: no tilt on the flat, the angle against the grade, the cap, the smoothing's convergence); the predictor (replay/visualError/freeze, the contact pass against walls and predicted bodies), the predicted-world framework (capture, error, return to interpolation, reconciliation), map dynamics (origin ↔ centre, capture and its closure, the two box views), remote tanks (capture with lookahead, extrapolation without damping, the render row), shots (gates/dedup/RTT) |
| Predictor parity | `core/src/client/predictor.rs` (`mod parity`) | the predictor's motion replica against the Rapier world (6 scenarios) — **required to run for any edit to motion in the core or `models.js`** |
| Rust integration | `core/tests/sim.rs` | simulation scenarios: driving, walls, hitscan kills, hit impulse independent of `range`, friendly fire, a bomb, weapon switching, bots (patrol and combat), clears, handoff, 2.5D levels (ramp, fall damage, a ramp jump — `terraces_ramp_launches_the_tank`, the tilt in the frame — `tank_row_carries_tilt`, cross-level shots and explosions) |
| JS↔WASM harness | `tests/core/core.test.js` + `tests/core/clientCore.test.js` | the ABI on a real config/maps, frame round-trips via `decode_frame`; e2e for the client core: interpolation, seq reordering, predictor convergence with the core on a real config, try_fire and duplicate suppression |

`tests/core/` tests are part of `npm test` and **are skipped** if
`core/pkg-node/` isn't built (JS development is possible without the Rust
toolchain). CI builds the core and runs both layers of tests.

## Known technical quirks

- **A freshly created body enters the broad phase on the world's first
  step**: a shot fired the same tick as a spawn "misses" the target
  (tests use a warm-up `step`). Doesn't show up in real scenarios (a spawn
  at round start).
- `remove_actor` places a null removal marker in the next frame itself.

---

[← Previous: Configuration](configuration.md) · [Next: Extending →](extending.md)
