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
| `coreParams.levels` | `fallTime: 0.35, fallDamage: 30, fallDamageFreeHeight: 0.5, maxFallDamage: 100, climbGravity: 500, climbMaxSpeedFactor: 0.5, levelAdoptFrames: 8, maxSideEntryRise: 0.5, rampLaunchFactor: 0.35, minLaunchVz: 0.35, maxLaunchVz: 3.5, jumpClearance: 0.45, tiltGain: 2.0, tiltAirGain: 0.12, tiltResponse: 12.0, tiltMax: 0.6, landingShake: { intensity: 3, duration: 220, minImpact: 1.5, fullImpact: 6 }` | 2.5D level rules handed to the game's Rust core as-is (the engine neither reads nor validates `coreParams`): `fallTime` is the time of ONE level of height, and `fallDamage` the price of one level ABOVE the dead zone `fallDamageFreeHeight` (`0` — falling is free): the landing costs `fallDamage · max(0, height − fallDamageFreeHeight)`, so an arc lower than the dead zone — a ramp jump — is free, while a drop of exactly one level costs `fallDamage · (1 − fallDamageFreeHeight)`. `maxFallDamage` caps a single landing, `climbGravity` is the roll-back acceleration per unit of longitudinal grade, and `climbMaxSpeedFactor` is how much a grade of 1.0 trims the speed ceiling (`[0, 1)`). The grade is DIMENSIONLESS: the engine computes it as `rise * levelHeight / span`, where `levelHeight` is the map's level height in world units (the tile size by default), so a level-per-tile climb gives 1.0 while the demo maps' runs range from 0.11 (`terraces.rampLong`) to 0.5 (`terraces.rampSteep`). `levelAdoptFrames` is how many frames in a row must hold a level ABOVE the client's replica before it adopts one (a level below is adopted at once — a late frame can only lie upwards; see `client::predictor`). `maxSideEntryRise` caps how far the ramp's height at the entry point may sit from the body's own height when it enters a run across the axis (in levels, the bound excluded). `fallTime` no longer sets a duration directly but the GRAVITY: falling is ballistic (`vz -= g·dt`), and `g` is picked so that a drop of exactly one level still takes `fallTime`. Jumping: `rampLaunchFactor` (dimensionless, `0` — no jump at all) is the share of the slope's vertical speed carried into flight when the body leaves a run's top end; `minLaunchVz` (levels/s, `0` — even a walking-pace exit jumps) is the threshold below which no flight starts; `maxLaunchVz` (levels/s) caps the take-off speed and with it the arc — `maxLaunchVz² / (2·g)`, where `g = 2 / fallTime²`, 0.375 of a level at the values above; `jumpClearance` (levels, `0` — walls vanish the instant the tank takes off) is how far above the take-off level the tank stops seeing walls and flies over obstacles. The pair is an invariant: while `maxLaunchVz² / (2·g) < jumpClearance` holds, a regular jump never reaches the clearance, so flying over walls stays a core mechanic that the shipped settings never trigger — a map that wants it raises `rampLaunchFactor`/`maxLaunchVz` of its own (see [extending.md](extending.md)). Hull tilt: `tiltGain` (dimensionless, `1` — the angle equals the grade's arctangent, `0` — no tilt on a ramp) is how strongly the grade turns into an angle; `tiltAirGain` (radians per level/s, `0` — the nose does not follow the flight) tilts the nose by the vertical speed; `tiltResponse` (1/s, `0` — the hull freezes at its current angle) is how fast the hull returns to the target angle; `tiltMax` (radians, `0` — no tilt at all) caps the tilt by absolute value. `landingShake` is the camera shake on touchdown, declared exactly like a weapon's (`cameraShake` in `src/data/weapons.js`): `intensity` is the strength at a full impact, `duration` its length in ms, `minImpact` the contact |vz| (levels/s) below which the landing is soft and there is no shake at all, and `fullImpact` the |vz| that yields the full strength (anything above gives the same — `intensity` is the cap). The block may be omitted, and then a landing shakes nothing, exactly as before the rule existed. NOTE: `minImpact`/`fullImpact` numerically duplicate the `landing` block in `src/config/render.js` (hull squash, dust and sound on the client) — the client renderer and the WASM core share no source for them, so the two must always be changed together; otherwise you get a camera without dust, or dust without a camera. A flat map never touches them |
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

- **`componentDependencies`** — which services get injected into which
  components (`renderer` → Map, Tank, Tracks, Smoke, Dust, Bomb, ShotEffect,
  ExplosionEffect; `assetsBase` → Map;
  `soundManager` → ExplosionEffect, ShotEffect, Bomb, Tank, Dust;
  `mapDynamics` → ShotEffect; `rampRuns` → Map; `levelView` → Tank, Map, MapRadar,
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
  JS. `levelView` is the game's own service too
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
| `lowerTint` | Tint for levels **below** the player: "darker means lower" |

| `parallax` | Meaning |
| --- | --- |
| `shear` | How far an object shifts away from the camera centre per level of height, as a share of the distance to it, AND how much larger it is drawn (`1 + z * shear`) — the shift and the scale are one projection. ONE number for every consumer — the level layer and its volume, the ramp wedge, the tank hull and wreck, the track marks, the engine smoke, bombs and effects: a tank on the level-1 slab has to move exactly with the slab. See `src/client/parallax.js` |
| `levelZStride` | The `zIndex` stride between levels (`src/client/levelZ.js`). It has to exceed every part's base `zIndex`, otherwise the bridge layer sinks below a ground-level canopy |

| `volume` | Meaning |
| --- | --- |
| `enabled` | `false` switches layer extrusion and the ramp wedge off entirely — the fallback path on a weak machine |
| `slices` | Extrusion slices per layer: the whole effect costs `slices` draw calls regardless of how many walls there are. Layer VOLUMES only (buildings, railings) — their side face is vertical |
| `rampSegments` | Ramp-wedge segments per run cell. The wedge is a slope (one mesh per run); this is its vertex density: the shift along the run grows quadratically, and at 4 segments per cell the polyline is indistinguishable from it |
| `sideTint` | Tint of the lower slices — the side faces of the block, and of the ramp wedge's skirt |

| `shadow` | Meaning |
| --- | --- |
| `scaleGain` | How much the shadow grows per unit of RISE above the support. The shadow is drawn ONLY while the tank is airborne — it is the sign of a jump or a fall, and a tank on the ground has nothing to show — so a jump on the upper deck looks exactly like the same jump on the ground |
| `baseAlpha`, `alphaFalloff` | The shadow's opacity on the support and how fast it fades as the rise grows |
| `sizeFactor` | The shadow's size as a share of the hull LENGTH: the texture is already in the hull's proportion, so at the start of a jump the shadow lies exactly under the hull and never peeks out |

| `tilt` | Meaning |
| --- | --- |
| `enabled` | `false` restores the old flat hull sprite: the tilt is not drawn at all (the host still computes the angles and carries them) |
| `lift` | The on-screen rise of the raised edge of the quad, as a share of its height: this turns the authoritative `pitch`/`roll` into `PerspectiveMesh` corners (`src/client/tilt.js`) |
| `vertices` | The `PerspectiveMesh` grid density along each axis |
| `shading` | The light-and-shade of the tilt: how far the hull's brightness swings at the maximum tilt. `0` — no shading, the picture as before |
| `lightDir` | Light direction in SCREEN space (not the hull's): `[x, y]`, normalised on read. The default is light from the north-west — the same way the side faces of buildings are lit |

The hull has NO extrusion of its own (there used to be `body`, `bodySlices`
and `sideTint`). In this projection a side face shifts by
`thickness · shear · distance to the screen centre`: on another player's
tank at the edge of the screen it grew as long as the hull itself, broke
into steps and always pointed at the local player — the camera centre. The
volume of a tank comes from `shading` alone.

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

The `spatial` block overrides the engine's spatial-sound geometry, and only
what this game has to override: `mode: 'topDown'`, `virtualElevation: 108`,
`innerRadius: 5`. The engine's own defaults (`180` / `40`) are calculated
for a 1:1 scale, and here a **world unit is not a screen pixel**:
`mapScale: 0.3` (`src/config/game.js`) with `baseScale: '5:1'`
(`src/config/client.js`) makes one world unit five screen pixels, so the
defaults would spread the stereo base over five screen widths and treat a
radius of five tank hulls as "inside the player". `108` is half the visible
screen height in world units (`1080 / 2 / 5`); at the edge of the screen
(`192` units sideways) that is an angle of about 60°, next to the hull — a
few degrees. `5` is the half-diagonal of the `m1` hull, which is `8 x 6`
world units (`size * 4 x size * 3` at `size: 2` in `src/data/models.js`), so
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
It is the ONE field of `m1` that is not interpolated, and deliberately so:
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

The dynamic map row (`c1`/`c2`) is `[x, y, angle, z, level, vx, vy,
angvel]`, and `z`/`level` must declare `role: 'z'` and `role: 'level'`:
the engine recognises a layered row by its ROLES, not by field names (the
name belongs to the game), and a role without its pair fails the map load
instead of silently falling back to a flat row. The height and the level
sit in the HEAD rather than the tail,
because a resting body ships no tail at all and the level would read as
zero — a crate on the bridge would "fall" to the ground for the viewer.
`optionalFrom: 5`: a dynamic map element ships `[vx, vy, angvel]` only
while it moves, so a resting crate costs 12 bytes less per frame (decoding
still yields the full eight-field row, the missing tail as zeros). Full
mechanism — the engine's
[network.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/network.md#binary-snapshot-frame-port-5).

## src/data/ — game data

### models.js

The only model — the `m1` tank: the `Tank` constructor, starting weapon
`w1`, size (`size: 2`, dimensions `size×4 : size×3`), motion parameters
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

Five maps: `pool mini` (small), `canopy`, `garden`, `overpass` (the two-level
2.5D demo) and `terraces` (the three-level one). Each describes tile layers (`layers`, `tiles`), respawn points
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

---

[← Previous: Architecture](architecture.md) · [Next: Gameplay →](gameplay.md)
