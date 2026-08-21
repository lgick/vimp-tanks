# Changelog

All notable changes to `@vimp-games/tanks` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The snapshot frame carries the velocities the client needs to predict a
  contact (frame v4/v5, requires `vimp-engine` 0.12 / `vimp-engine-core`
  0.6). The tank row (`m1`) gained `angvel`, so the client can predict how
  far another tank's hull turns during the interpolation delay; the dynamic
  map elements (`c1`/`c2`) gained `vx`, `vy`, `angvel` behind the schema's
  new `optionalFrom: 3` — a moving crate ships its velocities, a resting one
  ships only its transform and costs 12 bytes less per frame. Decoding always
  yields the full six-field row (a missing tail reads as zeros), so the hot
  buffer and the client parts stay fixed-width; the predicted record in the
  hot buffer is 13 floats now.

- The chat commands the engine used to own — `/name`, `/nr`, `/timeleft`,
  `/mapname`, `/rank` — are declared by the game now and registered next to
  `/bot`, because the engine's `CommandProcessor` no longer parses any command
  of its own (`src/host/metaCommands.js`, `src/host/index.js`). Behaviour is
  unchanged for the player: all five keep working exactly as before.

### Fixed

- An explosion pushes the dynamic map objects again, as it does in
  `tank-battle`. Detonation dropped every body whose `user_data` did not
  decode into a game `BodyTag` (`core/src/tanks.rs`), and the engine tags a
  dynamic map body with its own `MAP_OBJECT_TAG`, so crates in the blast
  radius were filtered out before the impulse was computed. Such a body is a
  target now — it takes the impulse with the same falloff as a tank, and no
  damage.
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
- `ImpactEffect` shard fade-out comment said 70% of lifetime while the
  actual `fadeOutStart` value is `0.8` (80%); corrected the comment to
  match (`src/client/parts/effects/shot/ImpactEffect.js`).
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

- `explosionTexture`, `smokeTexture` and `impactParticleTexture` are baked by
  a single `blurredCircleTexture` baker (`src/client/bakers/`): the three
  separate files drew the same shape and differed only in parameters, which
  now live in `src/config/client.js` (`radius`, `blur`, `quality`, `color`).
  Bakers of these three assets return `{ texture, contentSize }` instead of a
  bare texture.

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
