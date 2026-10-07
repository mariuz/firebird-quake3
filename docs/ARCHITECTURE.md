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

**The simulation**: `game` (one row: tic, time, map, skill, gravity, sky, music, frag limit, match
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
−24..32, view height 26.

---

## 5. The game tic

`q3_tic(tics, fwd, side, yaw_d, pitch_d, fire, jump, run, imp)` in `bots.sql` runs `tics` tics of
50 ms (the loop asks for one or two, never more, so a slow machine plays in slow motion rather than
stalling) and returns one row with everything the HUD needs: health, armour, ammo, weapon, frags,
position and angles, view height, dead, match state, `onground`, `move_speed`, the weapon's loop
sound, the lead state. Each tic:

1. advances `game.time_` and the tic counter;
2. `player_think` (`player.sql`): angles from the mouse, `view_vectors`, the water and ground state,
   `PM_WalkMove` / `PM_AirMove` / `PM_WaterMove` through `walk_move` and `fly_move`, jumping and
   landing with their sounds, footsteps on a distance clock, drowning, lava and slime damage, item and
   trigger touching through `touch_triggers`, weapon switching with Quake III's raise/drop timing
   (`weaponstate`, `pending_weapon`), firing through `player_fire`, the impulses (1–9 weapons, 12/14
   cycle, 13 holdable, 99 give all), powerup timers, health decay above the maximum;
3. `run_pushers`: every mover (`movetype` 7) moves along its `calc_move` track and pushes what stands
   on it or in its way (`push_move`, the pushed set kept in the `pushed` temporary table so a blocked
   mover can put everything back, as `G_MoverPush` does); doors reverse when blocked and crush at
   `dmg`; bobbing platforms, pendulums and rotating things have their own `*_think`;
4. `run_think`: every entity whose `nextthink` has come, dispatched by the `think` name: `bot_think`,
   `item_respawn`, `missile_explode`, the door, plat, button and train states, `timer_think`,
   `speaker_think`, `remove`;
5. `run_physics`: the projectiles (`launch_missile` sets a straight velocity; grenades `toss_move`),
   the gibs and corpses, `impact` when something hits, `missile_explode` with `t_radius_damage`;
6. the respawn and match clocks: `score_frag` keeps the scoreboard, announces the lead changes and
   "fight!", and ends the match at the frag limit (20) with `match_over`, `winner` and `over_time`;
   `exit_kind` 3 asks the page to restart the map.

The weapons (`player.sql`) are `g_weapon.c` with its numbers: `fire_bullets` with Quake III's spread
(machinegun 200, shotgun 700 over 11 pellets), `fire_rail` (a trace that goes through players and
spawns the rail effect), `fire_lightning` (768 range, 8 damage every 50 ms), `fire_gauntlet`, the
missiles (rocket 900 units a second, plasma 2000, grenade tossed at 700, BFG 2000) through
`launch_missile`/`launch_grenade`, `fire_time` per weapon (gauntlet 400 ms, machinegun 100, shotgun
1000, grenade 800, rocket 800, lightning 50, rail 1500, plasma 100, BFG 200). `fire_weapon(shooter,
w, origin, dir, vol)` is shared by the player and the bots; `muzzle` computes the muzzle point from
the eye and the weapon's offset.

Damage (`game.sql`) is `g_combat.c`: `t_damage(target, inflictor, attacker, damage, knockback, flags,
mod)` with the knockback velocity, godmode, the battle suit, armour absorbing 66 percent, quad ×3,
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

**Edges** (`wp_edges`: `a → b`, length, kind 0 walk / 1 jump pad / 2 teleporter / 3 drop).
`wp_link_chunk` links each node to its ten nearest neighbours within 420 units, and then to the four
nearest on a lower level (the ten are all on the node's own level when the grid is dense, and a
ledge needs its way down), when `wp_walkable` says a player can get there: first a straight box
trace with the floor probed at a third and two thirds of the way (no pits, no lava); if that fails
and the two are on one level, a chest-height point trace rules out walls at once; otherwise a
*stepped walk* of 40-unit steps, each one tried 18 units up (three times for stairs and ramps) and
settled onto the floor below with a drop of up to 400 units allowed (a fall that hurts a little, the
AAS's "jump down"), which must end within 48 units of the target. A flat walk is stored both ways; a
drop is one way. Pads and teleporters get their edges when their nodes are made.

**Routing.** `wp_nearest(x, y, z, see)` finds the node nearest a spot (height weighted ×4), the
nearest *in sight* for the bot's own position. `wp_route(src, dst)` is a breadth-first search: the
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
sidesteps and re-routes. Stepping onto a jump pad's node puts the bot in the pad's trigger;
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

**Known limits.** No jumping across gaps, no rocket jumps, no air control, so on q3dm17 the platforms
reached only by steering off the vertical boost pad stay out of the bots' reach; nodes on roofs and
other sealed pockets are harmless islands. The bots test runs the hunt from the farthest spawn on
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

`frame_all(mode, last_sound, last_fx, want_speakers [, vx, vy, vz, vyaw, vpitch])`: the five optional
parameters are the eye to use instead of the player's (the page passes its interpolated view); the
Node scripts leave them out.
| 8 | (mode 1) one projected vertex | face id, screen x y z, s t u v, colour |
| 2 | an entity to draw (MD3 item, sprite, player model) | id, model, frame, weapon, effects, pose, legs and torso clocks, `pmodel/skin`, `legs_anim,torso_anim,health,classname` |
| 4 | a sound event newer than `last_sound` | id, name, position, volume, attenuation, entity |
| 5 | an effect newer than `last_fx` | id, kind, position, direction, count |
| 6 | the pose of a rotated brush model | id, pitch, yaw, roll |
| 7 | (every 10th frame) the `target_speaker`s audible now | `lst` = ids |
| 9 | a console line | id, time, text |

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
calls, `present(tint)`), and `src/scene.js` drives either: view bob from `move_speed` and the land
time, the faces, the entities (items bob 4 units and rotate, as `CG_Item` does), the player models
hung on their tags (`tag_torso`, `tag_head`, `tag_weapon`), the sprites, the explosions and beams
kept in `FrameState` from the effects of earlier frames, the view weapon from the `_hand.md3` with a
minimum ambient light of 96 (`RF_MINLIGHT`) and the muzzle flash, and the screen tint from damage,
powerups and water.

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
Shift walks, 1–9 weapons, `/` or the wheel cycles, Enter or H uses the holdable, Tab shows the
scoreboard, G gives everything, P pauses; touch: the left half moves, the right half looks, a tap
fires) and keeps the previous tic's row and poses. Every frame, ticked or not, is painted *between
the last two tics* (`CG_CalcEntityLerpPositions`): `viewRow` interpolates the eye's position and the
clock by how far the frame sits into the current tic and applies the mouse's and the turn keys'
pending deltas to the angles, so the look never waits for a tic; `frame_all` is called with that
view (its `vx … vpitch` parameters override the player's eye in `view_setup`, so the face list is
culled for the view actually painted); `interpolateFrame` moves the entities, the brush models'
origins and their angles back toward the previous tic's poses by the same fraction, snapping
instead when something jumped more than 200 units (a teleport). The result is one tic (50 ms) of
latency on positions and none on the view, as in the original's client. The rows then go to
`scene.js` and `audio.js`; on ticked frames the loop also refreshes the scoreboard and, while the
waypoint graph is incomplete, runs `buildWaypoints`. `document.hidden` pauses it. The stats line
shows frames and tics per second separately.

Settings (map, bots, skill, detail 640×480 / 320×240 / 160×120, brightness, renderer fast / sql /
gl, sound and music volumes) persist in `localStorage`. The SQL console runs any statement against
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
| `npm test` | `sql-smoke.mjs q3dm1`: loads the map, walks, turns, jumps, lands, takes a jump pad, fires every weapon, checks the frame queries, the effects and that every queued sound exists in the pak |
| `npm run test:dm7`, `test:dm17` | the smoke test on the other arenas (q3dm17 for the pads) |
| `npm run test:bots` | `bots-test.mjs`: four bots join, see, fire, die, respawn, pick up a weapon, a bot hunts the player from the farthest spawn over the graph, a minute of play scores frags and strands nobody |
| `npm run test:bots:dm17` | the same on q3dm17, plus: the bots take the jump pads |
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
