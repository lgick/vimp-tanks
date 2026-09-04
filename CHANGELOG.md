# Changelog

All notable changes to `@vimp-games/tanks` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### ⚠️ Breaking

- Requires `vimp-engine-core` 0.11.0 (`STATIC_LEVEL_GROUP`).
- The state dump changed shape again: `Transit::Ramp` is no longer a bare
  variant but carries `entered_at` and `from_level`, so a dump taken by an
  older build no longer loads (same class of change as the `BotBrain`
  handoff dump below).

### Added

- The client checks `MAP_DATA` before it builds its replica of the map.
  `ClientCore.set_map` now runs the engine's `map::validate_levels` — the
  very rules the host runs on `load_map` — and refuses a broken map instead
  of building geometry that differs from the authoritative one and desyncing
  prediction with nothing in the console.
- `ClientPlugin.serviceNames` lists the two services the plugin provides
  (`levelView`, `mapDynamics`). It restores contract rule `C4` to an error:
  the checker cannot call `hooks.services(core)`, so without the list a typo
  in `componentDependencies` was only a warning. `npx vimp-contract --strict`
  is green again.

### Changed

- A falling tank no longer phases through buildings. It used to collide
  with nothing at all, and at `maxForwardSpeed` a 0.35 s fall covers some
  seven tiles — enough to end up inside a wall and be shoved out by the
  solver. It now carries the engine's `STATIC_LEVEL_GROUP` mask: the walls
  of every level stop it, while tanks, crates, rays and blasts still do
  not reach it (the invulnerability window is unchanged).
- A ramp changes a tank's level only when it is entered through the end
  matching that level — from the foot going up, from the top going down.
  A ramp run has open sides, and the cell next to its top is often
  reachable straight off the ground, which used to snap the tank onto the
  bridge for free, past the ramp itself. Entering from the side now keeps
  the tank's level and the run behaves as flat ground for it.
- The map fingerprint that decides whether the level geometry has to be
  rebuilt now includes an FNV-1a checksum of the level grids. `setId` plus
  the grid size is the same for every tanks map, so two layered maps of
  equal size were indistinguishable on the round-restart path, which calls
  `createMap` without `clear()`.
- `overpass`: the two bridge crates moved off the railing gaps onto the
  outer slab rows. Level rules apply to tanks only, so a crate pushed over
  a ledge would hang on the slab layer above open ground.

### Fixed

- The local tank takes its level from the very first frame. The engine sets
  the client's own `gameId` after `begin_reconcile`, so that first frame
  found no row to read and a tank spawned on a slab (`overpass` has two such
  respawns per team) was predicted on the ground for a frame — wrong
  collision groups and a tracer on the wrong level. Later frames keep coming
  from the raw frame, as before: an interpolated sample lags by the buffer
  and would drag a finished climb back down.
- The level-1 probe a ground ray gets at a bridge ledge is now exactly one
  cell long. Its end was estimated as the cell diagonal, which is the
  longest a ray can stay inside a cell, so at any other entry angle the
  probe spilled into the next cells and a tank standing well inside the
  slab could be shot from the ground. The exit distance is now taken from
  the cell walk itself.
- A ray fired straight along an axis from under the bridge is now checked
  against the cell strictly behind it. The zero component of the direction
  was treated as negative, so the "is the shooter deep under the slab?"
  test looked at a diagonal neighbour — exactly the case of shooting north
  from the `overpass` `team2` spawn.
- A bot no longer holds fire at an enemy on its own level standing in the
  ledge window. The gate asked which level wins at that distance (the
  upper one, by design), instead of whether the ray covers the target's
  level at all.
- A missed shot ends at the level in force at the end of the ray rather
  than at the level of the last segment in the list, so a ground tracer
  that grazes the bridge ledge is no longer drawn on the slab layer. Host
  and client are corrected together and stay bit-identical.
- The bridge slab now really turns semi-transparent while the local player
  drives under it. The feature was dead for two independent reasons:
  `Map` declared `onRender` as a class method, which shadows the
  `Container.prototype.onRender` accessor so PixiJS never registered the
  callback; and `Tank` computed "is this me?" once in the constructor,
  where `localPlayer.id` is still `null` for a tank built from
  `FIRST_SHOT_DATA` — the local one. The callback is now assigned as a
  property (slab layers only), and the local check is asked at update time.
- The `levelView` service is created per client core instead of once per
  module, so several `VirtualClient`s in one headless process no longer
  share (and overwrite) the "where is the player" state.
- `src/standalone.js` is back on the `pool mini` map; the 2.5D demo map is
  selected with `VITE_MAP='overpass' npm run dev` instead of an edit.
- A fall now survives reconciliation. The replica used to drop an
  unfinished `Falling` and start it over, so the height of one's own tank
  followed the length of the replay rather than the host's fall time — it
  jerked on an RTT spike and could land early on a long replay. The phase
  is rebuilt from the authoritative `z`/`level`, which are now read off the
  raw frame (`begin_reconcile`) rather than the interpolated sample.
- A tank on a ramp is now predicted to be hit the way the host resolves it.
  The host holds both level masks for it, while the client filtered targets
  by the single discrete `level` of the frame row, so a predicted tracer
  disagreed with the authoritative hit. A row whose `z` differs from its
  `level` is now offered to the segments of both levels.
- The level of a remote hull in the shot predictor comes from the predicted
  world (`sim_boxes()`) when the tank is predicted there, and from the frame
  row only as a fallback — the same single source the OBB already used.

## [0.17.0] - 2026-09-03

### Added

- 2.5D levels in the game core: a tank now carries a level (`0` — ground,
  `1` — overpass) and a visual height `z`. Driving a ramp lifts it between
  levels, a bridge ledge starts a fall (controls locked, no collisions),
  and the landing applies `fallDamage` — a lethal one is recorded as a
  suicide. Tanks on different levels do not collide. The rules live in one
  place, `core/src/level.rs`, so the host and the client replica cannot
  drift apart.
- `coreParams.levels` in `src/config/game.js` (`fallTime` 0.35 s,
  `fallDamage` 15): the level rules the engine hands to the game core
  as-is. A game without the section keeps the defaults; a flat map never
  touches them.
- Fields `z` and `level` at the end of the `m1` snapshot row
  (`src/config/snapshot.js`). The frame format itself is unchanged —
  `PLAYER_STATE_LEN` is still 8 and the snapshot version did not move.
- Shooting and explosions across 2.5D levels. A shot ray is split into
  single-level segments (`core/src/shot_levels.rs`): a ray from the bridge
  drops to the ground at the first cell without a slab, a ray from the
  ground can hit a tank standing on an open ledge in the first slab cell it
  enters (railings close that window), and past it the slab shields
  everything. An explosion only reaches targets of its own level, a bomb
  remembers the level it was dropped on (over a cell without a slab — a
  ramp, say — it lands on the ground), and a falling tank is hit by neither
  rays nor blasts. Flat maps keep the previous shooting path untouched.
- Fields `startLevel`/`endLevel` in the tracer row (`w1`) and `level` in
  the bomb (`w2`) and explosion (`w2e`) rows of the snapshot schema
  (`src/config/snapshot.js`).
- Client-side prediction of the own tank's level: the replica runs the same
  `core/src/level.rs` rules as the host over the same layered geometry, so
  a ramp climb and a fall are predicted rather than awaited. The frame's
  `level` is a hard correction, applied only while the replica is not in a
  transit — on a ramp the frame lags by the interpolation buffer and would
  drag the climb back every tick. Predicted contacts are skipped between
  bodies whose level masks do not intersect (a tank on the bridge does not
  push a box below it), a falling tank makes no contacts at all, and the
  local tracer is cut into the same per-level segments as the authoritative
  ray. `PLAYER_STATE_LEN` is still 8: `level`/`z` are derived, not
  transmitted.
- `coreParams` now reaches the CLIENT core as well (`prediction.coreParams`
  in `CONFIG_DATA`, needs an engine with that passthrough): the replica has
  to see `levels.fallTime` exactly as the host does, otherwise a falling
  tank lands early or late and flickers between levels.
- 2.5D rendering: every part now draws on its own level. A part's base
  `zIndex` is shifted by `LEVEL_Z_STRIDE = 100` per level
  (`src/client/levelZ.js`), so an overpass layer always covers the ground
  below it, and tanks, smoke, tracks, bombs, tracers and explosions follow
  the level they belong to. Track marks stay on the level they were left
  on. A map without upper levels keeps exactly the previous draw order.
- See-through bridge: a map layer of level >= 1 fades while the local
  player drives under its slab, and fades back smoothly on the way out.
- Service `levelView` (`src/client/levelView.js`), handed to the parts by
  `ClientPlugin.hooks.services`: where the local player is and on which
  level. The local `Tank` writes it (`localPlayer` tells it that it is the
  local one), the bridge layers read it.

- Bots use the ramps and bridges: the path is built over the layered nav
  graph (a level change is a ramp or a ledge), a falling bot is not steered
  and is no longer mistaken for a stuck one, obstacle avoidance and the
  strafe point after a shot stay on the bot's own level, a target on the
  bot's own level is preferred, and a shot is held while the bridge slab
  shields the target — the bot drives to it over a ramp instead.
  `level_at_distance()` (`core/src/shot_levels.rs`) answers which level a
  ray is on at a given distance.
- Map `overpass` (`src/data/maps/overpass.js`): the 2.5D demo — a through
  overpass with railings, two ramps at its ends, two gaps in the railings to
  fall from and to shoot through from below, boxes on both levels and
  respawn points on the ground and on the slab. Registered in the map
  catalog; the default map stays `pool mini`.
- `requires: ['map.layers']` in both plugin halves and in the generated
  manifest: without layered maps in the engine `overpass` would load without
  its second level and without a single error, so the capability is a hard
  requirement. `scripts/build-game-manifest.js` takes the list from
  `src/host/index.js` — one source for the manifest and the plugin.
- Debug scenarios `bridge.json`, `fall.json`, `crosslevel.json` and
  `bots_bridge.json` (`tests/scenarios/`): the ramp climb and the descent,
  a fall off a ledge, hitscan and a bomb across levels, and bots using the
  bridge over a long run.

### Changed

- The internal `BotBrain` handoff dump changed shape: the path and the
  patrol target are now points with a level (`PathPoint`), not bare
  coordinates. The dump is internal and unversioned, so an old one no
  longer restores — a handoff has to happen between equal builds.
- Client map geometry moved from the flat `Grid` to the layered
  `MapLevels`: prediction and the shot raycast share one structure built
  once per `MAP_DATA`, and each of them reads the grid, the solid tiles and
  the tile size of the level it works on.
- Rebuilt against `vimp-engine` 0.23.0 and `vimp-engine-core` 0.9.0. Nothing
  in the game had to change: `dispatch`/`abi_describe` arrive from the
  `export_game_core_abi!` macro, and `engineApi` stays 4. The engine no
  longer rejects a package for being older than itself, so this update is
  the game following the engine by choice, not by necessity.

### Fixed

- `MapRadar` no longer duplicates the same wall graphics for every render
  layer of a map: only the layer that owns the solid tiles draws them.
- `ShotEffect` reads the map-dynamics anchor at its new index in the tracer
  row: the row grew by `startLevel`/`endLevel`, and debris from a hit on a
  moving box was landing at the pre-shot position again.
- `players_data()` now emits the full-width `m1` row: it stopped at `team`
  and silently dropped `angvel`, so the JSON path (the first frame's
  `FIRST_SHOT_DATA`) and the binary frames disagreed on row width.

## [0.13.1] - 2026-08-26

### Added

- `scripts/build-game-manifest.js` now also writes `min`/`max` on the
  generated `maxPlayers`/`roundTime`/`mapTime` `roomForm` fields, alongside
  the existing generated `regExp` — the engine uses them to show a range
  hint next to the field's label and to validate without a native browser
  popup (needs `vimp-engine` with that `formBuilder.js` support).

## [0.13.0] - 2026-08-21

### Fixed

- `MapDynamics::render_data` (`core/src/client/map_dynamics.rs`) skips a
  predicted body with no entry in `indices` instead of falling back to id
  `0` — the fallback silently overwrote row `d0`'s render data with a
  stranger's.

## [0.12.1] - 2026-08-21

Version bump only: the engine pin moves to `vimp-engine` `^0.14.3`
(`acd0405`). No game code changed.

## [0.12.0] - 2026-08-21

### Removed

- The unused `map_dynamics_box(key)` method of the client ABI
  (`core/src/lib.rs`). Nothing on the JS side ever called it: the
  `mapDynamics` service exposes only `toWorld` on top of
  `map_dynamics_to_world`, and the shot effect reads its anchor through that.
  `MapDynamics::render_box` stays — it is what `to_world` is built on.

The engine pin moves to `vimp-engine` `^0.14.2` / `vimp-engine-core` `0.8.2`
in the same release (`efedd4c`).

## [0.11.2] - 2026-08-21

### Fixed

- An explosion pushes the dynamic map objects again, as it does in
  `tank-battle`. Detonation dropped every body whose `user_data` did not
  decode into a game `BodyTag` (`core/src/tanks.rs`), and the engine tags a
  dynamic map body with its own `MAP_OBJECT_TAG`, so crates in the blast
  radius were filtered out before the impulse was computed. Such a body is a
  target now — it takes the impulse with the same falloff as a tank, and no
  damage.

## [0.11.1] - 2026-08-21

### Fixed

- A map-dynamics render row is addressed by the object's index in
  `physicsDynamic`, not by the body's position in the predicted set
  (`core/src/client/map_dynamics.rs`). The two numbers matched only by
  construction — insertion order plus a set nothing ever removes from — and
  the day a body left the set, a crate would silently have been drawn at
  another crate's coordinates.

- MAP_DATA is parsed exactly once on the client (`TanksClient::set_map`), and
  the motion predictor and the shot predictor share the resulting wall grid
  (`Rc<Grid>`) instead of each building its own from a separate parse. The two
  copies could only be kept identical by hand, so any edit to one `set_map`
  (a different tile scale, a different set of solid tiles) would have let the
  ray and the hull contact see different maps.

## [0.11.0] - 2026-08-21

Version bump only: the engine pin moves to `vimp-engine` `^0.14.1` /
`vimp-engine-core` `0.8.1` (`86ba8be`). No game code changed.

## [0.10.0] - 2026-08-21

Version bump only: the engine pin moves to `vimp-engine` `^0.14.0` /
`vimp-engine-core` `0.8.0` (`7e5c2cf`). No game code changed.

## [0.9.0] - 2026-08-21

Released without journal entries: the client-side prediction of remote
tanks, of the dynamic map elements and of the shot ray landed in the
release commit itself (`ff1a9fc` — `core/src/client/remote_tanks.rs`,
`core/src/client/map_dynamics.rs`, `core/src/client/shot.rs`). See the git
history and `docs/en/core.md` for what it does.

## [0.8.1] - 2026-08-21

Released without journal entries: the predicted-set client core
(`core/src/client/predicted_set.rs`, `core/src/client/predictor.rs`) landed
in the release commit itself (`8fd25d3`). See the git history and
`docs/en/core.md`.

## [0.8.0] - 2026-08-20

### Added

- The snapshot frame carries the velocities the client needs to predict a
  contact (frame v4/v5; needs `vimp-engine` ≥ 0.12.0 / `vimp-engine-core`
  ≥ 0.6.0 — the minors that introduced `optionalFrom`). The tank row (`m1`)
  gained `angvel`, so the client can predict how far another tank's hull
  turns during the interpolation delay; the dynamic map elements
  (`c1`/`c2`) gained `vx`, `vy`, `angvel` behind the schema's
  new `optionalFrom: 3` — a moving crate ships its velocities, a resting one
  ships only its transform and costs 12 bytes less per frame. Decoding always
  yields the full six-field row (a missing tail reads as zeros), so the hot
  buffer and the client parts stay fixed-width; the predicted record in the
  hot buffer is 13 floats now.

### Changed

- `explosionTexture`, `smokeTexture` and `impactParticleTexture` are baked by
  a single `blurredCircleTexture` baker (`src/client/bakers/`): the three
  separate files drew the same shape and differed only in parameters, which
  now live in `src/config/client.js` (`radius`, `blur`, `quality`, `color`).
  Bakers of these three assets return `{ texture, contentSize }` instead of a
  bare texture.

### Fixed

- Tanks no longer sink into geometry on impact. The tank body is built with
  `soft_ccd_prediction(width.min(height))` (`core/src/tank.rs`): Rapier's
  default contact prediction distance of 0.002 units is calibrated for a
  metre-scale world, while a tank covers up to 2.2 units per `1/120` step,
  so the contact was born only once the hull already overlapped the obstacle
  (peak penetration 1.26 units in the frame of impact against 0.03 with
  prediction). Dynamic map objects get the same on the engine side.

- `brakingFactor` in `src/data/models.js` is `0.3` instead of `10`. The old
  value compensated for the contact error above; with predictive contacts it
  made the tank stop far too abruptly.

- Blurred-circle sprites no longer show a rectangular edge. The baker sets
  `filter.padding = blurMargin(blur)` and reserves the same allowance on the
  canvas (`src/client/bakers/blurMargin.js`): without the padding Pixi renders
  the blur only within `2 * strength` around the shape and clips it before the
  frame, whatever the canvas size.

- Particle scale no longer depends on the blur allowance. The baker returns
  `{ texture, contentSize }`, where `contentSize` is the diameter of the drawn
  circle, and `ExplosionEffect`, `Smoke` and `ImpactEffect` derive their scale
  from it instead of the canvas size — changing `blur` in the config used to
  silently resize every sprite.

## [0.7.1] - 2026-08-20

Version bump only: the engine pin moves to `vimp-engine` `^0.11.1`
(`1823988`). No game code changed.

## [0.7.0] - 2026-08-19

### Added

- The chat commands the engine used to own — `/name`, `/nr`, `/timeleft`,
  `/mapname`, `/rank` — are declared by the game now and registered next to
  `/bot`, because the engine's `CommandProcessor` no longer parses any command
  of its own (`src/host/metaCommands.js`, `src/host/index.js`). Behaviour is
  unchanged for the player: all five keep working exactly as before.

## [0.6.5] - 2026-08-18

Version bump only, plus a `scripts/build-game-manifest.js` tweak that does
not change the produced manifest (`8624f38`).

## [0.6.4] - 2026-08-18

### Fixed

- `ImpactEffect` shard fade-out comment said 70% of lifetime while the
  actual `fadeOutStart` value is `0.8` (80%); corrected the comment to
  match (`src/client/parts/effects/shot/ImpactEffect.js`).

## [0.6.3] - 2026-08-18

Version bump only: the engine pin moves to `vimp-engine` `^0.10.0`
(`5dfd4b8`). No game code changed.

## [0.6.2] - 2026-08-18

Internal refactor only: the asset-staging scripts and
`src/client/parts/Map.js` were reworked without a behaviour change
(`3103385`).

## [0.6.1] - 2026-08-18

### Added

- Local standalone launch: `npm run dev` opens a browser tab with a playable
  match against four bots — no master server, no OAuth, no lobby screen
  (`index.html`, `src/standalone.js`, the `serve` branch of
  `vite.config.js`). Built on `vimp-engine/standalone` (engine ≥ 0.8.0).

- Map images now ship with the game: `assets/img/` holds the sources
  (`tiles.png`, `tiles2.png`, `tiles3.png`, `b1.png`, `bob.jpg`,
  `stalin.jpg`) and `scripts/copy-game-images.js` stages them into
  `build/img/` (the `npm run dev` root, via `predev`) and `dist/img/` (the
  published asset). They used to live in the engine's `public/img/`, which
  meant `npm run dev` drew maps with no tiles at all and no other game could
  reuse the pipeline.

- `npm run build:manifest` now fails when a map names an image that is not in
  `dist/img/`, and `npm run check:pack` requires the tile sheets in the
  tarball. Both failures are silent at runtime: the map simply renders empty.

### Changed

- `src/client/parts/Map.js` builds texture URLs from the engine's
  `assetsBase` service (`${assetsBase}img/<file>`) instead of the hardcoded
  absolute `/img/<file>`, and logs a readable `console.error` (leaving the
  map empty, the way an asset load failure already behaves) when the service
  is missing. The service is declared in `src/config/client.js`
  (`componentDependencies.assetsBase`). **Requires `vimp-engine` ≥ 0.9.0** —
  earlier engines do not supply the base.

## [0.6.0] - 2026-08-09

Releases up to and including 0.6.0 predate this changelog — see the git
history for their contents.
