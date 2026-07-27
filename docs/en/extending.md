# Extending the Game

Guides for adding content to `vimp-tanks`. General project rule: new
entities follow the existing style (there's no fixed contract — existing
files serve as templates), and every change ends with a green `npx eslint
.` and `npm test`, with the new code covered by tests.

## New map

1. Create `src/data/maps/<name>.js` following the existing ones (e.g.
   `pool_mini.js`). Format:
   - `setId` — the map constructor's snapshot key (`c1`/`c2`);
   - `scale` — the map's scale;
   - `spriteSheet` — the tile image and frames `[x, y, w, h]`;
   - `layers` — tile distribution across render layers (1 — under tanks,
     2 — tank level, 3+ — above);
   - `physicsStatic` — tile numbers that act as walls (static physics and
     client-side raycasting are built from these);
   - `physicsDynamic` — dynamic physical objects (they move and are sent
     in the snapshot);
   - `step` — the tile size;
   - `respawns` — respawn points by team: arrays `[x, y, angle]`;
   - `map` — the tile matrix.
2. Register the map in `src/data/maps/index.js` — the object's key
   becomes its name in votes and room settings. The engine master's map
   catalog reads the same data (a master restart refreshes what it
   serves).

## New weapon

There are two architecturally different types (see [core.md](core.md)):

- **Hitscan** (example `w1`): the hit is computed instantly by a ray
  (`castRay` in the core); there's no physical projectile, only the
  result.
- **Explosive** (example `w2`): a physical projectile (`Bomb`) is created
  in the Rapier world, lives through the physics cycle, is sent to the
  client as a snapshot entity, and detonates on a timer.

Steps:

1. Define the weapon in `src/data/weapons.js` (type, damage, cooldown,
   cost, etc.) — this data flows both into the core (`buildCoreConfig`)
   and to the client.
2. Implement the authoritative side in this game's Rust crate
   (`core/src/`: `tanks.rs`, `tank.rs`, and, if needed, its own entity
   modeled on `bomb.rs`), following the existing weapon of the same type.
   Block packing (`SnapshotPacker`) lives in the engine crate
   (`vimp_engine_core::snapshot`) — this game only supplies rows per its
   `SnapshotConfig` schema.
3. Create the client-side rendering in `src/client/parts/`.
4. Register the entity in `src/config/client.js`: `parts.gameSets`
   (snapshot key → classes) and `parts.entitiesOnCanvas` (class →
   canvas).
5. Register the weapon's snapshot keys (and its effects) in
   `src/config/snapshot.js` — an unregistered key breaks frame packing.
   If the existing `kind` values don't fit the data shape, a new block
   layout needs adding to the engine crate's `snapshot.rs` and mirroring
   in its client decoder `client/unpack.rs`, bumping the format version —
   that's an engine-repository change, coordinate there.
6. Pass the **author's id** as the last element of the event/entity data
   (like `shooterId` for `w1` and `ownerId` for `w2`) — this game's client
   core (`core/src/client/shot.rs`) uses it to suppress authoritative
   duplicates of client-side spawns; it supports `hitscan`/`explosive`
   automatically from the weapon config.
7. Add ammo to `src/config/game.js` (`panel`) and a panel key in
   `src/config/client.js` (`modules.panel`).

## New sound

1. Add an entry in `src/config/sounds.js`: `file`, `priority`, `volume`,
   optionally `loop`.
2. Put the source file into `assets/audio-raw/` and run `npm run
   game:build` — `audio:process` normalizes it (ffmpeg) and emits
   **`.webm` and `.mp3`** (the codec list — `codecList`) into
   `dist/sounds/`, served via `assetsBase`.
3. Playback: UI/system sounds — `soundManager.playSystemSound(name)`;
   spatial ones — `registerSound(name, { position })` (voice limits and
   priorities are handled by the engine's `SoundManager`, see the
   engine's
   [client.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/client.md#soundmanager)).

## New client entity (part)

1. Create a class in `src/client/parts/` following the existing ones
   (`Tank`, `Bomb`, effects in `parts/effects/`) and export it from
   `parts/index.js` — it lands in the engine's `Factory` registry.
2. Add it to `gameSets`/`entitiesOnCanvas` (`src/config/client.js`).
3. If it needs a procedural texture, add a baker in `src/client/bakers/`
   (follow the existing ones) and an entry in `bakedAssets`. No extra work
   is needed for filters: `bakers/index.js` wraps every baker with
   `warmUpRenderer` (`src/client/bakers/warmUpRenderer.js`) before calling
   it, so the renderer's root render target is always bound before
   `generateTexture` runs. This matters because baking happens before the
   engine's first render pass, and PixiJS v8 binds that render target
   lazily on the first `render()` call — a `Filter` applied to an
   unrendered target crashes deep in the filter pipeline otherwise.
4. If it needs services (`renderer`, `soundManager`), add the class to
   `componentDependencies`.

Entities can be subclassed and shown on different canvases: for example,
a simplified radar class is created for the radar (like `MapRadar` from
`Map`).

## Tests

New code is covered by tests in `tests/` (the layout mirrors `src/`).
Patterns — this repo's own conventions (mirroring the engine's): singletons
through `vi.resetModules()` + a dynamic import; core logic — Rust tests
(`cargo test`) + the JS↔WASM harness in `tests/core/`; host-facade
integration — `tests/host/HostGame.test.js` on top of the real
`core/pkg-node`. Changing the tank's motion model requires running the
cargo predictor-replica parity check (`npm run core:test`).

---

[← Previous: Configuration](configuration.md)
