-- schema.sql – the whole of Quake III Arena's world, as Firebird tables.
--
-- A Quake III BSP (IBSP 46) is a relational database already: FACES own
-- their VERTEXES (with texture and lightmap coordinates) and reference a
-- shader of the TEXTURES lump; LEAFS list their faces through LEAFFACES and
-- the BRUSHES that fill them through LEAFBRUSHES, and belong to a CLUSTER
-- whose potentially visible set the VISDATA lump holds; NODES form the tree
-- that rendering and collision walk; brush MODELS (doors, plats) carry a
-- range of faces and brushes. loader.js copies those lumps in, denormalised
-- so the hot loops never need a second lookup, and tessellates the Bézier
-- patches into faces and one-sided collision facets; game.sql simulates the
-- entities, player.sql the client, bots.sql the opponents, render.sql draws.

-- ── session / configuration ─────────────────────────────────────────────
-- the arenas of the pak, in the order the rotation plays them
CREATE TABLE map_list (
  ord  INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR(32) NOT NULL
);

CREATE TABLE game (
  id             SMALLINT NOT NULL PRIMARY KEY,
  tic            INTEGER DEFAULT 0 NOT NULL,
  bot_rl         SMALLINT DEFAULT 0 NOT NULL,           -- the bots' fight moves: 0 Quake III's, 1 the learned table's (bot_q), 2 the table's, learning on, 3 the network's (bot_nn)
  rl_logging     SMALLINT DEFAULT 0 NOT NULL,           -- 1: every learned move is written to bot_rl_log (scripts/rl-train.mjs: the network's training data)
  demo_rec       INTEGER,                               -- the demo being recorded (demos.id), its next snapshot's number and
  demo_n         INTEGER DEFAULT 0 NOT NULL,            -- the last sound, effect and line it has (while playing: the snapshot shown)
  demo_snd       INTEGER DEFAULT 0 NOT NULL,
  demo_fx        INTEGER DEFAULT 0 NOT NULL,
  demo_msg       INTEGER DEFAULT 0 NOT NULL,
  demo_play      INTEGER,                               -- the demo playing
  time_          DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- seconds, tic / 20
  tele_time      DOUBLE PRECISION,                      -- the last EV_PLAYER_TELEPORT_IN (a teleport's arrival, a
  tele_x         DOUBLE PRECISION,                      -- spawn) and where: the bots let anyone there be for 3 s
  tele_y         DOUBLE PRECISION,                      -- (lastteleport_time, lastteleport_origin)
  tele_z         DOUBLE PRECISION,
  map_name       VARCHAR(32),
  next_map       VARCHAR(64),
  exit_kind      SMALLINT DEFAULT 0 NOT NULL,           -- 0 playing, 1 on to next_map, 3 restart this one
  skill          SMALLINT DEFAULT 2 NOT NULL,           -- bot skill 1..5
  world_model    INTEGER DEFAULT 0 NOT NULL,            -- models.id of the world
  gravity        DOUBLE PRECISION DEFAULT 800 NOT NULL,
  level_msg      VARCHAR(200),
  sky            VARCHAR(64),                           -- the sky shader of the map
  music          VARCHAR(64),
  fraglimit      INTEGER DEFAULT 20 NOT NULL,           -- 0: none
  timelimit      INTEGER DEFAULT 0 NOT NULL,            -- minutes, 0: none
  time_warnings  SMALLINT DEFAULT 0 NOT NULL,           -- said already: 1 five minutes, 2 one minute, 4 sudden death
  warmup_end     DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- the countdown before the match ends then (the clock counts from it)
  warmup_said    SMALLINT DEFAULT 0 NOT NULL,           -- the last of three, two, one said (0: done)
  has_water      SMALLINT DEFAULT 0 NOT NULL,           -- the map has water: the shots look for bubbles
  gametype       SMALLINT DEFAULT 0 NOT NULL,           -- g_gametype: 0 free for all, 1 tournament (GT_TOURNAMENT), 3 team deathmatch (GT_TEAM)
  red_score      INTEGER DEFAULT 0 NOT NULL,            -- level.teamScores[TEAM_RED], [TEAM_BLUE]
  blue_score     INTEGER DEFAULT 0 NOT NULL,
  team_lead      SMALLINT DEFAULT 0 NOT NULL,           -- who leads, as last announced: 0 tied 1 red 2 blue
  red_leader     INTEGER,                               -- each team's leader (bs->teamleader, heard by all its bots)
  blue_leader    INTEGER,
  match_over     SMALLINT DEFAULT 0 NOT NULL,           -- 1 from the frag or time limit on: the intermission
  winner         VARCHAR(32),
  over_time      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  num_bots       SMALLINT DEFAULT 3 NOT NULL,
  speakers_on    SMALLINT DEFAULT 1 NOT NULL
);

-- The map's areas (cm.areas): the parts q3map split at area portal brushes, which sit in doors. An
-- area portal is open while a door over it is (CM_AdjustAreaPortalState counts them); flood numbers the
-- areas the open portals join (CM_FloodAreaConnections), and what is in an area of another flood than
-- the eye's is not drawn (R_MarkLeaves' areamask, the snapshot's CM_AreasConnected)
CREATE TABLE areas (
  area   INTEGER NOT NULL PRIMARY KEY,
  flood  INTEGER NOT NULL
);
CREATE TABLE area_portals (
  a1     INTEGER NOT NULL,
  a2     INTEGER NOT NULL,
  cnt    INTEGER DEFAULT 0 NOT NULL,
  PRIMARY KEY (a1, a2)
);

CREATE TABLE viewcfg (
  id     SMALLINT NOT NULL PRIMARY KEY,
  w      INTEGER NOT NULL,
  h      INTEGER NOT NULL,
  fov    DOUBLE PRECISION NOT NULL,     -- horizontal, degrees
  near_z DOUBLE PRECISION NOT NULL,
  vis_cluster INTEGER,                 -- the cluster VIS_FACES was marked for
  portal_cluster INTEGER               -- ... and PORTAL_FACES, for the portal camera's view
);

-- ── resources ───────────────────────────────────────────────────────────
-- Every model the renderer and the simulation know: the world and its
-- brush models (*1, *2, …) and the MD3s.
CREATE TABLE models (
  id        INTEGER NOT NULL PRIMARY KEY,
  name      VARCHAR(64) NOT NULL,
  kind      CHAR(1) NOT NULL,            -- B bsp, M md3
  minx DOUBLE PRECISION, miny DOUBLE PRECISION, minz DOUBLE PRECISION,
  maxx DOUBLE PRECISION, maxy DOUBLE PRECISION, maxz DOUBLE PRECISION,
  headnode  INTEGER,                     -- BSP models: the root node (nodes.id), or a leaf as -(leaf + 1)
  first_face INTEGER, num_faces INTEGER,
  nframes   INTEGER DEFAULT 1 NOT NULL,
  flags     INTEGER DEFAULT 0 NOT NULL,
  radius    DOUBLE PRECISION DEFAULT 0 NOT NULL,
  area1     INTEGER,                     -- a brush model between two areas (a door over an area portal): both
  area2     INTEGER
);
CREATE INDEX models_name ON models (name);

-- bg_itemlist: what an item classname is
CREATE TABLE item_defs (
  cls      VARCHAR(40) NOT NULL PRIMARY KEY,
  kind     CHAR(1) NOT NULL,             -- H health A armor W weapon M ammo P powerup O holdable
  model    VARCHAR(64) NOT NULL,         -- the first model (the renderer draws the others too)
  snd      VARCHAR(64) NOT NULL,
  name     VARCHAR(40) NOT NULL,
  qty      INTEGER NOT NULL,
  respawn  DOUBLE PRECISION NOT NULL,
  bit      INTEGER DEFAULT 0 NOT NULL,   -- weapons: the WP bit; ammo: the weapon index; powerups: the PW bit
  bot_respawn DOUBLE PRECISION          -- botlib's respawntime (botfiles/items.c): how long a bot avoids it
);

-- ── map geometry ─────────────────────────────────────────────────────────
-- The BSP tree. Children < 0 are leaves: leaf = -(child + 1). The plane is
-- copied in so a step of the walk is one lookup; ptype 0..2 is an axial plane.
CREATE TABLE nodes (
  id   INTEGER NOT NULL PRIMARY KEY,
  nx DOUBLE PRECISION NOT NULL, ny DOUBLE PRECISION NOT NULL, nz DOUBLE PRECISION NOT NULL,
  dist DOUBLE PRECISION NOT NULL,
  ptype SMALLINT DEFAULT 3 NOT NULL,
  c0 INTEGER NOT NULL,
  c1 INTEGER NOT NULL,
  cc0 INTEGER,                         -- a leaf child's contents (NULL for a node): empty leaves are skipped without a visit
  cc1 INTEGER
);

CREATE TABLE leaves (
  id       INTEGER NOT NULL PRIMARY KEY,
  contents INTEGER NOT NULL,            -- the union of the leaf's brushes' CONTENTS_* bits
  cluster  INTEGER NOT NULL,            -- -1: outside the world (or a brush model's leaf)
  area     INTEGER DEFAULT 0 NOT NULL,
  minx DOUBLE PRECISION, miny DOUBLE PRECISION, minz DOUBLE PRECISION,
  maxx DOUBLE PRECISION, maxy DOUBLE PRECISION, maxz DOUBLE PRECISION,
  first_lf INTEGER NOT NULL,            -- leaffaces
  num_lf   INTEGER NOT NULL,
  first_lb INTEGER NOT NULL,            -- leafbrushes
  num_lb   INTEGER NOT NULL,
  -- the PVS of the leaf's cluster as hex: cluster j visible ⇔ bit j
  -- (the character at index j >> 2, low nibble first). '' means everything.
  pvs      VARCHAR(2048) CHARACTER SET ASCII
);
CREATE INDEX leaves_cluster ON leaves (cluster);

CREATE TABLE leaffaces (
  id   INTEGER NOT NULL PRIMARY KEY,
  face INTEGER NOT NULL
);

CREATE TABLE leafbrushes (
  id    INTEGER NOT NULL PRIMARY KEY,
  brush INTEGER NOT NULL
);

-- Collision: a brush is a convex volume bounded by its sides' planes. A
-- facet (from a patch) is one-sided: its surface plane and the border planes.
CREATE TABLE brushes (
  id         INTEGER NOT NULL PRIMARY KEY,
  contents   INTEGER NOT NULL,
  first_side INTEGER NOT NULL,
  num_sides  INTEGER NOT NULL,
  facet      SMALLINT DEFAULT 0 NOT NULL,
  minx DOUBLE PRECISION DEFAULT -99999 NOT NULL, miny DOUBLE PRECISION DEFAULT -99999 NOT NULL, minz DOUBLE PRECISION DEFAULT -99999 NOT NULL,
  maxx DOUBLE PRECISION DEFAULT 99999 NOT NULL, maxy DOUBLE PRECISION DEFAULT 99999 NOT NULL, maxz DOUBLE PRECISION DEFAULT 99999 NOT NULL
);

CREATE TABLE brushsides (
  id   INTEGER NOT NULL PRIMARY KEY,   -- brushes.first_side + k
  nx DOUBLE PRECISION NOT NULL, ny DOUBLE PRECISION NOT NULL, nz DOUBLE PRECISION NOT NULL,
  dist DOUBLE PRECISION NOT NULL,
  flags INTEGER DEFAULT 0 NOT NULL     -- the side's shader SURF_* flags (4 sky, 2 slick, 0x4000 nonsolid …)
);

CREATE TABLE faces (
  id        INTEGER NOT NULL PRIMARY KEY,
  model_id  INTEGER NOT NULL,
  -- the plane of a polygon (ftype 1); patches and meshes are two-sided
  nx DOUBLE PRECISION DEFAULT 0 NOT NULL, ny DOUBLE PRECISION DEFAULT 0 NOT NULL, nz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  dist DOUBLE PRECISION DEFAULT 0 NOT NULL,
  twosided  SMALLINT DEFAULT 0 NOT NULL,
  ftype     SMALLINT DEFAULT 1 NOT NULL, -- 1 polygon 2 patch 3 mesh 4 billboard
  nverts    INTEGER NOT NULL,
  tex       INTEGER,                    -- textures.id
  flags     INTEGER DEFAULT 0 NOT NULL, -- SURF_*: 4 sky 0x80 nodraw 0x400 nolightmap …
  cx DOUBLE PRECISION DEFAULT 0 NOT NULL, cy DOUBLE PRECISION DEFAULT 0 NOT NULL, cz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  radius DOUBLE PRECISION DEFAULT 0 NOT NULL
);
CREATE INDEX faces_model ON faces (model_id);

-- a face's vertices in order (polygons), or its triangle list three by three
-- (patches, meshes), with texture (s, t) and lightmap (u, v) coordinates
CREATE TABLE face_verts (
  face INTEGER NOT NULL,
  seq  INTEGER NOT NULL,
  x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL, z DOUBLE PRECISION NOT NULL,
  s DOUBLE PRECISION DEFAULT 0 NOT NULL, t DOUBLE PRECISION DEFAULT 0 NOT NULL,
  u DOUBLE PRECISION DEFAULT 0 NOT NULL, v DOUBLE PRECISION DEFAULT 0 NOT NULL,
  PRIMARY KEY (face, seq)
);

CREATE TABLE textures (
  id       INTEGER NOT NULL PRIMARY KEY,
  name     VARCHAR(64) NOT NULL,        -- the shader name
  flags    INTEGER DEFAULT 0 NOT NULL,  -- SURF_*
  contents INTEGER DEFAULT 0 NOT NULL   -- CONTENTS_*
);

-- The entity lump as authored (the keys the game reads; spawn_map_ents uses it).
CREATE TABLE map_ents (
  id         INTEGER NOT NULL PRIMARY KEY,
  classname  VARCHAR(40) NOT NULL,
  targetname VARCHAR(40),
  target     VARCHAR(40),
  team       VARCHAR(40),
  model      VARCHAR(64),              -- '*N' for brush models, or a file
  ox DOUBLE PRECISION DEFAULT 0 NOT NULL, oy DOUBLE PRECISION DEFAULT 0 NOT NULL, oz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  angle      DOUBLE PRECISION,
  apitch DOUBLE PRECISION, ayaw DOUBLE PRECISION, aroll DOUBLE PRECISION,   -- "angles"
  spawnflags INTEGER DEFAULT 0 NOT NULL,
  message    VARCHAR(400),
  wait_      DOUBLE PRECISION,
  delay      DOUBLE PRECISION,
  random_    DOUBLE PRECISION,
  speed      DOUBLE PRECISION,
  lip        DOUBLE PRECISION,
  height     DOUBLE PRECISION,
  health     INTEGER,
  light      INTEGER,
  dmg        INTEGER,
  count_     INTEGER,
  noise      VARCHAR(64),
  phase      DOUBLE PRECISION,
  gravity    DOUBLE PRECISION,
  music      VARCHAR(64),
  notfree    INTEGER,
  nobots     INTEGER,                    -- the "notbot" key: the bots leave it alone (a button they are not to use)
  notteam    INTEGER,
  gametype   VARCHAR(80)                   -- the game types it is in ("ffa tournament team ..."), Team Arena's key
);
CREATE INDEX map_ents_class ON map_ents (classname);
CREATE INDEX map_ents_tname ON map_ents (targetname);

-- ── live entities (gentity_t) ───────────────────────────────────────────
CREATE SEQUENCE ent_seq;

CREATE TABLE ents (
  id         INTEGER NOT NULL PRIMARY KEY,
  classname  VARCHAR(40) NOT NULL,
  model_id   INTEGER,                   -- NULL = invisible
  frame      INTEGER DEFAULT 0 NOT NULL,
  skin       INTEGER DEFAULT 0 NOT NULL,
  effects    INTEGER DEFAULT 0 NOT NULL,  -- EF_: 1 rotate+bob (items) 2 gib 8 plasma 16 rocket 32 grenade 64 bfg 128 shell 256 invisible 512 quad 1024 regen 2048 haste 4096 enviro
  renderfx   INTEGER DEFAULT 0 NOT NULL,
  x DOUBLE PRECISION DEFAULT 0 NOT NULL, y DOUBLE PRECISION DEFAULT 0 NOT NULL, z DOUBLE PRECISION DEFAULT 0 NOT NULL,
  vx DOUBLE PRECISION DEFAULT 0 NOT NULL, vy DOUBLE PRECISION DEFAULT 0 NOT NULL, vz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  pitch DOUBLE PRECISION DEFAULT 0 NOT NULL, yaw DOUBLE PRECISION DEFAULT 0 NOT NULL, roll DOUBLE PRECISION DEFAULT 0 NOT NULL,
  avel_yaw   DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- degrees per second
  avel_pitch DOUBLE PRECISION DEFAULT 0 NOT NULL,
  avel_roll  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  minx DOUBLE PRECISION DEFAULT 0 NOT NULL, miny DOUBLE PRECISION DEFAULT 0 NOT NULL, minz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  maxx DOUBLE PRECISION DEFAULT 0 NOT NULL, maxy DOUBLE PRECISION DEFAULT 0 NOT NULL, maxz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  solid      SMALLINT DEFAULT 0 NOT NULL,   -- 0 not 1 trigger 2 bbox 3 bbox (player/bot) 4 bsp
  movetype   SMALLINT DEFAULT 0 NOT NULL,   -- 0 none 2 noclip 3 walk(player) 4 step(bot) 5 fly 6 toss 7 push 8 stop 9 flymissile 10 bounce
  clipmask   INTEGER DEFAULT 1 NOT NULL,    -- what this entity collides with (MASK_*)
  flags      INTEGER DEFAULT 0 NOT NULL,    -- FL_*: 1 fly 2 swim 8 inwater 16 godmode 32 bot 64 notarget 512 onground 1024 partialground 2048 teamslave 4096 noknockback
  health     INTEGER DEFAULT 0 NOT NULL,
  max_health INTEGER DEFAULT 0 NOT NULL,
  gib_health INTEGER DEFAULT -40 NOT NULL,
  takedamage SMALLINT DEFAULT 0 NOT NULL,   -- 0 no 1 yes 2 aim
  deadflag   SMALLINT DEFAULT 0 NOT NULL,
  mass       INTEGER DEFAULT 200 NOT NULL,
  owner_id   INTEGER,
  enemy_id   INTEGER,
  goal_id    INTEGER,
  nbg_id     INTEGER,                       -- a bot's nearby goal (BotNearbyGoal), its deadline (nbg_time) and the next check
  nbg_until  DOUBLE PRECISION,
  nbg_check  DOUBLE PRECISION,
  attack_jump DOUBLE PRECISION,              -- a bot's attackjump_time: no jump in a fight before it
  attack_crouch DOUBLE PRECISION,            -- a bot's attackcrouch_time: crouched in a fight until it
  step_time DOUBLE PRECISION,                -- a bot's next footstep (the player's is player.step_time)
  camp_id    INTEGER,                       -- a bot camping (LTG_CAMP): the info_camp spot, until when (teamgoal_time), and
  camp_until DOUBLE PRECISION,              -- when it last started or chose not to (camp_time)
  camp_time  DOUBLE PRECISION,
  last_health INTEGER,                      -- a bot's health when it last looked for an enemy (lasthealth)
  item_seen  SMALLINT DEFAULT 0 NOT NULL,   -- an item that has been in the arena (botlib's level item linked to it): a powerup not yet come is no goal
  hold_item SMALLINT DEFAULT 0 NOT NULL,     -- a bot's holdable: 1 the personal teleporter, 2 the medkit (the player's is player.holdable)
  -- a bot's ammunition (ps.ammo[]: bullets, shells, grenades, rockets, lightning, slugs, cells, BFG; the player's is in player)
  ammo2 SMALLINT DEFAULT 0 NOT NULL, ammo3 SMALLINT DEFAULT 0 NOT NULL, ammo4 SMALLINT DEFAULT 0 NOT NULL, ammo5 SMALLINT DEFAULT 0 NOT NULL,
  ammo6 SMALLINT DEFAULT 0 NOT NULL, ammo7 SMALLINT DEFAULT 0 NOT NULL, ammo8 SMALLINT DEFAULT 0 NOT NULL, ammo9 SMALLINT DEFAULT 0 NOT NULL,
  st         VARCHAR(12) DEFAULT 'idle' NOT NULL,  -- bots: stand run attack pain die dead / doors: top bottom up down
  anim       VARCHAR(16),
  anim_frame INTEGER DEFAULT 0 NOT NULL,
  think      VARCHAR(24),
  nextthink  DOUBLE PRECISION,
  targetname VARCHAR(40),
  target     VARCHAR(40),
  team       VARCHAR(40),
  message    VARCHAR(400),
  spawnflags INTEGER DEFAULT 0 NOT NULL,
  wait_      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  delay      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  random_    DOUBLE PRECISION DEFAULT 0 NOT NULL,
  speed      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  lip        DOUBLE PRECISION DEFAULT 0 NOT NULL,
  dmg        INTEGER DEFAULT 0 NOT NULL,
  dmg_radius DOUBLE PRECISION DEFAULT 0 NOT NULL,
  count_     INTEGER DEFAULT 0 NOT NULL,
  height     DOUBLE PRECISION DEFAULT 0 NOT NULL,
  phase      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  item       VARCHAR(40),                   -- items: the item_defs.cls
  -- movers (doors, plats, buttons, trains, bobbing)
  p1x DOUBLE PRECISION DEFAULT 0 NOT NULL, p1y DOUBLE PRECISION DEFAULT 0 NOT NULL, p1z DOUBLE PRECISION DEFAULT 0 NOT NULL,
  p2x DOUBLE PRECISION DEFAULT 0 NOT NULL, p2y DOUBLE PRECISION DEFAULT 0 NOT NULL, p2z DOUBLE PRECISION DEFAULT 0 NOT NULL,
  dstx DOUBLE PRECISION DEFAULT 0 NOT NULL, dsty DOUBLE PRECISION DEFAULT 0 NOT NULL, dstz DOUBLE PRECISION DEFAULT 0 NOT NULL,
  mv_state   SMALLINT DEFAULT 0 NOT NULL,   -- 0 top 1 bottom 2 up 3 down
  mv_done    VARCHAR(24),                   -- think to run when the move finishes
  mv_time    DOUBLE PRECISION,              -- when it finishes
  linked_id  INTEGER,                       -- the master of a team of movers
  noise1     VARCHAR(64),                   -- start / open sound
  loop_sound VARCHAR(64),                   -- a mover's "noise" (InitMover's s.loopSound), looped while it exists
  noise2     VARCHAR(64),                   -- middle (looping) sound
  noise3     VARCHAR(64),                   -- end / close sound
  -- players and bots
  bot        VARCHAR(16),                   -- bots: the bot's name
  last_chat  DOUBLE PRECISION DEFAULT -100 NOT NULL,   -- bots: when it last said something (25 s between)
  -- the rewards (PERS_*_COUNT, EF_AWARD_*): when the last kill was (two in 3 s is excellent), the railgun
  -- hits in a row (two is impressive), the last award (1 excellent 2 impressive 3 gauntlet) and when
  last_kill    DOUBLE PRECISION DEFAULT -10 NOT NULL,
  rail_hits    SMALLINT DEFAULT 0 NOT NULL,
  award        SMALLINT DEFAULT 0 NOT NULL,
  award_time   DOUBLE PRECISION DEFAULT -10 NOT NULL,
  n_excellent  SMALLINT DEFAULT 0 NOT NULL,
  n_impressive SMALLINT DEFAULT 0 NOT NULL,
  n_gauntlet   SMALLINT DEFAULT 0 NOT NULL,
  -- accuracy (accuracy_shots, accuracy_hits): every shot but the gauntlet's, and the shots that hit someone
  acc_shots    INTEGER DEFAULT 0 NOT NULL,
  acc_hits     INTEGER DEFAULT 0 NOT NULL,
  pteam        SMALLINT DEFAULT 0 NOT NULL,             -- sessionTeam: 0 free, 1 red, 2 blue
  queued       SMALLINT DEFAULT 0 NOT NULL,             -- a tournament's bot waiting its turn (TEAM_SPECTATOR); the player's is player.spectator
  spec_time    DOUBLE PRECISION DEFAULT 0 NOT NULL,     -- since when it waits (sess.spectatorTime): the longest waiting plays next
  wins         SMALLINT DEFAULT 0 NOT NULL,             -- a tournament's sess.wins and sess.losses
  losses       SMALLINT DEFAULT 0 NOT NULL,
  pmodel     VARCHAR(16),                   -- the player model (sarge, grunt …)
  pskin      VARCHAR(16),
  color1     SMALLINT DEFAULT 4 NOT NULL,   -- the "color1" userinfo, the rail's colour: 1 blue, 2 green, 4 red, summed (4 by default, G_AddBot's too)
  legs_anim  INTEGER DEFAULT 22 NOT NULL,   -- LEGS_IDLE
  legs_time  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  torso_anim INTEGER DEFAULT 11 NOT NULL,   -- TORSO_STAND
  torso_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
  weapon     INTEGER DEFAULT 2 NOT NULL,    -- the weapon in hand (WP bit)
  weapons    INTEGER DEFAULT 3 NOT NULL,    -- bots: the weapons held
  armor      INTEGER DEFAULT 0 NOT NULL,
  frags      INTEGER DEFAULT 0 NOT NULL,
  deaths     INTEGER DEFAULT 0 NOT NULL,
  ideal_yaw  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  yaw_speed  DOUBLE PRECISION DEFAULT 30 NOT NULL,
  view_factor DOUBLE PRECISION DEFAULT 1 NOT NULL,   -- a bot's CHARACTERISTIC_VIEW_FACTOR: the share of the angle left its view turns a think
  ideal_pitch DOUBLE PRECISION,                      -- where a bot's view is turning to look up or down (NULL: level)
  attack_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  pain_finished   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  search_time     DOUBLE PRECISION DEFAULT 0 NOT NULL,
  attack_state    SMALLINT DEFAULT 0 NOT NULL,
  lefty      SMALLINT DEFAULT 0 NOT NULL,
  respawn_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
  quad_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  haste_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- bots: the other powerups (the player's are in player)
  invis_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  regen_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  enviro_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  health_tick     DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- bots: the next ClientTimerActions second
  -- placement
  leaf       INTEGER,                      -- leaf of the origin
  cluster    INTEGER,
  clusters   VARCHAR(200) CHARACTER SET ASCII,   -- ',' separated clusters the box touches
  lx DOUBLE PRECISION, ly DOUBLE PRECISION, lz DOUBLE PRECISION,   -- where it was last linked
  vis_cl     INTEGER,                      -- brush models: the view cluster VIS was decided for
  vis        SMALLINT,                     -- ... and whether the model is in that cluster's PVS
  waterlevel SMALLINT DEFAULT 0 NOT NULL,
  watertype  INTEGER DEFAULT 0 NOT NULL,
  ltime      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  body_of    INTEGER,                      -- a corpse: whose body it is, until it respawns (CopyToBodyQue)
  -- bots in a team game (ai_team.c, ai_dmq3.c): when it came, the team leader's timers (askteamleader_time,
  -- becometeamleader_time, teamgiveorders_time and the team's size it last saw), and an order to accompany
  -- a teammate (LTG_TEAMACCOMPANY): whom, who ordered it, until when, when it says it will, when it last saw
  -- the companion, whether it said it arrived
  enter_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
  tl_ask     DOUBLE PRECISION DEFAULT 0 NOT NULL,
  tl_become  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  tl_orders  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  tl_mates   SMALLINT DEFAULT 0 NOT NULL,
  acc_id     INTEGER,
  acc_by     INTEGER,
  acc_until  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  acc_msg    DOUBLE PRECISION DEFAULT 0 NOT NULL,
  acc_arrived SMALLINT DEFAULT 0 NOT NULL,
  get_id     INTEGER,                       -- a bot told to get an item (LTG_GETITEM, chat.sql): which, and until when
  get_until  DOUBLE PRECISION,
  -- a bot whose strategy a language model decides (bot_llm_state and bot_llm_apply in chat.sql; src/llm.js asks
  -- the model): 1 when it is led, what it was last told and when
  llm        SMALLINT DEFAULT 0 NOT NULL,
  llm_plan   VARCHAR(60),
  llm_time   DOUBLE PRECISION,
  -- a bot's learned fight moves (bot_rl_move in bots.sql): whether it uses them (NULL: as game.bot_rl says), the
  -- state and the move it is on and until when, the damage it has given and taken in all and at that choice
  rl         SMALLINT,
  rl_s       INTEGER,
  rl_a       SMALLINT,
  rl_until   DOUBLE PRECISION,
  rl_log     INTEGER,                       -- the row of bot_rl_log its move in progress is (while logging)
  rl_given   INTEGER DEFAULT 0 NOT NULL,
  rl_taken   INTEGER DEFAULT 0 NOT NULL,
  rl_g0      INTEGER DEFAULT 0 NOT NULL,
  rl_t0      INTEGER DEFAULT 0 NOT NULL,
  act_id     INTEGER,                       -- a bot's activate goal (BotGetActivateGoal): the button (or trigger) that opens the
  act_until  DOUBLE PRECISION,              -- shut door on its way, until when it tries; with no button, when it may try again
  acc_arrive_t DOUBLE PRECISION,             -- when it came to its companion (arrive_time): it looks at it 2 s, then about
  teleport_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
  fly_sound_time DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- fly_sound_debounce_time: a target_push's sound at most every 1.5 s
  area1      INTEGER,                    -- a brush model's areas (areanum, areanum2): a door between two holds their portal
  area2      INTEGER,
  spawn_x DOUBLE PRECISION DEFAULT 0 NOT NULL, spawn_y DOUBLE PRECISION DEFAULT 0 NOT NULL, spawn_z DOUBLE PRECISION DEFAULT 0 NOT NULL,
  alpha      SMALLINT DEFAULT 0 NOT NULL,  -- 1 = not drawn (a picked-up item waiting to respawn)
  viewheight DOUBLE PRECISION DEFAULT 0 NOT NULL,
  gravity    DOUBLE PRECISION DEFAULT 1 NOT NULL     -- a multiplier of the world's
);
CREATE INDEX ents_class ON ents (classname);
CREATE INDEX ents_tname ON ents (targetname);
CREATE INDEX ents_solid ON ents (solid);
CREATE INDEX ents_think ON ents (nextthink);
CREATE INDEX ents_model ON ents (model_id);
CREATE INDEX ents_movetype ON ents (movetype);
CREATE INDEX ents_team ON ents (team);

-- The one client.
CREATE TABLE player (
  id              SMALLINT NOT NULL PRIMARY KEY,
  ent_id          INTEGER,
  armor           INTEGER DEFAULT 0 NOT NULL,
  bullets         INTEGER DEFAULT 100 NOT NULL,
  shells          INTEGER DEFAULT 0 NOT NULL,
  grenades        INTEGER DEFAULT 0 NOT NULL,
  rockets         INTEGER DEFAULT 0 NOT NULL,
  lightning       INTEGER DEFAULT 0 NOT NULL,
  slugs           INTEGER DEFAULT 0 NOT NULL,
  cells           INTEGER DEFAULT 0 NOT NULL,
  bfg             INTEGER DEFAULT 0 NOT NULL,
  weapons         INTEGER DEFAULT 3 NOT NULL,             -- WP bits: 1 gauntlet 2 machinegun 4 shotgun 8 grenade 16 rocket 32 lightning 64 railgun 128 plasma 256 bfg
  weapon          INTEGER DEFAULT 2 NOT NULL,             -- the WP bit of the current weapon
  pending_weapon  INTEGER DEFAULT 0 NOT NULL,             -- switching to
  weapon_time     DOUBLE PRECISION DEFAULT 0 NOT NULL,    -- the switch completes
  weaponstate     SMALLINT DEFAULT 0 NOT NULL,            -- 0 ready 1 firing 2 dropping 3 raising
  attack_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  attack_start    DOUBLE PRECISION DEFAULT 0 NOT NULL,
  pain_finished   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  punchangle      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  view_ofs        DOUBLE PRECISION DEFAULT 26 NOT NULL,
  dmg_take        INTEGER DEFAULT 0 NOT NULL,
  dmg_save        INTEGER DEFAULT 0 NOT NULL,
  dmg_time        DOUBLE PRECISION DEFAULT 0 NOT NULL,
  dmg_x DOUBLE PRECISION DEFAULT 0 NOT NULL, dmg_y DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- where the last hit came from (the view kicks away from it)
  dmg_z DOUBLE PRECISION DEFAULT 0 NOT NULL,
  dmg_world       SMALLINT DEFAULT 1 NOT NULL,            -- 1: from no direction (a fall, lava, slime, drowning, a crusher, a hurt trigger)
  bonus_time      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  quad_finished   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  haste_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  invis_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  regen_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  enviro_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  flight_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  holdable        SMALLINT DEFAULT 0 NOT NULL,            -- 1 teleporter 2 medkit
  jump_released   SMALLINT DEFAULT 1 NOT NULL,
  name            VARCHAR(32) DEFAULT 'Player' NOT NULL,  -- what the bots call you
  model           VARCHAR(16) DEFAULT 'sarge' NOT NULL,   -- the model and skin played (the "model" userinfo: sarge/krusade)
  skin            VARCHAR(16) DEFAULT 'default' NOT NULL,
  color1          SMALLINT DEFAULT 4 NOT NULL,            -- the rail's colour played (the "color1" userinfo)
  spectator       SMALLINT DEFAULT 0 NOT NULL,            -- TEAM_SPECTATOR: out of the match, flying or following
  follow_id       INTEGER,                                -- SPECTATOR_FOLLOW: the bot whose eyes we see through
  spec_fire       SMALLINT DEFAULT 0 NOT NULL,            -- the attack button at the last tic (it cycles on the press)
  knockback_until DOUBLE PRECISION DEFAULT 0 NOT NULL,    -- PMF_TIME_KNOCKBACK: no ground friction, air acceleration, until then
  ducked          SMALLINT DEFAULT 0 NOT NULL,            -- PMF_DUCKED: the box 16 high instead of 32, the eye at 12 instead of 26
  fly_sound_time  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  step_time       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  air_finished    DOUBLE PRECISION DEFAULT 0 NOT NULL,
  dmg_lava_time   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  next_drown_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
  drown_dmg       INTEGER DEFAULT 2 NOT NULL,
  msg             VARCHAR(200),
  msg_time        DOUBLE PRECISION DEFAULT 0 NOT NULL,
  cprint          VARCHAR(400),
  cprint_time     DOUBLE PRECISION DEFAULT 0 NOT NULL,
  frags           INTEGER DEFAULT 0 NOT NULL,
  deaths          INTEGER DEFAULT 0 NOT NULL,
  dead_time       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  pitch           DOUBLE PRECISION DEFAULT 0 NOT NULL,    -- view pitch, degrees (+down)
  oldz            DOUBLE PRECISION DEFAULT 0 NOT NULL,
  stepz           DOUBLE PRECISION DEFAULT 0 NOT NULL,
  land_time       DOUBLE PRECISION DEFAULT 0 NOT NULL,
  land_change     DOUBLE PRECISION DEFAULT -8 NOT NULL,   -- how far the view dips on that landing: -8, -16, -24 (EV_FALL_SHORT, MEDIUM, FAR)
  mover_yaw       DOUBLE PRECISION DEFAULT 0 NOT NULL,    -- the degrees a turning mover turned us in the last q3_tic call (delta_angles[YAW])
  weapon_sound    SMALLINT DEFAULT 0 NOT NULL,
  regen_time      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  health_decay    DOUBLE PRECISION DEFAULT 0 NOT NULL,    -- health above the maximum counts down
  reward_time     DOUBLE PRECISION DEFAULT 0 NOT NULL,
  last_kill       DOUBLE PRECISION DEFAULT -10 NOT NULL,
  spawn_protect   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  lead_state      SMALLINT DEFAULT 0 NOT NULL,               -- 0 behind 1 tied 2 leading (for the announcer)
  move_speed      DOUBLE PRECISION DEFAULT 0 NOT NULL,       -- horizontal speed of the last tic (view bob)
  onground        SMALLINT DEFAULT 0 NOT NULL
);

-- S_StartSound: every sound the simulation makes, for the browser to play.
CREATE SEQUENCE sound_seq;
CREATE TABLE sound_events (
  id     INTEGER NOT NULL PRIMARY KEY,
  tic    INTEGER NOT NULL,
  ent_id INTEGER,                  -- a new sound on the same ent/channel cuts the old one
  chan   SMALLINT DEFAULT 0 NOT NULL,
  snd    VARCHAR(64) NOT NULL,
  vol    DOUBLE PRECISION DEFAULT 1 NOT NULL,
  attn   DOUBLE PRECISION DEFAULT 1 NOT NULL,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION
);

-- Temp entities the browser draws for a moment: 1 bullet hit, 2 rocket explosion,
-- 3 blood, 4 rail trail (to x2 y2 z2), 5 teleport effect, 6 plasma hit, 7 sparks,
-- 8 bfg explosion, 9 grenade explosion, 10 bubbles, 11 shotgun hit, 12 lightning beam, 13 gib splat, 14 jump pad
CREATE SEQUENCE fx_seq;
CREATE TABLE fx_events (
  id   INTEGER NOT NULL PRIMARY KEY,
  tic  INTEGER NOT NULL,
  kind SMALLINT NOT NULL,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION, z2 DOUBLE PRECISION,
  n    INTEGER DEFAULT 0 NOT NULL
);

-- The obituaries and pickup lines of the last seconds (the console's top lines)
CREATE SEQUENCE msg_seq;
CREATE TABLE messages (
  id   INTEGER NOT NULL PRIMARY KEY,
  time_ DOUBLE PRECISION NOT NULL,
  msg  VARCHAR(200) NOT NULL
);

-- Demos (CL_Record's .dm_68: the gamestate, then every snapshot the client gets, played back by the client with no
-- server running). One row per recording; its snapshots are the tic rows q3_tic returned (the playerState and the
-- rest the page reads), the entities that changed since the last one (entityState_t, delta-compressed as
-- MSG_WriteDeltaEntity does: a row only when something in it changed, `gone` when it was removed), and the sounds,
-- effects and console lines of the tic
CREATE TABLE demos (
  id       INTEGER NOT NULL PRIMARY KEY,
  map_name VARCHAR(32),
  gametype SMALLINT DEFAULT 0 NOT NULL,
  ent_id   INTEGER,                  -- the player's entity
  frames   INTEGER DEFAULT 0 NOT NULL,
  seconds  DOUBLE PRECISION DEFAULT 0 NOT NULL
);
CREATE TABLE demo_frames (
  demo_id INTEGER NOT NULL,
  n       INTEGER NOT NULL,
  tic INTEGER,
  time_ DOUBLE PRECISION,
  health INTEGER,
  max_health INTEGER,
  armor INTEGER,
  bullets INTEGER,
  shells INTEGER,
  grenades INTEGER,
  rockets INTEGER,
  lightning INTEGER,
  slugs INTEGER,
  cells INTEGER,
  bfg INTEGER,
  weapons INTEGER,
  weapon INTEGER,
  pending_weapon INTEGER,
  weaponstate SMALLINT,
  weapon_time DOUBLE PRECISION,
  attack_start DOUBLE PRECISION,
  attack_finished DOUBLE PRECISION,
  px DOUBLE PRECISION,
  py DOUBLE PRECISION,
  pz DOUBLE PRECISION,
  yaw DOUBLE PRECISION,
  pitch DOUBLE PRECISION,
  view_z DOUBLE PRECISION,
  punch DOUBLE PRECISION,
  msg VARCHAR(200),
  cprint VARCHAR(400),
  dmg_take INTEGER,
  dmg_save INTEGER,
  dmg_time DOUBLE PRECISION,
  dmg_x DOUBLE PRECISION,
  dmg_y DOUBLE PRECISION,
  bonus_time DOUBLE PRECISION,
  dead SMALLINT,
  exit_kind SMALLINT,
  frags INTEGER,
  deaths INTEGER,
  waterlevel SMALLINT,
  watertype INTEGER,
  map_name VARCHAR(32),
  level_msg VARCHAR(200),
  quad DOUBLE PRECISION,
  haste DOUBLE PRECISION,
  invis DOUBLE PRECISION,
  regen DOUBLE PRECISION,
  enviro DOUBLE PRECISION,
  flight DOUBLE PRECISION,
  holdable SMALLINT,
  leaf INTEGER,
  cluster INTEGER,
  match_over SMALLINT,
  winner VARCHAR(32),
  land_time DOUBLE PRECISION,
  onground SMALLINT,
  move_speed DOUBLE PRECISION,
  weapon_sound SMALLINT,
  lead INTEGER,
  ducked SMALLINT,
  fraglimit INTEGER,
  timelimit INTEGER,
  over_time DOUBLE PRECISION,
  next_map VARCHAR(64),
  dmg_z DOUBLE PRECISION,
  dmg_world SMALLINT,
  land_change DOUBLE PRECISION,
  vx DOUBLE PRECISION,
  vy DOUBLE PRECISION,
  warmup_end DOUBLE PRECISION,
  award SMALLINT,
  award_time DOUBLE PRECISION,
  n_excellent SMALLINT,
  n_impressive SMALLINT,
  n_gauntlet SMALLINT,
  spectator SMALLINT,
  follow_name VARCHAR(32),
  mover_yaw DOUBLE PRECISION,
  gametype SMALLINT,
  red_score INTEGER,
  blue_score INTEGER,
  team SMALLINT,
  acc_shots INTEGER,
  acc_hits INTEGER,
  follow_id INTEGER,
  view_ofs DOUBLE PRECISION,
  PRIMARY KEY (demo_id, n)
);
CREATE TABLE demo_ents (
  demo_id INTEGER NOT NULL,
  n       INTEGER NOT NULL,
  gone    SMALLINT DEFAULT 0 NOT NULL,
  id INTEGER,
  classname VARCHAR(40),
  model_id INTEGER,
  frame INTEGER,
  skin INTEGER,
  effects INTEGER,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  vx DOUBLE PRECISION,
  vy DOUBLE PRECISION,
  vz DOUBLE PRECISION,
  pitch DOUBLE PRECISION,
  yaw DOUBLE PRECISION,
  roll DOUBLE PRECISION,
  minx DOUBLE PRECISION,
  miny DOUBLE PRECISION,
  minz DOUBLE PRECISION,
  maxx DOUBLE PRECISION,
  maxy DOUBLE PRECISION,
  maxz DOUBLE PRECISION,
  solid SMALLINT,
  movetype SMALLINT,
  flags INTEGER,
  health INTEGER,
  deadflag SMALLINT,
  st VARCHAR(12),
  alpha SMALLINT,
  weapon INTEGER,
  pmodel VARCHAR(16),
  pskin VARCHAR(16),
  color1 SMALLINT,
  legs_anim INTEGER,
  legs_time DOUBLE PRECISION,
  torso_anim INTEGER,
  torso_time DOUBLE PRECISION,
  award SMALLINT,
  award_time DOUBLE PRECISION,
  waterlevel SMALLINT,
  watertype INTEGER,
  quad_finished DOUBLE PRECISION,
  haste_finished DOUBLE PRECISION,
  invis_finished DOUBLE PRECISION,
  regen_finished DOUBLE PRECISION,
  enviro_finished DOUBLE PRECISION,
  leaf INTEGER,
  cluster INTEGER,
  clusters VARCHAR(200) CHARACTER SET ASCII,
  area1 INTEGER,
  area2 INTEGER,
  loop_sound VARCHAR(64),
  count_ INTEGER,
  bot VARCHAR(16),
  pteam SMALLINT,
  queued SMALLINT,
  frags INTEGER,
  deaths INTEGER,
  wins SMALLINT,
  losses SMALLINT,
  spec_time DOUBLE PRECISION,
  viewheight DOUBLE PRECISION,
  body_of INTEGER,
  owner_id INTEGER,
  item VARCHAR(40),
  armor INTEGER,
  n_excellent SMALLINT,
  n_impressive SMALLINT,
  n_gauntlet SMALLINT,
  acc_shots INTEGER,
  acc_hits INTEGER,
  PRIMARY KEY (demo_id, n, id)
);
-- what the last snapshot said of each entity (the delta's base: the client's previous snapshot)
-- (an entity's last row up to a snapshot: demo_seek)
CREATE INDEX demo_ents_id ON demo_ents (demo_id, id, n);
CREATE TABLE demo_last (
  id INTEGER NOT NULL PRIMARY KEY,
  classname VARCHAR(40),
  model_id INTEGER,
  frame INTEGER,
  skin INTEGER,
  effects INTEGER,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  vx DOUBLE PRECISION,
  vy DOUBLE PRECISION,
  vz DOUBLE PRECISION,
  pitch DOUBLE PRECISION,
  yaw DOUBLE PRECISION,
  roll DOUBLE PRECISION,
  minx DOUBLE PRECISION,
  miny DOUBLE PRECISION,
  minz DOUBLE PRECISION,
  maxx DOUBLE PRECISION,
  maxy DOUBLE PRECISION,
  maxz DOUBLE PRECISION,
  solid SMALLINT,
  movetype SMALLINT,
  flags INTEGER,
  health INTEGER,
  deadflag SMALLINT,
  st VARCHAR(12),
  alpha SMALLINT,
  weapon INTEGER,
  pmodel VARCHAR(16),
  pskin VARCHAR(16),
  color1 SMALLINT,
  legs_anim INTEGER,
  legs_time DOUBLE PRECISION,
  torso_anim INTEGER,
  torso_time DOUBLE PRECISION,
  award SMALLINT,
  award_time DOUBLE PRECISION,
  waterlevel SMALLINT,
  watertype INTEGER,
  quad_finished DOUBLE PRECISION,
  haste_finished DOUBLE PRECISION,
  invis_finished DOUBLE PRECISION,
  regen_finished DOUBLE PRECISION,
  enviro_finished DOUBLE PRECISION,
  leaf INTEGER,
  cluster INTEGER,
  clusters VARCHAR(200) CHARACTER SET ASCII,
  area1 INTEGER,
  area2 INTEGER,
  loop_sound VARCHAR(64),
  count_ INTEGER,
  bot VARCHAR(16),
  pteam SMALLINT,
  queued SMALLINT,
  frags INTEGER,
  deaths INTEGER,
  wins SMALLINT,
  losses SMALLINT,
  spec_time DOUBLE PRECISION,
  viewheight DOUBLE PRECISION,
  body_of INTEGER,
  owner_id INTEGER,
  item VARCHAR(40),
  armor INTEGER,
  n_excellent SMALLINT,
  n_impressive SMALLINT,
  n_gauntlet SMALLINT,
  acc_shots INTEGER,
  acc_hits INTEGER
);
CREATE TABLE demo_sounds (
  demo_id INTEGER NOT NULL, n INTEGER NOT NULL, k INTEGER NOT NULL,
  ent_id INTEGER, chan SMALLINT, snd VARCHAR(64), vol DOUBLE PRECISION, attn DOUBLE PRECISION, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  PRIMARY KEY (demo_id, n, k)
);
CREATE TABLE demo_fx (
  demo_id INTEGER NOT NULL, n INTEGER NOT NULL, k INTEGER NOT NULL,
  kind SMALLINT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, x2 DOUBLE PRECISION, y2 DOUBLE PRECISION, z2 DOUBLE PRECISION, nn INTEGER,
  PRIMARY KEY (demo_id, n, k)
);
CREATE TABLE demo_msgs (
  demo_id INTEGER NOT NULL, n INTEGER NOT NULL, k INTEGER NOT NULL, msg VARCHAR(200),
  PRIMARY KEY (demo_id, n, k)
);
CREATE SEQUENCE demo_seq;

-- What a player can say to the bots (chat.sql; src/intents.js): the intents (kind: accompany, camp, dismiss, kill,
-- get with the item's class in arg, whereareyou, whatareyoudoing, hello, taunt, praise, chat for small talk), the
-- ways of saying each, and each phrase's embedding (EmbeddingGemma 2, its leading 128 dimensions, normalized;
-- src/intentvecs.js), a row a dimension so that a cosine similarity is a join and a sum
CREATE TABLE bot_intents (
  id   INTEGER NOT NULL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  arg  VARCHAR(40)
);
CREATE TABLE bot_phrases (
  id     INTEGER NOT NULL PRIMARY KEY,
  intent INTEGER NOT NULL,
  phrase VARCHAR(120) NOT NULL
);
CREATE TABLE bot_phrase_dims (
  phrase INTEGER NOT NULL,
  i      SMALLINT NOT NULL,
  v      DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (i, phrase)
);
-- the embedding of what the player just said (player_say)
CREATE GLOBAL TEMPORARY TABLE say_dims (
  i SMALLINT NOT NULL PRIMARY KEY,
  v DOUBLE PRECISION NOT NULL
) ON COMMIT DELETE ROWS;

-- What the bots have learned of fighting (reinforcement learning, tabular Q-learning: bot_rl_move in bots.sql): for
-- each state of a fight (the bot's gun, the enemy's, the distance, the bot's health, the enemy above or below) and
-- each move (0 advance, 1 strafe left, 2 strafe right, 3 back off, 4 hold, 5 Quake III's own attack move), the return expected of it, in health
-- points given less taken, and how often it was tried. Trained by self-play (scripts/rl-train.mjs) and shipped in
-- src/botq.js; mode 2 goes on learning while playing
CREATE TABLE bot_q (
  s INTEGER NOT NULL,
  a SMALLINT NOT NULL,
  q DOUBLE PRECISION DEFAULT 0 NOT NULL,
  n INTEGER DEFAULT 0 NOT NULL,
  PRIMARY KEY (s, a)
);

-- The same learned by a network (deep Q-learning; scripts/rl-deep.mjs trains it from bot_rl_log, src/botnn.js ships
-- it): the weights of a small multilayer perceptron, layer l's unit j from the layer before's unit i (i = -1:
-- the bias). Twelve inputs (the bot's gun class one-hot, 4; the enemy's, 3; the distance / 1000; the health /
-- 100; the armour / 100; the enemy's height over the bot / 200; the quad on), two hidden layers with ReLU, six
-- outputs: the moves' values. bot_nn_best in bots.sql runs it: a layer is a join and a sum
CREATE TABLE bot_nn (
  l SMALLINT NOT NULL,
  j SMALLINT NOT NULL,
  i SMALLINT NOT NULL,
  w DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (l, i, j)
);
CREATE GLOBAL TEMPORARY TABLE nn_x (
  l SMALLINT NOT NULL,
  i SMALLINT NOT NULL,
  v DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (l, i)
) ON COMMIT DELETE ROWS;
-- the moves made while game.rl_logging is on, for the network's training: the features of the fight when the
-- move was chosen, the move, what it brought (r, filled in when the next is chosen or the bot dies) and the row
-- of the move that followed in the same fight (NULL: the fight ended there)
CREATE SEQUENCE rl_log_seq;
-- The memory of a bot a language model leads (chat.sql: bot_llm_apply writes it, bot_llm_state reads it back to
-- the model, which has none of its own from one question to the next). bot_llm_log is every decision and what
-- followed it: the bot as it was when the decision was made and as it was at the next one (NULL until then).
-- bot_llm_notes is what the model asked to have remembered of an arena. A bot's last decisions are its own, by
-- its name; the totals and the notes are the arena's. The page keeps both in the browser's storage between visits.
CREATE SEQUENCE llm_seq;
CREATE TABLE bot_llm_log (
  id       INTEGER NOT NULL PRIMARY KEY,
  bot      VARCHAR(16) NOT NULL,
  map_name VARCHAR(32) NOT NULL,
  time_    DOUBLE PRECISION NOT NULL,     -- the match's clock at the decision
  action   VARCHAR(20) NOT NULL,
  arg      VARCHAR(40) NOT NULL,
  ok       SMALLINT NOT NULL,             -- 0: it could not be done (no such item there, nobody by that name)
  hp0 INTEGER NOT NULL, armor0 INTEGER NOT NULL, frags0 INTEGER NOT NULL, deaths0 INTEGER NOT NULL, weapons0 INTEGER NOT NULL,
  hp1 INTEGER, armor1 INTEGER, frags1 INTEGER, deaths1 INTEGER, weapons1 INTEGER,
  secs     DOUBLE PRECISION,              -- how long until the next decision closed it
  past     SMALLINT DEFAULT 0 NOT NULL    -- 1: of an earlier match (its clock is not this one's)
);
CREATE INDEX bot_llm_log_map ON bot_llm_log (map_name, bot, id);
CREATE TABLE bot_llm_notes (
  id       INTEGER NOT NULL PRIMARY KEY,
  bot      VARCHAR(16) NOT NULL,
  map_name VARCHAR(32) NOT NULL,
  note     VARCHAR(160) NOT NULL
);
CREATE INDEX bot_llm_notes_map ON bot_llm_notes (map_name, id);

-- What a small model was last offered (chat.sql: bot_llm_offer writes it, bot_llm_pick reads it): a small model
-- cannot be trusted with an item's class or a name, so SQL finds the best move of each kind and the model answers
-- with the kind, one word
CREATE TABLE bot_llm_choices (
  eid    INTEGER NOT NULL,
  word   VARCHAR(8) NOT NULL,
  action VARCHAR(20) NOT NULL,
  arg    VARCHAR(40) NOT NULL,
  PRIMARY KEY (eid, word)
);

CREATE TABLE bot_rl_log (
  id INTEGER NOT NULL PRIMARY KEY,
  f0 DOUBLE PRECISION, f1 DOUBLE PRECISION, f2 DOUBLE PRECISION, f3 DOUBLE PRECISION, f4 DOUBLE PRECISION, f5 DOUBLE PRECISION, f6 DOUBLE PRECISION, f7 DOUBLE PRECISION, f8 DOUBLE PRECISION, f9 DOUBLE PRECISION, f10 DOUBLE PRECISION, f11 DOUBLE PRECISION,
  a SMALLINT NOT NULL,
  r DOUBLE PRECISION,
  nxt INTEGER
);

-- The bots that can be spawned: a name, a model and a skin, a skill
CREATE TABLE bot_defs (
  name   VARCHAR(16) NOT NULL PRIMARY KEY,
  model  VARCHAR(16) NOT NULL,
  skin   VARCHAR(16) DEFAULT 'default' NOT NULL,
  skill  SMALLINT DEFAULT 2 NOT NULL
);

-- the bots' chat (botlib's be_ai_chat.c, read from the pak by src/botchat.js): each bot's lines by type,
-- the random strings of rnd.c they draw from, and the chat characteristics of its character file by
-- skill. A message is a template: {0} … {7} the variables, {r:NAME} a random string of BOT_RND
CREATE TABLE bot_chat (
  bot    VARCHAR(16) NOT NULL,
  ctype  VARCHAR(32) NOT NULL,
  idx    INTEGER NOT NULL,
  msg    VARCHAR(600) NOT NULL,
  PRIMARY KEY (bot, ctype, idx)
);
CREATE TABLE bot_rnd (
  name   VARCHAR(40) NOT NULL,
  idx    INTEGER NOT NULL,
  msg    VARCHAR(600) NOT NULL,
  PRIMARY KEY (name, idx)
);
-- the bots' item and weapon weights (botlib's be_ai_weight.c over the pak's botfiles, read by
-- src/itemweights.js; a gun's class is 'weapon:BIT'): a weight is the first case (o1, in the file's order)
-- whose bound b1 the inventory value v1 is under, within it the first (o2) whose bound b2 the value v2 is
-- under, and within that the first (o3) for v3; b 1e9 is the default, v null no switch at that level
CREATE TABLE bot_iw (
  bot  VARCHAR(16) NOT NULL,
  cls  VARCHAR(40) NOT NULL,
  o1   SMALLINT NOT NULL,
  v1   VARCHAR(32),
  b1   DOUBLE PRECISION NOT NULL,
  o2   SMALLINT NOT NULL,
  v2   VARCHAR(32),
  b2   DOUBLE PRECISION NOT NULL,
  o3   SMALLINT NOT NULL,
  v3   VARCHAR(32),
  b3   DOUBLE PRECISION NOT NULL,
  w    DOUBLE PRECISION NOT NULL
);
CREATE INDEX bot_iw_cls ON bot_iw (bot, cls);

-- the items a bot took, until they respawn (BotSetAvoidGoalTime with the item's respawn time): the bot
-- does not go for one until its travel time covers what is left, so it is back as the item is
CREATE TABLE bot_avoid (
  ent_id      INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  avoid_until DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (ent_id, item_id)
);

CREATE TABLE bot_chatchar (
  bot    VARCHAR(16) NOT NULL,
  skill  SMALLINT NOT NULL,
  ckey   VARCHAR(40) NOT NULL,              -- kill, death, insult, misc, random, startendlevel, …, and the fight's (reactiontime, aim_accuracy, …)
  val    DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (bot, skill, ckey)
);
