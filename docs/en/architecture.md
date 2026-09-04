# Architecture (game plugin)

`vimp-tanks` is a **dynamic plugin** for the [VIMP engine](https://github.com/lgick/vimp-engine)
(published as `vimp-engine` / `vimp-engine-core`): a team-based tank
deathmatch running entirely on the engine's P2P infrastructure (authoritative
browser host, WebRTC clients, Node.js master for lobby/signaling). This repo
owns only game rules — physics, transport, Worker handoff, and the client
MVC/render framework live in the engine; see its
[architecture.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/architecture.md)
for the full picture and the ADR on the engine/game split.

## Repository layout

```
index.html / vite.config.js — the plugin's Vite root (client/host builds)
src/
  host/      — HostPlugin: core-event router, TanksBotManager (scripted
               module), /bot command, b:* system messages
  client/    — ClientPlugin: parts/ (PixiJS entities and effects),
               bakers/ (procedural textures), hooks, game CSS
  config/    — game config halves (game.js, client.js, auth.js, sounds.js,
               snapshot.js)
  data/      — static data: maps/, models.js, weapons.js
  nodeCore.js — one branch shared by both plugin halves: browser wasm
               asset vs Node glue (headless runs)
core/        — vimp-tanks-core (Rust → WASM, pkg-web/pkg-node): tanks,
               weapons, bots, prediction, shot spawning (see core.md)
assets/      — authored inputs: audio-raw/ (raw sounds) and img/ (tile
               sheets, dynamic-body sprites; the engine ships none of them)
tests/       — host-plugin behavior, JS↔WASM harness, scenarios/ (headless
               debug runs, see getting-started.md)
scripts/     — audio processing, image copy, map export to JSON, manifest,
               scenario runner
```

`src/config/` and `src/data/` are read by the engine's host Worker, the
client bundle, and (for maps) the engine's master — all through the plugin
contract (`HostPlugin.gameConfig`, `ClientPlugin`, `GameManifest`), never by
direct import.

## How this plugin plugs into the engine

- **Host**: `host.worker.js` in the engine dynamically imports this
  package's `entries.host` (`src/host/index.js`, the `HostPlugin` default
  export) and calls `createCore()`, which loads this repo's WASM core.
  `TanksBotManager` implements the engine's scripted-module contract
  (`createMap`/`createScripted`/`removeScripted`/…).
- **Client**: the engine's client dynamically imports `entries.client`
  (`src/client/index.js`, the `ClientPlugin` default export) after a room is
  picked, and calls `createClientCore()`.
- **Both entries take `wasmUrl` in two shapes**: the hashed `.wasm` asset in
  a browser, and a `file:` URL of the Node glue (`entries.wasmNode`) under
  the engine's headless runner. The branch lives in `src/nodeCore.js` and is
  shared by both halves on purpose — a headless run on a different core than
  the browser's would prove nothing.
- **Master**: never executes plugin code — it only serves this package's
  `dist/manifest.json` and the exported map JSON under `/games/tanks/*`.
- **`requires: ['map.layers']`**: both plugin halves declare the engine
  capability the 2.5D maps stand on, and `build-game-manifest.js` copies the
  list into the manifest from `src/host/index.js` — one source, so the
  contract rule `B2` has something to compare. Without layered maps in the
  engine `overpass` would load without its second level and without a single
  error, so the capability is a hard requirement rather than a hint.

Full contract — the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md).

## The core's boundary

Simulation only: physics, tanks, both weapon types, bots, and binary frame
packing live in `core/` (Rust/WASM). Health/ammo live there too — the JS
panel is a projection of the core's events. Meta (chat, votes, stats,
rounds, the participant registry, auth) is engine-owned JS, parameterized
entirely by this plugin's config (`HostPlugin.gameConfig`).

## The client side

Three network-smoothing mechanisms live in the engine's generic `ClientCore`
machinery, with the game-specific halves implemented in this repo's core
crate:

- **Prediction** (`core/src/client/predictor.rs`): the local tank is
  simulated by a replica of the authoritative motion model (formulas shared
  with the authoritative side via `core/src/motion.rs`); the host confirms
  input (`lastInputSeq`), reconciliation replays unconfirmed input, and the
  discrepancy decays smoothly.
- **Client-side shot spawning** (`core/src/client/shot.rs`): a shot is seen
  and heard instantly; duplicates from the host are suppressed by author id.
- **Interpolation** is fully engine-owned (no game-specific code).

Rendering is built from engine MVC components + this plugin's PixiJS
entities (`src/client/parts/`) on two canvases (`vimp`, `radar`); procedural
textures are baked at startup from `src/client/bakers/`.

A part that needs something out of the game core gets it as a **service**:
`ClientPlugin.hooks.services(core)` (`src/client/index.js`) returns the game
services, the engine merges them into its own pool and hands them out by
`componentDependencies` (`src/config/client.js`). Today that is `mapDynamics`
— `toWorld(key, localX, localY)` over `ClientCore.map_dynamics_to_world`, by
which `ShotEffect` anchors its debris to the box the shot hit (see
[core.md](core.md)) — and `levelView` (`src/client/levelView.js`), where the
local player is, on which level and at which height: the local `Tank` writes
it, and everything that has to yield visibility to him reads it (see below).

The same two names are repeated in `ClientPlugin.serviceNames`. The hook
needs a live core, so the contract checker cannot read what it returns; the
list is what lets rule `C4` tell a game service from a typo in
`componentDependencies` instead of downgrading itself to a warning — an
unprovided service is silently `undefined` in the part.

### Draw order across levels (2.5D)

Every part is a direct child of the stage with `sortableChildren = true`, so
`zIndex` alone decides the order. `src/client/levelZ.js` turns a part's base
`zIndex` into a level-aware one:

```
zIndex = base zIndex + LEVEL_Z_STRIDE * level     // LEVEL_Z_STRIDE = 100
```

Base values are the single-level ones (`Tracks` 1, `Bomb`/`TankRadar`/
`MapRadar`/`ShotEffect`/funnel 2, `Tank` 3, `Smoke`/explosion 4, map layers
from `data.layer`), so a map without upper levels draws exactly as before.
The stride is larger than any base value, hence every level-1 layer covers
every level-0 one — the bridge slab hides what drives under it.

The consequences the parts implement themselves:

- **See-through above the player.** One formula for every part —
  `levelView.alphaFor(level, x, y)` (`src/client/seeThrough.js`), in two
  modes switched by `parts.seeThrough.mode` (`src/config/render.js`):
  `'hole'` opens a radial hole around the player, `'layer'` fades the whole
  slab (the old behaviour, the fallback path). Only what is **above** the
  player fades. A point entity (a box, another tank, smoke, a bomb, an
  effect) sets its own `alpha`; a solid `Map` layer needs a field over
  pixels rather than a single alpha, so it runs the hole as a filter
  (`createHoleFilter`, both a WebGL and a WebGPU branch — the second one
  would silently vanish otherwise). Either way the transition is
  time-smoothed (`fadeRate`), or driving under an edge blinks.
- **Boxes ride their level.** The dynamic row (`c1`/`c2`) carries `level`,
  so `Map`'s dynamic branch re-sorts by `levelZ` and recomputes its alpha
  every frame: a box that falls off the bridge is visibly falling off it.
- **Darker means lower.** Anything below the player's level is tinted with
  `seeThrough.lowerTint` — the only level cue that works at the edge of the
  screen. On the radar the same idea: layers of other levels dim, the level
  palette is shared (`src/client/levelColors.js`), and another tank's marker
  gets a ring in its level's colour.
- **Height reads as a shadow.** `Tank` keeps a shadow sprite as a **sibling
  on the stage** (its `zIndex` is that of the level the tank hangs over, and
  the stage is flat), offset away from the camera centre proportionally to
  `z`. The badge with the level number is drawn for the local tank only, and
  only on a layered map; it is a separate sprite, so — like the hull — it is
  brought down to world scale by `_scaleFactor` and is placed in screen axes
  (the offset is counter-rotated with the hull), which keeps it clear of the
  tank at any heading instead of orbiting it. The climb itself also compresses the hull along its
  heading and kicks dust from under the tracks; the grade is recovered
  client-side from `z` between frames (`src/client/grade.js`) — the `m1`
  frame is not changed for a visual.
- **Volumes shift with the camera.** A render layer with a height
  (`volumes` in the map, `data.volume` in the part) is extruded by
  `MapVolume`: `slices` copies of the layer's own baked picture, each
  shifted further away from the camera centre, so walls open up as the
  player moves. Slices rather than blocks: the effect costs `slices` draw
  calls no matter how many walls the map has.
- **Tracks keep their level**: track marks live in a per-level container
  that is a sibling of the `Tracks` part on the stage, so a mark left on the
  overpass stays on the overpass after the tank drives down.

### Texture and particle lifecycle

- **Texture ownership**: baked assets (`bakedAssets` in `src/config/client.js`)
  are generated once at startup and shared for the whole session — parts
  that use them call `destroy({ texture: false, textureSource: false })` so
  their own teardown never frees a texture another part still uses. The one
  exception is `Map.js`'s `mapSprite`, whose texture is generated per map
  instance via `renderer.generateTexture(...)` and is exclusively owned by
  it — its `destroy()` passes `textureSource: true` to release the GPU
  source when the map changes.
- **Particle systems**: `Smoke.js` and `SmokeEffect.js` render their
  particles through `ParticleContainer` + `Particle` (wrapped in a plain
  `Container` per part, since `ParticleContainer` only accepts particles,
  not display objects). Per-particle simulation state (velocity, age,
  sway, …) lives in a parallel plain-object array alongside the `Particle`
  instances, since `Particle` has no `customData`. `ParticlePool.js` pools
  `Particle` instances for reuse; callers are responsible for calling
  `container.removeParticle(...)` before returning a particle to the pool.
  `ImpactEffect.js` stays on a plain `Container` + `Sprite` — at 2-4
  particles per shot, `ParticleContainer` overhead isn't worth it.

## Key invariants

- **Single PixiJS instance**: engine and plugin must share one PixiJS
  module instance at runtime. `pixi.js` is a peer dependency and is
  externalized from the client build (`vite.config.js`); the host page
  resolves it via an import map. Bundling a second copy in either side
  breaks interop between engine-owned renderer/filter systems and this
  plugin's PixiJS objects (bakers, `parts/`).
- **Motion replica parity**: authoritative motion (Rapier, in `core/`) and
  the client prediction replica share the tick formulas (`core/src/motion.rs`);
  integration parity is locked in by cargo tests (`client::predictor::parity`)
  — any edit to motion in the core or the `models.js` coefficients requires
  running `npm run core:test`.
- **Level rules live in `core/src/level.rs`** and are called by both sides:
  the authoritative `TanksSim::update_levels` and the client replica
  (`Predictor::step`) run the very same `step_level()` over the same
  `MapLevels`, with the same `coreParams.levels` (they reach the client core
  through `prediction.coreParams` in CONFIG_DATA). A second copy of the
  rules would drift from the authoritative level silently; the same holds
  for `ray_segments()` (`core/src/shot_levels.rs`) and shooting.
- The snapshot key schema (`src/config/snapshot.js`) is this plugin's data —
  an unregistered key breaks frame packing on both the host and the client.
- `ENGINE_API_VERSION` compatibility is checked by the engine at plugin load
  time (client and host); a mismatch is rejected before this plugin's bundle
  is even imported.

---

[Next: Gameplay →](gameplay.md)
