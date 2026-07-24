# Local Setup (game plugin)

This repository builds `@vimp/tanks`, a game plugin for the
[VIMP engine](https://github.com/lgick/vimp-engine). For engine-side local
setup (running the master server, the lobby), see the engine's own
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/getting-started.md).

## Requirements

- **Node.js 22**, npm;
- **Rust toolchain** (`rustup` + `wasm-pack`) — required to build this
  plugin's WASM core, which the engine's browser host and every client
  load.

## Install

```bash
git clone https://github.com/lgick/vimp-tanks.git
cd vimp-tanks
npm install
```

`@vimp/engine` is a regular npm dependency here (not a workspace symlink)
— this plugin only imports its public `exports` surface (`./lib/*`,
`./config/*`, `./host/*`).

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
dynamically import.

## Playing a match locally against a local engine checkout

To develop against a local, unpublished copy of this plugin:

```bash
# in vimp-tanks/
npm run build          # or at minimum npm run core:build + build:client + build:host
npm link                # registers @vimp/tanks globally

# in vimp-engine/
npm link @vimp/tanks    # or: "@vimp/tanks": "file:../vimp-tanks" in package.json
npm run dev
```

Then open several browser tabs against the engine's dev server — one
creates a room, the rest join from the lobby. See the engine's
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/getting-started.md#local-multiplayer).

Bots are easiest to add with the chat command `/bot 5` (see
[gameplay.md](gameplay.md#chat-c-key-and-commands)).

## Tests

Stack: **Vitest** + happy-dom + coverage-v8. `vitest.config.js` splits the
run into two projects:

- `tanks` — `tests/host/{hostPlugin,botCommand,TanksBotManager}.test.js`,
  `tests/client/tanksClientPlugin.test.js`, `tests/config/**` (happy-dom
  environment);
- `integration` — `tests/host/HostGame.test.js` + `tests/core/**` (real
  core, node environment; **skipped** if `core/pkg-node/` isn't built).

Tests live in `tests/` and mirror `src/`. The JS↔WASM harness for the
Rust core — `tests/core/` (see [core.md](core.md)). Project rule: **any
code change must end with a green `npx eslint .` and `npm test`**; editing
motion in the core or `models.js` requires the cargo predictor-replica
parity run (`npm run core:test`).

CI (`.github/workflows/test.yml`) runs two jobs: `lint` (eslint only);
`tanks` (`cargo test -p vimp-tanks-core` + `core:build:web` + `core:build:node`
+ both Vitest projects — `@vimp/engine` is installed from the npm registry
here, not a workspace symlink).

---

[Next: Architecture →](architecture.md)
