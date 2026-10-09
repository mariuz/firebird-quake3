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
chat, the rewards and the countdown, and spectating are all in (see §8). What is left starts with §3.

## 2. Movement and physics

Nothing left here either: the movement matches `bg_pmove.c` (substeps, slopes, landings, the knock's
time without friction), turning movers carry their riders, and the bots rocket-jump (see §8). Quake III
has no ladders.

## 3. The game: `game/` and `cgame/`

| Gap | Notes |
| --- | --- |
| **Gametypes** | free-for-all, tournament and team deathmatch. Capture the flag (`team_CTF_*`, flags, `target_score`, the team overlay) is absent; the demo pak has no CTF maps, the full pak does. Teammates have no friend marker over their heads (`cg_drawFriend`: the demo pak lacks `sprites/friend1.tga`) |
| **`misc_model`** | skipped at spawn (q3map bakes the demo's into the BSP); the portal entities are read by the page from the map's entities, not spawned |
| **`shooter_*`, `target_laser`** | not spawned (none in the demo maps) |
| **Grappling hook** | not in Quake III's arenas; nothing to do |
| **Holdables** | medkit and the personal teleporter are picked up and used; the teleporter's destination is a random spawn, as in the game |
| **Powerups** | quad, haste, invisibility, regeneration, battle suit, flight are here, for the bots too but flight (they would float off); the red team's quad shell in team play (`redQuadShader`) and the powerups' sounds (the regeneration's pulse is played, the flight's loop and the battle suit's hum are not); a dead player does not drop its powerups (`TossClientItems`) |
| **Corpses** | the body is a separate entity from the moment of death (Quake III keeps the dead player itself until the respawn copies it into the queue), so it does not slide with the dead player's view. Gibs leave blood on the walls; a bleeding player does not (`CG_Bleed` leaves no mark either) |
| **Persistent stats** | accuracy, per-weapon kills, the end-of-match stats screen |

## 4. The renderer

The WebGL painter is a port of the renderer's approach, not of `tr_*`; the software one is a 1996-style
rasteriser. Shader features are reduced to a "look" per surface (`src/shader.js`). Missing, roughly in
the order a player notices them on the demo maps:

| Gap | Quake III | Where |
| --- | --- | --- |
| **Dynamic lights, the rest** | 32 lights (the port keeps the 8 nearest); a light behind the view's frustum or out of the PVS lighting what is in view (the port takes its lights from the entities in view); the bots' muzzle flashes; the software painter lights planar faces only, not patches or curved meshes, and models only in brightness | `scene.js` `sceneLights`, `renderer.js` `dlightFace` |
| **Shader features** | `deformVertexes` bulge, normal and autosprite2's axis, `tcGen vector`, more than the main stage plus one glow and one chrome, `alphaFunc` beyond a test, `rgbGen` wave variants, `alphaGen portal`, `fogparms`, `sort` keys, `polygonOffset`, `entityMergable`, multiple lightmap styles; the chrome reflects by the face's normal, not the vertices' (patches' normals are not kept) | `shader.js` and the painters |
| **Fog, the rest** | models, brass and sprites inside a fog are not fogged (`R_FogFactor` on entities); the software painter fogs the opaque faces only, and a surface's own translucent stages are drawn unfogged | `scene.js` and the painters |
| **Portals and mirrors, the rest** | mirrors (a portal surface without a camera) are not drawn; the view through a portal is seen from the camera itself, not from the viewer's offset behind it (that needs the clip plane at the camera Quake III uses); rotating and bobbing cameras; a portal inside a portal's view | `scene.js` `portalView`, the painters' portal pass |
| **Flares** | `flare` shaders on lights (the BSP's type 4 surfaces) | off by default in Quake III 1.32 (`r_flares 0`), so not drawn here either |
| **Entity shadows, the rest** | the stencil shadows (`cg_shadows 2`) and the projected ones (3); the blob is traced down by a point, not the 30-unit box | `scene.js` `drawShadows` |
| **MD3 LOD** | `_1.md3`, `_2.md3` picked by screen size | `md3.js`/`loader.js`; the demo models have them |
| **Curved surface LOD** | `r_lodCurveError` | the patches are tessellated once at level 4 |
| **Rail and lightning, the rest** | each shooter's `color1` for the rail (one colour here); `cg_oldRail 0`'s particle spiral; the lightning's impact flash model and its beam bending with the shooter's aim between tics | `scene.js` `drawRail`, `drawBolt` |
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
| **Dodging** | grenades are avoided (160 units, `bot_avoid_grenade`) and `BotAggression` decides retreat and chase (`bot_aggression`, `bot_retreat_goal`); no reaction to incoming rockets (botlib has none either, beyond the attack move's strafing), and the retreat's goal is an item in sight rather than the AAS long-term goal; ammunition is not counted, so a gun held is a gun loaded |
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
the jump key, the knock's time without friction, `PM_CrashLand`'s landings, `PM_WalkMove` on a slope
at the full speed along it: `npm run test:pmove` checks it side by side; `SURF_SLICK` floors), movers
that push, crush and carry, a turning one (`func_rotating`, `func_pendulum`) carrying its riders round
its axis and turning their view with it (none in the demo's arenas; the test builds one), half damage
from your own rocket after its full knock (`G_Damage`: "so rocket jumping works"), the bots' rocket
jumps to ledges no walk reaches (`TRAVEL_ROCKETJUMP` edges, `BotCanAndWantsToRocketJump`, the jump
and the shot straight down, the flight steered with the air acceleration); team deathmatch (`GT_TEAM`:
`PickTeam`, the red and blue skins, no friendly fire, team scores through `AddScore`, the team's
fraglimit and tied time limit, "red leads" / "blue leads" / "teams are tied", the bots leaving
teammates alone and holding fire with one in the way, the HUD's two scores and the team scoreboard:
`npm run test:team`); the tournament (`GT_TOURNAMENT`: two play and the rest wait as spectators in the
order they came, "waiting for players" and the countdown when both are there, wins and losses, the
loser to the back of the queue and the arena restarted for the next: `npm run test:tourney`); bots
joining and leaving mid-game (`addbot` at a skill and `kick` from the page's menus: `G_AddBot`,
`ClientDisconnect`, the goodbye of `BotChat_ExitGame`), swimming with its
bubbles (shots and rockets in water, `CG_BubbleTrail`), the view's wave and the muffled sound with the
head under (the demo's arenas have lava only, a registered pak's have water), crouching (`PM_CheckDuck`, the crouch animations, the
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
times; damage, knockback, gibs, obituaries; the body queue (8 corpses, each lying until its owner respawns,
5 s more, then sinking into the floor); the player model animation system with
`animation.cfg`, tags and skins; the HUD, scoreboard, announcer, lead state; the frag and time
limits with the time warnings and sudden death, the intermission at the map's intermission point,
the map rotation; bots with
five skill levels, weapon choice, strafing, health runs, item pickup, and the waypoint graph with pad
and teleporter edges; the PVS, frustum and back-face culling in SQL for the view actually painted, frames interpolated
between tics with live mouse look and the local player predicted (extrapolated, clamped by a trace);
the impact marks (`CG_ImpactMark`, `R_MarkFragments`: bullet holes, the
lightning gun's holes, burns, the plasma's and the rail's energy marks, gibs' blood, clipped to the world's faces and
fading after 10 s); the rockets' and grenades' smoke trails (`CG_RocketTrail`) and the machinegun's and shotgun's
brass (`CG_MachineGunEjectBrass`, `CG_ShotgunEjectBrass`) bouncing on the floor; the dynamic lights
(`R_AddLightToScene`: rockets and BFG balls in flight, rocket and grenade explosions, the quad's carriers, the
muzzle flash) on the world as `ProjectDlightTexture` lights it and on the models as `R_SetupEntityLighting` does;
the shader features the demo's arenas use most: `tcGen environment` (the chrome of `pewter_shiney` all over
q3dm17 and q3tourney2, under the pewter picture, and the lamps), `deformVertexes autoSprite` (the lamp flares)
and `deformVertexes wave` and `move` (the lava, the banners, the bobbing lamps); the fog volumes (the `fogs` lump
and `fogparms`: q3dm7's red pit and orange ground fog, q3tourney2's hell fogs) as `RB_CalcFogTexCoords` and
`R_FogFactor` have them; the portal (q3dm7's teleporter shows its camera's view, `R_MirrorViewBySurface`, fogged
over in 256 units by `alphaGen portal`); the blob shadow under every player and under the player itself
(`CG_PlayerShadow`, `cg_shadows 1`); the rail's core and rings (`cg_oldRail 1`) fading over 400 ms and the lightning
gun's four crossed ribbons; the powerups' shells on players and on our own gun (quad, regeneration, battle suit,
invisibility) and the haste's smoke;
lightmaps with the overbright
shift, the light grid for models, sky cloud layers, blend/add/filter surfaces, scroll/scale/turb
tcMods, animMap, two-sided surfaces; the software and WebGL painters; positional sound, loops,
speakers, music; touch controls; the SQL console.
