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

- **`w1` — bullet (hitscan)**: an instant ray, 40 damage, 1500 range, 200 ammo, one shot per 0.3 s. The hit is computed by the host as a ray; the client draws the tracer instantly, with a tank-gun muzzle flash and, on a hit, a shell burst (flame, smoke and debris) at the hit point. A hit shoves a tank about 5 units — standing, starting off or driving (forward or in reverse), front, rear or side, on any surface — and turns it by at most a degree; a dynamic map body gets an impulse of `1750000` at the hit point. The impulse does **not** scale with the weapon's range.
- **`w2` — bomb (explosive)**: a physical projectile, planted and detonating on a 1 s timer; 70 damage at the epicenter falling off over a 50 radius, 100 ammo. The blast impulse (`2000000`, with the same falloff) applies to every dynamic body in the radius — tanks and dynamic map objects alike; ordinary map objects take the push without damage, destructible ones take damage too (see [Destructible objects](#destructible-objects)).

Health is 100. The tank's `condition` visually degrades with damage (smoke), and it's destroyed at 0. Stats — [configuration.md](configuration.md#weaponsjs).

A destroyed tank explodes: a flash, a fireball, sparks, a burst of black
smoke and an explosion sound of its own; the wreck is tossed up and nearby
tanks rock (render only: no extra damage and no push). The wreck then burns
for about 9 s, the fire dies down by about 14 s, and the lightening smoke
clears by about 30 s. At night the fire lights its surroundings with a
flickering glow. A scorch mark stays on the ground until the end of the round.
Timings and sizes — [configuration.md](configuration.md#wreck-fire-wreckfx).

The throttle is visible and audible: the exhaust over the pipe thickens with
the engine load (`engineLoad`) — from a shiver at idle to a dense plume at
full throttle — and pushing into a wall under throttle (`engineLoad > 1`)
adds dust from the spinning tracks and raises the engine's pitch. Damage
smoke runs on its own channel and does not follow the throttle.

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
- **A climb is visible.** The tank rises out of the wedge: the hull shifts
  and grows with height by the same projection as the slab under it, and the
  wedge itself is drawn as a solid embankment with sides and a top end face.
  There is no shadow on a climb: the shadow marks a tank that has LEFT its
  support, and it appears only in a jump or a fall. The hull TILTS with
  it: nose up on a climb, nose down on a descent, rolled onto one side
  across the slope, and in flight the nose follows the vertical speed. The
  angles (`pitch`/`roll`) are computed by the host from the grade under the
  tracks and carried in the frame, so the tilt does not die under a tank
  parked on a ramp and other tanks are tilted just like your own. (The tilt
  used to be recovered on the client from the height delta between frames —
  that delta is zero under a parked tank, the tilt froze, and the scheme was
  dropped; hence the frame fields instead of a client-side computation.) How
  strongly the tilt reads on screen is set by `tilt` in
  [configuration.md](configuration.md#renderjs). To see it:
  `VITE_MAP='terraces' npm run dev`, team `team1`, whose first spawn point
  is the foot of the steep ramp facing west; hold `W`. At full throttle the
  climb lasts a third of a second. There is no
  level number above the tank — the level reads from another tank's ring in
  its level colour, the layer tinting on the radar, the dimming of levels
  below the player, the transparency of the slab above them and the height
  parallax; in flight the shadow's gap from the hull joins them.
- **Ramps are entered at their ends, from any direction.** A run lifts (or
  lowers) only the tank that drove into an END CELL matching its own level:
  the foot cell takes tanks of the lower level, the top cell tanks of the
  upper one. HOW the tank got there does not matter — head-on, at an angle
  or from the side all count, so a hill can be taken on the diagonal. Two
  limits keep that from becoming a lift: a tank entering across the axis
  must be standing at its own level's height (not stuck halfway up another
  run), and the ramp's height at the entry point must be LESS than half a
  level above it (`coreParams.levels.maxSideEntryRise`; exactly half a
  level is already refused). A tank that drove into the MIDDLE of a run keeps its
  level, and the run behaves as ordinary flat ground for it until it leaves
  and comes back through an end. The middle is closed off physically too:
  the run's side rails start one cell past the foot, and its "wrong" end is
  capped, so driving onto the wedge sideways mid-climb, or in under it from
  the top, stops the tank. A legal climber does not see those barriers at
  all — leaving a run sideways is always allowed. A **wide** ramp — a rectangular
  block of ramp tiles — is driven through whole: the core cuts such a block
  into parallel lane runs, and changing lanes mid-climb — diagonally
  included — keeps the climb going instead of being judged as a fresh
  entry. Lanes of DIFFERENT length
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
  on the ground. The fall is BALLISTIC: the height is integrated
  (`vz -= g·dt`) instead of being played back linearly. Gravity is derived
  from `fallTime`, so a one-level drop still takes the same 0.35 s — but a
  two-level one is faster than twice that. Damage is charged for the
  levels ABOVE the dead zone only — `fallDamage` (30) per level beyond
  `fallDamageFreeHeight` (0.5), capped by `maxFallDamage` (100) per
  landing — so a ramp jump, whose whole arc is lower than the dead zone,
  is free, while a drop of exactly one level costs the usual 15 health.
  Deeper falls cost MORE than they used to, and not proportionally: the
  dead zone makes the curve steeper, so two levels cost 45 instead of 30
  and four levels reach `maxFallDamage` and kill.
  The height is measured from the ARC'S PEAK rather than from the take-off
  level: a tank thrown upwards by a jump pays for the climb too. Only driving is dead
  while airborne — **the turret turns and the gun fires**. As long as the
  tank is `jumpClearance` above the level it left, it does not even see
  walls and flies over obstacles; below that the walls of every level are
  back, so a fall alongside a building ends in front of it instead of
  inside it. With the shipped settings that clearance is unreachable: the
  arc is capped at 0.375 of a level by `maxLaunchVz` and `jumpClearance` is
  0.45, so flying over walls remains a core mechanic that no regular jump
  triggers — the railings hold, and so does the map's perimeter. Tanks, crates, rays and blasts never reach a tank in the air.
  A fatal landing counts as a suicide — the stats record a loss and nobody
  gets a frag. A hard touchdown SHAKES THE CAMERA of the tank that landed
  (the `levels.landingShake` rule; the shake is authoritative and comes from
  the host, just like a weapon's): its strength scales with the vertical
  speed at contact and is capped by `intensity`. A soft touchdown (|vz|
  below `minImpact`) leaves the camera alone — the very same threshold at
  which the client gives no squash, no dust and no thud, so stepping off an
  edge stays calm.
- **Off the ramp.** Leaving a run's top end at speed throws the tank into
  the air: the vertical speed at the exit is the grade times the speed along
  it (`rampLaunchFactor`), and the jump only starts if that exceeds
  `minLaunchVz` and is capped at `maxLaunchVz`. A gentle ramp therefore
  gives no jump at all, a steep one at full throttle does, and the steepest
  run on the map jumps no higher than the cap allows — 0.375 of a level.
  Landing back on the tank's own level deals no damage (the arc is lower
  than `fallDamageFreeHeight`); the touchdown squashes the hull, kicks dust from
  the tracks and thuds. To see it: `VITE_MAP='terraces' npm run dev`, team
  `team1`, its first spawn point, hold `W`.
- **Crates fall like tanks.** A dynamic map object follows the same level
  rules: pushed off a slab it falls along the same trajectory and lands on
  the nearest floor below that has a surface, changing its level (and with
  it whom it can push). Level 1 crates next to a gap in the railings are
  fine now — that is the intended way to drop one. Ramps are off limits to
  map bodies: they are pushed, not driven, so a crate keeps its level on a
  ramp cell.

### Shooting across levels

A bullet flies at the shooter's gun height, as in GTA 2, and hits only what
reaches that height:

| Situation | Rule |
| --- | --- |
| **Slab to slab** | While the ray is over a floor of its level it only hits targets of that level; railings block it. A shot over another slab of the same level (a second bridge) travels on it just the same. |
| **Off a slab** | The bullet does not drop to the level below. Over a cell without a floor of its level it flies on at gun height: it passes over tanks, crates and walls lower than itself and hits only what reaches it — a wall taller than the bullet or a tank at the very top of a ramp. The tracer stays at the height of the level it was fired from. |
| **Ground to ground** | The ray travels at level 0; it passes freely under the bridge, and ground walls block it. |
| **Upwards** | A bullet from below never reaches a tank on a slab above, not even on its very edge: it flies under the slab. Only a ramp leads up. |
| **Tank on a ramp** | Visible to bullets of every level the run connects, if the bullet reaches it over the embankment and does not pass above it. |
| **Ramp embankment** | A bullet flies at the shooter's gun height; on a slope the barrel follows the slope. A ramp's slope and sides stop it wherever the embankment is higher than the bullet. So a tank high up a ramp cannot be hit from the ground, a tank at its foot can, and a side shot hits the embankment face at gun height. A shot fired up the slope flies on over the slab the ramp leads to. |
| **Tank on a slope** | Its bullet flies at its own gun height above the slope, so shooting sideways it passes over tanks standing on the ground below — the mirror of the embankment rule. Its bullet never passes through a slab: fired down a ramp that stands on a terrace, it stays on the terrace. |
| **Tank in the air** | Invulnerable: while airborne neither rays nor explosions reach it. This is a rule, not a side effect — only map walls still stop it. It does SHOOT, though: only driving is locked in flight. |
| **Explosion** | Only hits targets on its own level — the slab shields it both upwards and downwards. |
| **Bomb** | Lands on its owner's level; if there is no floor of that level under the drop point (on a ramp, for instance), the bomb comes to rest on the nearest floor below it — on a three-level map that is the level 1 slab, not the ground. |

On a miss the tracer's end is drawn at the height the bullet flies at the
**end** of the ray: a shot from a bridge over the ground ends at bridge
height, not on the ground.

Which maps have levels and how they are authored — see
[extending.md](extending.md#new-map).

## Surfaces

A map may lay surfaces on its tiles. A surface acts on the level it is laid on
(a conveyor under a bridge does not move a tank on the bridge), and a tank in
flight feels none of them.

- **Sand and mud** — weaker thrust, a lower speed ceiling and extra drag; mud
  is heavier.
- **Water** (shallow) — moderate drag and a loss of thrust. A tank in water
  splashes: quietly when standing, louder and higher-pitched at speed.
- **Oil** — almost no lateral grip or braking and sharper turns: the tank
  skids and spins. The tracks stay oily after you drive off: the skid fades
  out over 1.5 seconds, and the tank leaves oily marks for as long.
- **Conveyor** — a moving floor along its arrow. A standing tank is carried:
  hard across the hull (the tracks' side grip holds it to the belt), barely
  along it.
- **Boost plate** — a one-off push along the arrow when you drive onto the
  plate in the arrow's direction (from 20 units/s). Crossing the cells of one
  plate pushes once; driving against the arrow does nothing. After the push the
  tank keeps the extra speed for about a second (`boostTime`): its speed
  ceiling is raised and the speed does not melt away, the gas keeps
  accelerating. In the air the hold only runs down. Crates and barrels get the
  push but not the hold.

Each track feels its own ground: with one track in mud, the tank pulls toward
the mud. Wrecks are carried and slowed the same way. Crates and barrels ride
belts, slow down in sand, mud and water and get the boost push too (felt at
their centre); oil does nothing to them. Bots do not take surfaces
into account. The values — [configuration.md](configuration.md#core-parameters).

## Destructible objects

A map may make some of its objects destructible:

- **Fence** — little health: a bullet or ramming it at speed breaks it. The
  debris does not block the way.
- **Crate** — sturdy: bullets do half damage, blasts one and a half. It shows
  a "damaged" stage before it breaks; the debris does not block the way. A
  ram at full speed damages a crate, a second one breaks it.
- **Barrel** — little health; destroyed, it explodes: damage and a push around
  it and a camera shake. A barrel caught in another blast goes off after a
  short delay (0.15 s), so barrels standing together make a chain reaction.
  The blast does not care about teams, and a death from it counts as a
  suicide — nobody gets the frag. Ramming a barrel at full speed blows it
  up, and the blast hits the rammer too.

Ramming counts only the impact speed along the contact at the moment it
starts: driving into a fence at speed breaks it, pushing it slowly does not,
and the tank itself takes no damage. A blast reaches only objects on its own
level. Everything destroyed is restored at the start of every round.

Bots know nothing about destruction: their navigation graph is static, so a
broken fence does not open a new route for them. The values —
[configuration.md](configuration.md#core-parameters).

## HUD panel

Left to right: round time, health, `w1`/`w2` ammo (the active weapon is highlighted). Spectators see hidden values (an empty panel). Values reset to defaults every round.

## Bots

AI lives in this game's Rust core ([core.md](core.md)): bots are full participants —
they show up in stats, drive tanks, and shoot through the same input as
players. Navigation is the engine's grid-based pathfinding. Added via
`/bot` or a vote; a bot is evicted when a human joins a full team (also
when a human connects past the combined `maxPlayers` limit).

How a bot knows about enemies:

- like a player from the radar, it knows where every living enemy is — but
  with a delay (it "glances at the radar" every `radarInterval`) and an
  error (`radarNoise`), and without their speed;
- only an enemy it sees (a clear line of sight within 900 units; a bot on a
  bridge also sees tanks below it) is known exactly: its position, speed
  and hull condition;
- it remembers which enemy aims at it and which one wounded it last.

How a bot picks a target: by route distance, visibility (a visible target
it can shoot at weighs most), threat (an enemy aiming at it or the one that
just wounded it), how damaged the enemy is, and its own level. It keeps a
chosen target for a while instead of flickering between two, unless another
enemy has just wounded it. It chases a target it does not see to where the
radar shows it, now and then pausing to look around. It does not shoot when
a teammate or a crate stands in the line of fire.

How a bot drives:

- it always follows a route over the engine's nav graph, and the route fits
  its hull — it does not squeeze through gaps narrower than the tank or
  scrape along walls, and it cuts corners only where a hull-wide corridor
  is clear;
- chasing an enemy behind a wall, it drives that route instead of straight
  at the target;
- when it runs into a wall it backs off, turns and re-plans the route
  around the spot; a fence or crate in its way is shot through, and after
  repeated failures it gives up the goal and picks another;
- a watchdog re-plans a bot that has not moved for 5 s (a bot standing
  still while shooting at a visible target is not stuck).

On a 2.5D map (levels, ramps, bridges) a bot knows its own level:

- it paths through ramps — a route to the bridge goes over a ramp, because
  the nav graph carries level transitions as its own edges. It enters a
  ramp head-on: it first lines up with the run in front of its foot, since
  the entry gate lets a tank onto the run only from its end;
- it jumps off a ledge when the route down is shorter — a ledge edge costs
  extra in the graph, since the landing costs health. An aggressive bot
  that is healthy enough to afford the landing (`fallDamage`) jumps more
  readily in a chase; a wounded one does not;
- while falling it is not steered at all, and the fall is not mistaken for
  being stuck; if it lands somewhere unexpected it re-plans;
- it prefers a target on its own level, and holds fire when the bridge slab
  shields the target — instead it drives towards it, over a ramp. A target
  its bullet does reach is shot at; one the bullet would pass over or
  under — a ground tank for a bot on a bridge or high on a ramp, a tank on
  a bridge for a bot on the ground — is not;
- it weaves in a fight only to points walkable on its own level — except
  that in the heat of a fight it may drive off a bridge edge (`edgeRisk`)
  — and it steers around obstacles of its own level (railings above a bot
  on the ground are not obstacles).

What it does not do: it does not shoot at a level it cannot reach, does not
take surfaces (oil, ice, boosts) into account, does not know that a fence or
a crate has been destroyed (its nav graph is static) and does not use the
chat.

### Combat

A bot aims and shoots like a player, with the same keys:

- it reacts to a new target with a delay (`reactionTime`; faster if its gun
  was already pointing where the target appeared), and first it misses: the
  aim error (`aimError`, larger for a target crossing its view) fades while
  it keeps tracking (`aimSettleTime`). On top of it the aim trembles
  (`aimTremor`), jumps off after every shot, and is worse while the bot is
  driving or the target moves fast across its view;
- it pulls the trigger once the barrel is close enough to the target
  (`fireTolerance` — above 1 it also fires while the barrel is still just
  beside the target, so it misses);
- it fires in bursts (`burstShots`, `shotInterval`) with pauses between them
  (`burstPause`); it fires on the move too, at a visible target in its line
  of fire, but when attacking only within its combat distance
  (`preferredRange` max × 1.3): a target seen farther away it drives up to
  first; in an ambush or on a retreat, and at an enemy that has hit it
  within the last 3 seconds, it returns fire at any distance;
  sometimes it fires one blind shot at a target that has just
  ducked behind a wall (`panicFire`);
- the turret turns at most `maxGunAngle` from the hull: a target beyond it
  makes the bot turn its hull first.

How a bot moves in a fight: it closes in when the target is farther than
`preferredRange`, backs off in reverse, facing it, when the target is
closer (an aggressive bot instead closes in for a bomb), and weaves inside
the range — at about 61° to the line to the target, so the target stays
within the turret's arc. It switches the weaving side every 1.5–3 s, when
it bumps into something and (except `easy`) when the target aims at it; a
teammate or a crate in the line of fire makes it move at once — it does
not shoot a crate. In the heat of a fight it may drive off a bridge edge
(`edgeRisk`) and take the fall damage.

The bomb (`w2`, dropped under itself) is used only point-blank: the enemy
closer than 0.8 of the blast radius, on the bot's level, and only if its
own bomb cannot hurt it (`friendlyFire` off) — with `friendlyFire` on, only
a very aggressive bot with health to spare, and never while a teammate on
its level could drive into the blast before the bomb goes off. It then
drives away from the
bomb for a second and takes the gun back. With no gun ammo left (and no
enemy within the bomb's reach) a bot retreats.

### Teamwork

- A bot knows where its teammates are — humans included — and how battered
  their hulls look (it sees hulls, not health).
- The team shares a focus: the enemy closest to the team, seen by the most
  of its bots and the most damaged. Bots prefer it as a target, so they hit
  the same tank; the focus changes only when another enemy is clearly
  better (and not within 3 s of the last change).
- Roles: with three bots or more, the most aggressive one flanks — its
  route avoids the straight line from the team to the focus and comes out
  from the side; a wounded bot (health below 50) supports — it hangs back
  about 200 units behind the nearest teammate on the line to the target
  and joins the fight only at a visible target. The rest assault.
- A bot that has run far ahead of the team (350 units closer to the target
  than the team's centre) without an advantage waits: it drives back
  towards the team's centre and resumes the chase after at most 4 s.
- It does not shoot through teammates (a teammate in the line of fire makes
  it move), steps aside from a teammate nearby, and in a fight weaves away
  from a teammate closer than 120 units.
- When a visible enemy wounds it while it is driving around, chasing or
  regrouping, it turns on the attacker at once. Damage from its own fall or
  its own bomb is not blamed on an enemy.

### Retreat and defence

A bot retreats when:

- its health is at or below `retreatHealth` and it is under fire (wounded
  within 4 s or a visible enemy within 450 units); a very aggressive bot
  (`aggression` above 0.8) holds out longer — down to 0.6 of that;
- the enemy is stronger nearby (the strength ratio within 350 units is below
  `retreatAdvantage`) and its health is below 70;
- it has nothing left to fight with.

Where to: behind the nearest teammate who is farther from the threats, into
cover (a point within 5–8 tiles that no threat can see), home (its spawn
point) or — on a bridge, with health to spare for the landing — down off
the edge. The candidates are compared by the route around the threats, and
a point next to teammates is preferred, one a threat can see is avoided.
With a visible enemy behind it the bot backs away in reverse, facing it,
and fires back — with a worse aim than usual; an enemy chasing it closer
than 60 units gets a bomb.

At the retreat point (or once no threat has been seen for 2 s and a
teammate is near) the bot holds the position: it stands, keeps the
threat within the turret's arc with its gun already pointing where the
enemy is expected (so it reacts faster when the enemy shows up), fires at
a visible enemy and now and then shifts a tile aside if the new spot is
still covered. It goes back to the chase when the hold time is over and
the forces are even, or at once when teammates push forward; an enemy
coming close is engaged; a bot finished off in its cover (health below 20)
retreats again to another spot.

## Kicks

- **Idle**: a player with no input/chat for longer than `idleKickTimeout.player` (2 min) gets kicked (spectators don't, `null` by default).
- **Network**: a smoothed (EMA) latency above `maxLatency` (1000 ms — a threshold sized for P2P hosting over home connections) or `maxMissedPings` (5) consecutive missed pings closes the connection with a technical message.

These kick policies are engine mechanisms — see the engine's
[configuration.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/configuration.md#kicks-rtt-idlekicktimeout).

## Maps

`pool mini`, `canopy`, `garden` — tile-based maps with per-team respawns,
static geometry, and dynamic objects (sent in the snapshot). Changed by vote
or map timer. Adding a new one — [extending.md](extending.md#new-map).

`downtown` — a night city on two levels that uses every map mechanic:

- **West and east** — the team bases, eight respawn points each, and a
  `GUNS` sign on the roof of each base.
- **Neon Strip** (centre) — a crossing with an oil slick in its middle,
  lamps on the corners and neon signs on the roofs.
- **The overpass** runs along the avenue between the northern districts and
  the centre, with a ramp at each end and two gaps in its railings.
- **The industrial yard** (north-west) — two conveyors running towards each
  other, crates, a group of barrels that go off in a chain, rooftop fans.
- **The construction site** (north-east) — patches of sand and mud, two
  lines of fences with short detours around them, crates.
- **The canal** (south) — shallow water across the whole map, two bridges
  with ramps, barrels by the canal wall and a ford with a boost plate on the
  southern bank that throws a tank north through the water.
- **The jump** (west of the centre) — a boost plate in front of a ramp onto a
  rooftop car park; the boosted jump lands on the roof.

Destroyed fences, crates and barrels are restored at the start of every
round.

---

[← Previous: Architecture](architecture.md) · [Next: Configuration →](configuration.md)
