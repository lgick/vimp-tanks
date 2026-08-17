# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

`vimp-tanks` — a team-based tank deathmatch, a game plugin for the
[VIMP engine](https://github.com/lgick/vimp-engine) (`vimp-engine`,
`vimp-engine-core`). This repo owns only game rules: physics entities
(tanks, weapons, bots), rendering parts, config, and maps. Transport,
Worker infrastructure, master server, and the client MVC/render framework
live in the engine and are consumed here only through the plugin contract
(`GameManifest`/`HostPlugin`/`ClientPlugin`) — never imported statically.

## Documentation

Bilingual docs live in `docs/en/` (canonical, ToC at `docs/en/README.md`)
and `docs/ru/` (identical structure, ToC at `docs/ru/README.md`). **Rule**:
any functional change updates the matching `docs/en/` and `docs/ru/` pages
in the same change. Area → page:

| Change | Page |
| --- | --- |
| `src/config/*` (game.js, client.js, auth.js, sounds.js, snapshot.js), `src/data/*` | `configuration.md` |
| game rules (rounds, stats, votes, chat commands, controls, weapons, bots) | `gameplay.md` |
| `core/` (Rust: tanks.rs, tank.rs, motion.rs, bomb.rs, bots/, client/, WASM ABI) | `core.md` |
| `src/host/*`, `src/client/*` plugin wiring | `architecture.md` |
| new maps/weapons/sounds/images/client entities | `extending.md` |
| `assets/*` and the scripts that stage it into `build/`/`dist/` | `extending.md`, `getting-started.md` |
| build/link/test setup, debug scenarios (`tests/scenarios/`) | `getting-started.md` |

Engine-side concepts (transport, master, Worker infra, generic core traits,
the plugin contract itself) are documented in the engine's own repo, not
here — link out to `https://github.com/lgick/vimp-engine/blob/main/docs/en/...`
rather than duplicating.

## Commands

```bash
npm run core:build        # both WASM targets (web + nodejs)
npm run core:build:web    # browser/Worker → core/pkg-web/
npm run core:build:node   # Node.js (tests) → core/pkg-node/
npm run core:test         # cargo test --workspace
npm run dev                # standalone match in a browser tab (no master, no OAuth)
npm run build              # full plugin build → dist/ (client+host bundles, assets, manifest.json)
npx eslint .               # lint
npm test                   # Vitest, single run
npm run test:watch
npm run sim:scenarios      # headless debug scenarios (tests/scenarios/*.json)
npm run sim -- --scenario tests/scenarios/movement.json   # a single one
```

`sim:*` need a built plugin (`npm run build`) and `core/pkg-node/`; they run
the engine's headless runner over the real core.

Requires the Rust toolchain (`rustup` + `wasm-pack`) to build the core. See
`docs/en/getting-started.md` for linking a local checkout against a local
engine checkout (`npm link`).

## Code Conventions

Same conventions as the engine (ES modules, camelCase/PascalCase/
UPPER_SNAKE_CASE, no two consecutive uppercase letters, `===`/`let`/`const`
only, curly braces required). `src/host/` must stay Worker-safe: no DOM, no
Node globals.

## Testing

Vitest (`tanks` + `integration` projects, see `vitest.config.js`) +
`@vitest/coverage-v8`. Every change ends with a green `npx eslint .` and
`npm test`. Rust: unit tests per module plus the `client::predictor::parity`
cargo suite — run `npm run core:test` after any change to `core/`'s motion
or `src/data/models.js`.

## Deployment

This repo has no deployment of its own — it publishes `@vimp-games/tanks` (npm,
ships `dist/`) for the engine's master/host/client to consume. CI builds
and tests the crate + JS; see `.github/workflows/test.yml`.
