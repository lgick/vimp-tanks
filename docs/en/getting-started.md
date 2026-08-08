# Local Setup (game plugin)

This repository builds `@vimp-games/tanks`, a game plugin for the
[VIMP engine](https://github.com/lgick/vimp-engine). For engine-side local
setup (running the master server, the lobby), see the engine's own
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/getting-started.md).

## Requirements

- **Node.js 24**, npm;
- **Rust toolchain** (`rustup` + `wasm-pack`) — required to build this
  plugin's WASM core, which the engine's browser host and every client
  load.

## Install

```bash
git clone https://github.com/lgick/vimp-tanks.git
cd vimp-tanks
npm install
```

`vimp-engine` is a regular npm dependency here (not a workspace symlink)
— this plugin only imports its public `exports` surface (`./lib/*`,
`./config/*`, `./host/*`).

`pixi.js` is a **peer dependency**, not bundled: the client build
externalizes it (`vite.config.js`), and at runtime it must resolve to the
same module instance the engine uses, supplied via an import map on the
host page. Two independent PixiJS copies (engine + plugin each bundling
their own) crash at runtime — each copy has its own extension/pipe
registry and uid counters, and objects created by one copy (e.g. this
plugin's baker `Container`/`Filter` instances) aren't valid input to the
other's renderer. The import map itself is set up on the engine side — see
its [client.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/client.md).

## Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # or: cargo install wasm-pack
```

## Build

```bash
npm run core:build       # both WASM targets (web + nodejs)
npm run core:build:web   # browser/Worker → core/pkg-web/
npm run core:build:node  # Node.js (tests) → core/pkg-node/
npm run core:test        # cargo test --workspace (this repo's crate)
npm run build            # full plugin build: client+host JS bundles, assets, manifest.json → dist/
```

`npm run build` produces `dist/manifest.json` (a `GameManifest`), the
client/host JS bundles, exported map JSON, and processed sound assets
(`npm run audio:process`, needs ffmpeg) — everything the engine's master
serves under `/games/tanks/*` and everything the host Worker/client
dynamically import. If `core/pkg-node/` is built, `build:manifest` also
copies it into `dist/core-node/` and declares `entries.wasmNode` on that
copy: `dist` is the only published content, so a manifest pointing outside
it would work in this checkout and break in the installed package
(`npm run check:pack` guards that, and it also runs on `prepack`).

## Playing a match locally against a local engine checkout

To develop against a local, unpublished copy of this plugin, build it once
and link the two checkouts **into each other**:

```bash
cd vimp-tanks && npm run core:build && npm run build   # WASM + dist/ (manifest, maps, sounds)

cd vimp-tanks && npm link                     # registers @vimp-games/tanks globally
cd vimp-engine/packages/engine && npm link    # registers vimp-engine globally

cd vimp-engine && npm link @vimp-games/tanks  # engine ← plugin
cd vimp-tanks && npm link vimp-engine         # plugin ← engine

cd vimp-engine && npm run dev
```

The reverse link matters as much as the forward one: without it this
plugin's `vimp-engine/*` imports resolve to a registry copy inside its own
`node_modules` — a second module instance with its own, silently skewed
`ENGINE_API_VERSION`. Note that `npm install` in either repository replaces
the symlinks with registry copies, so the two `npm link <name>` commands have
to be repeated afterwards.

In dev the engine serves this plugin's `src/**` and `core/pkg-web/*.wasm`
straight through Vite `/@fs/` (HMR), so client/host JS edits need no rebuild
at all; `dist/` is still read once at master startup for the manifest, maps
and sounds — hence the initial `npm run build`. Full breakdown of what to
rebuild after which edit — the engine's
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/getting-started.md#development-loop).

`pixi.js` needs no import-map work in dev either: Vite resolves this
plugin's bare `pixi.js` to the same optimized copy the engine itself uses.
The import map (see Install above) is what keeps that single-instance
guarantee in production builds.

Then open several browser tabs against the engine's dev server — one
creates a room, the rest join from the lobby (note that all tabs of one
browser profile share the identity token, i.e. the same player). See the
engine's
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/getting-started.md#local-multiplayer).

Bots are easiest to add with the chat command `/bot 5` (see
[gameplay.md](gameplay.md#chat-c-key-and-commands)).

## Tests

Stack: **Vitest** + happy-dom + coverage-v8. `vitest.config.js` splits the
run into two projects:

- `tanks` — `tests/host/{hostPlugin,botCommand,TanksBotManager}.test.js`,
  `tests/client/**` (`tanksClientPlugin.test.js`, `parts/**` — the sound
  contract of `Tank`/`Bomb`), `tests/config/**`,
  `tests/scripts/**` (build-script helpers, e.g.
  `tests/scripts/rangeToPattern.test.js`) — happy-dom environment;
- `integration` — `tests/host/HostGame.test.js` + `tests/core/**` (real
  core, node environment; **skipped** if `core/pkg-node/` isn't built).

Tests live in `tests/` and mirror `src/`. The JS↔WASM harness for the
Rust core — `tests/core/` (see [core.md](core.md)). Project rule: **any
code change must end with a green `npx eslint .` and `npm test`**; editing
motion in the core or `models.js` requires the cargo predictor-replica
parity run (`npm run core:test`).

CI (`.github/workflows/test.yml`) runs two jobs: `lint` (eslint only);
`tanks` (`cargo test -p vimp-tanks-core` + `core:build:web` + `core:build:node`
+ both Vitest projects — `vimp-engine` is installed from the npm registry
here, not a workspace symlink).

## Debug scenarios (headless match)

The engine ships a headless runner (`vimp-sim`) that closes the loop
"host → binary frame → `ClientCore` → hot buffer → scene" in one Node
process and checks 12 contracts. It needs a built plugin — `dist/` with
`entries.wasmNode`, i.e. `core/pkg-node/` built **before** `npm run build`,
which copies it into `dist/core-node/`:

```bash
npm run core:build:node          # Node build of the core → core/pkg-node/
npm run build                    # dist/ + manifest.json (copies dist/core-node/)
npm run sim:scenarios            # every tests/scenarios/*.json, one verdict
npm run sim:scenarios -- --determinism   # + an identical repeat run (frame hashes)
npm run sim -- --scenario tests/scenarios/movement.json   # a single one
```

Exit code is the verdict, so this is the loop to run after touching motion,
the snapshot schema or the panel. The scenarios:

| File | Covers |
| --- | --- |
| `movement.json` | driving, turning, turret; prediction drift with tight thresholds |
| `combat.json` | two players, both weapons, explosions, a map with dynamic bodies (`c1`) |
| `round.json` | bots, friendly fire, death → round end → respawn (invariant 10) |

Threshold calibration and the scenario format live in the engine's
[debugging.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/debugging.md).

The runner exercises the **real** core, so it needs the same
`vimp-engine-core` version the engine build expects. When working against a
local engine checkout, patch cargo locally — do **not** commit this:

```toml
# Cargo.toml, workspace root
[patch.crates-io]
vimp-engine-core = { path = "../vimp/packages/engine/core" }
```

---

[Next: Architecture →](architecture.md)
