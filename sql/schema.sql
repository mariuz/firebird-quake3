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
CREATE TABLE game (
  id             SMALLINT NOT NULL PRIMARY KEY,
  tic            INTEGER DEFAULT 0 NOT NULL,
  time_          DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- seconds, tic / 20
  map_name       VARCHAR(32),
  next_map       VARCHAR(64),
  exit_kind      SMALLINT DEFAULT 0 NOT NULL,           -- 0 playing, 1 next map, 3 restart
  skill          SMALLINT DEFAULT 2 NOT NULL,           -- bot skill 1..5
  world_model    INTEGER DEFAULT 0 NOT NULL,            -- models.id of the world
  gravity        DOUBLE PRECISION DEFAULT 800 NOT NULL,
  level_msg      VARCHAR(200),
  sky            VARCHAR(64),                           -- the sky shader of the map
  music          VARCHAR(64),
  fraglimit      INTEGER DEFAULT 20 NOT NULL,
  match_over     SMALLINT DEFAULT 0 NOT NULL,           -- 1 once someone reached the fraglimit
  winner         VARCHAR(32),
  over_time      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  num_bots       SMALLINT DEFAULT 3 NOT NULL,
  speakers_on    SMALLINT DEFAULT 1 NOT NULL
);

CREATE TABLE viewcfg (
  id     SMALLINT NOT NULL PRIMARY KEY,
  w      INTEGER NOT NULL,
  h      INTEGER NOT NULL,
  fov    DOUBLE PRECISION NOT NULL,     -- horizontal, degrees
  near_z DOUBLE PRECISION NOT NULL,
  vis_cluster INTEGER                  -- the cluster VIS_FACES was marked for
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
  radius    DOUBLE PRECISION DEFAULT 0 NOT NULL
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
  bit      INTEGER DEFAULT 0 NOT NULL    -- weapons: the WP bit; ammo: the weapon index; powerups: the PW bit
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
  nobots     INTEGER
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
  noise2     VARCHAR(64),                   -- middle (looping) sound
  noise3     VARCHAR(64),                   -- end / close sound
  -- players and bots
  bot        VARCHAR(16),                   -- bots: the bot's name
  pmodel     VARCHAR(16),                   -- the player model (sarge, grunt …)
  pskin      VARCHAR(16),
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
  attack_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  pain_finished   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  search_time     DOUBLE PRECISION DEFAULT 0 NOT NULL,
  attack_state    SMALLINT DEFAULT 0 NOT NULL,
  lefty      SMALLINT DEFAULT 0 NOT NULL,
  respawn_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
  quad_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
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
  teleport_time DOUBLE PRECISION DEFAULT 0 NOT NULL,
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
  dmg_x DOUBLE PRECISION DEFAULT 0 NOT NULL, dmg_y DOUBLE PRECISION DEFAULT 0 NOT NULL,   -- where the last hit came from (for the HUD)
  bonus_time      DOUBLE PRECISION DEFAULT 0 NOT NULL,
  quad_finished   DOUBLE PRECISION DEFAULT 0 NOT NULL,
  haste_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  invis_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  regen_finished  DOUBLE PRECISION DEFAULT 0 NOT NULL,
  enviro_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  flight_finished DOUBLE PRECISION DEFAULT 0 NOT NULL,
  holdable        SMALLINT DEFAULT 0 NOT NULL,            -- 1 teleporter 2 medkit
  jump_released   SMALLINT DEFAULT 1 NOT NULL,
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

-- The bots that can be spawned: a name, a model and a skin, a skill
CREATE TABLE bot_defs (
  name   VARCHAR(16) NOT NULL PRIMARY KEY,
  model  VARCHAR(16) NOT NULL,
  skin   VARCHAR(16) DEFAULT 'default' NOT NULL,
  skill  SMALLINT DEFAULT 2 NOT NULL
);
