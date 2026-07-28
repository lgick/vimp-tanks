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
core/        — vimp-tanks-core (Rust → WASM, pkg-web/pkg-node): tanks,
               weapons, bots, prediction, shot spawning (see core.md)
tests/       — host-plugin behavior, JS↔WASM harness
scripts/     — audio processing, map export to JSON
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
- **Master**: never executes plugin code — it only serves this package's
  `dist/manifest.json` and the exported map JSON under `/games/tanks/*`.

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
- The snapshot key schema (`src/config/snapshot.js`) is this plugin's data —
  an unregistered key breaks frame packing on both the host and the client.
- `ENGINE_API_VERSION` compatibility is checked by the engine at plugin load
  time (client and host); a mismatch is rejected before this plugin's bundle
  is even imported.

---

[Next: Gameplay →](gameplay.md)
