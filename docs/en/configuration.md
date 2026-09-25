# Configuration (game plugin)

This page covers `vimp-tanks`'s own configuration — the game half of the
contract described in the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md).
For the engine's own configuration (env vars, `hostDefaults`, master/lobby
config, ports/opcodes), see the engine's
[configuration.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/configuration.md).

`src/config/game.js` (host half) and `src/config/client.js` (client half)
are exposed to the engine through `HostPlugin.gameConfig` and
`HostPlugin.buildClientGameConfig()`; `src/config/auth.js` through
`HostPlugin.authSchema`; `src/config/sounds.js` and `src/config/snapshot.js`
feed into the client config and the snapshot codec respectively.

## src/config/game.js — the game config

Imports maps, models, and weapons from `src/data/`.

### Core parameters

| Parameter | Value | Description |
| --- | --- | --- |
| `parts.friendlyFire` | `false` | Damage to your own team |
| `parts.mapConstructor` | `'Map'` | The map constructor's name |
| `parts.hitscanService` | `'HitscanService'` | The hitscan-shot calculation service |
| `mapScale` | `0.3` | Map scale |
| `currentMap` | `'pool mini'` | The default map |
| `mapsInVote` | `4` | How many maps show up in a vote |
| `mapSetId` | `'c1'` | The default snapshot key for the map constructor |
| `coreParams.levels` | `fallTime: 0.35, fallDamage: 30, fallDamageFreeHeight: 0.5, maxFallDamage: 100, climbGravity: 500, climbMaxSpeedFactor: 0.5, levelAdoptFrames: 8, maxSideEntryRise: 0.5, rampLaunchFactor: 0.35, minLaunchVz: 0.35, maxLaunchVz: 3.5, jumpClearance: 0.45, tiltGain: 2.0, tiltAirGain: 0.12, tiltResponse: 12.0, tiltMax: 0.6, landingShake: { intensity: 3, duration: 220, minImpact: 1.5, fullImpact: 6 }` | 2.5D level rules handed to the game's Rust core as-is (the engine neither reads nor validates `coreParams`): `fallTime` is the time of ONE level of height, and `fallDamage` the price of one level ABOVE the dead zone `fallDamageFreeHeight` (`0` — falling is free): the landing costs `fallDamage · max(0, height − fallDamageFreeHeight)`, so an arc lower than the dead zone — a ramp jump — is free, while a drop of exactly one level costs `fallDamage · (1 − fallDamageFreeHeight)`. `maxFallDamage` caps a single landing, `climbGravity` is the roll-back acceleration per unit of longitudinal grade, and `climbMaxSpeedFactor` is how much a grade of 1.0 trims the speed ceiling (`[0, 1)`). The grade is DIMENSIONLESS: the engine computes it as `rise * levelHeight / span`, where `levelHeight` is the map's level height in world units (the tile size by default), so a level-per-tile climb gives 1.0 while the demo maps' runs range from 0.11 (`terraces.rampLong`) to 0.5 (`terraces.rampSteep`). `levelAdoptFrames` is how many frames in a row must hold a level ABOVE the client's replica before it adopts one (a level below is adopted at once — a late frame can only lie upwards; see `client::predictor`). `maxSideEntryRise` caps how far the ramp's height at the entry point may sit from the body's own height when it enters a run across the axis (in levels, the bound excluded). `fallTime` no longer sets a duration directly but the GRAVITY: falling is ballistic (`vz -= g·dt`), and `g` is picked so that a drop of exactly one level still takes `fallTime`. Jumping: `rampLaunchFactor` (dimensionless, `0` — no jump at all) is the share of the slope's vertical speed carried into flight when the body leaves a run's top end; `minLaunchVz` (levels/s, `0` — even a walking-pace exit jumps) is the threshold below which no flight starts; `maxLaunchVz` (levels/s) caps the take-off speed and with it the arc — `maxLaunchVz² / (2·g)`, where `g = 2 / fallTime²`, 0.375 of a level at the values above; `jumpClearance` (levels, `0` — walls vanish the instant the tank takes off) is how far above the take-off level the tank stops seeing walls and flies over obstacles. The pair is an invariant: while `maxLaunchVz² / (2·g) < jumpClearance` holds, a regular jump never reaches the clearance, so flying over walls stays a core mechanic that the shipped settings never trigger — a map that wants it raises `rampLaunchFactor`/`maxLaunchVz` of its own, and `jumpClearance` along with them (see [extending.md](extending.md)). The invariant is no longer a convention: `TanksConfig::validate()` checks it (`core/src/config.rs`), so an arc that reaches the clearance — whether from a raised `maxLaunchVz` or from a longer `fallTime`, which lowers gravity and grows the arc — is a config load error, not a silent regression. The same check refuses `maxLaunchVz < minLaunchVz`: the ceiling is applied to the take-off speed BEFORE the threshold is compared, so a ceiling below the threshold does not make jumps low, it turns them off entirely (use `rampLaunchFactor: 0` for that). Hull tilt: `tiltGain` (dimensionless, `1` — the angle equals the grade's arctangent, `0` — no tilt on a ramp) is how strongly the grade turns into an angle; `tiltAirGain` (radians per level/s, `0` — the nose does not follow the flight) tilts the nose by the vertical speed; `tiltResponse` (1/s, `0` — the hull freezes at its current angle) is how fast the hull returns to the target angle; `tiltMax` (radians, `0` — no tilt at all) caps the tilt by absolute value. `landingShake` is the camera shake on touchdown, declared exactly like a weapon's (`cameraShake` in `src/data/weapons.js`): `intensity` is the strength at a full impact, `duration` its length in ms, `minImpact` the contact |vz| (levels/s) below which the landing is soft and there is no shake at all, and `fullImpact` the |vz| that yields the full strength (anything above gives the same — `intensity` is the cap). The block may be omitted, and then a landing shakes nothing, exactly as before the rule existed. NOTE: `minImpact`/`fullImpact` numerically duplicate the `landing` block in `src/config/render.js` (hull squash, dust and sound on the client) — the client renderer and the WASM core share no source for them, so the two must always be changed together; otherwise you get a camera without dust, or dust without a camera. A flat map never touches them |
| `coreParams.surfaces` | `trackYawGain: 0.004, trackSampleX: 0.6, trackSampleY: 0.75, bodyBeltCoupling: 4.0, types: { sand, mud, water, oil, conveyor, boost }` | Surface types a map can lay on its tiles (`game.surfaces`, see [Surfaces](#surfaces-gamesurfaces)); the values are starting ones. `trackYawGain` is Δω per unit of the difference in track thrust; `trackSampleX`/`trackSampleY` place the sampling points along the hull (share of half the length) and on the track line (share of half the width), both in `(0, 1]`. `bodyBeltCoupling` (`≥ 0`, 1/s) is how hard a belt pulls a map body (crate, barrel) toward its speed: `(belt − v) · bodyBeltCoupling · dt`, plus the belt tile's `drag` if set. Per type, multipliers (neutral `1`): `accel` — thrust, `[0, 2]`; `maxSpeed` — the forward speed ceiling, `(0, 2]`; `grip` — lateral grip, `≥ 0`; `brake` — braking without gas, `≥ 0`; `turn` — turning, `≥ 0`. Additive terms (neutral `0`): `drag` — extra linear drag, 1/s; `angularDrag` — extra angular drag, 1/s (a negative one weakens the damping and gives a spin; it may not go below `−damping.angular` of any model). `slickTime` (`> 0`, seconds, optional) — the residue: after the tank drives off the type its tracks stay slick for that long, the effect fading linearly (see [core.md](core.md#surfaces-coresrcsurfacers)); without it there is no residue. The kind fields: `belt` (units/s along the tile's arrow) makes a conveyor; `boostDv` makes a boost plate and then requires both `boostMaxSpeed` (`> 0`, the speed along the arrow the push never exceeds) and `minEntrySpeed` (`≥ 0`, the lowest entry speed along the arrow) — they have no defaults, and a missing one is a load error naming the type. The boost hold is optional: `boostTime` (`≥ 0`, seconds) — for that long after the push the tank's speed ceiling is multiplied by `boostSpeedFactor` (`≥ 1`, default `1`) and the linear damping is compensated (see [core.md](core.md#surfaces-coresrcsurfacers)); without `boostTime` the plate is a one-off push. `belt` together with `boostDv`, or `boostMaxSpeed`/`minEntrySpeed`/`boostTime`/`boostSpeedFactor` without `boostDv`, is an error too. Shipped types: `sand { accel 0.6, maxSpeed 0.55, drag 1.2, turn 0.8 }`, `mud { accel 0.45, maxSpeed 0.4, drag 2.0, grip 0.9, turn 0.7 }`, `water { accel 0.7, maxSpeed 0.6, drag 1.5, grip 0.8, brake 0.8, turn 0.85 }`, `oil { accel 0.35, grip 0.08, brake 0.1, turn 1.6, angularDrag −0.5, slickTime 1.5 }`, `conveyor { belt 60 }`, `boost { boostDv 220, boostMaxSpeed 480, minEntrySpeed 20, boostTime 1.2, boostSpeedFactor 1.8 }` (to be tuned by hand). Checked by `TanksConfig::validate()`; the client gets the same section through `prediction.coreParams` |
| `coreParams.props` | `fence { hp 30, ramThreshold 60, ramDamagePerSpeed 0.5 }, crate { hp 120, damagedAt 0.5, bulletFactor 0.5, blastFactor 1.5, ramThreshold 140, ramDamagePerSpeed 0.6 }, barrel { hp 40, ramThreshold 150, ramDamagePerSpeed 1.0, chainDelay 0.15, blast { radius 70, damage 80, impulse 2500000, cameraShake { intensity 30, duration 400 } } }` | Destructible map-body types that a map assigns with `physicsDynamic[i].game.prop` (see [Destructible props](#destructible-props-physicsdynamicgameprop)); world units after `mapScale`, the values are starting ones. `hp` (`> 0`) is the body's health. `damagedAt` (`[0, 1)`, `0` — no stage) is the share of `hp` below which the body is damaged (state `1`). `bulletFactor`/`blastFactor` (`≥ 0`, default `1`) multiply the damage of a shot and of a blast. `ramThreshold` (`≥ 0`) is the impact speed along the contact normal below which ramming deals nothing, and `ramDamagePerSpeed` (`≥ 0`) the damage per unit of speed above it. `blast` (`radius > 0`, `damage`, `impulse`, optional `cameraShake`) makes the type explode when destroyed (a barrel); such a type requires `chainDelay` (`> 0`, seconds) — the fuse after someone else's blast, rounded up to whole steps and never shorter than one. Checked by `TanksConfig::validate()`; the client does not use the section |
| `roomDefaults.maxPlayers` | `8` | The bounds for the lobby's room settings: caps the limit picked by the creator (also published in `GameManifest.roomDefaults`) |
| `roomForm` | 5 field descriptors | The room-creation form's schema (published as `GameManifest.roomForm`, engine forms v3): one descriptor per `roomDefaults` key (`maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `map`), each with a `control` (`text`/`checkbox`/`select`) and `label`; no `default` — the engine seeds values from `roomDefaults`. Time bounds (`roundTime`/`mapTime`) are in ms; `map` uses `source: 'maps'` so the engine supplies choices from the map catalog. `scripts/build-game-manifest.js` adds `regExp` **and** `min`/`max` to `maxPlayers`/`roundTime`/`mapTime` from these same bounds — the engine renders `min`/`max` as a "(min–max)" hint next to the field's label and checks them client-side; the authoritative clamp stays in the engine's `applyRoomOverrides.js` |
| `scripted` | `namePrefix: 'Bot', defaultModel: 'm1'` | Scripted-participant (bot) parameters: the `Bot<id>` name prefix and the default tank model |
| `soundCues` | `roundStart, victory, defeat, frag, death: 'gameOver'` | Maps engine events to this game's sound names (`SocketManager.sendSoundCue`) |
| `initialVote` | `'teamChange'` | The vote sent to a player right after the first frame |
| `spectatorTeam` | `'spectators'` | The spectator team's name |
| `teams` | `team1: 1, team2: 2, spectators: 3` | Teams and their ids |

### Stats (`stat`)

Describes the scoreboard columns. Per parameter:

- `key` — the cell's index within a row;
- `bodyMethod` — how the table body updates (`=` — replace, `+` — add);
- `bodyValue` — the default value;
- `headSync` — sync the head with the body;
- `headMethod` — how the header updates (`#` — count of values, `=` —
  replace, `+` — add);
- `headValue` — the default value in the header.

Current columns: `name` (0), `status` (1), `score` (2), `deaths` (3),
`latency` (4). The engine's Stat mechanism writes only into columns this
schema declares — a game may omit any of them.

### Player rank/state (`playerState`)

See the engine's
[auth.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/auth.md#rank-and-state-loading-and-sync-host)
and
[host.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/host.md#player-rank-and-state-sync-stage-b4)
for the sync mechanism. This game declares the default shape of the opaque
per-player "skills" blob:

| Parameter | Value | Description |
| --- | --- | --- |
| `playerState.defaultState` | `{}` | What a participant starts with when the auth service has no saved state for them (or is unreachable on join) |

The engine treats `state` as an opaque JSON blob — only this game
interprets its shape. `rank` (a plain numeric kill-delta accumulator, ±1
per kill) has no config schema — it's just a number.

### HUD panel (`panel`)

The panel schema: `fields` — fields with string keys and default player
resource values (reset every round; they also flow into the core), `activeKey`
— the active weapon's key in panel frames:

- `fields.health` → key `h`, value `100`;
- `fields.w1` → key `w1`, `200` ammo;
- `fields.w2` → key `w2`, `100` bombs;
- `activeKey: 'wa'`.

The client-side mapping of keys to DOM elements is in `client.js`
(`modules.panel.keys`, including `t` — time and `wa` — active weapon).

### Keys (`playerKeys`)

A player's commands. Each key has a bitmask `key` (`1 << n`, used by the
predictor and the core in the input history) and an optional `type`:

- `type: 0` (default) — a repeatable action: starts on keyDown, ends on
  keyUp (movement, turret rotation);
- `type: 1` — fires once on keyDown (`gunCenter`, `fire`, `nextWeapon`,
  `prevWeapon`).

The keyCode → command mapping is set in `client.js` →
`modules.controls.keySetList`. The spectator keyset is engine-owned.

## src/config/client.js — the client half of CONFIG_DATA

Supplied through `HostPlugin.buildClientGameConfig()`, merged by the
engine's `buildClientConfig.js` with its own `clientDefaults.js`.

### `parts` — game entities

- **`gameSets`** — mapping snapshot keys to rendering classes:

  ```js
  gameSets: {
    c1: ['Map', 'MapRadar'],
    c2: ['Map'],
    m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks', 'Dust'],
    w1: ['ShotEffect'],
    w2: ['Bomb'],
    w2e: ['ExplosionEffect'],
  }
  ```

  A single key can create several entities (a tank is drawn on the main
  canvas and the radar, plus smoke, tank tracks and dust).

- **`entitiesOnCanvas`** — which canvas (`vimp` or `radar`) each class
  renders on. Entities can be subclassed and shown on different canvases
  (e.g. `MapRadar` — a simplified map for the radar).

- **`bakedAssets`** — procedural textures "baked" once at startup
  (`BakingProvider`, engine-owned mechanism): explosions, particles, smoke,
  the tank, the tank shadow, the bomb, track marks, radar
  blips. Each entry: `name`
  (texture id), `component` (who owns it), `params` (generation
  parameters). `explosionTexture`, `smokeTexture`, `dustTexture` and
  `impactParticleTexture` are baked by a single `blurredCircleTexture`
  baker and differ only by `params` (`radius`, `blur`, `quality`,
  `color`); it returns `{ texture, contentSize }`, where `contentSize` is
  the diameter of the drawn circle without the blur allowance.
  `tankShadowTexture` has a baker of its own: a blurred rounded rectangle in
  the hull's proportion (`width`, `height`, `radius`, `blur`, `color`), the
  cheapest and most readable sign of height (2.5D). It is a silhouette
  rather than a circle because a circle's soft halo stuck out from under the
  corners of a turning hull; `contentSize` here is the CRISP length of the
  shape, so the consumer normalises the scale independently of the blur
  allowance.

  `funnelTexture` bakes not one texture but a set of crater silhouettes
  (`variants`), from which `FunnelEffect` picks a random one so the mark
  never repeats. The fill is two-toned: the dark hollow (`colorFill`)
  reads on light maps, the light ejecta rim (`colorRim`, `rimWidth`) on
  dark ones. It returns `{ textures, contentSize }` with the same
  `contentSize` semantics. A `blur` above ~1/4 of `baseRadius` smears the
  blob across the whole canvas and the rim stops reading.

  `scorchTexture` and `debrisTexture` belong to `Map` (the destroyed prop,
  `parts/map/MapObject.js`). `scorchTexture` bakes `variants` blurred dark
  blobs with a darker core (`baseRadius`, `irregularity`, `blur`,
  `numPoints`, `color`, `coreColor`, `coreRatio`) — the mark of a destroyed
  prop without `game.imgDestroyed`; `debrisTexture` bakes `variants` white
  splinters (`length`, `width`, `color`) tinted per sprite by the debris
  burst. Both return `{ textures, contentSize }`.

- **`componentDependencies`** — which services get injected into which
  components (`renderer` → Map, Tank, Tracks, Smoke, Dust, Bomb, ShotEffect,
  ExplosionEffect; `assetsBase` → Map;
  `soundManager` → ExplosionEffect, ShotEffect, Bomb, Tank, Dust, Map;
  `mapDynamics` → ShotEffect; `rampRuns` → Map; `surfaces` → Dust, Tracks,
  Tank; `levelView` → Tank, Map, MapRadar,
  Smoke, Bomb, ShotEffect, ExplosionEffect, Tracks, Dust; `localPlayer` →
  Tank, ShotEffect).
  `mapDynamics` is the map-dynamics geometry from the client core
  (`toWorld(key, localX, localY)` over `ClientCore.map_dynamics_to_world`),
  handed to the pool by the plugin itself (`hooks.services`, see
  [architecture.md](architecture.md)): the shot effect keeps an anchor on a
  body and asks where that body is drawn at the moment the impact spawns. The
  service exists only with client-side prediction on — an undeclared service
  silently arrives as `undefined`. `rampRuns` is the game's service over
  `ClientCore.ramp_runs`: `forLevel(level)` gives the level's ramp runs in
  world units, and the layer draws the ramp wedge by them — the same
  geometry the physics puts its guards on, instead of a second grid walk on
  JS. `surfaces` is the game's service over `ClientCore.surface_at`/
  `surface_dir_at`: `kindAt(x, y, level)` and `dirAt(x, y, level)` tell the
  dust, the track marks and the tank what cell the tank is on (see
  [architecture.md](architecture.md)); on a map without `game.surfaces` they
  return `null` and the parts behave as before. `levelView` is the game's own service too
(`src/client/levelView.js`): where the local player is, on which level and
at which height — the local `Tank` writes it (`localPlayer`, an engine
service, is what tells it that it is the local one), and everything that has
to yield visibility to him reads it through the one shared formula
`levelView.alphaFor(level, x, y, z)` — map layers and the boxes on them, other
tanks, smoke, bombs, effects and track marks (see
[architecture.md](architecture.md)). `renderer` is what lets a part
reconstruct the camera centre (`src/client/camera.js`) for the 2.5D
projection.
`assetsBase` is the engine's
  asset base for this package: `Map` turns it into
  `${assetsBase}img/<file>` for the tile sheets and dynamic-body sprites
  it loads (see [extending.md](extending.md#new-map-image)).

### The 2.5D render: `seeThrough`, `parallax`, `volume`, `shadow`, `tilt`, `landing`

All six objects come from `src/config/render.js` and lie here as part of
the game's client config. The module is the single source: the engine hands
a part only services, never the config (`new Part(data, assets,
dependencies, context)`), so `src/client/levelView.js`,
`src/client/parallax.js` and the parts import that module directly. Editing
it changes both sides at once.

| `seeThrough` | Meaning |
| --- | --- |
| `mode` | `'hole'` — a radial hole around the player (default, GTA 2 style); `'layer'` — the whole layer above fades, the fallback path |
| `radius` | World units: the radius of the hole (`'hole'`) |
| `softness` | The share of the radius spent on the fade-out of the hole's edge |
| `minAlpha` | Opacity at the centre of the hole |
| `layerAlpha` | `'layer'` mode: opacity of the whole slab |
| `fadeRate` | Per second: how fast the transition is smoothed — an instant jump reads as blinking every time you drive under an edge |
| `roofMargin` | World units: the margin with which a roof (`game.roofs`) counts as covering the tank. `0` by default, the same rule as for walls: a larger margin reaches the roof cell while the tank merely stands next to the building, and the roof opens (its neon dims) without covering anything |
| `lowerTint` | Tint for levels **below** the player: "darker means lower" |

| `parallax` | Meaning |
| --- | --- |
| `shear` | How far an object shifts away from the camera centre per level of height, as a share of the distance to it, AND how much larger it is drawn (`1 + z * shear`) — the shift and the scale are one projection. ONE number for every consumer — the level layer and its volume, the ramp wedge, the tank hull and wreck, the track marks, the engine smoke, bombs and effects: a tank on the level-1 slab has to move exactly with the slab. See `src/client/parallax.js` |
| `levelZStride` | The `zIndex` stride between levels (`src/client/levelZ.js`). It has to exceed every part's base `zIndex`, otherwise the bridge layer sinks below a ground-level canopy |

| `volume` | Meaning |
| --- | --- |
| `enabled` | `false` switches layer extrusion and the ramp wedge off entirely — the fallback path on a weak machine |
| `faces` | `true` (default) draws a volume as one solid piece: the side walls as a mesh (one quad per exposed cell side, inner edges skipped) plus a single copy of the layer at the top height. A wall does NOT sample the layer's baked picture — every tile gets its own side texture, a strip of `faceTileRepeats` copies of its image stacked vertically. The tile spans the wall once across and as many copies down as the wall's depth from the camera calls for (measured along the face's normal, so the courses of brick stay parallel along a straight wall instead of fanning out), so bricks come out the same size on every wall. `false` falls back to the stack of `slices` copies, whose steps show at the screen edge and with the camera zoomed out |
| `faceTileRepeats` | Copies of the tile in a side texture's strip. A wall takes as many of them as it covers on screen, which is what keeps the brick size even; the strip is finite, so the longest walls stretch its last copy. Hardware texture repeat is not used — a batched mesh clamps the coordinates instead, which smeared the tile's edge column into horizontal stripes. Costs one `step × step·N` texture per volume tile |
| `faceBleedPx` | How far, in SCREEN pixels, a side wall reaches above the volume's top. The top is a sprite and the wall is a mesh, so at a fractional stage scale a one-pixel crack opens between the two rasterisations and the seam flickers; the overlap hides under the top, which is drawn later. Screen pixels rather than world units because the engine zooms the camera out with speed — a world-sized margin stopped covering the crack once the camera pulled back. `0` brings the flicker back |
| `slices` | With `faces: false` — the number of layer copies, i.e. `slices` draw calls per layer; unused with `faces: true`, but `0` still turns extrusion off. Layer VOLUMES only (buildings, railings) |
| `rampSegments` | Ramp-wedge segments per run cell. The wedge is a slope (one mesh per run); this is its vertex density: the shift along the run grows quadratically, and at 4 segments per cell the polyline is indistinguishable from it |
| `sideTint` | Tint of the side walls of a volume (or its lower slices) and of the ramp wedge's skirt |

| `shadow` | Meaning |
| --- | --- |
| `scaleGain` | How much the shadow grows per unit of RISE above the support. Growth and fading count only in flight — the sign of a jump or a fall — so a jump on the upper deck looks exactly like the same jump on the ground |
| `baseAlpha`, `alphaFalloff` | The shadow's opacity on the support and how fast it fades as the rise grows |
| `sizeFactor` | The shadow's size as a share of the hull LENGTH: the texture is already in the hull's proportion, so at the start of a jump the shadow lies exactly under the hull and never peeks out |
| `groundOffset` | World units: the shadow is shifted AWAY from the light (`tilt.lightDir`, in screen axes, so it does not turn with the hull). The shift lets the shadow stay under a parked or driving tank and give the hull volume: it peeks out on one side, like the shadows of buildings. Without a shift it would lie exactly under the hull as a grey halo, so `0` restores the shadow only in flight |
| `groundAlpha` | The shadow's opacity under a tank on the ground (in flight `baseAlpha`/`alphaFalloff` apply). A wreck has no shadow |

| `tilt` | Meaning |
| --- | --- |
| `enabled` | `false` restores the old flat hull sprite: the tilt is not drawn at all (the host still computes the angles and carries them) |
| `lift` | The on-screen rise of the raised edge of the quad, as a share of its height: this turns the authoritative `pitch`/`roll` into `PerspectiveMesh` corners (`src/client/tilt.js`) |
| `vertices` | The `PerspectiveMesh` grid density along each axis |
| `shading` | The light-and-shade of the tilt: how far the hull's brightness swings at the maximum tilt. `0` — no shading, the picture as before |
| `lightDir` | Light direction in SCREEN space (not the hull's): `[x, y]`, normalised on read. The default is light from the north-west — the same way the side faces of buildings are lit |

A live tank is a low-poly 3D model (`src/client/tank3d/`): tracks, a hull
with sloped sides and a front plate, an octagonal turret, a barrel with a
muzzle brake. Heading, `pitch`/`roll`, turret rotation, recoil, the blast
jolt and the landing squash move it as a rigid body instead of skewing a
flat picture; every face is lit by its own normal (`faceShade`, the
`tankLight` formula). It is drawn almost from above: the map projection
(`shear` per level) would stretch the sides at the screen edge longer than
the hull — that is why the old slice extrusion (`body`, `bodySlices`,
`sideTint`) was removed — so the lean away from the screen centre is ONE for
the whole tank, weakened and smoothly capped (`leanGain`, `maxLean`). The
wreck is the same model with a burnt atlas and a knocked-askew turret.

| `tankModel` | Meaning |
| --- | --- |
| `enabled` | `false` — the flat hull (`PerspectiveMesh` with normal maps and `tilt.lift`) as before |
| `trackHeight`, `hullBase`, `hullTop`, `turretBase`, `turretTop`, `barrelHeight`, `barrelRadius`, `brakeRadius` | Part heights in pixels of the hull art (40 × 30 at base size 10); the plan shape comes from the art itself (`tankTexture.js`), everything scales by `size / 10` |
| `levelHeight`, `leanGain`, `maxLean` | World units per level for the lean away from the screen centre, the share of the map's lean the model takes (weak on purpose: the camera leads the tank at speed, and a building-like lean made the turret slide at every acceleration), and a smooth cap on how far the model's top point moves, world units |
| `shadowBlur` | Softness of the silhouette shadow (blur strength, `0` — sharp). The shadow is the model's silhouette cast along the light (`tilt.lightDir`, `tankLight.lightZ`): every part casts its own, the turret and barrel included, and tilt and lift show in it. Opacity — `shadow.groundAlpha` on the ground, `shadow.baseAlpha`/`alphaFalloff` in the air; the wreck casts none. Without the model the rectangular shadow sprite is used |

Faces are textured from the `tankModelTexture` atlas: tops and slopes map the
same art as the flat texture by (u, v), vertical sides of the tracks, barrel
and brake have their own strips.

| `tankLight` | Value |
| --- | --- |
| `enabled` | Lights the hull, turret and wreck by the normal maps baked next to the tank textures (`src/client/tankLight.js`): bevels facing the light get brighter, bevels facing away get darker. The light is `tilt.lightDir`, in SCREEN axes, so the lit side stays north-west whatever the heading; the normal also follows `pitch`/`roll`, so the tilt shading of `tilt.shading` is not applied on top. A flat level top keeps a factor of exactly 1. A mesh with its own shader is not batched: +3 draw calls per tank. `false` — the batched mesh and `tilt.shading`, as before |
| `ambient`, `diffuse` | Ambient and directional shares of the light: the lower `ambient`, the darker the faces turned away |
| `lightZ` | Height of the light above the map plane relative to the length of `lightDir`: lower — a grazing light and more contrast |

| `tracer` | Meaning |
| --- | --- |
| `speed`, `minDuration`, `maxDuration` | Speed of the tracer head (world units per second) and the bounds of its flight time, ms |
| `trailLength`, `trailShare` | Longest visible tail: at least `trailLength` world units and at least `trailShare` of the whole ray. The tail grows straight from the muzzle (no gap) and shrinks towards the target at the end of the path. The share is for long shots: the flight is capped by `maxDuration` (about 5 frames), the head covers hundreds of units per frame, and a short tail hung far from the barrel, usually off-screen |
| `color`, `coreColor`, `coreWidth`, `glowWidth`, `glowAlpha` | A solid line, film-like rather than a cartoon beam: a thin white-hot core over a narrow dim glow in the warm colour of burning tracer phosphor, drawn additively (the tracer is light, not paint) |
| `alphaStart`, `alphaEnd` | Head opacity at the start and at the end of the path |
| `fadeSteps` | Tail sub-segments. The tail fades towards the muzzle quadratically: the brightness sits at the head, like a point smeared by motion, not an even stripe |

| `muzzleFlash` | Meaning |
| --- | --- |
| `duration` | Flash length, ms — one or two frames, like a real muzzle flash. Visible by day as well; the night light flash is `lighting.flash.shot`. When the muzzle and the end of the ray are on different levels, the flash is moved onto the barrel's own projection |
| `spikes`, `length`, `width`, `spread`, `jitter` | Irregular flame tongues forward: how many, length and base width (world units), angular spread around the shot (rad) and the length spread (share). Angle and length are random per shot and fixed for its lifetime — the shape does not flicker |
| `sideLength`, `sideWidth` | The two side jets of the muzzle brake (also with a random length) |
| `layers` | Soft edge without textures: the same tongues drawn in layers `{ scale, alpha, core }` — wider and dimmer outside, narrower and brighter inside; `core` — the layer in `coreColor` |
| `shrink` | The flash fades rather than shrinks: brightness falls quadratically, the size only by this share |
| `color`, `coreColor` | Flame and core colours, the same as the tracer's (additive) |

| `blastJolt` | Meaning |
| --- | --- |
| `enabled` | Visual reaction of a tank to a bomb or barrel explosion (`src/client/blastJolt.js`): render only, the push itself is the core's. Tanks on the same level inside the blast radius react with strength `1 − d / radius`, like the damage; a wreck reacts too. `false` — explosions do not visibly touch tanks |
| `rock`, `wobbleHz`, `decay`, `duration` | The side facing the blast rises by `rock` rad (at strength 1), then the hull rocks at `wobbleHz` and settles within ~`decay` ms; `duration` — when the reaction ends. A weaker blast does not cancel the rocking of a stronger one |
| `hop`, `hopDuration`, `underShare` | A blast under the hull (closer than `underShare` of the hull length to its centre): the hull is tossed up by `hop` levels over `hopDuration` ms — over its shadow, larger by the height projection — with a random tilt, then lands with the `landing` squash |
| `shake`, `shakeDuration` | A short shake of the hull by up to `shake` world units, fading over `shakeDuration` ms |

| `recoil` | Meaning |
| --- | --- |
| `enabled` | Visual recoil after a `w1` (hitscan) shot (`src/client/recoil.js`): render only, the tank does not move physically. `false` — a shot does not touch the tank |
| `duration`, `attack` | Full length in ms and the share of it spent on the fast rise; the rest is a quadratic return. A shot during the return puts the recoil back at its peak, so held fire keeps the gun pulled back instead of jittering |
| `gunKick`, `bodyKick` | World units: how far the turret with the gun and the hull move back along the gun |
| `rock` | Radians: how much the side the gun points to rises (added to `pitch`/`roll`, so the normal-map light rocks too). The wreck gets no recoil |

| `landing` | Meaning |
| --- | --- |
| `minImpact` | The \|`vz`\| threshold at touchdown (levels/s) below which a landing counts as soft: no squash, no dust, no sound |
| `fullImpact` | The touchdown speed that gives the full squash; anything above is clamped to it |
| `squash` | The maximum vertical compression of the hull, as a share (0.14: 0.22 read as the tank folding up on every jump — the squash has to be visible without changing the silhouette) |
| `duration` | How long the squash and the recovery take, ms |

The height of one level in world units is a **map** field, not a render
constant: `levelHeight` (see [extending.md](extending.md)). It is a
**physics** quantity — the core makes the ramp grade and the fall out of it
— and the renderer does NOT read it: the vertical scale of the picture is
`parallax.shear` alone, and it is deliberately map-independent, otherwise
layers of different maps would read differently from one another. A map with
an unusual `levelHeight` therefore climbs differently but looks the same.

### Night and lighting: `lighting`

`src/config/render.js → lighting` (also exported from `src/config/client.js`)
configures the `lighting` service (`src/client/lighting/`), the headlights
of `Tank` and the flashes of `ExplosionEffect` and `ShotEffect`. A map turns
night on with `game.lighting` ([below](#night-lighting-gamelighting)); how it
is drawn — [architecture.md](architecture.md#lighting-night).

| `lighting` | Meaning |
| --- | --- |
| `enabled` | `false` switches the system off entirely, night maps included: no overlays, no sources, `addEmissive` returns `false` |
| `resolution` | Resolution of a level's light map relative to the screen (`0.5` by default). The map itself covers the map area plus a margin of its longer side and is clipped to the screen, so a window resize or a camera far from the map origin does not change it |
| `maxLights` | Cap on visible sources per frame, after screen culling |
| `headlights` | Two cones per live tank: `length` (world units), `spread` (half-width at the far end as a share of the length), `intensity`, `color`, `offset` (headlight offset from the hull axis as a share of the hull half-width). The headlights have no glare sprite of their own. `occlusion` — walls stop the light: `enabled` (`false` — the old cone through walls), `rays` (rays of the visibility fan). `bounce` — the light bouncing off a wall: a spot on the floor in front of the point where the headlight axis hits a wall no farther than `maxDistance`; `intensity` (share of the headlight, fading towards `length`; `0` — no bounce), `radius` (world units). Each spot is one more source against `maxLights` |
| `rampSpill` | Light of an upper level on the ramps leading up to it (`0..1`, `1` by default): the headlights of a tank on the slab and lamps near the top of a ramp light its wedge, clipped to the wedge so the ground under the bridge stays dark. `0` — ramps catch no light from above |
| `tankGlow` | A faint light under every live tank so enemies stay readable: `radius`, `intensity`, `color` |
| `flash.explosion`, `flash.shot` | Short flashes: `radius`, `intensity`, `duration` (ms), `color` |
| `glints` | Glint: an additive highlight on the side of a tank or prop facing the strongest source at it — a lamp, another tank's headlight or a flash (a tank's own headlights and every tank glow do not count). `enabled`, `intensity` (multiplier of the source's strength at the point), `size` (highlight size as a share of the object's size). The gradient is clipped by the object's silhouette; at most `maxLights` glints per tick, off-screen objects get none |
| `shafts` | Light shafts in the air around every lamp with `head: true`, drawn additively into the lamp level's light map: `enabled`, `rays` (rays baked into the texture), `length` (shaft radius as a share of the lamp radius), `intensity`, `shadows` (tanks and props in the shafts cut dark wedges out of them), `maxShadowCasters` (nearest shadows per lamp). At most `maxLights` lamps with shafts per frame |

Baked textures (`parts.bakedAssets.vimp`): `lightRadialTexture`,
`lampHeadTexture`, `glintTexture` and `lightShaftTexture` (component `Map`),
`headlightConeTexture` (component `Tank`); `Tank` takes the glint texture
from the service (`texture('glint')`). The engine hands a baked asset to one component only, so the
service receives them through the parts (`registerTextures` merges a partial
set); the head texture draws the lamp heads.

A source lands only in the light map of its `level`. A source may also carry
`levels: number[]`, which puts it into every listed level's map, with a single
projection by `z`. `maxLights` counts each placed sprite. `Tank` uses this on
a ramp: while the ground under it is fractional (`0 < z`, not a whole level,
`vz = 0`), its headlights and glow light both `floor(z)` and `ceil(z)`. The
ramp wedge is darkened by the lower level's overlay, and the slab the beam
reaches by the upper one. Otherwise the level is the render level
(`lightLevels` in `lightMath.js`).

Roofs (`game.roofs`, [below](#roofs-gameroofs)) get a light map of their own
per level, with the same sources as the level's ordinary map; the ordinary
floor mask leaves roof cells out. Its hole opens only while a roof covers the
drawn point of the local tank, not whenever the player is lower. A level's
map also covers the tops of its volumes: over the sources it draws the cells
of every volume tile in the projection `(L + volume) · shear` in `ambient`.
Headlights of a tank on the ground still light the side walls, but not the
top of a building.

The service (`componentDependencies.lighting`: `Map`, `Tank`,
`ExplosionEffect`, `ShotEffect`) exposes `enabled`, `attachStage`,
`acquireMap`/`releaseMap` (per-key counter, owner-bound mask),
`setLevelMask` (with `{ roof }`), `setVolumeTops`, `setRampWedges`, `registerTextures`, `texture`,
`addLight`/`updateLight`/`removeLight`, `flash`,
`addEmissive`/`removeEmissive`, `isNight`, `lightsAt` (the strongest
sources at a world point of a level — lamps through a cell grid, cones,
flashes), `onScreen`, `setCaster` (an object casting a shadow in the
shafts) and `render`.

### Animations: `animations`

`src/config/render.js → animations` (also exported from
`src/config/client.js`) drives the client-only animated map elements: the
tiles of `game.animatedTiles`, the decals of `game.decals` and the neon
flicker of `game.signs` ([below](#animated-elements-gameanimatedtiles-gamesigns-gamedecals)).
The host knows nothing about them.

| `animations` | Meaning |
| --- | --- |
| `enabled` | `false` — animated tiles and decals stay on frame 0 and neon does not flicker; nothing is updated per tick (a night sign still follows the camera) |
| `maxFps` | Cap on how often frames change (`30` by default): the animation time is quantized to `1 / maxFps` |

### Surface effects: `surfaceFx`

`src/config/render.js → surfaceFx` — how the cell surfaces look under a tank
(`Dust.js`, `Tracks.js`). What surface a cell has comes from the core (the
`surfaces` service); a map without `game.surfaces` never reads these numbers.

| Key | Meaning |
| --- | --- |
| `sand`, `mud`, `water` | Continuous emission while driving: `color`, `rate` (particles per second per track at `fullSpeed`), `fullSpeed`, `minSpeed` (no emission below it), `lifetime` (`{min, max}`, ms), `sizeFactor`, `alpha`. Sand gives frequent light dust, mud short-lived large dark clods, water blue spray to the sides of the tracks |
| `water.sideSpeed`, `water.entryBurst`, `water.entryMinSpeed` | The spray's lateral speed; the one-off splash on entering water: particles per track and the entry-speed threshold |
| `water.sound` | The `tankWater` splashing loop (`Tank.js`): `minVolume` — the share of `volume` a tank standing in water is heard at, `fullSpeed` — the speed (world units/s) at which it plays at full `volume`, `rate` (`{min, max}`) — playback rate from standstill to `fullSpeed` |
| `boost` | The one-off tail flash when a boost fires: `color`, `burst`, `lifetime`, `sizeFactor`, `alpha`, `tailSpeed` (thrown against the arrow) |
| `boost.boostMinSpeed` | A visual copy of `coreParams.surfaces.types.boost.minEntrySpeed`: the render and the WASM share no source, and a mismatch only costs an extra or a missed flash |
| `boost.resetDistance` | A per-frame position jump (world units, ~2 map cells) after which the part does not compare cells and only remembers the current one — a teleport or respawn of one's own or another tank |
| `tracks.oil`, `tracks.mud` | Track marks on the surface: `alpha` and `lifetime` multipliers and the mark's `tint`. Oil leaves dark, denser, long-lived marks; mud darker ones. `trail` (seconds, oil `1.5`) — after driving off the surface the tank keeps leaving its marks on plain cells that long, their alpha fading linearly; the timer is the part's own (remote tanks' core residue is not visible to the client) |
| `tracks.noMarks` | Surfaces that leave no marks at all (`water`) |

Oil raises no dust at all, not even when the tracks spin. The boost flash
follows the core's entry rule (`surface::boost_dv`): the hull centre is on a
`boost` cell with arrow `dir`, the previous frame's cell is not a boost with
the same `dir`, the speed along the arrow is `≥ boostMinSpeed`, the tank is
not airborne. Moving between cells of one plate gives no flash; the first
frame of a part, a respawn (`condition` 0 → alive) and a jump beyond
`resetDistance` only remember the cell. The engine's camera-reset flag is not
used: the engine consumes it in the canvas model and the parts never see it.

### `modules.controls.keySetList`

An array of two `keyCode: 'command'` sets: `[0]` — spectator (`n`/`p` —
switch the watched player, engine-owned set), `[1]` — player (`w/s/a/d` —
movement, `k/l/u` — turret, `j` — fire, `n/p` — weapon switch). Which set
is active is dictated by the host over port `17` (KEYSET_DATA).

### Texts and schemas

- **`chat.messages`** — system message templates: groups `s`
  (status/commands, engine), `v` (votes, engine), `m` (maps, engine), `c`
  (teams, engine), `n` (names, engine), `b` (bots, this game). The host
  only sends `'group:number:params'`, the client assembles the text.
- **`panel.fields`** — the typed field schema: an ordered list of
  `{ name, elem, type: 'bar'|'value'|'time'|'weapon', max?, blocks? }` —
  the engine's `PanelView` generates the panel DOM and rendering behavior
  from the types, not from field names.
- **`stat.heads`/`stat.bodies`/`stat.sortList`** — scoreboard table
  templates and sort parameters (an array of `[cell index, descending?]`
  pairs; on a tie, comparison moves to the next pair).
- **`vote.templates`** — `[a title with {0} placeholders, options (an
  array — static, a string — request the list from the host), timeOff]`.
  `menu` — the main vote menu's items.
- **`gameInform.list`** — templates for on-screen game messages.
- **`initIdList`** — which modules/canvases to initialize at startup
  (`vimp`, `radar`, `panel`, `chat`); the initialization mechanism itself
  is engine-owned.

The full engine/game ownership table for every CONFIG_DATA field lives in
the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md#clientplugin-api).

## src/config/auth.js — auth form config

Arrives via `HostPlugin.authSchema`: DOM element ids (`elems`), form
parameters (`params`), this game's validators (`validators`), and the
form's texts (`texts`: `title` + help `sections` of
`{ heading, lines: [{ keys, text, last? } | { separator }] }`) — the
engine's `auth.pug` template is a neutral shell (title, help sections, a
`Start` button, no `name` field: the nick comes from the verified lobby
identity token, not the form), `AuthView` fills in this game's title and
help sections from `texts`. `elems` points at `fieldsId: 'auth-fields'`,
the container the engine renders `params` controls into (engine forms v3;
there's no `formId` — the engine owns the `<form>` element). `params`
declares only this game's own field, `model` (a default value, `options`:
`control: 'select'` + `label: 'Model'` + the list of choices from
`models.js`, `validator: 'isValidModel'`, a `storage` key for
localStorage) — there's no field using the engine's `isValidName`.
`control` is required per field under engine forms v3: a field with an
`options` object but no `control` is silently dropped (`console.error` +
skip in `formBuilder.buildForm`), not a build error. `isValidModel` (the
model exists in `models.js`) is injected into the engine's `validateAuth`
as the third argument. Validation runs on the client (with validators from
this game's bundle) and is repeated by the host (Worker) as the actual
authority; only `elems`/`params`/`texts` travel over the wire (`AUTH_DATA`,
port 1) — the validator code doesn't.

## src/config/sounds.js — sound catalog

Each sound: `file` (the filename without an extension, served from
`dist/sounds/` under this plugin's `assetsBase`), `priority` (higher wins
when voices compete), `volume`, optionally `loop: true`.
`codecList: ['webm', 'mp3']` — files must exist in both formats. Playback
mechanics — the engine's
[client.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/client.md#soundmanager).

Surfaces have no sounds of their own yet: the splash and boost sounds are
postponed until there are source files for them (reusing `hit`/`explosion`
would read as a shot). Mud is still heard — the host's higher `engineLoad`
already raises the engine's pitch in `Tank.js`.

`volume` is read against **normalized** sources. `scripts/process-audio.js`
used to pass `-af` once, and since that is an *output* option it filtered
only the file that followed it — the mp3, which in practice is the Safari
branch. The webm every other browser picks went through unfiltered and was
spread over 11 LU (the engine loop was the quietest thing in the set, the
explosion 11 LU above it). Both outputs now carry the filter chain, so every
sound sits at `I = -16` LUFS and one `volume` number means the same thing in
every browser; `npm run audio:check` measures `build/sounds/` and fails when
the two codecs of one sound disagree by more than 1 LU. The current values
were rescaled by the measured per-file difference, so each sound is as loud
as it used to be — the relative mix is unchanged and is tuned by ear.

The engine loop (`src/client/parts/Tank.js`,
`calculateEngineSoundParams`) reads `engineLoad` twice over: as pitch
(`rate`, from `MIN_ENGINE_RATE` at idle to `MAX_ENGINE_RATE` at full speed
and up to `STRAIN_ENGINE_RATE` under strain — gas into a wall) and as volume
(`MIN_ENGINE_VOLUME_FACTOR` → `MAX_ENGINE_VOLUME_FACTOR` of the `volume`
above). At idle the pitch also wobbles slightly (`IDLE_WOBBLE_DEPTH`,
`IDLE_WOBBLE_HZ`), fading out as the load grows: a bass tone held at a fixed
pitch reads to the ear as a hum rather than as a running engine. `volume` is
therefore set for the moving tank; the standing one is `0.6` of it.

`tankLanding` is the hull hitting the slab. It is fired not by the engine's
event mapping (`soundCues` in `src/config/game.js`) but by the `Dust` part
itself (`registerSound`/`playSound`): a landing is visible in the frame as
`vz` rather than as a host event, and it sounds for every tank, not only for
your own. The volume follows the impact, and a soft landing (below
`landing.minImpact`) stays silent.

`tankWater` is the splashing loop under the tracks. The `Tank` part
registers it while a live tank stands or drives on a `water` cell (the
`surfaces` service) and is not in flight, and removes it on leaving the water,
on death and on `destroy`. Volume and pitch follow the tank's speed
(`surfaceFx.water.sound`); one's own tank is heard non-spatially, like its
engine. The spray itself is drawn by `Dust`, the sound lives only in `Tank`.

The `spatial` block overrides the engine's spatial-sound geometry, and only
what this game has to override: `mode: 'topDown'`, `virtualElevation: 108`,
`innerRadius: 7.5`. The engine's own defaults (`180` / `40`) are calculated
for a 1:1 scale, and here a **world unit is not a screen pixel**:
`mapScale: 0.3` (`src/config/game.js`) with `baseScale: '5:1'`
(`src/config/client.js`) makes one world unit five screen pixels, so the
defaults would spread the stereo base over five screen widths and treat a
radius of five tank hulls as "inside the player". `108` is half the visible
screen height in world units (`1080 / 2 / 5`); at the edge of the screen
(`192` units sideways) that is an angle of about 60°, next to the hull — a
few degrees. `7.5` is the half-diagonal of the `m1` hull, which is `12 x 9`
world units (`size * 4 x size * 3` at `size: 3` in `src/data/models.js`), so
an explosion inside the hull is split evenly between both ears.
`refDistance` / `maxDistance` / `rolloffFactor` are deliberately left to the
engine.

Both numbers are calibrated for the **design window, 1920×1080**; on any
other window size the engine scales them itself through the scene scale, so
they need no per-resolution variant. `108` is still the calculated starting
point: the audible range to tune it in is 90–150, and nothing has confirmed
the exact value by ear yet — treat it as a defensible default, not as a
measured one. What the keys mean and how the position is computed —
[client.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/client.md#soundmanager).

The local player's own tank is registered with `spatial: false`
(`src/client/parts/Tank.js`), and so is the local player's own shot
(`ShotEffectController`). The listener is the camera centre, i.e. the local
tank itself: a source lying exactly on the listener is not silence for HRTF
but comb colouring — a hum instead of an engine — and a two-pixel gap
between camera and tank throws the same source fully into one ear, because
the Web Audio azimuth follows direction, not distance. Everything else stays
in the world and pans normally.

`propBreak` is a destroyed prop (a fence, a crate): the `hit` file, quieter
and at a lower priority, so the shot that broke the fence is heard over the
crack. It is fired by the `Map` part itself (`MapObject`) on the transition
to `state = 2` — not on the first frame of a prop that is already destroyed.
A barrel's explosion sounds as `explosion` through `ExplosionEffect` (its
`w2e` row).

## src/config/snapshot.js — the snapshot key schema

Registered as `HostPlugin.gameConfig.snapshot`: `m1`, `w1`, `w2`, `w2e`,
`c1`, `c2` → a numeric id + `kind`, which drives the block's byte layout
(the engine's schema-driven packer/unpacker, see
[core.md](core.md)). An unregistered key breaks frame packing.

The tank row (`m1`) carries 16 fields; its tail is `angvel`, `z`, `level`,
`vz`, `pitch`, `roll`. `z` is the visual height (`f32`, `interp: 'lerp'`: a
ramp climb and a flight must look smooth), `level` the discrete 2.5D level
(`u8`, not interpolated), which switches the zIndex and the collision set.
`vz` (`f32`, `interp: 'discrete'`) is the vertical speed in levels per
second, zero on the ground: the client reads flight and impact strength off
it, and the local tank's replica reads the phase of the arc (one height
answers both the rise and the descent, so it cannot be recovered from `z`).
It is the one `f32` field of `m1` that is not interpolated, and
deliberately so (the `u8` fields — `condition`, `size`, `team`, `level` —
declare no `interp` at all: the engine's default is already `'discrete'`):
the touchdown detector (`src/client/landing.js`) fires on the frame where
`vz` becomes exactly zero, and a smoothed value never gives another
player's tank that exact zero — the squash, the dust and the landing sound
of everyone but yourself would be lost. `pitch`/`roll` (`f32`,
`lerp`) are the hull tilt in radians, computed by the host because nothing
else can tilt another player's tank. That tail's width and order are a
positional contract with three places at once: `TankRow::fields` and
`players_json` in the host core, and `render_overlay` in the client core.

The 2.5D level travels with the shot blocks as well: the tracer (`w1`)
ends with `startLevel`/`endLevel` — the level the ray started at and the one
it ended at (they differ where the ray drops off a ledge) — while the bomb
(`w2`) and its explosion (`w2e`) each carry a `level`. The client could
derive all four from its own copy of the layers, but then the picture would
depend on one more repeated algorithm; four bytes are cheaper.

The dynamic map row (`c1`/`c2`) is `[x, y, angle, z, level, state, vx, vy,
angvel]`, and `z`/`level` must declare `role: 'z'` and `role: 'level'`:
the engine recognises a layered row by its ROLES, not by field names (the
name belongs to the game), and a role without its pair fails the map load
instead of silently falling back to a flat row. The height and the level
sit in the HEAD rather than the tail,
because a resting body ships no tail at all and the level would read as
zero — a crate on the bridge would "fall" to the ground for the viewer.
`state` (`u8`, `role: 'state'`, capability `map.bodyState`) is the map
body's state byte: the engine writes it at the role's position, its meaning
belongs to the game. For now it is always `0` (intact). It sits in the head
for the same reason as the level.
`optionalFrom: 6`: a dynamic map element ships `[vx, vy, angvel]` only
while it moves, so a resting crate costs 12 bytes less per frame (decoding
still yields the full nine-field row, the missing tail as zeros). Full
mechanism — the engine's
[network.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/network.md#binary-snapshot-frame-port-5).

## src/data/ — game data

### models.js

The only model — the `m1` tank: the `Tank` constructor, starting weapon
`w1`, size (`size: 3`, dimensions `size×4 : size×3`, that is 12 × 9 world units), motion parameters
(acceleration/braking, `maxForwardSpeed: 260`, `maxReverseSpeed: −130`,
turn torque, damping, lateral grip), physics (`density`, `friction`,
`restitution`), "driving feel" (throttle/turn thresholds and rates), and
the turret (`maxGunAngle: 1.4` rad, rotation/centering rates).

`brakingFactor: 0.3` is the braking coefficient: the higher it is, the
sharper the tank stops. The value is deliberately low — the tank body is
built with predictive contacts (see [core.md](core.md#tank-body)), so
braking no longer has to compensate for contact errors.

> ⚠️ The `models.js` coefficients are used both by the core's
> authoritative path and by the client prediction replica
> (`core/src/client/predictor.rs`, formulas shared through
> `core/src/motion.rs`). Changing them requires the cargo parity check:
> `npm run core:test`.

### weapons.js

Two architecturally different weapon types:

| | `w1` (bullet) | `w2` (bomb) |
| --- | --- | --- |
| Type | `hitscan` — an instant ray, no physical projectile | `explosive` — a physical `Bomb` projectile in the Rapier world |
| Damage | 40 | 70 at the epicenter, 50 blast radius |
| Range | 1500 units | — (detonates on a `time: 300` ms timer) |
| Cooldown | 0.01 s | 0.1 s |
| Other | `spread: 0`, costs 1 ammo, hit impulse `7500000` (independent of `range`) | `size: 8`, explosion impulse `2000000`, effect `w2e` |
| Camera shake | 20px / 200ms | 30px / 400ms |

### maps/

Six maps: `pool mini` (small), `canopy`, `garden`, `overpass` (the two-level
2.5D demo), `terraces` (the three-level one) and `downtown` (the night city —
the reference for the `game` fields: surfaces, props, lighting, animated
tiles, signs and decals). Each describes tile layers (`layers`, `tiles`), respawn points
(`respawns`), static (`physicsStatic`) and dynamic (`physicsDynamic`)
physics. Registration — `src/data/maps/index.js`. How to add a map — see
[extending.md](extending.md#new-map).

#### The 2.5D fields (`levels`, `ramps`)

The format is additive: `map` / `physicsStatic` / `layers` stay level 0, so
a map without the fields below loads exactly as before. `overpass.js` is the
two-level reference: ground plus a through overpass with railings, two ramps
and two gaps in the railings. `terraces.js` is the three-level one: a terrace
(level 1) with an upper platform (level 2) over it, a 0 → 2 ramp climbed in
one run, a stepped 0 → 1 → 2 path, a ramp whose top end opens into the level 0
passage under the slab, crates at the gaps in the railings of both levels and
`volumes` on the buildings and the railings.

| Field | Meaning |
| --- | --- |
| `levels` | Upper levels, key — the level number as a string (`1`). `MAX_LEVELS = 8`, so `"1"`..`"7"`; levels must run from 1 without gaps |
| `levels[n].map` | The level's own grid, **the same dimensions** as `map`. `0` is emptiness — no level here, the one below shows through |
| `levels[n].floor` | Tiles you can drive on at this level (the slab). A railing tile belongs here too |
| `levels[n].walls` | Wall tiles of the level (railings): they block movement and the ray at this level and screen the slab edge from a shot from below. Every `walls` tile must also be in `floor` — the core rejects the map otherwise |
| `levels[n].layers` | Render layers of that grid (`zIndex` → tiles), the same base values as level 0; the renderer shifts them by `LEVEL_Z_STRIDE = 100` itself |
| `ramps[]` | Transitions: `{ tile, dir, from, to }` — the tile index in the `from` level's grid, and `dir` (`north`/`south`/`west`/`east`) is the direction you drive **to climb** |
| `physicsDynamic[].level` | The level a box stands on (`0` by default). Bodies of different levels never touch |
| `game` | Optional, the game's own map data (capability `map.gameData`): the engine stores it as raw JSON and the core parses it on both sides (`core/src/map_game.rs`). Unknown keys are ignored. The core reads `game.surfaces` (see [Surfaces](#surfaces-gamesurfaces)); the client reads `game.lighting` (see [Night lighting](#night-lighting-gamelighting)). `downtown.js` is the reference |
| `physicsDynamic[].game` | Optional, the game's data of a map body (`{ prop, imgDamaged, imgDestroyed }`, see [Destructible props](#destructible-props-physicsdynamicgameprop)); `downtown.js` is the reference |
| `volumes` / `levels[n].volumes` | Optional, **visual only**: `zIndex of the render layer` → its height in levels. A layer with a height is extruded by `Map` itself and shifts as the camera moves; the engine validates the value and passes it to the part in `data.volume` |
| `levelHeight` | Optional: **world units per level** (before `scale`), the tile size by default. One number that makes the ramp grade dimensionless in the core (physics only — the client no longer computes a grade); the part receives it as `data.levelHeight`, and the engine validates it (`vimp-engine >= 0.32.0`) |
| `respawns[team][i][3]` | Optional 4th element of a respawn point — the level. Without it the level is derived from the geometry (`GameMap::level_at`), i.e. a ground point that happens to sit under the slab would spawn the tank **on** the bridge |

A ramp is a directed run of level-0 tiles: the core groups equal tiles into
runs along the ramp axis and interpolates `z` from `from` to `to` along the
run (`MapLevels::build`). The level flips at the halfway point of the run,
and while a tank's centre is on a ramp cell it collides with **both**
levels' geometry, so the flip pushes nothing.

The core validates all of this when the map loads (`MapConfig::validate`)
and refuses a map with mismatched grid dimensions, a gap in the level
numbering, a railing outside `floor`, a ramp tile missing from its grid or a
level number out of range in `respawns`/`physicsDynamic`. Structural checks
of the same kind run offline as contract rule `E4` (`vimp-contract`).

#### Surfaces (`game.surfaces`)

```js
game: {
  surfaces: {
    '0': { 41: 'sand', 44: 'oil', 45: { type: 'conveyor', dir: 'east' }, 47: { type: 'boost', dir: 'north' } },
    '1': { 44: 'oil' },
  },
},
```

The key is a level; inside it, the tile id of that level's grid (`map` for
`0`, `levels[n].map` for `n`) maps to a type from `coreParams.surfaces.types`:
its name, or `{ type, dir }`. `dir` (`north` = −y, `south` = +y, `west` = −x,
`east` = +x — as for `ramps`) is required for a conveyor and a boost and
forbidden for any other type. Both sides check it on load
(`MapGame::validate_surfaces`): the level exists, the type is declared, `dir`
matches the kind, and the tile is neither a wall (`physicsStatic`/`walls`) nor
a ramp tile of its level — otherwise the map is refused. How surfaces act on
motion — [core.md](core.md#surfaces-coresrcsurfacers).

#### Night lighting (`game.lighting`)

```js
game: {
  lighting: {
    night: true,
    ambient: 0x3a4260,
    lamps: [{ cell: [12, 30], level: 0, radius: 110, color: 0xffc070, intensity: 0.9, head: true, flicker: 0 }],
  },
},
```

Only the client reads it; the core ignores the key.

| Field | Meaning |
| --- | --- |
| `night` | `true` — the map is dark. `false` or no `game.lighting` — day, the system draws nothing |
| `ambient` | Colour of the darkness the scene is multiplied by (brightness ≈ 0.35–0.45 keeps enemies readable) |
| `lamps[].cell` | `[col, row]` of the grid; the lamp stands in the cell centre (`(col + 0.5) · step · scale`) |
| `lamps[].level` | The level the lamp lights (`0` by default); it has to exist |
| `lamps[].radius`, `color`, `intensity` | The light spot: world units, colour, strength |
| `lamps[].head` | `true` — draw a glowing lamp head set into the road: a tank driving over it covers it |
| `lamps[].flicker` | `0..1`, flicker strength (deterministic, the same on every client) |

On a night map no render layer of any level may have a base `zIndex` of 40
or more: the light map lies at 40 and the emissive layer at 45
(`tests/config/game.test.js` checks it together with the lamp cells).

#### Roofs (`game.roofs`)

```js
game: {
  roofs: { 1: [T.ROOF] },
},
```

Only the client reads it; the core ignores the key. Level → the tiles that
are roofs of that level (the key is a level number). A roof render layer is
not see-through while the player is lower: its hole — and the hole of its
light map — opens only when the roof covers the drawn point of the tank
(with `seeThrough.roofMargin`). Bridges and overpasses keep the old rule.

A roof needs its own render layer (`levels[L].layers`) holding roof tiles
only; a layer that mixes roofs with other tiles logs a warning and behaves
like an ordinary slab. Signs and decals standing on a roof go on the roof's
layer: they fade together with it.

#### Animated elements (`game.animatedTiles`, `game.signs`, `game.decals`)

```js
game: {
  animatedTiles: {
    45: { kind: 'frames', frames: [45, 60, 61, 62], speed: 60 }, // conveyor: fps is derived from speed
    43: { kind: 'frames', frames: [43, 63, 64, 65], fps: 4 },    // water
  },
  signs: [
    { cell: [40, 20], level: 1, layer: 1, text: 'HOTEL', color: 0xff3ad0, size: 18, angle: 0,
      flicker: { pulse: 0.15, dropouts: 0.2 }, light: { radius: 80, intensity: 0.7 } },
  ],
  decals: [
    { cell: [10, 8], level: 1, layer: 1, frame: 70, kind: 'rotate', rps: 1.5 }, // a rooftop fan
  ],
},
```

Only the client reads these keys; the core ignores them.

| Field | Meaning |
| --- | --- |
| `animatedTiles[id]` | The tile `id` is animated on every level and layer that draws it. It is left out of the layer bake and drawn as live sprites |
| `animatedTiles[id].frames` | Frame indices of `spriteSheet.frames`; they have to exist |
| `animatedTiles[id].fps` / `speed` | Exactly one of them. `fps` — a plain animation. `speed` (units/s) — a conveyor: `fps = speed · frames / (step · scale)`, and `speed` must equal the `belt` of the tile's surface type. Frames are chevrons already drawn in the belt direction (one tile and its own frames per direction); sprites are never rotated |
| `signs[].cell`, `level`, `layer` | Grid cell and the owning render layer: exactly the layer whose `(level, layer)` match builds the sign |
| `signs[].text`, `size`, `color`, `angle` | Text (bold monospace), font size in grid units, colour (`tint`), angle in degrees |
| `signs[].flicker` | `pulse` — depth of the slow pulse; `dropouts` — share of time windows with a short deterministic dropout (the core dims more than the glow) |
| `signs[].light` | `radius`, `intensity` of a light source in the sign's colour — night maps only |
| `decals[].cell`, `level`, `layer`, `frame` | A sprite of `frame` in the cell centre of the owning layer |
| `decals[].kind` | `'rotate'` with `rps` (turns per second) or `'frames'` with `frames` and `fps` |

Rooftop fans go on the roof slabs of a level ≥ 1 (the level's render layer),
not on top of a volume extrusion. `tests/config/game.test.js` checks the
rules above: one of `fps`/`speed`, existing frames, every conveyor tile has
an animation whose `speed` equals its `belt`, and signs and decals stand on
existing layers.

#### Destructible props (`physicsDynamic[].game.prop`)

```js
physicsDynamic: [
  { position: [200, 84], width: 32, height: 32, density: 100, game: { prop: 'barrel' } },
],
```

A body with `game.prop` becomes a prop of that type from `coreParams.props`;
a body without it stays an ordinary indestructible crate. An unknown name
fails the map load (`physicsDynamic[i].game.prop: unknown prop '…'`). The
prop's state travels in the `state` byte of its `c1`/`c2` row: `0` — intact,
`1` — damaged, `2` — destroyed (debris or scorch). The optional
`game.imgDamaged` and `game.imgDestroyed` name the images of those states
(files in `assets/img/`, checked by `npm run build:manifest`); without
`imgDestroyed` a destroyed prop is drawn as a procedural scorch
(`scorchTexture`). How props break —
[gameplay.md](gameplay.md#destructible-objects), the core side —
[core.md](core.md#destructible-props-coresrcpropsrs).

---

[← Previous: Architecture](architecture.md) · [Next: Gameplay →](gameplay.md)
