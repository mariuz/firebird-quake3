# Roadmap: what Quake III Arena has that this port does not

A comparison of the port against the real engine (ioquake3's `code/` tree: `qcommon`, `server`,
`client`, `renderergl1`, `game`, `cgame`, `ui`, `botlib`), ordered by what a player feels first. Each
item says where it would go. "Done" items are listed at the end so the picture is complete.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how the existing parts work.

The port is a from-scratch reimplementation of the game in PSQL plus two painters, one of them a
port of the renderer's approach; it is not the Quake III source compiled to anything. Nothing below
is a bug report; it is the gap between a 20 Hz SQL deathmatch and the 1999 game.

## 1. What you feel while playing

Nothing left in this section: the frames between tics with the predicted player, crouching, the time
limit with the intermission and the rotation, the view's kicks, the zoom, the weapon switch, the bots'
chat, the rewards and the countdown, and spectating are all in (see §8). What is left starts with §2.

## 2. Movement and physics

| Gap | Notes |
| --- | --- |
| Ladders | Quake III has none; nothing to do |
| Swimming | `PM_WaterMove` is here (swim, drown, surface jump); underwater sound filtering and the bubble trail are not |
| Fall damage | here (`player_think` on landing, `EV_FALL_*`'s three sizes); the damage and the pain sound are close but not checked against `bg_pmove.c`'s `PM_CrashLand` |
| Slopes | `PM_WalkMove` projects the wish direction onto the ground plane and keeps the speed going up and down a ramp; here the acceleration is horizontal and the step move climbs |
| Proximity to movers | a mover pushes and crushes; standing on a rotating `func_rotating` does not rotate the player with it |
| Knockback feel | `t_damage` applies Quake III's knockback and its 50 to 200 ms without friction (`PMF_TIME_KNOCKBACK`); rocket jumps work for the player, the bots never use them |

## 3. The game: `game/` and `cgame/`

| Gap | Notes |
| --- | --- |
| **Gametypes** | free-for-all only. Tournament (1 v 1 with a queue), team deathmatch, capture the flag (`team_CTF_*`, flags, `target_score`, the team overlay) are absent; the demo pak has no CTF maps, the full pak does |
| **Join and leave** | the player and the bots are there for the match; no mid-game `addbot`/`kick` from the UI (the console's `spawn_bot` works) |
| **`misc_model`, `misc_portal_surface`, `misc_portal_camera`** | skipped at spawn; portal surfaces and cameras need the renderer's portal pass |
| **`shooter_*`, `target_laser`** | not spawned (none in the demo maps) |
| **Grappling hook** | not in Quake III's arenas; nothing to do |
| **Holdables** | medkit and the personal teleporter are picked up and used; the teleporter's destination is a random spawn, as in the game |
| **Powerups** | quad, haste, invisibility, regeneration, battle suit, flight are here; invisibility is not drawn as the invisible shader, haste leaves no trail |
| **Corpses** | removed after 8 s (gibs after 5 to 8); Quake III sinks them into the floor first, and nothing here leaves blood marks |
| **Persistent stats** | accuracy, per-weapon kills, the end-of-match stats screen |

## 4. The renderer

The WebGL painter is a port of the renderer's approach, not of `tr_*`; the software one is a 1996-style
rasteriser. Shader features are reduced to a "look" per surface (`src/shader.js`). Missing, roughly in
the order a player notices them on the demo maps:

| Gap | Quake III | Where |
| --- | --- | --- |
| **Marks and decals** | bullet holes, burn marks, blood on walls (`CG_ImpactMark`) | a decal list in `scene.js`, drawn as small polygons on the hit plane |
| **Smoke and brass** | rocket and grenade smoke trails, machinegun and shotgun shells | `scene.js` local entities |
| **Dynamic lights** | rockets, plasma, the quad and the muzzle flash light the world (`R_AddLightToScene`) | the WebGL program: a few point lights; the software painter: a per-polygon tint |
| **Shader features** | `deformVertexes` (autosprite, wave, bulge), `tcGen environment`, `alphaFunc`, `rgbGen` wave variants, `alphaGen portal`, `fogparms`, `sort` keys, `polygonOffset`, `entityMergable`, multiple lightmap styles | `shader.js` and the painters; the demo maps use autosprite for flames and `tcGen environment` on a few metals |
| **Fog volumes** | `fogs` lump, per-vertex fog | not drawn; q3dm7's fog pit is clear |
| **Portals and mirrors** | `misc_portal_surface`, `surfaceparm portal` | a second frame query from the portal's camera |
| **Flares** | `flare` shaders on lights | small |
| **Entity shadows** | the blob shadow under players (`cg_shadows 1`) and the stencil shadows (3) | a decal under each player model |
| **MD3 LOD** | `_1.md3`, `_2.md3` picked by screen size | `md3.js`/`loader.js`; the demo models have them |
| **Curved surface LOD** | `r_lodCurveError` | the patches are tessellated once at level 4 |
| **Lightning bolt and rail rings** | the LG's beam shader, the rail's spiral and core | the port draws a textured beam for both |
| **Texture quality** | trilinear/anisotropic filtering, `r_picmip` | the WebGL painter samples the mip chain nearest; the software one picks one mip per polygon |
| **Cinematics** | RoQ videos on `videoMap` surfaces and the intro | none |
| **2D** | the full menu and HUD art (`gfx/2d/*`) with the `bigchars` font | the status bar, numbers, icons and the console font are drawn; menus are not |
| **r_speeds-style stats** | | the stats line shows tic, query, paint and particles |

## 5. Bots (`botlib/`, `ai_*.c`)

The port's bots are a deathmatch AI with a run-time waypoint graph; botlib compiles an AAS and runs
fuzzy logic from the botfiles. What that leaves out:

| Gap | Notes |
| --- | --- |
| **Jumping gaps, rocket jumps, air control** | the graph has drop edges (jumping *down* up to 400 units) but no jump edges across gaps; `wp_walkable` could add an edge for a gap under 200 units that a 270 jump at run speed clears, and `bot_follow_route` would press jump at the edge |
| **Vertical boost pads** | a pad that lands on itself (q3dm17's centre) is only useful with air control; the bots do not take it, so the railgun platform is theirs only by chance |
| **Item weights and timing** | botlib weighs items by the bot's needs and times the big ones (the "long-term goal"); here a roaming goal is the nearest item with a bonus for weapons, armour and powerups |
| **Dodging** | no reaction to incoming rockets, no retreat when losing except the health run |
| **Weapon preferences per bot** | all bots use `bot_best_weapon`; the botfiles give each character its favourites |
| **Fuzzy characteristics** | `bot_char` is five fixed skill levels; the botfiles have per-character values and the `w_*` weights |
| **Team play, CTF roles** | no teams |
| **AAS reachability kinds** | walk, step, jump down, pad, teleporter are here; swim, ladder (n/a), jump across, rocket jump, grapple, elevator (standing on a plat and waiting), func_bobbing are not: a bot on a plat does not wait for it |
| **Graph quality** | the grid finds nodes where a column drops onto a floor; thin walkways between columns and the insides of doorways can lack nodes (q3dm7 has a few unreachable corners). A finer grid or nodes at face centres of walkable floor polygons would fill them |

## 6. Engine core (`qcommon/`, `server/`, `client/`)

| Gap | Notes |
| --- | --- |
| **Networking** | none, by design: one player, local bots. Snapshots, prediction, delta compression, the master server do not apply |
| **Console commands and cvars** | the SQL console replaces them; there is no `bind`, `cg_fov` and friends are settings in `localStorage` |
| **Demos** | not recorded. The database *is* the state: recording the `q3_tic` inputs per tic (one table) would replay a match deterministically; dumping the tables would be a save game |
| **Area portals** | a closed door does not block the PVS on its far side (`CM_AdjustAreaPortalState`); the port draws through closed doors' areas |
| **Light styles** | not in the demo maps |
| **File system** | one pak; the game searches every `pak*.pk3` in `baseq3` and a mod directory |
| **Capsule traces** | players use a box; Quake III traces players as capsules against other players (`cm_trace.c` with `capsule`) |
| **The menu, key binding, player setup** | the page's controls do this; model and name choice for the player would be a small addition (`PLAYER_MODEL` is fixed to Sarge) |
| **Sound** | OpenAL-style spatialisation exists; missing: underwater low-pass, doppler, the mover loop sounds (`sound/movers/*` are played at the start and end only), the ambient `target_speaker` global flag, the `s_musicvolume` crossfades |

## 7. Performance and scale

| Gap | Notes |
| --- | --- |
| Frame rate | the painter runs at the display's rate since the interpolation; a frame is the frame query (3 to 8 ms) plus the paint, and the tic (6 ms) lands on every third frame. Batching `q3_tic` and `frame_all` into one procedure would save a round trip on those; the software painter at 640×480 is paint-bound |
| Bigger maps | the full game's maps have 2 to 4× the faces and brushes of the demo's; `mark_faces` per cluster and the trace cost scale with leaf size, untested beyond the four demo arenas |
| Load time | 1.3 s for q3dm1, the pak's inflate and the JPEGs dominate in the browser; the waypoint graph is already spread over frames |
| Memory | the engine is `memory://`; nothing persists between page loads (settings aside) |

## 8. Already there (for the record)

Collision against brushes and patch facets, brush models with their own leaf, rotated models;
`PM_GroundTrace`, slide and step moves, water, the open-ground movement matching `bg_pmove.c` at 8 ms
(friction, acceleration and gravity in six substeps a tic, the trapezoid gravity, `PM_CmdScale` with
the jump key, the knock's time without friction: `npm run test:pmove` checks it side by side), crouching (`PM_CheckDuck`, the crouch animations, the
smoothed eye; the bots never crouch); the first-person view's kick away from a hit, landing dips by the
fall, the run's lean and the step bob, the gun's sway; the zoom to 22.5 degrees with the slower mouse; the view's hand playing the switch and the attack from
the torso's frames (`CG_MapTorsoToWeaponFrame`), the bots' new gun coming up; the bots' chat from their own chat files (botlib's random strings, variables
and characteristics: level start and end, joining, deaths, kills, suicides, hits, idle talk; no synonyms,
no typing delay, no replies); the rewards (excellent for two frags in 3 s, impressive for two rail hits in a
row, gauntlet with "humiliation" for both), their medals on the HUD and over the earner's head and the
match's medals at the end; the countdown before the match ("prepare to fight", three, two, one, "fight!"); spectating (leaving the
match and joining again, free flight, following a bot through its eyes); doors with auto triggers, plats, buttons, trains,
bobbing, pendulum, rotating, static, timers, speakers; jump pads (`AimAtTarget`), teleporters, hurt
and multiple triggers, `G_UseTargets` with delays and relays, `target_give/kill/print/teleporter/
remove_powerups/score`; every item of `bg_itemlist` with its respawn, armour at 66 percent, the five
powerups and two holdables; the nine weapons with Quake III's spreads, speeds, damages and fire
times; damage, knockback, gibs, corpses, obituaries; the player model animation system with
`animation.cfg`, tags and skins; the HUD, scoreboard, announcer, lead state; the frag and time
limits with the time warnings and sudden death, the intermission at the map's intermission point,
the map rotation; bots with
five skill levels, weapon choice, strafing, health runs, item pickup, and the waypoint graph with pad
and teleporter edges; the PVS, frustum and back-face culling in SQL for the view actually painted, frames interpolated
between tics with live mouse look and the local player predicted (extrapolated, clamped by a trace);
lightmaps with the overbright
shift, the light grid for models, sky cloud layers, blend/add/filter surfaces, scroll/scale/turb
tcMods, animMap, two-sided surfaces; the software and WebGL painters; positional sound, loops,
speakers, music; touch controls; the SQL console.
