# VIMP Tanks

A team-based tank deathmatch — the reference game plugin for the
[VIMP engine](https://github.com/lgick/vimp-engine).

- **Game rules**: two teams, hitscan bullets and bombs, bots, votes, chat, statistics.
- **Rust core**: tank/weapon/bot simulation compiled to WASM, running on the engine's browser host and every client (physics via `rapier2d`, shared with the engine's `vimp-engine-core` crate).
- **Client**: PixiJS rendering parts, procedural textures, spatial audio — plugged into the engine's MVC/render framework.
- **Packaged as a plugin**: published as `@vimp/tanks` (npm) with a `dist/manifest.json`, loaded dynamically at runtime by any engine instance — never a build-time dependency of the engine.

## Quick start

```bash
git clone https://github.com/lgick/vimp-tanks.git
cd vimp-tanks
npm install
npm run core:build   # WASM core (needs the Rust toolchain: rustup + wasm-pack)
npm run build         # full plugin bundle → dist/
```

To actually play a match, this plugin needs to be linked into a running
[vimp-engine](https://github.com/lgick/vimp-engine) checkout — see
[docs/en/getting-started.md](docs/en/getting-started.md).

## Documentation

Full documentation lives in [docs/en/](docs/en/README.md):

- [Local setup](docs/en/getting-started.md)
- [Architecture](docs/en/architecture.md)
- [Gameplay](docs/en/gameplay.md)
- [Rust core](docs/en/core.md)
- [Configuration](docs/en/configuration.md)
- [Extending the game (maps, weapons, sounds)](docs/en/extending.md)

[Русская версия](docs/ru/README.md)

For engine-side concepts (transport, master server, plugin contract), see
the engine's own docs: [vimp-engine/docs/en/](https://github.com/lgick/vimp-engine/blob/main/docs/en/README.md).
