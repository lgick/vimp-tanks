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

A map may carry a second level — an overpass over the ground. There is no
jump key: the tank changes level only by driving.

- **Up and down a ramp.** A ramp is a directional run of ground tiles.
  Driving along it lifts the tank smoothly; halfway up it starts belonging
  to the upper level. While on the ramp the tank collides with the geometry
  of *both* levels, so it neither falls through the bridge nor clips into
  the wall at the top.
- **On the bridge.** Tanks on different levels ignore each other
  completely: a tank driving under the overpass will not bump into the one
  above it, and vice versa.
- **Off the ledge.** A bridge edge without railings is a ledge. Driving off
  it starts a fall: controls are dead for 0.35 s, the tank coasts on
  inertia and collides with nothing, and the landing costs 15 health. A
  fatal landing counts as a suicide — the stats record a loss and nobody
  gets a frag.

### Shooting across levels

A ray always travels at the shooter's level and changes it only by these
rules:

| Situation | Rule |
| --- | --- |
| **Bridge to bridge** | While the ray is over the slab it only hits level 1 targets; railings block it. |
| **Bridge to ground** | At the first cell without a slab the ray drops to the ground and from there only hits level 0 targets. It never climbs back. |
| **Ground to ground** | The ray travels at level 0; it passes freely under the bridge, and ground walls block it. |
| **Ground to bridge** | In the very first slab cell it enters, the ray can hit a level 1 tank — unless that cell is a railing. Past it the slab shields everything and the ray continues along the ground. |
| **Tank on a ramp** | Visible to rays of both levels. |
| **Falling tank** | Invulnerable: while airborne (0.35 s) neither rays nor explosions reach it. This is a rule, not a side effect. |
| **Explosion** | Only hits targets on its own level — the slab shields it both upwards and downwards. |
| **Bomb** | Lands on its owner's level; if there is no slab of that level under the drop point (on a ramp, for instance), the bomb ends up on the ground. |

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
  shields the target — instead it drives towards it, over a ramp;
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
