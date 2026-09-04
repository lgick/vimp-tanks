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
3. Put every image the map names — `spriteSheet.img` and each
   `physicsDynamic[].img` — into `assets/img/`. See
   [New map image](#new-map-image); `npm run build:manifest` fails if a
   name has no file.

### Upper levels (2.5D)

An optional `levels` field adds an overpass over the same grid (`ramps`
holds the transitions). Each level brings its own `layers`, over its own
`map`, plus `floor` (drivable slab tiles) and `walls` (railings).

- **Render layers.** A level's `layers` keys are the same base `zIndex`
  values as level 0 (1 under tanks, 2 tank level, 3+ above): the renderer
  shifts them by `LEVEL_Z_STRIDE = 100` per level itself
  (`src/client/levelZ.js`). So keep base layers below 100 — everything from
  100 up belongs to level 1 and would draw over the bridge. Nothing else
  has to be done to make an upper layer cover the ground.
- **Railings must be part of the slab** — a `walls` tile also belongs in
  `floor`, otherwise the railing hangs in the air and a shot from below
  does not see it.
- **Do not put a railing right where a ramp meets the slab**: a tank that
  has just climbed up would drive straight into it. Leave the ramp exit and
  the tile in front of it free.
- **Cap the ends of the bridge with railings.** Level-0 walls are no
  obstacle to a tank on the slab, so a bridge that simply ends drops the
  driver into the void beyond the map border. This one is checked: a slab
  cell may only have an open edge where the fall lands on walkable ground
  (a level-0 cell inside the grid that is not in `physicsStatic`) — that is
  a ledge. An edge over the map border or over a wall is rejected.
- **A ramp has to arrive somewhere.** The cell past the top end of a ramp
  run must be drivable surface of the level it climbs to (`floor` without a
  railing). A ramp into the void is rejected: a tank would reach the top
  and fall in the same step, and both the climb and the fall are normal
  rules, so nothing would say a word.
- **Every wall tile must be named by a render layer** — `physicsStatic`
  tiles by `layers`, a level's `walls` by that level's `layers`. The radar
  draws walls from the layer that lists them, so a wall no layer names is
  solid in physics and absent from the radar. Also checked.
- **Keep ground respawn points from under the slab.** A point without the
  4th element takes its level from the geometry, so one under the bridge
  spawns the tank on the bridge. Put an explicit `0` there, or move the
  point out.
- **A box on the slab needs `level: 1`** — without it the box stands on the
  ground under the bridge and the tank on the bridge drives right through
  it. `position` is the top-left corner of the body, not its centre.

Step by step, the way `overpass.js` was built:

1. Build both grids with one constructor function (80 × 60 by hand is not
   maintainable) — level 0 in `map`, the overpass in `levels[1].map`, the
   same dimensions.
2. Lay the ramp tiles into the level-0 grid and declare them in `ramps`
   with the direction you drive to climb. Open a gap in the railing where
   the ramp meets the slab.
3. Leave a gap or two in the railing away from the ramps — those are the
   ledges people fall from and shoot through from below.
4. Give the level its `floor`/`walls`/`layers` and give each `physicsDynamic`
   body its `level`.
5. Register the map in `src/data/maps/index.js` and check it:

```bash
npm test -- --silent          # tests/config/game.test.js checks tiles and respawns
npm run build                 # export + manifest (a missing image stops it)
npx vimp-contract             # rules E4/E5 — layered fields, walls on the radar
npm run sim:scenarios         # bridge/fall/crosslevel/bots_bridge on overpass
npm run dev                   # by eye: set room.map in src/standalone.js
```

The core validates the same structure at load time and refuses a broken
map, so a mistake is loud rather than silent — see
[configuration.md](configuration.md#the-25d-fields-levels-ramps). The rules
live in one place (`vimp_engine_core::map::validate_levels`) and run on both
sides: the host on `load_map`, the client on `MAP_DATA` — the map arrives
over the network, and a level grid that disagrees with the host's would
otherwise desync prediction silently. The contract checker (`E4`) and the
Rust validator share one corpus of cases
(`vimp-engine/contract/fixtures/layered/`), so the two cannot drift apart.

## New map image

Images are part of this package, not of the engine: `Map`
(`src/client/parts/Map.js`) builds their URLs from the engine's
`assetsBase` service as `${assetsBase}img/<file>`, exactly the way sounds
resolve to `${assetsBase}sounds/`.

1. Drop the `.png`/`.jpg` into `assets/img/` (tracked in git — unlike
   sounds, images need no processing step).
2. Name it from a map (`spriteSheet.img` or `physicsDynamic[].img`).
3. `scripts/copy-game-images.js` copies `assets/img/` to `build/img/`
   (the dev root of `npm run dev`, staged by `predev`) and to `dist/img/`
   (the packaged asset). It runs inside `npm run build:assets`.
4. `npm run build:manifest` verifies that every image the maps name exists
   in `dist/img/` and stops the build otherwise — at runtime a missing
   file is silent: the map renders as an empty canvas.
5. If the image is required by a map, add it to the `REQUIRED` list in
   `scripts/check-pack.js` so a broken publish fails instead of the
   player's match.

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
3. Create the client-side rendering in `src/client/parts/`. The blast
   radius from the event data scales the effect: `ExplosionEffectController`
   hands it to the flash, the crater and the smoke (the reference is
   `REFERENCE_BLAST_RADIUS = 50` in
   `parts/effects/explosion/SmokeEffect.js`). Only the sizes and the
   particle spread area scale with the radius — the crater diameter is a
   fraction of it (`FUNNEL_TO_BLAST_RATIO` in `FunnelEffect.js`).
   Lifetimes and alpha stay as they are — they define the character of the
   effect, not its size.

   The controller raises the flash and the crater with smoke together, in
   `run()`: the crater appears at the same instant as the flash and
   underneath it, fading in over `FUNNEL_FADE_IN_DURATION_MS`. Both go onto
   the scene in a single `addChild`, so the layer order is recomputed by one
   `sortChildren`. The controller's own destruction hangs on the crater
   completing, so `run()` on an already-cleared scene destroys the
   controller itself — otherwise the sound registered in the constructor
   would never be released. A repeated `run()` is ignored: it would raise a
   second pair of effects over the first and lose the references to it.
4. Register the entity in `src/config/client.js`: `parts.gameSets`
   (snapshot key → classes) and `parts.entitiesOnCanvas` (class →
   canvas).
5. Register the weapon's snapshot keys (and its effects) in
   `src/config/snapshot.js` — an unregistered key breaks frame packing.
   If the existing `kind` values don't fit the data shape, a new block
   layout needs adding to the engine crate's `snapshot.rs` and mirroring
   in its client decoder `client/unpack.rs`, bumping the format version —
   that's an engine-repository change, coordinate there.
6. Read the row through the named indices in
   `src/client/snapshotFields.js` (`M1_LEVEL`, `W1_END_LEVEL`, …) instead
   of a literal `data[12]`, and add the new key's constants there — the
   frame is positional, and the schema in `src/config/snapshot.js` is the
   only thing that fixes the order.
7. Pass the **author's id** as the last element of the event/entity data
   (like `shooterId` for `w1` and `ownerId` for `w2`) — this game's client
   core (`core/src/client/shot.rs`) uses it to suppress authoritative
   duplicates of client-side spawns; it supports `hitscan`/`explosive`
   automatically from the weapon config.
8. Add ammo to `src/config/game.js` (`panel`) and a panel key in
   `src/config/client.js` (`modules.panel`).

## New sound

1. Add an entry in `src/config/sounds.js`: `file`, `priority`, `volume`,
   optionally `loop`.
2. Put the source file into `assets/audio-raw/` and run `npm run
   build:assets` — `audio:process` normalizes it (ffmpeg) and emits
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
   (follow the existing ones) and an entry in `bakedAssets`. When using
   `BlurFilter`, the canvas size must include a `blurMargin(blur)`
   allowance around the shape (`bakers/blurMargin.js`) **and** the filter
   must get `filter.padding = blurMargin(blur)`: without the padding Pixi
   renders the blur only within `2 * strength` around the shape, without
   the allowance `generateTexture` clips the blur at the frame — either
   way the sprite gets a visible rectangular edge. A baker whose canvas is
   larger than the shape must return the shape size along with the texture
   (`{ texture, contentSize }`), and consumers must derive scale from
   `contentSize` — otherwise changing `blur` in the config silently
   resizes every sprite. Bakers for the same shape are shared:
   `explosionTexture`/`smokeTexture`/`impactParticleTexture` all map to
   `blurredCircleTexture` in `bakers/index.js`, differing only by
   `params`.
4. If it needs services (`renderer`, `soundManager`), add the class to
   `componentDependencies`.

Entities can be subclassed and shown on different canvases: for example,
a simplified radar class is created for the radar (like `MapRadar` from
`Map`).

If the entity spawns many short-lived sprites (dozens or more), follow the
`Smoke`/`SmokeEffect` pattern: a `ParticleContainer` + `Particle` wrapped in
a plain `Container`, per-particle simulation state in a parallel array (not
`customData`, which `Particle` doesn't have), and `ParticlePool.js` for
reuse — see [architecture.md](architecture.md#texture-and-particle-lifecycle).
For a handful of sprites per effect (like `ImpactEffect`'s 2-4 shrapnel
particles), a plain `Container` + `Sprite` is simpler and cheap enough.

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
