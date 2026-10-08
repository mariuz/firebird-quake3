# How Firebird Quake III Arena works

This is the long version of the README's "How it works": the whole pipeline from the `.pk3` on disk to
the pixels on the canvas, table by table and procedure by procedure, with the numbers that matter and
the reasons behind the odd choices. It is written for whoever works on the project next, human or
agent. [ROADMAP.md](ROADMAP.md) lists what the real Quake III engine has that this port does not; the
[README](../README.md) has the short tour and the Firebird lessons.

Everything that is *game* lives in the database. JavaScript reads the pak, loads the tables, forwards
the keyboard and mouse, paints what the queries return and plays what they say to play. There is no
game state in JavaScript beyond the particle systems and the explosion sprites, which are cosmetic.

```
pak0.pk3 ──(src/pk3.js, bsp.js, md3.js, shader.js, image.js)──▶ src/loader.js ──▶ Firebird tables
                                                                                     │
keyboard/mouse ──▶ SELECT * FROM q3_tic(tics, fwd, side, yaw, pitch, fire, jump, run, imp) ─┤ 20 Hz
                                                                                     │
canvas ◀── src/renderer.js | renderer-gl.js ◀── src/scene.js ◀── SELECT * FROM frame_all(...) ┘ every frame
```

Contents

1. [The pieces](#1-the-pieces)
2. [Loading: from the pak to the tables](#2-loading-from-the-pak-to-the-tables)
3. [The schema](#3-the-schema)
4. [Collision: `physics.sql`](#4-collision-physicssql)
5. [The game tic: `game.sql`, `player.sql`, `bots.sql`](#5-the-game-tic)
6. [The bots](#6-the-bots)
7. [The waypoint graph: `waypoints.sql`](#7-the-waypoint-graph-waypointssql)
8. [The frame: `render.sql`](#8-the-frame-rendersql)
9. [Painting: the software and WebGL renderers](#9-painting)
10. [Sound](#10-sound)
11. [The page and the loop: `main.js`](#11-the-page-and-the-loop)
12. [Testing, benchmarking, deploying](#12-testing-benchmarking-deploying)
13. [Performance](#13-performance)
14. [Firebird PSQL: the rules learnt the hard way](#14-firebird-psql-the-rules-learnt-the-hard-way)

---

## 1. The pieces

| Path | Lines | What it is |
| --- | --- | --- |
| `sql/schema.sql` | 415 | Every table: the map, the entities, the player, the events |
| `sql/physics.sql` | 971 | BSP point and box traces, entity linking, the movers' physics (slide, step, toss) |
| `sql/game.sql` | 1494 | Utilities, movers, triggers, targets, items, damage, projectiles, map spawning |
| `sql/waypoints.sql` | 446 | The bots' navigation graph: nodes, edges, routing |
| `sql/player.sql` | 631 | The weapons, the player's think, respawn, death |
| `sql/bots.sql` | 912 | Bot AI, pushers, the think and physics dispatchers, `q3_tic`, `init_map` |
| `sql/render.sql` | 390 | View setup, PVS marking, `frame_all` |
| `src/pk3.js` | 204 | Zip reader with a pure-JS inflate (no `node:zlib`, see §2) |
| `src/bsp.js` | 435 | IBSP 46 parser, Bézier tessellation, facet brushes, PVS, light grid |
| `src/md3.js` | 123 | MD3 models, `animation.cfg`, `.skin` files |
| `src/shader.js` | 147 | Shader scripts reduced to a "look" per surface |
| `src/image.js` | 117 | TGA and JPEG (jpeg-js) to `Uint32` ABGR pixels, mip halving |
| `src/gamedata.js` | 71 | `bg_itemlist`, the weapons' models and timings, the bot roster |
| `src/loader.js` | 277 | Schema creation, bulk loading, resources, `loadMap`, `buildWaypoints` |
| `src/scene.js` | 210 | Turns `frame_all` rows into draw calls; effects state |
| `src/renderer.js` | 914 | The software rasteriser (32-bit, z-buffer, perspective-correct spans) |
| `src/renderer-gl.js` | 670 | The WebGL 2 painter, same interface |
| `src/hud.js` | 131 | Status bar, icons, messages, crosshair, scoreboard |
| `src/audio.js` | 274 | Web Audio: events, loops, speakers, music |
| `src/main.js` | 383 | Boot, settings, input, the loop, the SQL console |
| `scripts/*.mjs` | | Fetch the pak, build, test, bench, screenshot (§12) |
| `public/` | | `index.html`, `style.css`, `coi-serviceworker.js`, the pak and music folders |

Order matters for the SQL files: `src/loader.js` lists them as `SQL_FILES = ['schema', 'physics',
'game', 'waypoints', 'player', 'bots', 'render']`, and a procedure may only reference functions and
procedures created before it (or forward-declared: `game.sql` opens with a dozen empty
`CREATE OR ALTER PROCEDURE … AS BEGIN END` stubs for the procedures that call each other across files).

---

## 2. Loading: from the pak to the tables

**The data.** The Quake III Arena demo's `pak0.pk3` (46 MB) may be freely redistributed.
`scripts/fetch-pak.mjs` downloads the Linux demo installer (`linuxq3ademo-1.11-6.x86.gz.sh`), finds the
gzip stream inside the shell script (offset 5468), walks the tar and writes `public/pak/pak0.pk3`. The
demo has four arenas (q3dm1, q3dm7, q3dm17, q3tourney2), no grenade launcher or BFG models and no
music. A registered `pak0.pk3` can be dropped in through the page's file input and everything else
works the same.

**The zip.** `src/pk3.js` reads the central directory and inflates entries on demand with its own
inflate, because esbuild's es2020 target rejects the top-level `await import('node:zlib')` that the
Node fallback needed. `inflateAll(filter)` inflates everything the game needs up front;
`imageName(name)` tries `.tga` then `.jpg` for a shader's image.

**The BSP.** `src/bsp.js` reads the 17 lumps of IBSP version 46. Beyond copying arrays it does four
things:

- *Tessellates the Bézier patches* twice: at `RENDER_LEVEL = 4` subdivisions per 3×3 control grid for
  drawing, and at `COLLIDE_LEVEL = 2` for collision, where every triangle becomes a one-sided *facet
  brush* with a surface plane and three border planes (what `cm_patch.c` does). Quake III's triangles
  are clockwise seen from the front, so the front normal is `cross(c − a, b − a)` and each border plane
  is `cross(n, edge)`.
- *Builds the faces* as convex polygons in vertex order (planar faces) or triangle lists (patches,
  meshes), each with a plane, a bounding sphere, a `twoSided` flag and its lightmap index; vertices are
  `Float32Array` with stride 10: `x y z s t u v r g b`.
- *Decompresses the PVS* into one hex string per cluster, so the SQL can test visibility with
  `SUBSTRING` and `BIN_AND` on a `VARCHAR`.
- *Keeps the light grid* (64×64×128 cells of ambient and directed colour) in JavaScript, where the
  models are lit, because the game never needs it.

**Models and resources.** `src/md3.js` parses MD3 (frames, per-frame tags with origin and axis,
surfaces with packed lat/lng normals), `animation.cfg` (the legs frames are rebased past the torso's,
as `CG_ParseAnimationFile` does) and `.skin` files. `src/shader.js` reads every `scripts/*.shader`
once and reduces each shader to a *look*: the image to draw, how to blend it (opaque, blend, add,
filter), whether it is lightmapped, its tcMods (scroll, scale, turb), its animation frames, and for
skies the cloud layers. `src/loader.js`'s `loadResources` loads every MD3 the items, weapons and
players need, the sprites (as models of kind `S`), the player models with their animations and skins,
and inserts `item_defs` (from `src/gamedata.js`'s copy of `bg_itemlist`) and `bot_defs`.

**Bulk loading.** The `TABLES` spec in `loader.js` generates a `LOAD_<table>` procedure per geometry
table that takes a packed text blob and inserts rows in one call. `loadMap` runs `geometryRows` over
the BSP, loads nodes, leaves, leaffaces, leafbrushes (rebuilt to include the facets: the loader walks
the tree and links each facet into every leaf its box touches), brushes, brushsides, faces,
face_verts, textures, models and `map_ents` (the entity lump parsed into columns), then calls
`init_map(name, world_model_id, skill, new_game, bots)`. On q3dm1 that is about 1.3 s in Node.

---

## 3. The schema

The tables fall into four groups.

**The map** (loaded once per arena, never changed): `nodes` (plane, children), `leaves` (cluster,
contents = the OR of its brushes, bounds, the PVS as hex), `leaffaces`, `leafbrushes`, `brushes`
(contents, bounds, `facet` flag), `brushsides` (plane, surface flags), `faces` (type, plane, sphere,
texture, lightmap, first vertex, count, `twosided`), `face_verts`, `textures` (name, surface and
content flags), `models` (world and sub-models with their head node; MD3s and sprites with their
bounds and frame count), `map_ents` (the entity lump: classname, targetname, target, team, model,
origin, angles, spawnflags, message, wait, delay, random, speed, lip, height, health, light, dmg,
count, noise, phase, gravity, music, notfree, nobots).

**The simulation**: `map_list` (the pak's arenas in rotation order), `game` (one row: tic, time, map, skill, gravity, sky, music, frag and time limits, the time warnings said, match
state, number of bots), `ents` (one wide row per entity: position, velocity, angles, bounds, solid,
movetype, clipmask, flags, health, owner/enemy/goal, think and nextthink, the mover fields, item,
the two "p" vectors used as launch velocity or mover endpoints, player-model and animation fields,
bot fields, visibility cache, water state), `player` (the local player's inventory, ammo, weapon
state, view offsets, damage feedback, powerup timers, messages, scores, movement feedback such as
`onground` and `move_speed`), `bot_defs`, `item_defs`, and the waypoint tables of §7.

**Events out** (append-only, read by the frame query with a high-water mark): `sound_events` (name,
position or entity, volume, attenuation), `fx_events` (kind, position, direction, count), `messages`
(console lines).

**Render state**: `viewcfg` (width, height, fov), `vis_faces` (the faces marked for the current
cluster), the temporary tables `sel_faces` and `clip_planes`.

`ents.flags` is Quake's `FL_*` (1 fly, 2 swim, 8 inwater, 16 godmode, 32 bot, 64 notarget, 512
onground, 1024 partialground, 2048 teamslave, 4096 noknockback). `solid` is 0 not solid, 1 trigger
(touched, not collided), 2 bounding box, 3 BSP brush model, 4 rotating brush model. Weapons are bits:
1 gauntlet, 2 machinegun, 4 shotgun, 8 grenade launcher, 16 rocket launcher, 32 lightning gun, 64
railgun, 128 plasma gun, 256 BFG. Contents and masks are Quake III's: `MASK_SOLID` 1,
`MASK_PLAYERSOLID` 33619969, `MASK_DEADSOLID` 65537, `MASK_WATER` 56, `MASK_OPAQUE` 25, `MASK_SHOT`
100663297; `CONTENTS_BODY` 33554432, `CONTENTS_CORPSE` 67108864.

---

## 4. Collision: `physics.sql`

A trace is a recursive procedure, as in `cm_trace.c`:

- `point_leaf(x, y, z)` walks the tree to the leaf; `point_contents` ORs the brushes of that leaf that
  contain the point (a brush "contains" a point when it is behind every side's plane).
- `rhc` is `CM_TraceThroughTree`: at every node the moving box's extents push the split plane out by
  the box's projection on the normal, the segment is split at the plane, and both sides are visited,
  nearest first. In each leaf `clip_leaf` clips the segment against every brush and facet whose
  contents match the mask (`CM_TraceThroughBrush`): enter and leave fractions across the sides, the
  nearest entering plane wins. Facets are one-sided: a facet never reports `startsolid`, otherwise a
  box under a curved floor would be trapped in it.
- `trace_hull` runs `rhc` from a head node; brush models have no tree of their own, so each one gets
  a leaf, reached as a negative head node `-(leaf + 1)`, and `trace_box` transforms the segment into a
  rotated model's frame when it has angles.
- `trace_move(mover, mins, maxs, from, to, mask)` is `SV_Trace`: the world, then every brush model
  (doors, plats) and every bounding-box entity (players, bots, corpses when the mask asks for them)
  whose box overlaps the segment's box, except the mover and its owner. It returns fraction, end
  point, plane normal, surface flags, contents, `allsolid`, `startsolid` and the entity hit. One
  world trace costs on the order of 0.3 to 1 ms in Firebird WASM, which is the number every other
  design decision bends around.

On top of the trace:

- `link_ent` finds the leaf, cluster and list of clusters an entity's box touches (for the PVS) and
  caches them in `ents`; `check_water` sets the water level and type.
- `clip_velocity` is `PM_ClipVelocity` with `OVERCLIP = 1.001`.
- `fly_move` is `PM_SlideMove`: up to four bumps, the clip planes collected in the `clip_planes`
  temporary table, velocity clipped against each, the crease handled with the cross product.
- `walk_move` is `PM_StepSlideMove`: the slide, then try again 18 units up and settle down; the player
  uses it with `PM_GroundTrace` (a quarter unit down every tic, which is what makes friction stable on
  flat floors; see the README's lessons).
- `move_step(eid, dx, dy, dz)` is Quake 2's `SV_movestep` for bots: a horizontal step that must end on
  the ground, with the 18-unit stair try; `toss_move` is `MOVETYPE_TOSS/BOUNCE` for grenades and gibs
  (grenades bounce at ×0.65).

The player's numbers are Quake III's: run 320 units a second (walk 160 with Shift), ground
acceleration 10, air acceleration 1, friction 6, jump 270, gravity 800, step 18, box −15..15 by
−24..32, view height 26; crouched, the box −24..16, the view 12, the walk ×0.25.

The movement matches `bg_pmove.c` as its client runs it, at 8 ms a frame (`pmove_fixed`), although the
tic is 50 ms. `player_think` runs friction, acceleration and gravity in six substeps a tic, the yaw
turning through the tic as the mouse did. It then runs the collision move once, with the average
velocity of the six (no more traces), and keeps the sixth's velocity with whatever the walls took off
the average taken off it too. Gravity is integrated as `PM_SlideMove` does it, the step moved by its
average speed (the trapezoid: Euler at 50 ms lost 6.5 units of every jump's 45.5 and made jump pads fall
short of what `AimAtTarget` aimed at; the bots in the air and `toss_move` do the same now). The wish
speed is `PM_CmdScale`'s, with the jump or crouch key among the keys (holding jump in the air takes air
control away; a jump held on the ground does not count), the crouch's quarter speed a cap after it, and
a knock (`t_damage` for the player) leaves 50 to 200 ms without ground friction and with air
acceleration (`PMF_TIME_KNOCKBACK`), which is what carries a rocket jump.

Walking is `PM_WalkMove`'s on any floor, not only a flat one: friction works on the horizontal speed and
scales all three, forward and right are clipped onto the ground plane before the acceleration (so the
wish direction runs along a ramp), and the velocity is then clipped onto the plane and given back the
speed it had ("don't decrease velocity when going up or down a slope"): 320 along a ramp, its horizontal
share the normal's z. A `SURF_SLICK` floor has no friction and air acceleration, and gravity still pulls
there and through a knock. On the ground the substeps' average has no trapezoid (the move is along the
plane, `PM_StepSlideMove` without gravity), and the tic's end velocity is clipped by the ground plane
again, as `PM_SlideMove` clips its `endVelocity`: what the step move took off the average must not leave
the velocity steeper than the ramp, where the next ground check (`vz > 0` and into the air by more than
10) would count it as leaving the ground. A landing clips the end velocity by the floor too, or what is
left of the fall would be turned along the ground by the next `PM_WalkMove`'s rescale.

A landing is `PM_CrashLand`'s, once a tic, after the move:
an airborne tic that ends on the ground (a second ground trace, as `PmoveSingle` makes) calls `crash_land`
with the tic's starting vertical speed and the height it fell, which solves for the speed at the moment
of contact as `bg_pmove.c` does and squares it (`delta = v² / 10000`); crouched doubles it, knee-deep water
halves it, waist-deep quarters it, the head under or a `SURF_NODAMAGE` floor cancels it. Above 60 it is
10 damage and the model's `*fall1`, above 40 5 damage and its `*pain100_1` (the normal pain sound held
back for 200 ms, `pain_debounce_time`), above 7 the `land1` thud, below that a footstep; the view dips
24, 16 or 8 units with them. The bots in the air land the same way in `run_physics`. `scripts/pmove-test.mjs`
checks all of it against a JavaScript reference of `bg_pmove`'s open-ground part at 8 ms, on q3dm17's
open floor: start-up, stopping, standing, running, strafe and held-jump arcs, crouch-walking, a
knock. Every quantity agrees within 0.2. It also drops the player from 30, 100, 300 and 450 units and
from 150 crouched, where Quake III's `delta` is exactly 0.16 of the height, and checks the damage, the
dip and the sounds of each; builds a turning platform (a brush, its own leaf, a model headed by the
leaf, a `func_rotating`) and rides it a quarter turn, and stands beside it to be swept round; and runs
up and down the ramp beside q3dm17's jump pad at x −312 (normal
(0, 0.447, 0.894)): 320 along it, 286.2 across the ground, on the ground every tic.

---

## 5. The game tic

`q3_tic(tics, fwd, side, yaw_d, pitch_d, fire, jump, run, imp)` in `bots.sql` runs `tics` tics of
50 ms (the loop asks for one or two, never more, so a slow machine plays in slow motion rather than
stalling) and returns one row with everything the HUD needs: health, armour, ammo, weapon, frags,
position and angles, view height, dead, match state, `onground`, `move_speed`, the weapon's loop
sound, the lead state. Each tic:

1. advances `game.time_` and the tic counter;
2. `player_think` (`player.sql`): angles from the mouse, `view_vectors`, the water and ground state,
   `PM_CheckDuck` (the `jump` argument is Quake III's upmove: 1 jumps, −1 crouches; crouched, the box
   is 16 high instead of 32 and the eye 12 above the origin instead of 26, kept in `player.ducked`,
   `view_ofs`, `ents.maxz` and `viewheight`; the player stands up again only where a trace of the
   standing box fits), `PM_WalkMove` / `PM_AirMove` / `PM_WaterMove` through `walk_move` and
   `fly_move` (a crouching walk at a quarter of the speed, `pm_duckScale`; −1 swims down), jumping and
   landing with their sounds, the legs animation (run, back, idle, crouch-walk `LEGS_WALKCR`,
   crouch-idle `LEGS_IDLECR`, jump, land), footsteps on a distance clock but never while crouched, drowning, lava and slime damage, item and
   trigger touching through `touch_triggers`, weapon switching with Quake III's raise/drop timing
   (`weaponstate`, `pending_weapon`), firing through `player_fire`, the impulses (1–9 weapons, 12/14
   cycle, 13 holdable, 99 give all), powerup timers, health decay above the maximum;
   A spectator (`player.spectator`, the page's *Spectate* button calling `set_spectator`, Quake III's
   `SetTeam`) leaves the match by dying first if alive (a suicide, a frag less) and comes back at a spawn
   point; `make_spectator` puts it at the intermission point (`intermission_point`, shared with the
   intermission's camera) with no body, no weapon and `FL_NOTARGET`, which the bots' target search and
   enemy check honour, clipped by the world only (`clipmask` 65537). Free, `player_think` flies it
   (`PM_FlyMove`: friction 5, acceleration 8 toward the wish velocity in three dimensions, jump and
   crouch for up and down, no gravity) and lets it touch only teleporters (which neither telefrag nor
   flash for it) and doors. Fire on the press cycles through the bots to follow (`follow_cycle`), jump
   lets go and leaves it where the one followed was (`stop_following`); following, `q3_tic` and
   `view_setup` take the eye, the angles, the health, the armour and the gun from the followed bot, and
   `frame_all` does not draw it. A spectator is not ranked at the time limit and stays one into the
   next arena.
3. `run_pushers`: every mover (`movetype` 7) moves along its `calc_move` track and pushes what stands
   on it or in its way (`push_move`, the pushed set kept in the `pushed` temporary table so a blocked
   mover can put everything back, as `G_MoverPush` does); doors reverse when blocked and crush at
   `dmg`; bobbing platforms, pendulums and rotating things have their own `*_think`. A turning mover
   first finds who stands on it (a one-unit trace down that hits it: Quake III's `groundEntityNum`),
   turns, then carries those riders and anything its new pose is inside round its origin by the turn
   (`angle_matrix` of the turn, model to world), and adds the yaw to players' and bots' facing
   (`delta_angles[YAW]`); one that cannot go leaves it where it was if the turn left it clear, or else
   everything goes back and `mover_blocked` runs. The player's share of the turn comes back from
   `q3_tic` as `mover_yaw` a tic, and the page turns the view on with it between tics;
4. `run_think`: every entity whose `nextthink` has come, dispatched by the `think` name: `bot_think`,
   `item_respawn`, `missile_explode`, the door, plat, button and train states, `timer_think`,
   `speaker_think`, `remove`;
5. `run_physics`: the projectiles (`launch_missile` sets a straight velocity; grenades `toss_move`),
   the gibs and corpses, `impact` when something hits, `missile_explode` with `t_radius_damage`;
6. the match: before it, the page's four-second countdown (`init_map`'s `warmup`; `CG_DrawWarmup`): "prepare to
   fight", then three, two, one a second apart and "fight!" from `check_exit_rules`, the bots standing and
   nobody firing until then, the match's clock counting from "fight!". The rewards are `give_award`'s
   (`player_die` and `weapon_railgun_fire` in g_combat.c and g_weapon.c): a gauntlet frag (and
   "humiliation" for its victim too), a frag within 3 s of the last (`CARNAGE_REWARD_TIME`: excellent),
   two railgun hits on players in a row (`fire_rail` counts `rail_hits`, a miss resets it: impressive).
   Each counts on the entity, sets `award` and `award_time`, plays the announcer for the player; the
   HUD shows the medal for 3 s, as many times as it was earned (`CG_DrawReward`), the frame query sets
   an `EF_AWARD_*` bit for 2 s so the painter floats the medal over the earner's head, and the
   intermission's scoreboard shows the player's medals of the match. Then `score_frag` keeps the
   scoreboard (through `add_score`, Quake III's `AddScore`), announces the lead changes and the frags left, and
   ends the match at the frag limit. *Team deathmatch* (`game.gametype` 3, `GT_TEAM`, from the page's
   Game setting through `init_map`) puts everyone on a team (`ents.pteam` 1 red, 2 blue): the player on
   the one asked for, the bots by `pick_team` (`PickTeam`: the smaller team, on a tie the one behind,
   else blue), in the model's `red` or `blue` skin. `on_same_team` is `OnSameTeam`: `t_damage` lets a
   teammate's knock through and returns before the damage (friendly fire off), `bot_find_target`
   skips teammates, and `bot_fire` holds its fire when a box-less shot trace from the eye meets a
   teammate first (`BotCheckAttack`). `add_score` adds every frag to the team's score too
   (`game.red_score`, `blue_score`); a frag of a teammate costs one, like a suicide. In a team game
   `score_frag` announces the team lead instead ("red leads", "blue leads", "teams are tied",
   `game.team_lead`), the fraglimit is the team's ("Red hit the fraglimit."), and the time limit's
   tie is the teams'; the winner is "Red team" or "Blue team" and the win music plays for its side.
   `q3_tic` returns `gametype`, `red_score`, `blue_score` and the player's `team`; the HUD's corner
   shows the two scores with ours marked, and `scoreboard` returns each row's team so the page lists
   the teams under their names and scores. The *tournament* (`gametype` 1, `GT_TOURNAMENT`) has two
   play and the others wait as spectators: the player through `player.spectator`, a bot through
   `ents.queued` (`bot_to_queue`: invisible, not solid, `FL_NOTARGET`, its think idling), each with
   `spec_time` (`sess.spectatorTime`). `init_map` lets the first two who came play. `tourney_check`
   (`CheckTournament`, from `check_exit_rules` every tic) queues a third who came in at the console,
   pulls the one who waited longest when fewer than two play (`tourney_pull`, `AddTournamentPlayer`),
   shows "Waiting for players" with the countdown held off (`warmup_end` 1e9) while there are not two,
   and once there are, clears the scores and starts the countdown with "prepare to fight" and "You vs
   Daemia". `end_match` adds a win to the first of the two (`duel_ranked`) and a loss to the second
   (`AdjustTournamentScores`, `ents.wins`, `losses`). The intermission ends through `exit_level`
   (`ExitLevel`, for the fire after five seconds and the thirty-second timeout alike): any other game
   type sets `exit_kind` for the page to load the next arena; a tournament sends the second of the two
   to the back of the queue (`RemoveTournamentLoser`) and restarts in place (`map_restart`: the items
   back, nothing in flight, the winner respawned, the next pulled in by `tourney_check`). Asking to
   play while two play leaves the player waiting. The ranking, the lead and the limits leave the
   waiting bots out; the scoreboard lists them as team 3 in queue order, with wins and losses; `check_exit_rules` (Quake III's `CheckExitRules`) runs after
   every tic for the time limit: "five minutes" and "one minute" once each (`game.time_warnings`),
   and at the limit either the leader wins or, with the lead tied (`ScoreIsTied`, the player and the
   bots compared), play goes on as sudden death, announced two seconds in, until a frag breaks the
   tie. Both limits end in `end_match`: `match_over`, `winner`, `over_time`, the win or loss music,
   `next_map` (the arena after this one in `map_list`, the pak's maps in natural order, wrapping
   round) and `begin_intermission`, which is `BeginIntermission` with `FindIntermissionPoint` and
   `MoveClientToIntermission`: the player, revived if dead, is put where the eye is the map's first
   `info_player_intermission`, looking at its target (or along its angle, or from a spawn point when
   the map has none), not solid and not moving; the bots vanish (`alpha` 1, as Quake III removes the
   clients' models) and stop thinking. `CheckIntermissionExit`: fire after five seconds, or thirty
   seconds of nobody pressing, sets `exit_kind` 1, and the page loads `next_map` (or the same arena
   with the page's *Rotate* box unticked; `exit_kind` 3 is a plain restart). The limits come from
   `init_map`'s last two arguments (frag limit 20 and no time limit by default; the page passes its
   settings, and changes them live with an `UPDATE game`, as the cvars take effect at once).

The weapons (`player.sql`) are `g_weapon.c` with its numbers: `fire_bullets` with Quake III's spread
(machinegun 200, shotgun 700 over 11 pellets), `fire_rail` (a trace that goes through players and
spawns the rail effect), `fire_lightning` (768 range, 8 damage every 50 ms), `fire_gauntlet`, the
missiles (rocket 900 units a second, plasma 2000, grenade tossed at 700, BFG 2000) through
`launch_missile`/`launch_grenade`, `fire_time` per weapon (gauntlet 400 ms, machinegun 100, shotgun
1000, grenade 800, rocket 800, lightning 50, rail 1500, plasma 100, BFG 200). `fire_weapon(shooter,
w, origin, dir, vol)` is shared by the player and the bots; `muzzle` computes the muzzle point from
the eye and the weapon's offset.

Damage (`game.sql`) is `g_combat.c`: `t_damage(target, inflictor, attacker, damage, knockback, flags,
mod)` with the knockback velocity, godmode, the battle suit, half the damage when hurting yourself
(after the knock is worked out from the whole of it, "so rocket jumping works"), armour absorbing 66 percent, quad ×3,
pain sounds by health, `killed` → `player_die`/`bot_die` into a corpse (`CONTENTS_CORPSE`, the death
animation chosen at random) or `gib_ent` under −40 health with a shower of `throw_gib`; the
`obituary` function knows the 20-odd means of death and their sentences ("was railed by", "almost
dodged … rocket", "does a back flip into the lava"). `t_radius_damage` is the splash: damage falls off
linearly with distance, a trace checks that the target is not behind a wall.

Items (`item_touch`) are `g_items.c`: health counts above the maximum and decays, armour caps at 200,
weapons give their ammo, every item respawns after the `respawn` time `item_defs` copied from
`bg_itemlist`, powerups stack their time, holdables (medkit, teleporter) wait for the Enter key (the
teleporter sends you to a `select_spawn` spot, as `Use_Teleporter` does); `item_respawn` makes the
item solid again and plays the respawn sound; a picked-up item is not drawn because `alpha = 1`
hides it from the frame query.

Map entities (`spawn_map_ents`) turn every `map_ents` row into a live `ents` row: `func_door` with an
auto-spawned `door_trigger` box (`Think_SpawnNewDoorTrigger`), `func_plat` with its `plat_trigger`,
`func_button`, `func_train` with its `path_corner`s, `func_bobbing`, `func_pendulum`,
`func_rotating`, `func_static`, `func_timer`, `trigger_multiple`/`once`/`hurt`/`push`/`teleport`
(a jump pad computes its launch velocity from its `target_position` the way `AimAtTarget` does and
stores it in `p1x..p1z`), `target_speaker`, `target_print`, `target_give`, `target_kill`,
`target_delay`, `target_relay`, `target_teleporter`, `target_remove_powerups`, `target_score`, the
items, `info_player_deathmatch` (`select_spawn` picks one not within 128 units of anyone, as
`SelectRandomDeathmatchSpawnPoint` does); `use_targets` and `trigger_fire` are `G_UseTargets` with
delays and the `wait`/`random` timing.

---

## 6. The bots

`bot_think` runs every 100 ms per bot on staggered clocks (a think costs 5 to 9 ms, mostly traces).
A think:

1. respawns a dead bot after its delay (`bot_respawn` puts it at a `select_spawn` spot with the
   default weapons and the skill's turn speed), and touches triggers and items where it stands;
2. keeps or drops its enemy: dropped when dead or unseen for `bot_char(skill, 'search')` seconds
   (3 to 7); a new one is noticed by `bot_find_target` once a second, within the skill's alertness
   range and field of view (unless very close) and in sight (`visible`, a trace between the eyes);
   a newly noticed enemy is not shot at before the skill's reaction time has passed;
3. with an enemy: faces it (`change_yaw`, the yaw speed per skill), picks a weapon for the distance
   (`bot_best_weapon`: gauntlet when touching, shotgun and lightning close, rockets and rail far),
   goes for a health item when hurt, hunts the enemy along the waypoint graph when it is out of sight
   or on another floor (`bot_follow_route`, §7) or chases it straight when visible and far
   (`move_to_goal`, Quake 2's `M_MoveToGoal` with `new_chase_dir` trying the sides), circle-strafes
   when close (switching sides when blocked or at random), hesitates and pauses by skill, and fires
   when facing within 25 degrees (`bot_fire` with the skill's aim scatter, leading rockets only from
   skill 3);
4. with nothing in sight: roams to an item chosen within 1800 units (weapons, armour and powerups
   weigh more), along the graph, or wanders with random turns when there is no route;
5. sets the legs animation from what happened (jump in the air, run when it moved, idle otherwise).

`bot_char(skill, key)` is the five skill levels' characteristics boiled down from the original bot
files: reaction 2.0/1.5/0.8/0.4/0.15 s, aim scatter 0.14 down to 0.012 of the distance, alertness
range 900 + 800×skill, field of view (cosine 0.5 at skill 1, everything at 5), turn speed, strafe,
hesitate and pause probabilities, speed 26/29/32 units per think (the player's 32 from skill 3), and
how long it searches. Measured with a standing player (`.prof/fair.mjs`): skill 1 first kills after
about two minutes, skill 2 after 25 s, skill 5 after 5 s.

`spawn_bot(name)` adds a bot from `bot_defs` (Sarge, Grunt, Major, Visor, Daemia, Stripe with their
models and skins); the page's console has an "add Visor" button.

---

**Chat** is botlib's, from the pak's own `botfiles/` (`src/botchat.js` reads them as `be_ai_chat.c`
and `be_ai_char.c` do; the loader puts them in three tables):

- `bot_rnd`: the random strings of `rnd.c` (`HELLO5 = { "Awright!! I OWN this arena!"; … }`, 2205 of them)
- `bot_chat`: each bot's lines by type from its `_t.c` (762 for the six demo bots); the team chats of
  `#include "teamplay.h"` are left out
- `bot_chatchar`: the chat characteristics of its `_c.c` for skills 1 to 5, interpolated between the
  skills the file defines (`BotInterpolateCharacters`)

A message is a template: the file's comma-joined pieces become literal text, `{0}` … `{7}` for the
numbered variables and `{r:NAME}` for a random string. `bot_say` picks a line of the type, draws the
random strings until none is left (they nest: `fighter` inside `DEATH_INSULT2`), fills the variables,
takes out the tildes and the `^n` colour codes, and says it ("Daemia: La venganza es dulce.") with
`sound/player/talk.wav`. `bot_chat_event` is the `BotChat_*` functions of `ai_chat.c`: what each event
says and with which variables, how likely by the bot's characteristic, and no more than once in 25
seconds a bot (`TIME_BETWEENCHATTING`) except at a level's start and end:

| Event | Hook | Types | Variables |
| --- | --- | --- | --- |
| a level starts | `init_map` | `level_start` | 0 own name |
| a bot joins a running game | `spawn_bot` | `game_enter` | 0 own, 1 a random opponent, 4 the map's title |
| the match ends | `end_match` | `level_end_victory` (first), `level_end_lose` (last), `level_end` | 0 own, 1 random opponent, 3 the last (victory) or the first, 4 map |
| the bot dies | `bot_die` | `death_drown`, `_slime`, `_lava`, `_cratered`, `_suicide`, `_telefrag` (0 a random opponent); `death_gauntlet`, `_rail`, `_bfg` half the time for those weapons; else `death_insult` or `death_praise` by its insult characteristic | 0 killer, 1 weapon |
| the bot kills | `score_frag` | `kill_gauntlet`, `kill_rail`, `kill_telefrag`, else `kill_insult` or `kill_praise` | 0 victim |
| its enemy kills itself | `score_frag` | `enemy_suicide` | 0 enemy |
| it is hit and lives | `bot_pain` | `hit_nodeath` | 0 shooter, 1 weapon |
| it hits and does not kill | `t_damage` | `hit_nokill` (at half the characteristic) | 0 victim, 1 weapon |
| nothing to fight | `bot_think`, one think in 200 | `random_misc` or `random_insult` | 0 random opponent, 1 own, 4 map, 5 a random weapon |

The player is called by `player.name` (the page's *Name*, "Player" by default). Not done: the synonym
substitution of `syn.c`, the typing delay (Quake III's bots stand still for the seconds it takes to type
at their `CHAT_CPM`), the chat balloon and `hit_talking`, and replies to what the player says. The HUD
wraps long console lines.

## 7. The waypoint graph: `waypoints.sql`

Quake III's bots navigate an *area awareness system* (AAS) compiled offline from the map. This port
builds the part a deathmatch bot needs at run time, in SQL, with the same traces the game uses:

**Nodes** (`waypoints`: position of a standing player's origin, `kind`, the entity it stands for).
`build_waypoints`, called by `init_map`, puts one at every spawn point (kind 1), item (2), jump pad
(3) and its landing (4), teleporter (5) and its destination (6). The pad's landing is found by flying
its arc: Quake III's `AimAtTarget` makes the `target_position` the *apex* of the throw, so the flight
continues past it with the pad's horizontal velocity, falling at 800 units/s², traced with the player
box every 50 ms until it lands, and `wp_floor` settles that spot. Then `wp_build_chunk` scans a
128-unit grid: down every column from the first open air (`point_leaf` says the cluster is not solid)
a point trace finds the floor (`wp_drop`; on a slope the box is settled onto it so the node sits where
a player's box would rest, on its uphill corner), `wp_stand` checks it is in the world, not lava,
slime or a `trigger_hurt` (the void of q3dm17) and that the box fits, and the scan goes on from under
that floor to find the next level. A floor the box does not fit on is tried 40 units to each side (a
wall beside the column), a column that finds nothing is tried 56 units to each side (corridors).
`wp_add` merges anything within 64 units of an existing node.

**Edges** (`wp_edges`: `a → b`, length, kind 0 walk / 1 jump pad / 2 teleporter / 3 drop / 4 rocket jump).
`wp_link_chunk` links each node to its ten nearest neighbours within 420 units, and then to the four
nearest on a lower level (the ten are all on the node's own level when the grid is dense, and a
ledge needs its way down), when `wp_walkable` says a player can get there: first a straight box
trace with the floor probed at a third and two thirds of the way (no pits, no lava); if that fails
and the two are on one level, a chest-height point trace rules out walls at once; otherwise a
*stepped walk* of 40-unit steps, each one tried 18 units up (three times for stairs and ramps) and
settled onto the floor below with a drop of up to 400 units allowed (a fall that hurts a little, the
AAS's "jump down"), which must end within 48 units of the target. A flat walk is stored both ways; a
drop is one way. Pads and teleporters get their edges when their nodes are made. Last, each node
(not a pad or a teleporter) gets up to two *rocket-jump* edges (the AAS's `TRAVEL_ROCKETJUMP`), one
way, to nodes 60 to 220 units higher and at least 48 to the side, six tried at most, when
`wp_rocket_jump` agrees: a floor a shot hits under the start (player clip lets a rocket through), the
reach of the flight (680 a second up once the rocket's knock is in, measured: a 300-unit apex; down
at gravity; across with the bots' air control, 16 a tic up to 320, with a fifth to spare), and room
for it: a box trace up from the start, across at the top, down onto the end. q3dm1 has 8, q3dm7 85,
q3dm17 2; building them adds nothing measurable to the edge time.

**Routing.** `wp_nearest(x, y, z, see)` finds the node nearest a spot (height weighted ×4), the
nearest *in sight* for the bot's own position. `wp_route(src, dst, rj)` is a breadth-first search (over
the rocket jumps only with `rj` 1, the travel flags with `TFL_ROCKETJUMP`): the
frontier is the `wp_visit` global temporary table, each level inserted with one `INSERT … SELECT`
from the edges of the previous level, stopping when the destination appears (40 levels at most), the
path walked back through `prev` into a string `,n1,n2,…,dst,`. A route costs 1 to 4 ms.

**Following.** `bot_follow_route(eid, target, dist)` in `bots.sql` keeps one row per bot in
`bot_routes` (target entity, its node, the path, when it was built, consecutive failed steps). It
re-routes when the target changed, moved to another node (not more than every 0.7 s), the path ran
out or was blocked three times, and every 4 s anyway; it pops every node reached (within 40 units,
200 for a pad landing, looking up to four nodes ahead because a pad lands a bot past the pad's own
node), steps toward the next node (trying 35 degrees to either side when blocked), and walks straight
at the target when at its node. When the next node is down a ledge and the step refuses to walk off
the edge (`move_step` wants ground under its feet, as Quake 2's did), the bot *jumps down*: its
velocity is set toward the node at run speed and `run_physics` flies it to the floor, the AAS's
jump-down reachability. It also keeps the nearest it has been to its next node; no progress for
1.5 s means it is stuck on something the steps slide along (a corpse, a mover, a corner), so it
sidesteps and re-routes. A bot that can and wants to rocket-jump (`bot_can_rj`, Quake III's
`BotCanAndWantsToRocketJump`: the launcher, 60 health and 90 unless it has 40 armour, no quad, a
`CHARACTERISTIC_WEAPONJUMPING` of 0.5 or more, read from its character file with the chat ones) routes
a second time over the rocket jumps and takes that route when there is no walk or the walk is a dozen
nodes longer (the AAS rates a rocket jump at five seconds). `bot_routes.last_node` remembers the node
last reached; when the edge from it to the next one is a rocket jump, the bot walks onto its start,
slowing as it nears it, then `bot_rocket_jump` (`BotTravel_RocketJump`) faces the landing, raises the
launcher, looks straight down, jumps and fires. In the flight `run_physics` calls `bot_air_steer`
(`BotFinishTravel_WeaponJump`): the horizontal velocity that would put it over the landing as it comes
down to it, approached at the air acceleration. The rocket takes 45 health of 100 (half of its 90), and
the bot lands within a few units of the node. Stepping onto a jump pad's node puts the bot in the pad's trigger;
`touch_triggers` launches it at the next think and, in the air, it only aims. The bot's think uses
routes to hunt an enemy out of sight or on another floor, to reach a health item, and to roam between
items; it falls back to the straight chase when there is no route.

**When it is built.** The entity nodes take 0.2 s at load. The grid scan (3 to 7 s) and the edges
(2 to 6 s) would double the load time, so the page runs `wp_build_chunk(3, 2)` once a frame (three
columns, then two nodes' edges) and shows "bots mapping the arena (N to go)" in the stats line; the
graph is complete 10 to 30 s into play (the chunk shrinks to one column or node when the last one
took over 40 ms). The Node scripts' `loadMap` finishes it synchronously unless
told `link: false` (screenshots do not need it). Sizes: q3dm1 172 nodes and 1170 edges; q3dm7 532
and 3700; q3dm17 287 nodes, 2880 edges, 12 pad edges and 3 teleporter edges; every spawn point can
route to every other on all three.

**Known limits.** No jumping across gaps and no air control except in a rocket jump, so on q3dm17 the
platforms reached only by steering off the vertical boost pad stay out of the bots' reach; nodes on
roofs and other sealed pockets are harmless islands. The bots test also puts a bot at the start of a
rocket-jump edge no walk replaces (q3dm1 has them; q3dm17's two have walks) and checks it gets there. The bots test runs the hunt from the farthest spawn on
q3dm1 and q3dm17 (four runs in a row pass on each; the criterion is "within 350 units", where a bot
in sight starts to circle-strafe instead of closing in). The page's console has a `waypoints` button and a `bot
routes` button; `SELECT wp_route(a, b) FROM rdb$database` asks for a route by hand.

---

## 8. The frame: `render.sql`

`frame_all(mode, last_sound, last_fx, want_speakers)` returns everything the page needs for one frame
in one result set. Every row has a `kind`, a few integer and double columns and a string, read
positionally by `src/scene.js`:

| kind | what | columns used |
| --- | --- | --- |
| 1 | the visible faces of a model (world or brush model) | entity id, origin, `lst` = face ids joined with commas |

`frame_all(mode, last_sound, last_fx, want_speakers [, vx, vy, vz, vyaw, vpitch, vfov])`: the optional
parameters are the eye to use instead of the player's (the page passes its predicted and kicked view)
and the field of view instead of `viewcfg`'s (the zoom); the Node scripts leave them out.
| 8 | (mode 1) one projected vertex | face id, screen x y z, s t u v, colour |
| 2 | an entity to draw (MD3 item, sprite, player model) | id, model, frame, weapon, effects, pose, legs and torso clocks, `pmodel/skin`, `legs_anim,torso_anim,health,classname` |
| 4 | a sound event newer than `last_sound` | id, name, position, volume, attenuation, entity |
| 5 | an effect newer than `last_fx` | id, kind, position, direction, count |
| 6 | the pose of a rotated brush model | id, pitch, yaw, roll |
| 7 | (every 10th frame) the `target_speaker`s audible now | `lst` = ids |
| 9 | a console line | id, time, text |
| 10 | the eye the frame was culled for (always the first row) | x y z in `d1..d3` |

How the faces are found: `view_setup` reads the player's eye and angles into `viewcfg`;
`mark_faces` runs once per cluster the eye enters and fills `vis_faces` with every face of every leaf
whose cluster is in the eye's PVS (`R_MarkLeaves`), with its plane and bounding sphere; `frame_faces_fast`
then scans `vis_faces` with the back-face test (the eye in front of the plane, or two-sided) and the
frustum test against the sphere as plain expressions, and `LIST()`s the ids into one row. Brush models
add a row each at their own origin, with their own PVS test through `clusters_visible`. Mode 1
(`frame_faces`) projects every vertex in SQL too (the "SQL projects every vertex" renderer option);
it is slower and exists to make the point. `frame_ents` is the entity half: MD3 and sprite models and
player models in the PVS (`pvs_visible` between the eye's cluster and the entity's cached clusters),
with the item bob and rotation left to the painter.

---

## 9. Painting

Both painters implement the same interface (`setSize`, `setResources`, `setSky`, `setBrightness`,
`beginFrame`, `drawFaceList`, `drawMd3`, `drawPlayer`, `drawSprite`, `drawBeam`, particles, the 2D
calls, `present(tint)`), and `src/scene.js` drives either: the first-person view, the faces, the entities (items bob 4 units and rotate, as `CG_Item` does), the player models
hung on their tags (`tag_torso`, `tag_head`, `tag_weapon`), the sprites, the explosions and beams
kept in `FrameState` from the effects of earlier frames, the view weapon from the `_hand.md3` with a
minimum ambient light of 96 (`RF_MINLIGHT`) and the muzzle flash, and the screen tint from damage,
powerups and water.

**The first-person view** (`firstPersonView` in `src/scene.js`: `CG_OffsetFirstPersonView`,
`CG_DamageFeedback`, `CG_CalculateWeaponPosition`) is what the view does on top of where the player
is, cosmetic state kept in `FrameState.kick`:

- *The kick of a hit.* `t_damage` records where a hit on the player came from in `player.dmg_x/y/z`
  (the inflictor, a rocket where it blew up or the shooter of a bullet, else the attacker) and sets
  `dmg_world` for damage from no direction (falling, lava, slime, drowning, crushing, hurt
  triggers). When the tic row's `DMG_TIME` changes, the view swings by 5 to 10 degrees (more the
  lower the health, `40 / health` of the damage): pitched up for a hit from the front, down from
  behind, rolled toward the side it came from, straight up from the world; in over 100 ms and back
  over 400.
- *The dip of a landing.* `impact` sets `player.land_change` to −8, −16 or −24 by the fall
  (`EV_FALL_SHORT`, `MEDIUM`, `FAR`); the eye drops that far in 150 ms and comes back in 300, the gun
  a quarter as far.
- *The lean of the run:* pitch with the forward speed (×0.002, `cg_runpitch`), roll against the
  sideways one (×0.005, `cg_runroll`), from the tic row's `VX`, `VY`.
- *The bob:* a phase that advances like `PM_Footsteps`' `bobCycle` (0.4 a millisecond running, 0.3
  walking, 0.5 crouched, 128 to a step; held in the air, reset standing still) gives `bobfracsin`,
  which tips the pitch and swings the roll a step each way (×0.002 of the speed, three times
  crouched) and lifts the eye up to 6 units (×0.005).
- *The gun* follows the view, kicks and all, swaying with the steps and drifting at rest. It hangs on
  the `tag_weapon` of the weapon's `_hand.md3`, whose 16 frames are played from the torso's animation
  as `CG_MapTorsoToWeaponFrame` maps them: 0 at rest, 1 to 6 firing (`TORSO_ATTACK`, `ATTACK2` for the
  gauntlet), 6 to 14 switching (`TORSO_DROP` then `TORSO_RAISE`, nine frames in a row in every demo
  model). `viewTorsoFrame` picks the torso frame from the tic row: the drop from 0.2 s before
  `WEAPON_TIME` while `WEAPONSTATE` is 2 (the old weapon going down), the raise from 0.25 s before it
  while 3 (the new one coming up), so the hand carries the gun out of view and back as Quake III's
  does. The bots play `TORSO_RAISE` when they change weapon.

*Under water* (the eye in a liquid, `WATERLEVEL` 3): the field of view waves a degree either way 0.4
times a second (`underwaterFov`, `CG_CalcFov`'s `WAVE_AMPLITUDE` and `WAVE_FREQUENCY`), and the effects
go through a low-pass (`audio.setUnderwater`; Quake III's mixer is told `inwater` and does nothing
with it). Bubbles are `CG_BubbleTrail`'s: `fire_bullets` emits an effect of kind 15 for a bullet or a
pellet that ends in, starts in or crosses water (the surface found by a trace against water alone),
only on maps with water (`game.has_water`, set by `init_map`), and the frame marks a rocket or a grenade
in water with the effect bit 65536 (`toss_move` checks the water for rockets there too), which the
painter trails with bubbles every 8 units instead of smoke. `FrameState.bubbles` holds them: radius 3
`sprites/bubble`, drifting up about 6 units a second with a jitter, 1 to 1.25 s each. The demo's
arenas have lava but no water; the smoke test turns q3dm7's lava into water to check it.

*The zoom* is the client's too (`CG_CalcFov`): Z or the right mouse button holds it, `zoomedFov`
eases the field of view to 22.5 degrees in 150 ms and back as fast on release, the mouse slows to
`fov_y / 75` of its speed while zoomed (`cg.zoomSensitivity`), and the gun is put away past half-way
(drawn with the zoomed view it would fill the screen). `frame_all`'s last optional parameter is the
field of view, so the frustum test and the SQL projection use it.

The page calls it before the frame query and passes the resulting eye and angles to `frame_all`, so
the faces are culled for the view that is painted; the dead (rolled 40 degrees) and the intermission
camera are left alone.

**Software** (`src/renderer.js`): a 32-bit ABGR framebuffer and a float z-buffer. Faces are
transformed, clipped against the near plane, and scan-converted into spans that interpolate 1/z, s/z
and t/z and divide every 16 pixels (perspective-correct). The texel is multiplied by the lightmap
texel (the 128×128 pages with the overbright shift of ×2 to ×4 and a hue-preserving clamp) and
written where z passes. Each polygon picks a mip level from its screen-space texel density. Sky faces
only write a mask; `skySpans` then fills them by the ray direction per pixel through the sky
shader's cloud layers. Alpha and additive surfaces are collected and drawn after the opaque ones,
back to front. MD3 triangles are lit from the light grid sample at the entity's origin (ambient +
directed × normal) and drawn through the same span code. Particles are points with depth.

**WebGL 2** (`src/renderer-gl.js`): the world's vertices go into one static buffer at `setResources`;
each frame builds an index buffer from the face list grouped by shader and lightmap page and draws
each group with the `WORLD` program (texture × lightmap page, the glow stages added with the stage's
blendFunc and tcMods, the sky by pixel direction), the `MODEL` program for MD3s (light grid colour in
the vertex shader) and the `SPRITE` program. The HUD, messages and the 2D pictures are drawn by a
software `Renderer` with `alpha: true` onto an overlay canvas on top; `#screen` (2D) and `#glscreen`
(WebGL) are separate canvases because a canvas can hold only one kind of context.

---

## 10. Sound

`src/audio.js` turns `sound_events` rows into Web Audio buffer sources panned and attenuated from
the listener (the player's eye and yaw), keeps loops (the lightning gun's hum, the railgun's hum)
and ambient `target_speaker`s (the frame's kind-7 row says which are audible now), and plays music:
the map's track from the pak when it has one, otherwise a synthesised drone, or nothing. The
announcer ("fight!", "you have taken the lead", the frag limit) and the obituaries' sounds are plain
events. Every event is checked against the pak in the smoke test so a mistyped name is caught in CI.

---

## 11. The page and the loop

`src/main.js` boots in this order: start Firebird 6 in a Worker (`FirebirdBrowser`, which needs the
page to be cross-origin isolated; `public/coi-serviceworker.js` adds the COOP/COEP headers on GitHub
Pages), fetch `./pak/pak0.pk3` (or take the user's file), `inflateAll`, `createSchema` (the SQL files
are imported as text by esbuild), `loadResources`, make the renderer from the settings, `startMap`.

The loop (`frame`) runs on `requestAnimationFrame` with a 60 ms `setTimeout` fallback, at the
display's rate; the game runs at 20 Hz inside it. When a 50 ms tic is due (one or two at most, so a
slow machine plays in slow motion rather than stalling) it calls `q3_tic` with the input (`readInput`:
WASD or arrows, mouse look with pointer lock on the `#screen-wrap`, Ctrl or click fires, Space jumps,
C crouches, Z or the right button zooms, Shift walks, 1–9 weapons, `/` or the wheel cycles, Enter or H uses the holdable, Tab shows the
scoreboard, G gives everything, P pauses; touch: the left half moves, the right half looks, a tap
fires) and keeps the previous tic's row and poses. Every frame, ticked or not, sits a fraction
`alpha` of the way into the current tic, and is painted the way the original's client paints:

- *Your own eye is predicted* (`CG_PredictPlayerState`). Quake III re-runs the player's move on the
  client; here the move is SQL, so `viewRow` extrapolates instead: the last tic's displacement
  (divided by the tics it covered) carried on for `alpha` of the next, at half strength on the
  ground with no move key down (friction is stopping you, and an overshoot that snaps back looks
  worse than a little lag), vertically only when both tics were in the air (a landing would sink
  the eye into the floor). The mouse's and the turn keys' pending deltas are applied to the angles.
  Nothing is predicted when dead or with the page's *Predict* box unticked.
- `frame_all` is called with that view (its `vx … vpitch` parameters override the player's eye in
  `view_setup`, so the face list is culled for the view actually painted). `view_setup` traces a
  ±8-unit box from the player's real eye to the predicted one, so a prediction that runs past a wall
  stops short of it, and the frame returns the eye it used as a row of kind 10, which the page
  then paints from.
- *Everything else is interpolated* (`CG_CalcEntityLerpPositions`): `interpolateFrame` moves the
  entities, the brush models' origins and their angles back toward the previous tic's poses by
  `1 − alpha`, snapping instead when something jumped more than 200 units (a teleport); the clock
  is interpolated the same way.

When the eye drops or rises 14 units for a crouch, the page spreads the step over 100 ms
(`CG_OffsetFirstPersonView`'s `DUCK_TIME`). So the look has no latency, your own motion about none (it is the last tic's motion carried on),
and the others are one tic (50 ms) behind, as in the original. The rows then go to
`scene.js` and `audio.js`; on ticked frames the loop also refreshes the scoreboard and, while the
waypoint graph is incomplete, runs `buildWaypoints`. `document.hidden` pauses it. The stats line
shows frames and tics per second separately.

Settings (map, bots, skill, frag limit, time limit, rotation, detail 640×480 / 320×240 / 160×120,
brightness, renderer fast / sql / gl, prediction, sound and music volumes) persist in `localStorage`.
During the intermission the HUD draws only the scoreboard, the console lines and "fire for" the next
arena (`CG_DrawIntermission`); otherwise a time limit adds the minutes left under the scores, red in
the last one. The SQL console runs any statement against
the live database (`Ctrl+Enter`) and has preset buttons: player, scoreboard, bots, items, movers,
entities, waypoints, bot routes, the frame queries, give all, add Visor, one-hit bots, god, console.

---

## 12. Testing, benchmarking, deploying

All scripts run against the real WASM engine in Node (`firebird-wasm`'s `DirectTransport`), so what
passes in Node is what runs in the browser.

| Command | What it does |
| --- | --- |
| `npm run fetch-pak` | downloads the demo and extracts `public/pak/pak0.pk3` |
| `npm run check` | compiles every SQL file into a fresh engine, reports the first error with Firebird's message |
| `npm test` | `sql-smoke.mjs q3dm1`: loads the map, walks, crouches (and stays down under a bot standing on its head), turns, jumps, lands, takes a jump pad, fires every weapon, checks the frame queries, the effects and that every queued sound exists in the pak |
| `npm run test:dm7`, `test:dm17` | the smoke test on the other arenas (q3dm17 for the pads) |
| `npm run test:bots` | `bots-test.mjs`: four bots join, see, fire, die, respawn, pick up a weapon, a bot hunts the player from the farthest spawn over the graph, a minute of play scores frags and strands nobody |
| `npm run test:bots:dm17` | the same on q3dm17, plus: the bots take the jump pads |
| `npm run test:view` | `view-test.mjs`: the first-person view's kicks, dips, lean and bob from synthetic tic rows, no engine |
| `npm run test:pmove` | `pmove-test.mjs`: the player's movement beside a reference of Quake III's `bg_pmove.c` at 8 ms, on q3dm17's open floor |
| `npm run bench`, `bench:tic`, `bench:raster` | tic and frame timings, the software painter's time per frame |
| `npm run screenshots` | headless PNGs of q3dm1 (`--at=x,y,z,yaw`, `--bright`, `--look=bot`, `--size`, `--bots`, `--sql`) into `docs/` |
| `npm run inspect` | dumps what is in the pak |
| `npm run build` | esbuild → `dist/`; `--serve [--coi]` serves it (`PORT=8085` when 8080 is busy) |

Browser verification: the Claude desktop app's built-in browser pane cannot start Firebird WASM (it
hangs at "Starting Firebird 6"), so use a real Chrome against `npm run serve -- --coi`; a background
tab throttles timers, so run big SQL through the page's console there.

`.github/workflows/pages.yml` runs on every push to `main`: `npm ci`, the pak from the Actions cache
(fetched when missing), `check`, the three smoke tests, both bots tests, the screenshots, the build,
and deploys `dist/` to GitHub Pages. Deploys take about four minutes; `gh run watch` follows one.

Commits are made as the repository's owner (`git -c user.name=mariuz -c user.email=…`) with the
`Co-Authored-By` trailer for the agent.

---

## 13. Performance

Measured in Node on the author's machine (the browser's Worker is within 20 percent):

| What | Cost |
| --- | --- |
| `loadMap` q3dm1 (tables + `init_map`) | 1.3 s |
| `q3_tic`, three bots | 6 ms mean, 10 ms p90 |
| one bot think | 5 to 9 ms (four to six traces) |
| `frame_all` | 3 ms median |
| software paint at 320×240 | 14 ms |
| WebGL paint | 1 ms |
| a world trace | 0.3 to 1 ms |
| `wp_route` | 1 to 4 ms |
| waypoint grid scan / edges | 3–7 s / 2–6 s, spread over frames |

The painter runs at the display's rate with the frame query (3 to 8 ms in the Worker) and the paint
per frame, and the tic on top every third frame or so: about 60 fps with WebGL and 30 to 40 with the
software painter at 320×240 on a 2020s laptop, where before interpolation every frame carried a tic.

---

## 14. Firebird PSQL: the rules learnt the hard way

The README's "Firebird lessons" has the ones about cost. The ones about getting a procedure to
compile and do what it says:

- Reserved words that bit: `OVER`, `COUNT`, `WAIT`, `RANDOM`, `TIME`, `VALUE`; local variables are
  named `wait_`, `random_`, `time_`, `match_done`, `by_`.
- `FIRST 1 SKIP (:k)`: the parameter needs parentheses.
- Inside any query in a procedure body, a local variable must be written with a colon (`:x`);
  outside queries (assignments, `IF`, function arguments in plain expressions) without. "Column
  unknown EX" means a bare local inside a `SELECT`, `INSERT … VALUES` or `WHERE`.
- A function used in a `WHERE` can be evaluated three times per row; compute once into a variable.
- Procedures with outputs are called with `EXECUTE PROCEDURE … RETURNING_VALUES a, b` from PSQL and
  `SELECT … FROM proc(...)` from SQL; functions are called as expressions, never with `EXECUTE`.
- A function or procedure must exist before anything that references it compiles; forward-declare
  with an empty body and `CREATE OR ALTER` the real one later.
- `CASE`/`IIF` over string literals of different lengths pads the shorter ones with spaces; wrap in
  `TRIM()`.
- A function may run DML (`wp_route` deletes and inserts into its temporary table); keep such
  functions out of `WHERE` clauses.
- Global temporary tables `ON COMMIT DELETE ROWS` are empty at the start of every statement the page
  sends (each is its own transaction), which is exactly right for a scratch frontier and exactly wrong
  for anything that must survive to the next statement.
- Updating rows of the table a `FOR SELECT` is iterating is fine (`wp_link_chunk` marks nodes as it
  goes).
- A loop that steps a coordinate must be shown to make progress: `gz = MINVALUE(fl - 8, gz - 32)`
  exists because a settled box could sit above the probe height and the scan spun forever, hanging
  every test with no output.
- Return a sentinel rather than `NULL` when the caller must tell "nothing there" from "the start was
  inside something" (`wp_drop` returns −99999 for a probe inside a solid, so the column scan can go on
  below it).
