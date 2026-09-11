# Changelog

All notable changes to `@vimp-games/tanks` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **A ramp is entered at its ends from ANY direction.** The entry gate used
  to demand that the previous cell be the neighbour straight along the run's
  axis, so a tank that reached the foot at an angle stayed on its own level
  and drove over the hill as if it were flat ground. The gate now judges the
  ENTRY CELL — the foot takes tanks of the lower level, the top cell tanks
  of the upper one — and ignores the direction. An entry across the axis
  may not lift the tank: it must stand at its own level's height, and the
  ramp's height at the entry point must be within half a level of it. The
  middle of a run is still closed, by the gate and by the engine's side
  rails, which now start one cell past the foot
  (`vimp-engine-core` 0.17.0); leaving a run sideways was never held and
  still is not.

### Fixed

- **A late frame no longer lifts a landed tank back onto the bridge.**
  While a tank descends, the frames still in flight carry the level it left,
  and the replica adopted them whenever it was grounded — snapping itself to
  `level = 1, z = 1`. Everything downstream then ran on the wrong level: the
  collision mask banged the tank against railings that do not exist for it
  on the host (the shaking under an overpass), the hull took the scale and
  the projection offset of a body on the slab (the shadow drifting away), and
  the slab above stopped being transparent. The frame is now only remembered;
  the level is recomputed by the replay, which rewinds to the frame's own
  step — and when the level history does not reach that far, the state is
  taken from the frame instead of being left over from the prediction.
- A falling tank is drawn by its height: the host keeps `level` at the level
  the tank fell from, so the hull kept the layer, tint and transparency of
  the overpass until it touched the ground.

- A point entity's transparency and the hole in the slab above the player
  were measured in different coordinate systems. The hole is centred on the
  player's **drawn** point — offset by his own height — while
  `levelView.alphaFor` measured the distance between raw world points, so a
  box on a bridge stayed opaque inside the hole, or faded past its edge; the
  gap grew with the distance from the screen centre and with the entity's
  height. Both sides now project through the same camera centre, which the
  local `Tank` publishes once per frame (`levelView.setCamera`), and an
  entity passes its own height (`alphaFor(level, x, y, z)`).

- The ramp-run guards no longer hold other players' tanks the host lets
  through. The replica decided "this body is climbing" by body index — only
  the local tank was released — so a remote tank driving legally up a run
  hit a side or a top guard that does not exist for it on the host, and
  jerked on the slope. The flag is now read off the map under each predicted
  body (`MapLevels::ramp_at`), exactly as the host reads it
  (`map::body_filter`).
- The replica takes the guards' geometry from the engine
  (`map::ramp_guards`, `vimp-engine-core` 0.16.0) instead of rebuilding it
  with its own copy of the formula, and builds it once per map load rather
  than on every simulation step.
- A descending ramp (`from > to`) is drawn again. The renderer skipped every
  run whose rise was not positive, so such a hill got full physics — a run,
  a grade, guards — and not a single pixel: neither wedge nor skirt. The
  wedge's height now follows `lerp(from, to, progress)`, the formula the
  core moves the tank's `z` by, and its skirt stands on the run's LOWER
  level instead of the layer's own.

### Changed

- The crate requirement is raised to `vimp-engine-core` 0.17.0
  (`core/Cargo.toml`): the replica needs `map::ramp_guards` (the shared
  guard geometry, with the run's foot cell now open),
  `client::collision::collect_block_contacts_into` (the buffered collection)
  and the degenerate-OBB fix in the speculative contacts.

- The ramp wedge is built from the core's runs (the new
  `ClientCore.ramp_runs` and the `rampRuns` client service) instead of a
  second grid walk on JS. The picture and the physics now share one source
  — `MapLevels::runs` — so a hill you can see but cannot drive up is no
  longer possible; `src/client/parts/rampRuns.js` became
  `src/client/parts/rampLanes.js` and only merges a block's lanes for the
  picture.

- Sound near the listener is continuous now: the game declares its own
  spatial-sound geometry in `src/config/sounds.js`
  (`mode: 'topDown'`, `virtualElevation: 108`, `innerRadius: 5`, all in
  world units, where one unit is a fifth of a screen pixel). An explosion
  under the tank no longer jumps into one ear with a change of timbre. Both
  numbers are calibrated for a 1920×1080 window; the engine scales them for
  other window sizes itself. An engine without `parts.sounds.spatial`
  support ignores the block and sounds as it did before — no version bump is
  required.

## [0.19.0] - 2026-09-06

### ⚠️ Breaking

- Requires `vimp-engine-core` 0.15.0 and `vimp-engine` 0.32.2: the map's
  `levelHeight`, the ramp guards, the glued wall blocks
  (`MapLevels::static_blocks`), the ramp block number (`RampRun::block`) and
  the `role`-tagged dynamic map row all come from there.

### Migration

- The `c1`/`c2` snapshot rows must declare `role: 'z'` and `role: 'level'`
  on their `z`/`level` fields (`src/config/snapshot.js`). Without the roles
  the engine refuses to load a layered map instead of silently shipping a
  flat row.
- `climbGravity` and `climbMaxSpeedFactor` were recalibrated (220 → 500,
  0.55 → 0.5) because the ramp grade is dimensionless now. A game config
  that kept the old numbers gets a climb that is 30–100 times weaker than
  intended.

### Changed

- `MapVolume` is gone: the `Map` part draws a layer's volume itself, as
  sprites over the SAME baked texture (the layer used to be baked twice)
  and as children of the same container. Anything that referred to the part
  by name — `gameSets`, `entitiesOnCanvas`, `componentDependencies` — moves
  to `Map`. The extrusion no longer rewrites ~40 000 vertices and four
  vertex buffers per frame of camera movement: the whole shift is one
  container transform.
- `volume.shear` moved to a shared `parallax.shear`
  (`src/config/render.js`): one number now drives the level layer, its
  volume, the ramp wedge, the tank hull and the track marks. The hull used
  a shear of its own (0.07), which meant a tank could not sit still on the
  slab it was standing on.
- The ramp grade is dimensionless (`rise * levelHeight / span`) instead of
  "levels per pixel", so climbing is actually felt: on the demo maps the
  grade now runs from 0.11 (`terraces.rampLong`) to 0.5
  (`terraces.rampSteep`) rather than 0.0087…0.039. `climbGravity` and
  `climbMaxSpeedFactor` were recalibrated to match — uphill speed and
  roll-back both change noticeably.
- The client replica mirrors the engine's ramp guards
  (`Predictor::resolve_world`): prediction no longer drives onto a run from
  the side where the host holds the tank. The mirror follows the engine
  block by block, and walls are read as the glued blocks the host puts its
  colliders by (`MapLevels::static_blocks` → `collect_block_contacts`)
  instead of tile by tile: a hull along a long wall used to collect several
  contacts with different levers where the host has one.
- The 2.5D render constants left the parts for `src/config/render.js`: the
  `zIndex` stride between levels joins `parallax`, and the new `shadow`
  block holds the tank shadow. They ship in the client config as
  `parts.parallax` and `parts.shadow`.
- The ramp wedge is a slope instead of a staircase: `Map` builds ONE mesh
  per run (`volume.rampSegments` segments per cell) whose every vertex
  carries its own height, so the parallax shift grows along the run
  continuously. The steps of the old `volume.slices` wedge were plainly
  visible in game. `volume.slices` now applies to layer volumes only, and
  `runSliceFrame` is gone with the last thing that used it.
- The height projection is one for the whole dynamics: the tank and its
  wreck, the engine smoke, bombs and the shot and explosion effects are all
  drawn shifted AND scaled by the same `parallax.shear` as the slab under
  them, so smoke and blasts on the bridge stand on the bridge instead of on
  the ground below it. `Smoke`, `Bomb`, `ShotEffect` and `ExplosionEffect`
  join `renderer` in `componentDependencies`.
- A layer's volume moved out of the part into an occluder container of its
  own on the stage (see Fixed); the ramp wedge stays a child of the part —
  a tank climbing a ramp has to be drawn over its surface.
- The engine sound reads its load differently: the idle volume factor is
  0.6 of `volume` instead of 0.9, full speed and strain pitch a little
  higher (1.15 / 1.25 instead of 1.1 / 1.18), and at idle the pitch wobbles
  slightly (1.5 % at 2.5 Hz, fading out as the load grows) — a bass tone
  held at a fixed pitch reads to the ear as a hum, not as a running engine.
  `tankEngine.volume` is 0.5, so a standing tank is a touch louder than
  before (0.30 vs 0.26 effective) and a moving one clearly louder.
  `calculateEngineSoundParams` is exported and guards a non-finite load.
- Every `volume` in `src/config/sounds.js` was recomputed against the
  normalized webm (`roundStart` 0.35, `victory` 0.38, `defeat` 0.5, `frag`
  0.26, `hit` 0.36, `gameOver` 0.31, `shot` 0.51, `explosion` 0.74,
  `bombHasBeenPlanted` 0.48, `tankEngine` 0.29). Each number is the old one
  scaled by that file's measured loudness change, so every sound is as loud
  as it used to be; the relative mix is unchanged.
- `npm run audio:check` (`scripts/check-audio-levels.js`) measures
  `build/sounds/` with `ebur128` and fails when the two codecs of one sound
  disagree by more than 1 LU. Run it after `npm run audio:process`; it needs
  ffmpeg and is not part of CI.

### Removed

- The hull tilt on a slope and the dust from under the tracks are gone,
  together with `src/client/grade.js`, the `grade` and `dust` config blocks
  and `levelView.setLevelHeight`. The client-side grade sums decayed only in
  frames WITH motion, so a wrong value froze under a parked tank and the
  fall effect stayed after the landing. Height now reads from the shadow,
  the parallax and the height scale. The map's `levelHeight` stays — the
  core needs it for the physics grade.
- `parallax.zScaleGain` is gone: the height scale is the same projection as
  the shift (`1 + z * shear`), so the tank, its wreck, the smoke, bombs and
  the effects grow exactly as much as the slab they stand on.
- The level badge next to the local tank is gone, together with its
  `levelBadgeTexture` baker and the `bakedAssets` entry. The level still
  reads from the radar ring, the layer colours on the radar, the tinting of
  the levels below, the shadow and the parallax. This also removes a state
  leak: `levelView.markLayered()` was never reset, so after a layered map a
  flat one kept showing a badge with a permanent "0".

### Fixed

- **Client prediction now matches the server on a tangential hit.** Grazing
  a railing with the corner of the hull at full speed cost a frame of jerk:
  the replica resolved contacts *after* integrating the position, so at
  148 u/s it was already 1.24 units inside the wall before it reacted, and
  it put the single contact point in the middle of the hull's face — no
  lever, so the hull did not turn where the server turned it (`angle` off by
  0.21 rad against a threshold of 0.06, `angvel` by 2.8 rad/s against 1.5).
  The step now follows Rapier's order — contacts on the pose at the start of
  the step, collected with the same `soft_ccd_prediction` gap the host uses
  (`motion::contact_prediction`, one formula for both sides), impulses, then
  the integration — and the engine's new two-point manifolds and accumulated
  impulses carry the lever. `tests/scenarios/bridge.json` and `fall.json`
  are green.
- **Climbing a steep ramp no longer eats the throttle.** On a run that
  crosses a whole level the authoritative height is fractional by design,
  and reconciliation read that as "the tank is in the air": the replica
  armed a fall, locked the input and lost 0.15 of throttle on every frame of
  the climb while the server was building it up. The verdict now asks the
  map under the authoritative position, exactly as the host does — the host
  never starts a fall on a ramp tile. `tests/scenarios/terraces_climb.json`
  is green.
- A falling tank freezes its input instead of zeroing it, mirroring
  `Tank::update`'s early return: the replica used to keep centring the
  turret, bleed the throttle off and brake with the thrust for the whole
  fall, while the server did none of it.
- A wide ramp is driven through whole: the core cuts a rectangular block of
  ramp tiles into parallel lane runs, and a lane change mid-climb used to be
  judged as a fresh entry — the climb broke on every lane border and the
  tank ran into its own lane's guard. `is_lane_change` carries the verdict
  across lanes of one ramp — identified by the crate's own `RampRun::block`,
  the same field the engine fences a block of lanes by, so the physics and
  the rules can no longer disagree about what one hill is; lanes of
  different length fall into different blocks and stay different ramps. The
  picture merges the lanes back into one run. Off-centre entry works too:
  the guards no longer turn a wide ramp into tile-wide troughs.
- The skirt of the ramp wedge is textured from INSIDE the run: the far edge
  of a run is already the next cell, which holds no ramp tile, so the face
  that stretched those pixels came out transparent and the embankment read
  as hollow from one side.
- A ramp is drawn as a solid embankment: every run gets a skirt — the two
  sides along the axis and the end face at the top, down to the run's base
  plane. The wedge used to be a single surface mesh with the ground showing
  under it, so the map read as "empty, I can drive through" where the
  engine's guards actually hold the tank. Under a high run (`1 → 2`) the
  gap remains, and there driving through really is allowed.
- A tank no longer climbs onto a volumetric wall: a layer's volume now
  lives in an occluder container on the stage whose `zIndex` is above the
  dynamics of its own level, so a tank behind a wall is drawn behind it.
  The wall stays solid: the hole around the player opens only when the
  volume actually covers the tank on screen (the source cell of the slice
  under the player is computed back from the projection), and a volume
  above the player still fades together with its own layer.
- Map teardown releases shared texture references before freeing the GPU
  source: every extrusion slice gets `Texture.EMPTY` first, so a mesh that
  outlives the part (a frame started before a map change) draws an empty
  texture instead of a destroyed source — the `BindGroup.setResource`
  crash class.
- The tank shadow is a silhouette of the hull instead of a blurred circle
  a third of its size: the circle was normalised by the model `size` rather
  than by the hull, so its halo stuck out from under the corners of a
  turning tank as a grey dot.
- The bridge is drawn ABOVE the ground instead of in the ground's own
  coordinates: a level-N layer is shifted away from the camera centre by
  its own height, so its walls no longer read as a dead wall across the
  level-0 passage, and they open up as the camera moves.
- A layer's volume takes part in see-through: the railings of the bridge
  now fade with the slab they belong to (the part declared `levelView` as a
  dependency and never read it), so a player under the bridge sees a hole
  in the slab instead of a solid block of railings over it.
- The 2.5D projection was inside out: the SHADOW was shifted away from the
  camera while the hull stayed in the world point, which read as a shadow
  hovering above the tank. Now the hull moves — by the same number as the
  slab under it — and the shadow stays on the ground.
- A ramp has a visible volume: each run is drawn as a wedge of
  `volume.slices` steps whose height grows along the run, so a tank driving
  under a ramp is hidden by it and the ramp reads as an obstacle from the
  side (which it now is physically, too).
- Track marks read `levelView`: marks left on a slab above the player fade
  like everything else, and marks on an upper level hang at its height
  instead of lying on the ground.
- The centre of the see-through hole follows the tank it belongs to: it is
  computed from the player's projected point, not from the world one, so it
  no longer drifts off the tank the further the tank is from the centre of
  the screen.
- A crate on the bridge is drawn at the bridge's height instead of on the
  asphalt under it.
- Bots drive onto a bridge instead of grinding at the foot of a ramp. Two
  things stood in the way: the nav graph routed paths through the cells of a
  run, straight into the guard colliders it cannot see (fixed in the engine,
  which also moved the ramp edge to the centre line of the run), and the
  bot's obstacle-avoidance rays saw the guards themselves — a run is one
  tile wide, so the side rays hit its rails on every approach and turned the
  bot away. The rays now cast with `map::levels_interaction_on_ramp`, which
  drops the guard bit; entry from the side is still held by the guards and
  by the nav graph.
- A tank driving under a ramp's cells (a `1 → 2` run lies in the level-1
  grid with ground beneath it) keeps the collision mask of its OWN level.
  It used to take the mask of every level of the run above it: it drove
  through the walls of its own level, ignored ground tanks and crates, and
  could not be hit by ground fire.
- The ramp entry gate judges each run on its own: `Transit::Ramp` now
  carries the run's number, so moving into an adjacent run is a new entry
  instead of inheriting the neighbour's verdict (a free climb, or a
  permanent refusal).
- A bomb dropped by the client lands where the host lands it: both sides
  call one `level::bomb_level()` — over a gap, and for a falling tank, the
  bomb settles on the nearest support below instead of on the ground.
- The level state takes part in reconciliation: the predictor snapshots
  `LevelState` per step and rewinds it to the frame's step before the
  replay, so the ramp entry gate can no longer fire on the client alone.
- The landing level is recomputed from the cell of touchdown rather than
  frozen at the moment of the drop, so drifting past the lower slab no
  longer lands the tank on a floor that is not under it. The fall height of
  `LevelEvent::Landed` is a saturating subtraction.

- Changing the map no longer takes the client down. A map part unloaded the
  shared tile sheet (`Assets.unload`) as soon as the first layer was torn
  down; PixiJS 8 does not refcount there, so the destroyed `TextureSource`
  nulled a live `BindGroup` and the next filter pass threw in `setResource`.
  Game assets now stay in the `Assets` cache across map changes.
- A part's async constructors (`Map.createStatic`, `Map.createDynamic`,
  `Map._createExtrusion`) check `destroyed` after every `await`, so a bake
  that finishes after a map change no longer builds onto a torn-down part —
  and its baked texture is released instead of leaking.
- GPU resources are freed only after the object leaves the scene, and
  `bakeTileLayer` destroys the temporary `Spritesheet`, so a map change no
  longer leaks one frame texture per tile.
- The webm sounds went through no filter at all: `-af` is an OUTPUT option
  in ffmpeg, so the single occurrence in `scripts/process-audio.js` applied
  to the mp3 that followed it and nothing else. Only Safari's branch was
  normalized, while the webm that Chrome, Firefox and Edge pick was raw and
  spread over 11 LU — the engine loop was the quietest file in the set and
  the explosion 11 LU above it. The filter chain is now stated for both
  outputs and every sound sits at `I = -16` LUFS.
- A looped sample no longer goes through `silenceremove` and is normalized
  in two passes (`loudnorm` with measured values and `linear=true`):
  a single pass normalizes dynamically, and a gain drifting inside the
  0.65 s engine loop is heard as an uneven idle and as a step at the loop
  seam, while `silenceremove` cuts at a threshold rather than at a zero
  crossing. `scripts/process-audio.js` reads which sounds loop from
  `src/config/sounds.js`, and `-application audio` is now explicit for
  libopus.
- `Tank.update` guards `engineLoad` with `|| 0`, as the constructor already
  did: a short `m1` row left it `undefined`, `clamp` turned that into `NaN`,
  and since `NaN !== NaN` the engine pushed a non-finite `rate` into Web
  Audio on every single frame.
- The local player's own tank and own shot are no longer panned: both
  register with `spatial: false`. The listener is the camera centre, i.e.
  the local tank itself, so its engine source lay exactly on the listener,
  where HRTF gives comb colouring — a hum instead of an engine — and a
  two-pixel gap between camera and tank threw the same source fully into one
  ear, since the Web Audio azimuth follows direction rather than distance.
  Other tanks and every world sound still pan.

## [0.18.0] - 2026-09-04

### ⚠️ Breaking

- Requires `vimp-engine-core` 0.12.0 and `vimp-engine` 0.31.0, and declares
  the `map.levelsN` capability: the plugin refuses to load on an engine
  without N-level maps instead of silently dropping the upper levels.
- The `c1`/`c2` snapshot rows carry `z` and `level` right after `angle`
  (`optionalFrom` moved from 3 to 5). Anything reading those rows by index
  moves with them — `C_VX`/`C_VY`/`C_ANGVEL` are now 5/6/7.
- The state dump changed shape: `LevelState` gained `prev_cell` and
  `slope_vec`, `Transit::Ramp` now carries `climbing`/`low`/`high` and
  `Transit::Falling` carries `to` (the landing level). A dump taken by an
  older build no longer loads.

### Migration

- Rebuild the core against the published crate: `vimp-engine-core = "0.12.0"`
  in `core/Cargo.toml`, then `npm run core:build`.
- A game reading `c1`/`c2` rows by index must use the constants from
  `src/client/snapshotFields.js` rather than literals.
- New `coreParams.levels` keys (`maxFallDamage`, `climbGravity`,
  `climbMaxSpeedFactor`) have defaults, but `TanksConfig::validate` now
  rejects `maxFallDamage < fallDamage` and `climbMaxSpeedFactor` outside
  `[0, 1)`.

### Added

- Crates fall. A dynamic map body pushed off a slab now falls by the same
  engine primitive as a tank (`step_body_level`), lands on the nearest floor
  below that has a surface and changes its collision level on the way. The
  client replica predicts the same fall, so a crate that a player pushes
  over the edge does not hang in the air until the next frame. Maps may now
  place level 1 crates next to a gap in the railings.
- Ramps climb through several levels at once (0 → 2 in one run): the level
  snaps to `z.round()` instead of a single half-way threshold, and the hull
  on a ramp collides with every level the run connects.
- Shots and explosions work on any number of levels. A ray now drops level
  by level (`landing_level`) instead of falling straight to the ground at
  the first missing slab, and the edge window over a ledge probes the
  nearest level above the shooter — so on a three-level map a shot fired
  from level 2 can hit a tank on the terrace of level 1 before reaching the
  ground. A single-level map still gets one ground segment, bit for bit.
- A bomb dropped over a gap lands on the nearest floor below instead of the
  ground: over a hole in the level 2 slab it comes to rest on the level 1
  slab, and the explosion is shielded per level as before.
- See-through has two modes, switched by `parts.seeThrough.mode`
  (`src/config/render.js`): `'hole'` (default) opens a radial hole around
  the player in the slab above him, `'layer'` keeps the old behaviour of
  fading the whole layer. One formula serves every part
  (`levelView.alphaFor`); the slab runs it as a filter with a WebGL and a
  WebGPU branch.
- Crates on a bridge fade with it. The dynamic branch of `Map` had neither
  an `onRender` callback nor an alpha at all, so a crate stayed opaque over
  the player; it now also re-sorts by the `level` in its own frame row, so a
  crate falling off the bridge is visibly falling off it.
- Level cues: everything below the player's level is tinted
  (`seeThrough.lowerTint`), the radar dims the other levels and marks
  another tank's level with a ring in that level's colour, and the local
  tank carries a level badge — on layered maps only.
- Height cues on a ramp: a shadow sprite offset away from the camera centre
  in proportion to `z` (a sibling on the stage, drawn on the level the tank
  hangs over), a hull compressed along its heading on a climb, and dust from
  under the tracks. The grade is recovered on the client from `z` between
  frames — the `m1` frame is unchanged.
- Volumetric map elements: a render layer with a height (`volumes` in the
  map) is extruded by the new `MapVolume` part and shifts as the camera
  moves. It draws `parts.volume.slices` slices per layer regardless of how
  many walls the map has, and `parts.volume.enabled = false` switches it off.
- A three-level demo map, `terraces`: a 0 → 2 ramp climbed in one run next
  to a stepped 0 → 1 → 2 path, a ramp whose top end opens into the level 0
  passage under the slab (drive up to it, but not up it), crates at the gaps
  in the railings of both upper levels, `volumes` on the buildings and the
  railings, respawns on all three levels and two runs of very different
  steepness. `overpass` gains the same `volumes` and its bridge crates move
  back next to the gaps in the railings.

### Changed

- Slopes are felt. `motion::drive_accel` takes the longitudinal grade:
  uphill the speed ceiling drops by `climbMaxSpeedFactor * grade` and the
  thrust loses `grade * climbGravity`, so a steep climb with no throttle
  rolls the tank back; downhill it accelerates. Off a ramp the grade is 0
  and the formula is bit-for-bit the old one.
- Falls scale with the height: `fallTime` and `fallDamage` are now counted
  per level of height instead of per fall, and `maxFallDamage` caps the
  damage of a single landing — a drop from level 2 hurts twice as much as
  one from level 1 and takes twice as long.

### Fixed

- The replica no longer reads a climb as a fall. On a ramp the level snaps
  to `z.round()`, so a frame routinely carries a `z` below the tank's own
  level — the reconciliation took that for the fall phase, and a fall locks
  the input: on the second half of every ramp the replica quietly dropped
  the throttle while the host kept it. The frame is now read as a fall only
  off a ramp run and only where the geometry has no floor of that level
  under the tank, the way the host decides it. On the demo maps this pulls
  the throttle drift from 0.083 (over the 0.06 threshold of the debug
  scenarios) down to 0.021, and the longitudinal speed drift from 33 to 7.

- Reconciliation no longer loses the level of a predicted crate. The level,
  height and fall phase of a map body now come from the raw frame the replay
  starts from (as they already did for the player's own tank) instead of the
  map config, so a crate that fell while the frame was in flight is replayed
  on the level it actually reached — and a falling one carries the engine's
  static-only mask, so it no longer bumps into tanks the host does not touch.
- A ramp can no longer be entered from the wrong side. The old gate only
  closed the top half of a run, so driving into the lower half from the
  side — or into the top end from the passage under the bridge — was a free
  ride up. The gate now judges the actual cell the tank came from
  (`prev_cell`): the entry must be a neighbour along the run's axis, through
  the end matching the tank's level. A side, diagonal or wrong-end entry
  leaves the run flat for that tank until it comes back through an end.

## [0.17.1] - 2026-09-04

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
