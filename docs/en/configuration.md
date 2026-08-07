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
| `roomDefaults.maxPlayers` | `8` | The bounds for the lobby's room settings: caps the limit picked by the creator (also published in `GameManifest.roomDefaults`) |
| `roomForm` | 5 field descriptors | The room-creation form's schema (published as `GameManifest.roomForm`, engine forms v2): one descriptor per `roomDefaults` key (`maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `map`), each with a `control` (`text`/`checkbox`/`select`) and `label`; no `default` — the engine seeds values from `roomDefaults`. Time bounds (`roundTime`/`mapTime`) are in ms; `map` uses `source: 'maps'` so the engine supplies choices from the map catalog |
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
    m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
    w1: ['ShotEffect'],
    w2: ['Bomb'],
    w2e: ['ExplosionEffect'],
  }
  ```

  A single key can create several entities (a tank is drawn on the main
  canvas and the radar, plus smoke and tank tracks).

- **`entitiesOnCanvas`** — which canvas (`vimp` or `radar`) each class
  renders on. Entities can be subclassed and shown on different canvases
  (e.g. `MapRadar` — a simplified map for the radar).

- **`bakedAssets`** — procedural textures "baked" once at startup
  (`BakingProvider`, engine-owned mechanism): explosions, particles, smoke,
  the tank, the bomb, track marks, radar blips. Each entry: `name`
  (texture id), `component` (who owns it), `params` (generation
  parameters).

- **`componentDependencies`** — which services get injected into which
  components (`renderer` → Map; `soundManager` → ExplosionEffect,
  ShotEffect, Bomb, Tank).

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
the container the engine renders `params` controls into (engine forms v2;
there's no `formId` — the engine owns the `<form>` element). `params`
declares only this game's own field, `model` (a default value, `options`:
`control: 'select'` + `label: 'Model'` + the list of choices from
`models.js`, `validator: 'isValidModel'`, a `storage` key for
localStorage) — there's no field using the engine's `isValidName`.
`control` is required per field under engine forms v2: a field with an
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

## src/config/snapshot.js — the snapshot key schema

Registered as `HostPlugin.gameConfig.snapshot`: `m1`, `w1`, `w2`, `w2e`,
`c1`, `c2` → a numeric id + `kind`, which drives the block's byte layout
(the engine's schema-driven packer/unpacker, see
[core.md](core.md)). An unregistered key breaks frame packing. Full
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
| Other | `spread: 0`, costs 1 ammo | `size: 8`, explosion impulse `2000000`, effect `w2e` |
| Camera shake | 20px / 200ms | 30px / 400ms |

### maps/

Three maps: `pool mini` (small), `canopy`, `garden`. Each describes tile
layers (`layers`, `tiles`), respawn points (`respawns`), static
(`physicsStatic`) and dynamic (`physicsDynamic`) physics. Registration —
`src/data/maps/index.js`. How to add a map — see
[extending.md](extending.md#new-map).

---

[← Previous: Architecture](architecture.md) · [Next: Gameplay →](gameplay.md)
