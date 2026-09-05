# Gameplay

A team-based tank deathmatch: two teams (`team1`, `team2`) fight round by
round, with a third "team" — spectators (`spectators`). All rules are
authoritative on the room host (the engine's
[host.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/host.md)).

## Player journey

1. **Connecting and auth** — the nick is not typed in; it comes from the player's lobby identity (the central auth service, verified by JWT), so the room's start page is informational (title + controls help) with just a **Start** button. The only form parameter is the tank model (default `m1`), validated on the host via `isValidModel`. The room limit (`maxPlayers`) is counted **by humans** (bots yield their slot); a full room replies with `roomFull`, there's no waiting queue (see the engine's host.md).
2. **Spectator** — once the map loads, the player enters the game as a spectator: sees the world, the camera follows the watched player, `n`/`p` switch the watch target. A team-selection window arrives right away.
3. **Team selection** — via the vote menu (`m` → Switch team). If the team has no free respawns, the host tries to evict a bot; otherwise the request is denied ("Team ... is full").
4. **Playing** — at round start the player gets a tank at a respawn. During the first `teamChangeGracePeriod` (10 s) of the round, a team change applies immediately; later, the player finishes the round (or leaves for the spectators), and the change takes effect next round.
5. **Death** — the player becomes a spectator until the round ends, and the camera switches to the killer.

## Rounds and victory

- A **round** lasts `roundTime` (2 minutes by default). Victory is a **team wipe**: eliminating every member of the enemy team (bots count). The winning team gets a team frag (`score +1` in the header), the losing team a loss (`deaths +1`); everyone hears the victory/defeat sound and sees "{team} WINS!".
- If the round time runs out with no winner, a new round starts without scoring.
- There's a `roundRestartDelay` (5 s) pause between rounds. At round start the world is recreated: everyone is alive, the panel resets to defaults, and respawns are handed out per team.
- A **map** lasts `mapTime` (10 minutes). When it runs out, the host automatically starts a vote for the next map (`mapsInVote` options); if nobody votes, the current map's time is extended.

## Stats (Tab)

Scoring rules (the engine's `RoundManager.reportKill`,
`packages/engine/src/host/meta/core/RoundManager.js`):

1. The eliminated player gets a loss (`deaths +1`) and a `dead` status until the round ends.
2. The player who eliminated an opponent gets a frag (`score +1`).
3. Eliminating a player on **your own** team loses you a frag (`score −1`).
4. A suicide is only a loss (`deaths +1`); frags don't change.
5. On a team wipe the winning team gets `score +1`, the losing team `deaths +1` (shown in the table header totals).
6. The `latency` column shows the player's current RTT (empty for bots).

Stat changes are broadcast the moment they happen; table sorting happens on the client (`score` descending, then `deaths` ascending). The columns themselves are this game's schema — [configuration.md](configuration.md#stats-stat).

## Votes (`m` key)

The engine's collective decision-making system (`Vote` + `VoteCoordinator`
in `packages/engine/src/host/meta/`):

- **Menu** — a window with "Switch team" and "Suggest map" entries.
- **Triggered by a player or by the system** — a player suggesting a map (if that player is the only one in the game, the map changes immediately, no vote), a vote for bots, an automatic map pick on timer.
- **Queue** — a vote created while another is active is queued and runs afterward.
- **Cooldown** — after a vote on a topic, a `timeBlockedVote` (30 s) lock prevents spam.
- **Lifetime** — `voteTime` (10 s); windows with `timeOff: true` (the menu) don't close on a timer.
- **Pagination** — lists longer than 7 are split into pages (Back/More).
- **Ties** — the winner is picked randomly among those tied for the max.

The vote mechanism is engine-owned; this game only supplies templates/menus
and creates dynamic votes (e.g. `/bot`) via
`ctx.voteCoordinator.createVote(...)`. Exchange format — the engine's
[network.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/network.md#vote-port-16).

## Chat (`c` key) and commands

Plain text is a message to the team/everyone (length capped by the host, 60 characters). Messages starting with `/` are commands. The engine parses none of its own: the `CommandProcessor` registry is filled entirely by the game through `HostPlugin.chatCommands` (`src/host/metaCommands.js` for the portable ones, `src/host/botCommand.js` for `/bot`), so the same `/timeleft` may be missing in another game:

| Command | Owner | Action |
| --- | --- | --- |
| `/name <nick>` | this game | Change name (with validation and a system message) |
| `/timeleft` | this game | Time remaining on the map |
| `/mapname` | this game | Current map's name |
| `/rank` | this game | Your current rank (loaded from the auth service) |
| `/bot <N> [team]` | this game | Spawn N bots (into a team, or spread evenly); `/bot 0 [team]` — remove bots |
| `/nr` | this game | New round — **dev mode only** |
| `/like <reason>` · `/unlike <reason>` | engine | Vote for/against the room's hoster (server rating) — **does not reach the host**, see below |

`/bot` is only available to active players. If more than one human is
active, a vote runs instead of immediate execution; executing the command
restarts the round.

**`/like <reason>` · `/unlike <reason>`** (the server rating) is the sole
anti-cheat measure: the browser host runs the simulation on its own machine
and can physically cheat (a modified client edits WASM memory bypassing the
core's logic), so moderation is social, not technical. The command is
intercepted **on the client** and goes straight to the master server over the
signaling WS (bypassing the host — its `CommandProcessor` could filter out a
vote against itself), not through the game protocol. A reason is required
(otherwise a local chat hint appears) and is never shown publicly. Available
only to guests of a room (the host player has no such option) and only to a
signed-in player — the vote carries their identity token; a disconnected
master connection shows an error message in chat. The master accepts a vote
only from a session that actually connected to that room, and proxies it to
the central auth service, which keeps one row per `(hoster, voter)` pair (an
opinion can change, `like`↔`unlike`, it doesn't accumulate) and recomputes
the hoster's score, clamped to `−10..10`. That score is what the server list
shows as the room's `rating`. On reaching `blockAt` (`−10`) the hoster is
blocked globally: their active rooms' signaling WS closes and they can't
register new ones (already connected P2P peers stay — there's no host
migration). Details — the engine's
[master.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/master.md#server-rating-likeunlike)
(server rating).

## Controls

The host switches the active key set by status (spectator/player):

- **Spectator**: `n` — next player, `p` — previous.
- **Player**: `w/s` — throttle/reverse, `a/d` — turn, `k/l` — turret rotation, `u` — center turret, `j` — fire, `n/p` — next/previous weapon.
- **Modes** (in any status): `c` — chat, `m` — vote, `Tab` — stats; `Esc`/`Enter` — control within modes.

Key layout is configured in `src/config/client.js` (`modules.controls`), commands and their types in `src/config/game.js` (`playerKeys`), see [configuration.md](configuration.md#keys-playerkeys).

## Weapons and the tank

The tank carries two weapons (switch with `n`/`p`, the active one is highlighted on the panel):

- **`w1` — bullet (hitscan)**: an instant ray, 40 damage, 1500 range, 200 ammo. The hit is computed by the host as a ray; the client draws the tracer instantly. A hit on a dynamic map body applies an impulse of `7500000` along the normalized shot direction — it does **not** scale with the weapon's range.
- **`w2` — bomb (explosive)**: a physical projectile, planted and detonating on a timer; 70 damage at the epicenter falling off over a 50 radius, 100 ammo. The blast impulse (`2000000`, with the same falloff) applies to every dynamic body in the radius — tanks and dynamic map objects alike; map objects take the push without damage.

Health is 100. The tank's `condition` visually degrades with damage (smoke), and it's destroyed at 0. Stats — [configuration.md](configuration.md#weaponsjs).

## Bridges and levels (2.5D)

A map may carry up to eight levels: the ground (0) and overhead floors
1..7. There is no jump key: the tank changes level only by driving.

- **Up and down a ramp.** A ramp is a directional run of ground tiles.
  Driving along it lifts the tank smoothly; the level snaps to the nearest
  whole one (0.5 is the border between floors). A single ramp may span
  several floors at once (0 → 2): while CLIMBING it the tank collides with
  the geometry of *every* level the run connects, so it neither falls
  through the bridge nor clips into the wall at the top. A tank merely
  driving under the run's cells (a `1 → 2` ramp sits above ordinary ground)
  stays on its own level with its own walls: a ground wall under a ramp
  cannot be driven through.
- **Slopes are felt.** Uphill the tank is slower (the speed ceiling drops
  with the grade) and on a steep climb with no throttle it rolls back
  down; downhill it picks up speed. The effect used to be a fraction of a
  percent: the grade was measured in "levels per pixel" while the constants
  were written for a dimensionless tangent. The grade is dimensionless now
  (the map's level height over the run's length), and a climb is actually
  felt. The grade follows the hull heading, so
  climbing at an angle is easier than head-on. The numbers are
  `climbGravity` and `climbMaxSpeedFactor` in
  [configuration.md](configuration.md#gamejs).
- **A climb is visible.** The tank rises out of the wedge: the shadow stays
  on the layer under it, the hull moves away from the shadow and grows with
  height by the same projection as the slab, and the wedge itself is drawn
  as a solid embankment with sides and a top end face. The hull no longer
  tilts and the tracks no longer kick dust — a grade recovered from the
  height between frames froze under a parked tank. To see it:
  `VITE_MAP='terraces' npm run dev`, team `team1`, whose first spawn point
  is the foot of the steep ramp facing west; hold `W`. At full throttle the
  climb lasts a third of a second. There is no
  level number above the tank — the level reads from another tank's ring in
  its level colour, the layer tinting on the radar, the dimming of levels
  below the player, the transparency of the slab above them, the shadow on
  the layer under the tank and the height parallax.
- **Ramps are entered from their ends.** A run lifts (or lowers) only the
  tank that drove in through the end matching its own level: from the foot
  going up, from the top going down. A tank that entered a ramp cell from
  the side — a cell near the top is often reachable straight off the
  ground — keeps its level, and the run behaves as ordinary flat ground for
  it until it leaves and comes back through an end. More than that: the
  run's sides and its "wrong" end are closed off — driving onto the wedge
  sideways, or in under it from the top, physically stops the tank. A legal
  climber does not see those barriers at all. A **wide** ramp — a rectangular
  block of ramp tiles — is driven through whole: the core cuts such a block
  into parallel lane runs, and changing lanes mid-climb keeps the climb
  going instead of being judged as a fresh entry. Lanes of DIFFERENT length
  (a stepped block) count as different ramps, and moving between them is
  judged by the gate as usual. The same holds for a
  spawn point placed on a ramp: it starts on the level the map geometry
  gives it, without a free ride upwards.
- **On the bridge.** Tanks on different levels ignore each other
  completely: a tank driving under the overpass will not bump into the one
  above it, and vice versa.
- **Off the ledge.** A bridge edge without railings is a ledge. Driving off
  it starts a fall. Tanks land on the nearest floor below that has a
  surface: dropping off level 2 over a level 1 slab lands on that slab, not
  on the ground. Time and damage scale with the height — 0.35 s and 15
  health per level, capped by `maxFallDamage` (100) per landing; while
  airborne the controls are dead and the tank coasts on inertia. While airborne it collides with
  the walls of every level and with nothing else — a tank, a crate, a ray
  or a blast does not reach it, but a building does, so a fall alongside
  one ends in front of the wall instead of inside it. A fatal landing
  counts as a suicide — the stats record a loss and nobody gets a frag.
- **Crates fall like tanks.** A dynamic map object follows the same level
  rules: pushed off a slab it falls along the same trajectory and lands on
  the nearest floor below that has a surface, changing its level (and with
  it whom it can push). Level 1 crates next to a gap in the railings are
  fine now — that is the intended way to drop one. Ramps are off limits to
  map bodies: they are pushed, not driven, so a crate keeps its level on a
  ramp cell.

### Shooting across levels

A ray always travels at the shooter's level and changes it only by these
rules:

| Situation | Rule |
| --- | --- |
| **Slab to slab** | While the ray is over a floor of its level it only hits targets of that level; railings block it. |
| **Downwards** | At the first cell without a floor of its level the ray drops to the nearest level below that still has one — over a hole in the level 2 slab it lands on level 1, not on the ground — and from there only hits targets of that level. The drop repeats level by level; the ray never climbs back. |
| **Ground to ground** | The ray travels at level 0; it passes freely under the bridge, and ground walls block it. |
| **Upwards** | In the very first cell that carries a floor of the nearest level above the shooter, the ray can hit a tank standing there — unless that cell is a railing of that level. Only the nearest level above is reachable: from the ground a tank on level 2 is never hit through the level 1 slab. The window is exactly that one cell wide and closes where the ray leaves it, so a tank standing on the second slab cell is already out of reach. Past it the slab shields everything and the ray continues at its own level. |
| **Tank on a ramp** | Visible to rays of every level the run connects. |
| **Falling tank** | Invulnerable: while airborne (0.35 s) neither rays nor explosions reach it. This is a rule, not a side effect — only map walls still stop it. |
| **Explosion** | Only hits targets on its own level — the slab shields it both upwards and downwards. |
| **Bomb** | Lands on its owner's level; if there is no floor of that level under the drop point (on a ramp, for instance), the bomb comes to rest on the nearest floor below it — on a three-level map that is the level 1 slab, not the ground. |

On a miss the tracer is drawn at the level in force at the **end** of the
ray, not at the last level it visited: a ground shot that grazes the bridge
ledge ends on the ground, not on the slab layer.

Which maps have levels and how they are authored — see
[extending.md](extending.md#new-map).

## HUD panel

Left to right: round time, health, `w1`/`w2` ammo (the active weapon is highlighted). Spectators see hidden values (an empty panel). Values reset to defaults every round.

## Bots

AI lives in this game's Rust core ([core.md](core.md)): bots are full participants —
they show up in stats, drive tanks, and shoot through the same input as
players. Navigation is the engine's grid-based pathfinding plus a spatial grid for target
search. Added via `/bot` or a vote; a bot is evicted when a human joins a
full team (also when a human connects past the combined `maxPlayers` limit).

On a 2.5D map (levels, ramps, bridges) a bot knows its own level:

- it paths through ramps — a route to the bridge goes over a ramp, because
  the nav graph carries level transitions as its own edges;
- it jumps off a ledge only when the shortcut is worth it — a ledge edge
  costs extra in the graph, since the landing costs health;
- while falling it is not steered at all, and the fall is not mistaken for
  being stuck;
- it prefers a target on its own level, and holds fire when the bridge slab
  shields the target — instead it drives towards it, over a ramp. A target
  its ray does reach is shot at even where the levels overlap, such as a
  ground enemy standing in the ledge window;
- it strafes after a shot only to a point walkable on its own level, and it
  steers around obstacles of its own level (railings above a bot on the
  ground are not obstacles).

What it does not do: it does not jump off a ledge to shorten a chase (only
when the path itself is shorter), it does not weigh its remaining health
against `fallDamage`, and it does not shoot at a level it cannot reach.

## Kicks

- **Idle**: a player with no input/chat for longer than `idleKickTimeout.player` (2 min) gets kicked (spectators don't, `null` by default).
- **Network**: a smoothed (EMA) latency above `maxLatency` (1000 ms — a threshold sized for P2P hosting over home connections) or `maxMissedPings` (5) consecutive missed pings closes the connection with a technical message.

These kick policies are engine mechanisms — see the engine's
[configuration.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/configuration.md#kicks-rtt-idlekicktimeout).

## Maps

`pool mini`, `canopy`, `garden` — tile-based maps with per-team respawns,
static geometry, and dynamic objects (sent in the snapshot). Changed by vote
or map timer. Adding a new one — [extending.md](extending.md#new-map).

---

[← Previous: Architecture](architecture.md) · [Next: Configuration →](configuration.md)
