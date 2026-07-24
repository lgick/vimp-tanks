# VIMP Tanks Documentation

`vimp-tanks` is a game plugin for the [VIMP engine](https://github.com/lgick/vimp-engine)
— a team-based tank deathmatch: physics, rules, and rendering entities
specific to this game, loaded dynamically by the engine at runtime via the
plugin contract (`GameManifest`/`HostPlugin`/`ClientPlugin`).

For anything not specific to this game — the P2P transport, the master
server, the browser host's Worker infrastructure, the client MVC/render
framework, the generic Rust engine crate — see the engine's own docs:
[vimp-engine/docs/en/](https://github.com/lgick/vimp-engine/blob/main/docs/en/README.md).

## Sections

| Page | Covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Local setup: install, Rust toolchain, building the WASM core, linking against a local engine checkout, tests |
| [architecture.md](architecture.md) | This plugin's layout, how it plugs into the engine, the core's boundary, key invariants |
| [gameplay.md](gameplay.md) | Gameplay: rounds, teams, stats, votes, chat commands, controls, weapons, bots, kicks |
| [core.md](core.md) | Rust game core (`vimp-tanks-core`): layout, ABI (commands/events/frames), WASM build, tests |
| [configuration.md](configuration.md) | This plugin's own configuration: `game.js`/`client.js` halves, auth form, sounds, snapshot schema, game data (models/weapons/maps) |
| [extending.md](extending.md) | Adding content: new maps, weapons, sounds, client entities |

## Where to start

- **I want to run a match locally** → [getting-started.md](getting-started.md)
- **I want to understand the game rules** → [gameplay.md](gameplay.md)
- **I want to add a map/weapon** → [extending.md](extending.md)
- **I want to understand how this plugs into the engine** → [architecture.md](architecture.md), then the engine's own [plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md)

> Documentation is maintained alongside the code: whenever functionality changes, the relevant page is updated in the same change (a rule codified in [CLAUDE.md](../../CLAUDE.md)).
