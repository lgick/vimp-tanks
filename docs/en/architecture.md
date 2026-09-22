# Architecture (game plugin)

`vimp-tanks` is a **dynamic plugin** for the [VIMP engine](https://github.com/lgick/vimp-engine)
(published as `vimp-engine` / `vimp-engine-core`): a team-based tank
deathmatch running entirely on the engine's P2P infrastructure (authoritative
browser host, WebRTC clients, Node.js master for lobby/signaling). This repo
owns only game rules — physics, transport, Worker handoff, and the client
MVC/render framework live in the engine; see its
[architecture.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/architecture.md)
for the full picture and the ADR on the engine/game split.

## Repository layout

```
index.html / vite.config.js — the plugin's Vite root (client/host builds)
src/
  host/      — HostPlugin: core-event router, TanksBotManager (scripted
               module), /bot command, b:* system messages
  client/    — ClientPlugin: parts/ (PixiJS entities and effects),
               bakers/ (procedural textures), hooks, game CSS
  config/    — game config halves (game.js, client.js, auth.js, sounds.js,
               snapshot.js)
  data/      — static data: maps/, models.js, weapons.js
  nodeCore.js — one branch shared by both plugin halves: browser wasm
               asset vs Node glue (headless runs)
core/        — vimp-tanks-core (Rust → WASM, pkg-web/pkg-node): tanks,
               weapons, bots, prediction, shot spawning (see core.md)
assets/      — authored inputs: audio-raw/ (raw sounds) and img/ (tile
               sheets, dynamic-body sprites; the engine ships none of them)
tests/       — host-plugin behavior, JS↔WASM harness, scenarios/ (headless
               debug runs, see getting-started.md)
scripts/     — audio processing, image copy, map export to JSON, manifest,
               scenario runner
```

`src/config/` and `src/data/` are read by the engine's host Worker, the
client bundle, and (for maps) the engine's master — all through the plugin
contract (`HostPlugin.gameConfig`, `ClientPlugin`, `GameManifest`), never by
direct import.

## How this plugin plugs into the engine

- **Host**: `host.worker.js` in the engine dynamically imports this
  package's `entries.host` (`src/host/index.js`, the `HostPlugin` default
  export) and calls `createCore()`, which loads this repo's WASM core.
  `TanksBotManager` implements the engine's scripted-module contract
  (`createMap`/`createScripted`/`removeScripted`/…).
- **Client**: the engine's client dynamically imports `entries.client`
  (`src/client/index.js`, the `ClientPlugin` default export) after a room is
  picked, and calls `createClientCore()`.
- **Both entries take `wasmUrl` in two shapes**: the hashed `.wasm` asset in
  a browser, and a `file:` URL of the Node glue (`entries.wasmNode`) under
  the engine's headless runner. The branch lives in `src/nodeCore.js` and is
  shared by both halves on purpose — a headless run on a different core than
  the browser's would prove nothing.
- **Master**: never executes plugin code — it only serves this package's
  `dist/manifest.json` and the exported map JSON under `/games/tanks/*`.
- **`requires: ['map.layers']`**: both plugin halves declare the engine
  capability the 2.5D maps stand on, and `build-game-manifest.js` copies the
  list into the manifest from `src/host/index.js` — one source, so the
  contract rule `B2` has something to compare. Without layered maps in the
  engine `overpass` would load without its second level and without a single
  error, so the capability is a hard requirement rather than a hint.
  The full list is `['map.layers', 'map.levelsN', 'map.gameData',
  'map.bodyState']`: `map.gameData` delivers the map's `game` field (and
  `physicsDynamic[i].game`) to the core on both sides, `map.bodyState` —
  the `state` byte in the `c1`/`c2` row.

Full contract — the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md).

## The core's boundary

Simulation only: physics, tanks, both weapon types, bots, and binary frame
packing live in `core/` (Rust/WASM). Health/ammo live there too — the JS
panel is a projection of the core's events. Meta (chat, votes, stats,
rounds, the participant registry, auth) is engine-owned JS, parameterized
entirely by this plugin's config (`HostPlugin.gameConfig`).

## The client side

Three network-smoothing mechanisms live in the engine's generic `ClientCore`
machinery, with the game-specific halves implemented in this repo's core
crate:

- **Prediction** (`core/src/client/predictor.rs`): the local tank is
  simulated by a replica of the authoritative motion model (formulas shared
  with the authoritative side via `core/src/motion.rs`); the host confirms
  input (`lastInputSeq`), reconciliation replays unconfirmed input, and the
  discrepancy decays smoothly.
- **Client-side shot spawning** (`core/src/client/shot.rs`): a shot is seen
  and heard instantly; duplicates from the host are suppressed by author id.
- **Interpolation** is fully engine-owned (no game-specific code).

Rendering is built from engine MVC components + this plugin's PixiJS
entities (`src/client/parts/`) on two canvases (`vimp`, `radar`); procedural
textures are baked at startup from `src/client/bakers/`.

The `Map` part is a **dispatcher over two strategies**: the engine hands
static layers (`s0..sN`) and dynamic bodies (`d0..dN`) to the SAME list of
part names (`gameSets[setId]`, `src/config/client.js`), so the part name is
one and the data kind is resolved inside. `src/client/parts/Map.js` only
checks `assetsBase`, picks the strategy and wires its `render` to
`onRender`; the work lives in `src/client/parts/map/` — `MapLayer.js` (the
layer itself: constructor, `render()` and `destroy()`), `layerAssets.js`
(loading and baking, the volume, the wedge, the ramp lanes in grid cells),
`layerSeeThrough.js` (the bridge slab and its occluder yielding visibility,
in both modes), `MapObject.js` (the crate: its own frame row, level and
alpha), `extrusion.js` (pure geometry of volume slices and the ramp wedge),
`holeOverlay.js` (the see-through hole: state and the filter) and
`tileGrid.js` (the base scale and the two world → cell conversions,
`cellOfPoint` for a point inside a tile and `cellOfEdge` for a tile's
boundary — shared by the layer and the crate).

A part that needs something out of the game core gets it as a **service**:
`ClientPlugin.hooks.services(core)` (`src/client/index.js`) returns the game
services, the engine merges them into its own pool and hands them out by
`componentDependencies` (`src/config/client.js`). Today that is `mapDynamics`
— `toWorld(key, localX, localY)` over `ClientCore.map_dynamics_to_world`, by
which `ShotEffect` anchors its debris to the box the shot hit (see
[core.md](core.md)) — and `levelView` (`src/client/levelView.js`), where the
local player is, on which level and at which height: the local `Tank` writes
it, and everything that has to yield visibility to him reads it (see below).
The same service owns the frame's camera centre — it is asked for the scene
once and computes the centre itself. `surfaces` tells `Dust`, `Tracks` and
`Tank` what the tank drives on: `kindAt(x, y, level)` gives the type name of
the cell (`sand`, `mud`, `water`, `oil`, `conveyor`, `boost`) or `null`, and
`dirAt(x, y, level)` the unit vector of its arrow or `null`. It reads the
core's own table (`ClientCore.surface_at`/`surface_dir_at`) instead of a copy
of `game.surfaces` on JS: a second copy could drift from the physics
silently — dust rising where the track does not slow down. The type names
(`surface_types`) are cached until the map changes (`map_generation`).

The same service names (`levelView`, `mapDynamics`, `rampRuns`, `surfaces`)
are repeated in `ClientPlugin.serviceNames`. The hook
needs a live core, so the contract checker cannot read what it returns; the
list is what lets rule `C4` tell a game service from a typo in
`componentDependencies` instead of downgrading itself to a warning — an
unprovided service is silently `undefined` in the part.

### Draw order across levels (2.5D)

Every part is a direct child of the stage with `sortableChildren = true`, so
`zIndex` alone decides the order. `src/client/levelZ.js` turns a part's base
`zIndex` into a level-aware one:

```
zIndex = base zIndex + LEVEL_Z_STRIDE * level     // LEVEL_Z_STRIDE = 100
```

Base values are the single-level ones (`Tracks` 1, `Bomb`/`TankRadar`/
`MapRadar`/`ShotEffect`/funnel 2, `Tank` 3, `Smoke`/explosion 4, map layers
from `data.layer`), so a map without upper levels draws exactly as before.
The stride is larger than any base value, hence every level-1 layer covers
every level-0 one — the bridge slab hides what drives under it.

The consequences the parts implement themselves:

- **See-through above the player.** One formula for every part —
  `levelView.alphaFor(level, x, y, z)` (`src/client/seeThrough.js`), in two
  modes switched by `parts.seeThrough.mode` (`src/config/render.js`):
  `'hole'` opens a radial hole around the player, `'layer'` fades the whole
  slab (the old behaviour, the fallback path). Only what is **above** the
  player fades. A point entity (a box, another tank, smoke, a bomb, an
  effect) sets its own `alpha`; a solid `Map` layer needs a field over
  pixels rather than a single alpha, so it runs the hole as a filter
  (`createHoleFilter`, both a WebGL and a WebGPU branch — the second one
  would silently vanish otherwise). Either way the transition is
  time-smoothed (`fadeRate`), or driving under an edge blinks. Both sides
  measure the distance in **drawn** coordinates: the player and the entity
  are each offset by their own height (the 2.5D projection below), and the
  hole in the slab is centred on the same offset point. The camera centre
  that projection needs is a property of the FRAME, and the service gets it
  itself: the first part of the game canvas to render hands it the scene
  (`levelView.attachStage(stage, renderer)`), and `levelView.camera()` then
  recomputes the centre once per NEW scene transform, for everyone at once.
  The cache is keyed on that transform and not on the shared ticker's tick:
  the canvas can be drawn several times per tick (`vimp-engine` up to 0.34
  calls `app.render()` from `updateCoords` on every camera frame — first the
  discrete frame's camera, then the predicted one), so a per-tick key handed
  every draw but the first a foreign centre — on the upper levels that reads
  as jitter, the stronger the faster the player drives. How many draws a tick
  brings is the engine's business, and the plugin must not depend on that
  number.
  It used to be published by the local `Tank` alone, so without one (a
  spectator, the gap between death and respawn) there was no camera at all
  while the `Map` layer computed its own — the hole rode the fresh
  projection and the entities' alpha the previous one — and a part rendered
  before the tank used the previous frame's centre. Raw world points would
  drift the entity's fade circle away from the drawn hole the further the
  player is from the screen centre and the higher the entity sits.
- **Touchdown is detected in one place.** `src/client/landing.js` holds the
  single detector — the frame where `vz` goes from non-zero to exactly zero
  — and both `Tank` (the hull squash and the thud) and `Dust` (the puff from
  under the tracks) read it from there. The two used to carry a verbatim
  copy each, and `vz` is `interp: 'discrete'` in the snapshot schema exactly
  so the detector sees that zero on other players' tanks as well.
- **Boxes ride their level.** The dynamic row (`c1`/`c2`) carries `level`,
  so `Map`'s dynamic branch re-sorts by `levelZ` and recomputes its alpha
  every frame: a box that falls off the bridge is visibly falling off it.
- **A falling body draws by its height, not by `level`.** While a body
  falls, the host keeps `level` at the level it fell FROM
  (`core/src/level.rs`), so the `Tank` part computes the DRAWN level as
  `min(level, round(z))`: layer, tint and transparency move down halfway
  through the fall rather than on touchdown. A climb is untouched — on a run
  `level` is `round(z)` already.
- **Darker means lower.** Anything below the player's level is tinted with
  `seeThrough.lowerTint` — the only level cue that works at the edge of the
  screen. On the radar the same idea: layers of other levels dim, the level
  palette is shared (`src/client/levelColors.js`), and another tank's marker
  gets a ring in its level's colour.
- **Height reads as a shadow.** `Tank` keeps a shadow sprite as a **sibling
  on the stage** (its `zIndex` is that of the level the tank hangs over, and
  the stage is flat) drawn ON THE SUPPORT — at the tank's world point taken
  through the same 2.5D projection as the slab underneath, `groundZ *
  shear`, while the hull rides its own height `z`. The gap that opens
  between them is the RISE above the support, and that is what reads as
  height. The shadow exists ONLY in flight (the sign is a non-zero `vz` in
  the frame): a parked or driving tank has no rise, and the shadow would lie
  exactly under the hull and read as a grey halo around it. A shadow left in
  the raw world point drifted away from the hull by
  `z · shear · (distance to the screen centre)` and lived a life of its
  own. The shadow is a **silhouette of the hull**
  (`src/client/bakers/tankShadowTexture.js`), not a circle: a blurred circle
  normalised by the model `size` stuck out from under the corners of a
  turning hull and read as a grey dot beside the tank. There is no level
  number above the tank, and no hull tilt either: the level reads from the
  radar ring, the tint of the levels below, the shadow, the parallax and the
  height scale. The client no longer recovers a grade from `z` — the sums
  decayed only in frames with motion, so a false value froze under a parked
  tank for good — and there is no track dust.
- **The 2.5D projection is one formula** (`src/client/parallax.js`). Anything
  at height `h` **in levels** is drawn pushed AWAY from the camera centre:

  ```
  point:     p' = p + (p - cam) * k,   k = h * parallax.shear
  container: the same result is a scale of (1 + k) about the camera centre
  ```

  The **scale is part of the same projection**: an object at height `z` is
  drawn both shifted by `z * shear` and enlarged by `(1 + z * shear)` —
  exactly like the slab it stands on. There is no separate height-scale
  coefficient any more. Its consumers are the level-N layer and its volume
  (`Map`), the ramp wedge, the tank hull and wreck, the track-mark
  containers (`Tracks`), the engine smoke, bombs and the shot and explosion
  effects. One number for the layer and for the tank is not a coincidence: a
  tank standing on the level-1 slab has to move exactly with the slab or it
  slides off it.
  The shadow rides the same projection, but at the height of the SUPPORT
  rather than the tank's own: that is what makes the rise visible. Nothing
  recomputes vertices: a container carries the whole shift in its own
  transform.
- **Volumes shift with the camera and occlude.** A render layer with a
  height (`volumes` in the map, `data.volume` in the part) is extruded by
  `Map` itself: side walls as a mesh (`buildVolumeWalls` — one quad per
  exposed cell side, textured from a strip of `volume.faceTileRepeats`
  copies of that cell's tile — its own side texture per tile, so bricks keep
  one size — the lower edge at
  `level`, the upper one at `level + volume` plus `volume.faceBleedPx`
  screen pixels of overlap, every vertex and its vertical UV recomputed per
  frame (`updateWallMesh`) like the ramp wedge) plus one sprite of the layer's own baked picture at the top
  height, so walls open up as the player moves and read as one solid block.
  Faces turned away from the camera are drawn first (`orderWallMesh`
  rewrites the index order only when a face changes side). `volume.faces =
  false` falls back to `slices` stacked sprites. They live in an **occluder container** — a sibling
  of the part on the stage whose `zIndex` sits ABOVE the dynamics of its own
  level (`OCCLUDER_BASE_Z`, still far below `parallax.levelZStride`), so a
  tank standing behind a wall is drawn behind it instead of climbing onto
  it. The extrusion goes away from the camera centre, that is, it covers the
  area BEHIND the wall — where the tank is. A volume of the player's own
  level never fades, even when it covers the tank: at speed the camera
  look-ahead carries the camera past the wall face, the wall top overhangs
  the tank, and a hole there used to flatten the wall. The tank may be
  partly hidden by the wall top for a moment, until the camera catches up.
  A volume ABOVE the player fades together with its own layer, as the slab
  does.
- **A ramp is a slope, not a flat sprite.** `Map` takes the ramp runs FROM
  THE CORE — the `rampRuns` service (`src/client/index.js` over
  `ClientCore.ramp_runs`) returns the very `MapLevels::runs` the physics
  puts its guards on, in world units; `src/client/parts/rampLanes.js` only
  converts them into the layer's cells and merges the lanes. A second grid
  walk on JS used to live there and could drift from the core silently — a
  hill you can see and cannot drive up. The part then bakes a texture out of
  the ramp tiles only and builds ONE mesh (`MeshSimple`) per run: a strip of
  `volume.rampSegments` segments per cell whose every vertex carries its own
  height, `lerp(from, to, progress)` — the same formula the core moves the
  tank's `z` by, so a DESCENDING ramp (`from > to`) is drawn as well: its
  tile lies in the upper level's grid and the wedge goes down from there. A container transform cannot express
  that shift — it differs per vertex — so the vertices are recomputed every
  frame with the same `offsetPoint` formula. The height now grows along the
  run continuously (the wedge used to be a staircase of `slices` steps, and
  the steps showed), and a tank driving under the wedge is hidden by it.
  Each run also gets a second mesh — a **skirt**: the two sides along the
  axis and the end face at the TOP end, pulled down to the run's base plane.
  Without it the ground showed under the wedge and the map lied — the sides
  of a run are closed by the engine's guard colliders. Which is why the
  sides are drawn by the guards' OWN bounds, `railMin`/`railMax` of the same
  `rampRuns` service (`map::ramp_rail_span`): they start one cell past the
  foot, and a run one cell long has no sides at all — there the skirt is the
  end face alone. The lower end stays open (that is the legal entry), and a
  `1 → 2` run keeps a visible gap under it, where driving through really is
  allowed. The wedge stays a
  child of the PART, unlike the volume: a tank climbing the ramp has to be
  drawn on top of its surface. For the picture the lanes of one wide ramp
  are merged into a single run (`rampLanes.js`, by the core's `block`
  number) — the core keeps them separate because the entry gate is judged
  per lane, and skirts on the lane borders would draw partitions that do not
  exist in the physics.
- **Tracks keep their level**: track marks live in a per-level container
  that is a sibling of the `Tracks` part on the stage, so a mark left on the
  overpass stays on the overpass after the tank drives down.

### Lighting (night)

On a map with `game.lighting.night: true` the `lighting` service
(`src/client/lighting/`, created in `hooks.services` next to `levelView`)
darkens the scene. It is **atmosphere only**: enemies stay readable (every
live tank carries a faint `tankGlow`), the radar does not change, and
`render.js → lighting.enabled = false` switches the system off on any map.

- **One light map per level.** Level `L` gets an overlay container on the
  stage at `zIndex = levelZ(40, L)` — above every dynamic part of its level
  (`Tank` 3, smoke 4, volume occluder 5) and below the level stride. The
  overlay lives in world coordinates with no transform of its own. Inside:
  a base covering the map plus a margin of its longer side on every edge
  (so a zoomed-out camera past the edge still sees dusk), the floor mask and
  the light sources drawn additively. A pass-through filter at
  `lighting.resolution` renders that into a pooled texture and lays it onto
  the scene with `blendMode: 'multiply'`.
- **`filterArea`, not `boundsArea`.** The filter region is the same world
  rectangle, set once as `filterArea`; PixiJS clips it to the screen. For a
  container with `boundsArea`, PixiJS 8.19 (`getFastGlobalBounds`) applies
  the stage transform twice, so the region followed the camera off-screen,
  the filter was skipped and the overlay was drawn without `multiply` — a
  white screen or no night at all after a resize or far from the map
  origin.
- **A filter, not a `RenderTexture`.** Parts drive the service from
  `onRender`, and PixiJS calls it INSIDE a frame, after the screen target is
  bound (`renderStart`). A nested `renderer.render({ target })` there resets
  the render-target stack, and the rest of the frame would be drawn into the
  light map. A filter renders through the push/pop of the same pass.
- **White base and floor mask.** Level 0's base is `ambient`. For `L ≥ 1`
  the base is **white** (multiplying by white changes nothing); on top the
  floor cells of that level (`setLevelMask` — the union of the contributions
  of the level's layers; railings are part of `floor`) are filled with
  `ambient` in the level's projection, then its lights. Outside the floor the
  map stays white, so level 0 is not darkened twice, a level-0 light never
  reaches the bridge slab (it is drawn under it), and a bridge light never
  spills outside the slab. The level-0 overlay always exists on a night map;
  an upper one only while its mask is non-empty.
- **The hole above the player.** An upper overlay gets the same hole as its
  slab (`holeOverlay`, its own filter state; in `'layer'` mode — the
  overlay's `alpha`), otherwise a dark patch would stay in the hole. While
  the hole is attached, its filter is the last in the chain and carries the
  `multiply` blend itself.
- **Emissive layer.** Per level a container at `levelZ(45, L)` with additive
  sprites drawn over the darkness: lamp heads (created by the service),
  headlight glares (`Tank`), neon signs (`parts/map/NeonSign.js`). Their transparency is
  `levelView.alphaFor`. Without night `addEmissive` returns `false`, and the
  caller keeps its sprite — or, for glares, does not create one.
- **Map state and session state.** The engine destroys every part of the old
  map before it creates the new ones, so the service counts parts per map
  key (`lightMath.mapKeyOf`: grid size plus a hash of `game.lighting` — the
  only data every static part has) and runs `clear()` when the counter of
  the CURRENT key reaches zero: overlays, lamps and mask contributions go,
  first off the stage, then destroyed. Textures, `addLight` sources and
  emissive entries are session state: tanks and effects outlive a map change
  and remove their own in `destroy()`. A key switch while the old counter is
  still live (the reverse order) frees only the old map. After a WebGL
  context loss the engine recreates every part: the counter drops to zero,
  the new parts acquire the key again and register fresh baked textures.
  The parts acquire the key synchronously in their constructor, before the
  asynchronous layer build — a tank created on the first frame must already
  see the night.
- **Sources.** Lamps (`game.lighting.lamps`, cell centres, owned by the
  service), two headlight cones and a glow per live tank (updated in
  `Tank.update`, in world coordinates, before the frame is drawn), and short
  flashes from `ExplosionEffect` and `ShotEffect`. They share three baked
  textures (`lightRadialTexture`, `headlightConeTexture`, `lampHeadTexture`)
  and therefore batch, are culled against the screen and capped by
  `lighting.maxLights`. The layout runs once per stage transform per tick.
- **No shift shadows.** Sources light spots and cast nothing: projected
  shadows would need the geometry of every wall per light per frame, and
  the 2.5D volumes already read as height.

### Animated map elements

Water, conveyors, rooftop fans and neon signs are client-only; the host
knows nothing about them.

- **`layerRoot`.** A static layer (`parts/map/MapLayer.js`) keeps a root
  container inside its part: the baked `mapSprite` first, then the
  `animated` container. Parallax and the map scale are applied to
  `layerRoot`, so live sprites move with the baked picture. The hole filter
  and the `'layer'`-mode alpha stay on the part container itself — it also
  holds the ramp wedge meshes, and both have to fade.
- **Animated tiles are not baked.** `bakeTileLayer({ exclude })` skips the
  tiles of `game.animatedTiles`; `parts/map/animatedTiles.js` draws one
  sprite per cell of such a tile in `animated`, grouped by description (a
  group shares its frame number, one pass per group). Textures come from
  the layer's own parsed sheet (`parseSpriteSheet`) over the same tile
  image, so they batch with each other. A group whose container is entirely
  off screen is not updated that tick.
- **Shared clock.** `src/client/animationClock.js` advances once per
  `Ticker.shared` tick (seconds since start), however many times the canvas
  is drawn in that tick; every map and layer is in sync.
  `render.js → animations.maxFps` quantizes it. Tile frames, decal rotation
  and flicker are functions of that time, not accumulated steps.
- **Neon.** `parts/map/neonCache.js` bakes a sign's white `core` (a `Text`)
  and its blurred `glow` once per text and size and refcounts them; at zero
  both textures are destroyed. The engine destroys every part after a WebGL
  context loss, so the count drops to zero and new signs bake fresh
  textures instead of reusing dead ones. A sign (`NeonSign.js`) is built in
  the layer's async `_build`, after the synchronous `acquireMap`: at night
  both sprites go to the emissive layer (`addEmissive`), the sign adds a
  light of its colour and positions itself in the level's projection every
  draw; otherwise (`addEmissive → false`: day or `lighting.enabled = false`)
  it stays in `animated`. The flicker (`src/client/neonFlicker.js`) is a pure
  function of time and a cell hash — pulse plus SplitMix32-scheduled
  dropouts — identical on every client. `destroy()` removes the light and
  the emissive entries; the cache references are released after the part is
  off the stage.
- **Ownership.** Signs and decals are built only by the layer whose
  `(level, layer)` match; the tile sheet and the sprites' textures are the
  layer's, released in its deferred `destroy` callback.

### Texture and particle lifecycle

- **Texture ownership**: baked assets (`bakedAssets` in `src/config/client.js`)
  are generated once at startup and shared for the whole session — parts
  that use them call `destroy({ texture: false, textureSource: false })` so
  their own teardown never frees a texture another part still uses. The one
  exception is `mapSprite` in `parts/map/MapLayer.js`, whose texture is
  generated per map
  instance via `renderer.generateTexture(...)` and is exclusively owned by
  it — its `destroy()` passes `textureSource: true` to release the GPU
  source when the map changes. The order matters: take the object off the
  scene first, free the GPU resource second — a source destroyed under a
  live sprite or mesh breaks the frame that was already built.
- **A part never unloads a game asset**: one tile sheet is shared by every
  map layer, and `b1.png` by the dynamic bodies
  of EVERY map. `Assets.unload` does not refcount in PixiJS 8: it destroys
  the `TextureSource`, which emits `change`, which nulls the `BindGroup`
  (`BindGroup.onResourceChange`), and the next filter pass throws in
  `setResource`. The `Assets` cache survives a map change on its own.
- **Prop state textures** (`parts/map/MapObject.js`). A prop follows the
  `state` byte of its `c1`/`c2` row: `0 ↔ 1` swaps the sprite to
  `game.imgDamaged`, `→ 2` to `game.imgDestroyed` or, without one, hides it
  under a procedural scorch sprite (`scorchTexture`), drops the body to base
  `zIndex` 1 (under the tanks), fires a one-off debris burst
  (`parts/effects/DebrisEffect.js`, `debrisTexture`, world coordinates, a
  sibling on the scene the part removes itself) and the `propBreak` sound;
  `2 → 0` (a new round) restores the texture and the `zIndex`. The first
  frame that already says `2` (joining mid-round) shows the debris with no
  burst and no sound. State images are loaded with `Assets.load` and, like
  `img`, never unloaded; the texture is applied only if the part is not
  destroyed and the body is still in that state after the `await`. Alpha,
  tint and parallax are unchanged.
- **A layer is baked once.** The volume walls and top are drawn with the SAME
  baked texture as the flat layer, and only its owner (`mapSprite`) frees
  it. The ramp wedge has a second baked texture of its own (ramp tiles
  only), shared by every run's mesh, so `destroy()` releases the source
  exactly once and the meshes go with the container's children.
- **Every mesh is batched explicitly.** The ramp meshes
  (`parts/map/extrusion.js`) set `geometry.batchMode = 'batch'` instead of
  leaving the default `'auto'`. With `'auto'` PixiJS sends a mesh longer
  than 100 vertices (`Mesh.batched`) around the batcher, into the
  renderer-wide `GlMeshAdaptor` shader, which holds the texture source in
  its own `BindGroup`. Destroying that source — a map change frees the ramp
  texture — nulls the bind group FOREVER (`resources = null`), and the next
  unbatched mesh throws in `BindGroup.setResource`: a blank screen one map
  change later. The threshold is crossed by map content, not by the code
  (`terraces.rampLong` is long enough, `overpass`'s runs are not), so the
  mode is stated, not inferred. The tank's `PerspectiveMesh`
  (`parts/Tank.js`) states it for the same reason and as a guard only: at
  the shipped `tilt.vertices` (6×6) it batches on its own, and would cross
  the threshold above 10.
- **Async part constructors** (`createStatic`, `createDynamic`,
  `_createExtrusion`) check `this.destroyed` after EVERY `await`: a map change
  tears down the old parts in the same tick that creates the new ones, and a
  bake finishing later would otherwise build onto a destroyed part (and its
  texture would never be freed). Whatever a bake did manage to build for a
  part that is already gone is freed by `disposeAssets` in
  `parts/map/layerAssets.js` — one place, with the same ownership rules as
  `MapLayer.destroy()`.
- **Particle systems**: `Smoke.js` and `SmokeEffect.js` render their
  particles through `ParticleContainer` + `Particle` (wrapped in a plain
  `Container` per part, since `ParticleContainer` only accepts particles,
  not display objects). Per-particle simulation state (velocity, age,
  sway, …) lives in a parallel plain-object array alongside the `Particle`
  instances, since `Particle` has no `customData`. `ParticlePool.js` pools
  `Particle` instances for reuse; callers are responsible for calling
  `container.removeParticle(...)` before returning a particle to the pool.
  `ImpactEffect.js` stays on a plain `Container` + `Sprite` — at 2-4
  particles per shot, `ParticleContainer` overhead isn't worth it.

## Key invariants

- **Single PixiJS instance**: engine and plugin must share one PixiJS
  module instance at runtime. `pixi.js` is a peer dependency and is
  externalized from the client build (`vite.config.js`); the host page
  resolves it via an import map. Bundling a second copy in either side
  breaks interop between engine-owned renderer/filter systems and this
  plugin's PixiJS objects (bakers, `parts/`).
- **Motion replica parity**: authoritative motion (Rapier, in `core/`) and
  the client prediction replica share the tick formulas (`core/src/motion.rs`);
  integration parity is locked in by cargo tests (`client::predictor::parity`)
  — any edit to motion in the core or the `models.js` coefficients requires
  running `npm run core:test`.
- **Level rules live in `core/src/level.rs`** and are called by both sides:
  the authoritative `TanksSim::update_levels` and the client replica
  (`Predictor::step`) run the very same `step_level()` over the same
  `MapLevels`, with the same `coreParams.levels` (they reach the client core
  through `prediction.coreParams` in CONFIG_DATA). A second copy of the
  rules would drift from the authoritative level silently; the same holds
  for `ray_segments()` (`core/src/shot_levels.rs`) and shooting.
- The snapshot key schema (`src/config/snapshot.js`) is this plugin's data —
  an unregistered key breaks frame packing on both the host and the client.
- `ENGINE_API_VERSION` compatibility is checked by the engine at plugin load
  time (client and host); a mismatch is rejected before this plugin's bundle
  is even imported.

---

[Next: Gameplay →](gameplay.md)
