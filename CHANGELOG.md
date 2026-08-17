# Changelog

All notable changes to `@vimp-games/tanks` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  absolute `/img/<file>`, and throws with a readable message when the service
  is missing. The service is declared in `src/config/client.js`
  (`componentDependencies.assetsBase`). **Requires `vimp-engine` ≥ 0.9.0** —
  earlier engines do not supply the base.

## [0.6.0] - 2026-08-09

Releases up to and including 0.6.0 predate this changelog — see the git
history for their contents.
