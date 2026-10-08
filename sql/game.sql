-- game.sql – the game module (g_*.c), in PSQL. Part 1: utilities, movers
-- (g_mover.c), triggers and targets (g_trigger.c, g_target.c), jump pads and
-- teleporters, items (g_items.c), damage (g_combat.c), projectiles
-- (g_missile.c), touching, and spawning the map's entities (g_spawn.c).
-- player.sql has the client (bg_pmove.c, g_weapon.c, g_client.c);
-- bots.sql the opponents and the per-tic driver.

SET TERM ^ ;

-- forward declarations (signatures must not change)
CREATE OR ALTER PROCEDURE t_damage (targ INTEGER, inflictor INTEGER, attacker INTEGER, damage INTEGER, knockback INTEGER, dflags INTEGER, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE use_targets (eid INTEGER, activator INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE bot_die (eid INTEGER, attacker INTEGER, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE bot_pain (eid INTEGER, attacker INTEGER, damage INTEGER, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE bot_chat_event (eid INTEGER, ev VARCHAR(16), other INTEGER, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE player_die (attacker INTEGER, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE door_use (eid INTEGER, activator INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE plat_go_down (eid INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE plat_go_up (eid INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE trigger_fire (eid INTEGER, activator INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE button_fire (eid INTEGER, activator INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE train_next (eid INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE t_radius_damage (inflictor INTEGER, attacker INTEGER, damage DOUBLE PRECISION, ignore INTEGER, radius DOUBLE PRECISION, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE bot_think (eid INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE player_fire (btn SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE teleport_ent (eid INTEGER, dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, dyaw DOUBLE PRECISION) AS BEGIN END^
CREATE OR ALTER PROCEDURE score_frag (attacker INTEGER, victim INTEGER, mod_ SMALLINT) AS BEGIN END^
CREATE OR ALTER PROCEDURE set_anims (eid INTEGER, legs INTEGER, torso INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE item_touch (item INTEGER, other INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE bot_item_touch (item INTEGER, other INTEGER) AS BEGIN END^

-- ── utilities ─────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE snd (eid INTEGER, chan SMALLINT, name VARCHAR(64), vol DOUBLE PRECISION, attn DOUBLE PRECISION)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE tic INTEGER;
BEGIN
  IF (name IS NULL) THEN EXIT;
  name = TRIM(name);   -- IIF/CASE over literals of different lengths pads the shorter one
  -- a "*" sound is the entity's player model's (CG_CustomSound)
  IF (name STARTING WITH '*') THEN name = 'sound/player/' || COALESCE((SELECT e.pmodel FROM ents e WHERE e.id = :eid), 'sarge') || '/' || SUBSTRING(name FROM 2);
  SELECT e.x + (e.minx + e.maxx) / 2, e.y + (e.miny + e.maxy) / 2, e.z + (e.minz + e.maxz) / 2 FROM ents e WHERE e.id = :eid INTO x, y, z;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  INSERT INTO sound_events (id, tic, ent_id, chan, snd, vol, attn, x, y, z)
    VALUES (NEXT VALUE FOR sound_seq, :tic, :eid, :chan, :name, :vol, :attn, :x, :y, :z);
END^

CREATE OR ALTER PROCEDURE snd_at (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, name VARCHAR(64), vol DOUBLE PRECISION, attn DOUBLE PRECISION)
AS
DECLARE tic INTEGER;
BEGIN
  IF (name IS NULL) THEN EXIT;
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  INSERT INTO sound_events (id, tic, ent_id, chan, snd, vol, attn, x, y, z)
    VALUES (NEXT VALUE FOR sound_seq, :tic, NULL, 0, TRIM(:name), :vol, :attn, :x, :y, :z);
END^

-- a sound only the player hears (the announcer, pickups): attenuation 0
CREATE OR ALTER PROCEDURE snd_local (name VARCHAR(64))
AS
DECLARE pe INTEGER;
BEGIN
  SELECT p.ent_id FROM player p WHERE p.id = 1 INTO pe;
  EXECUTE PROCEDURE snd(pe, 4, name, 1, 0);
END^

CREATE OR ALTER PROCEDURE fx (kind SMALLINT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION, z2 DOUBLE PRECISION, n INTEGER)
AS
DECLARE tic INTEGER;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  INSERT INTO fx_events (id, tic, kind, x, y, z, x2, y2, z2, n) VALUES (NEXT VALUE FOR fx_seq, :tic, :kind, :x, :y, :z, :x2, :y2, :z2, :n);
END^

CREATE OR ALTER PROCEDURE cprint (msg VARCHAR(400))
AS
BEGIN
  UPDATE player p SET p.cprint = :msg, p.cprint_time = (SELECT g.time_ FROM game g WHERE g.id = 1) + 3 WHERE p.id = 1;
END^

CREATE OR ALTER PROCEDURE sprint (msg VARCHAR(200))
AS
BEGIN
  UPDATE player p SET p.msg = :msg, p.msg_time = (SELECT g.time_ FROM game g WHERE g.id = 1) + 3 WHERE p.id = 1;
END^

-- a line of the console (obituaries)
CREATE OR ALTER PROCEDURE say (msg VARCHAR(200))
AS
BEGIN
  INSERT INTO messages (id, time_, msg) SELECT NEXT VALUE FOR msg_seq, g.time_, :msg FROM game g WHERE g.id = 1;
  DELETE FROM messages m WHERE m.id < (SELECT MAX(m2.id) FROM messages m2) - 6;
END^

CREATE OR ALTER FUNCTION now_ () RETURNS DOUBLE PRECISION
AS
DECLARE t DOUBLE PRECISION;
BEGIN
  SELECT g.time_ FROM game g WHERE g.id = 1 INTO t;
  RETURN t;
END^

CREATE OR ALTER FUNCTION player_ent () RETURNS INTEGER
AS
DECLARE e INTEGER;
BEGIN
  SELECT p.ent_id FROM player p WHERE p.id = 1 INTO e;
  RETURN e;
END^

-- a reward (G_Damage's and weapon_railgun_fire's): the count goes up, the medal floats over the head for
-- two seconds (EF_AWARD_*), and the player hears the announcer and sees the medal on the HUD for three
-- (CG_RewardSound, CG_DrawReward). 1 excellent, 2 impressive, 3 gauntlet
CREATE OR ALTER PROCEDURE give_award (eid INTEGER, kind SMALLINT)
AS
BEGIN
  UPDATE ents e SET e.award = :kind, e.award_time = now_(), e.n_excellent = e.n_excellent + IIF(:kind = 1, 1, 0),
         e.n_impressive = e.n_impressive + IIF(:kind = 2, 1, 0), e.n_gauntlet = e.n_gauntlet + IIF(:kind = 3, 1, 0) WHERE e.id = :eid;
  IF (eid = player_ent()) THEN
    EXECUTE PROCEDURE snd_local(TRIM(CASE kind WHEN 1 THEN 'sound/feedback/excellent.wav' WHEN 2 THEN 'sound/feedback/impressive.wav' ELSE 'sound/feedback/humiliation.wav' END));
END^

CREATE OR ALTER FUNCTION model_by_name (name VARCHAR(64)) RETURNS INTEGER
AS
DECLARE id INTEGER;
BEGIN
  SELECT FIRST 1 m.id FROM models m WHERE m.name = :name ORDER BY m.id DESC INTO id;
  RETURN id;
END^

CREATE OR ALTER FUNCTION vlen (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN SQRT(x * x + y * y + z * z);
END^

CREATE OR ALTER FUNCTION vectoyaw (x DOUBLE PRECISION, y DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
DECLARE a DOUBLE PRECISION;
BEGIN
  IF (x = 0 AND y = 0) THEN RETURN 0;
  a = ATAN2(y, x) * 57.29577951308232e0;
  IF (a < 0) THEN a = a + 360;
  RETURN a;
END^

CREATE OR ALTER FUNCTION anglemod (a DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN a - 360 * FLOOR(a / 360);
END^

-- crandom(): -1..1
CREATE OR ALTER FUNCTION crand () RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN RAND() * 2 - 1;
END^

-- the name of a player or bot for the obituaries
-- OnSameTeam: two players or bots of one team, in a team game
CREATE OR ALTER FUNCTION on_same_team (a INTEGER, b INTEGER) RETURNS SMALLINT
AS
DECLARE ta SMALLINT; DECLARE tb SMALLINT;
BEGIN
  IF (a IS NULL OR b IS NULL OR a <= 0 OR b <= 0 OR (SELECT g.gametype FROM game g WHERE g.id = 1) < 3) THEN RETURN 0;
  SELECT e.pteam FROM ents e WHERE e.id = :a AND e.classname IN ('player', 'bot') INTO ta;
  SELECT e.pteam FROM ents e WHERE e.id = :b AND e.classname IN ('player', 'bot') INTO tb;
  RETURN IIF(ta > 0 AND ta = tb, 1, 0);
END^

CREATE OR ALTER FUNCTION ent_name (eid INTEGER) RETURNS VARCHAR(32)
AS
DECLARE n VARCHAR(32);
BEGIN
  IF (eid IS NULL OR eid <= 0) THEN RETURN 'the world';
  SELECT IIF(e.classname = 'player', 'You', COALESCE(e.bot, e.classname)) FROM ents e WHERE e.id = :eid INTO n;
  RETURN COALESCE(n, 'something');
END^

-- visible(): a clear line between the eyes (MASK_OPAQUE)
CREATE OR ALTER FUNCTION visible (a INTEGER, b INTEGER) RETURNS SMALLINT
AS
DECLARE x1 DOUBLE PRECISION; DECLARE y1 DOUBLE PRECISION; DECLARE z1 DOUBLE PRECISION;
DECLARE x2 DOUBLE PRECISION; DECLARE y2 DOUBLE PRECISION; DECLARE z2 DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  SELECT e.x, e.y, e.z + e.viewheight FROM ents e WHERE e.id = :a INTO x1, y1, z1;
  SELECT e.x, e.y, e.z + e.viewheight FROM ents e WHERE e.id = :b INTO x2, y2, z2;
  IF (x1 IS NULL OR x2 IS NULL) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, x1, y1, z1, x2, y2, z2, 25)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  RETURN IIF(f = 1, 1, 0);
END^

CREATE OR ALTER FUNCTION infront (a INTEGER, b INTEGER) RETURNS SMALLINT
AS
DECLARE d DOUBLE PRECISION;
BEGIN
  SELECT (COS(e1.yaw * 0.0174532925e0) * (e2.x - e1.x) + SIN(e1.yaw * 0.0174532925e0) * (e2.y - e1.y))
         / MAXVALUE(1e-3, vlen(e2.x - e1.x, e2.y - e1.y, 0))
    FROM ents e1 CROSS JOIN ents e2 WHERE e1.id = :a AND e2.id = :b INTO d;
  RETURN IIF(d > 0.3e0, 1, 0);
END^

-- ── entities ─────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE spawn_ent (cls VARCHAR(40), x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION)
RETURNS (id INTEGER)
AS
BEGIN
  id = NEXT VALUE FOR ent_seq;
  INSERT INTO ents (id, classname, x, y, z) VALUES (:id, :cls, :x, :y, :z);
  SUSPEND;
END^

CREATE OR ALTER PROCEDURE remove_ent (eid INTEGER)
AS
BEGIN
  DELETE FROM ents e WHERE e.id = :eid;
  UPDATE ents e SET e.enemy_id = NULL WHERE e.enemy_id = :eid;
  UPDATE ents e SET e.goal_id = NULL WHERE e.goal_id = :eid;
END^

-- setmodel(): for brush models also setsize() from the model's bounds
CREATE OR ALTER PROCEDURE set_model (eid INTEGER, name VARCHAR(64))
AS
DECLARE mid INTEGER; DECLARE kind CHAR(1);
DECLARE a DOUBLE PRECISION; DECLARE b DOUBLE PRECISION; DECLARE c DOUBLE PRECISION;
DECLARE d DOUBLE PRECISION; DECLARE e_ DOUBLE PRECISION; DECLARE f DOUBLE PRECISION;
BEGIN
  SELECT FIRST 1 m.id, m.kind, m.minx, m.miny, m.minz, m.maxx, m.maxy, m.maxz FROM models m WHERE m.name = :name ORDER BY m.id DESC
    INTO mid, kind, a, b, c, d, e_, f;
  IF (mid IS NULL) THEN
  BEGIN
    UPDATE ents e SET e.model_id = NULL WHERE e.id = :eid;
    EXIT;
  END
  IF (kind = 'B') THEN
    UPDATE ents e SET e.model_id = :mid, e.minx = :a, e.miny = :b, e.minz = :c, e.maxx = :d, e.maxy = :e_, e.maxz = :f WHERE e.id = :eid;
  ELSE
    UPDATE ents e SET e.model_id = :mid WHERE e.id = :eid;
END^

-- G_SetMovedir: angle -1 up, -2 down, else a yaw
CREATE OR ALTER PROCEDURE movedir (angle DOUBLE PRECISION) RETURNS (dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION)
AS
BEGIN
  dx = 0; dy = 0; dz = 0;
  IF (angle = -1) THEN dz = 1;
  ELSE IF (angle = -2) THEN dz = -1;
  ELSE
  BEGIN
    dx = COS(COALESCE(angle, 0) * 0.0174532925e0);
    dy = SIN(COALESCE(angle, 0) * 0.0174532925e0);
  END
  SUSPEND;
END^

-- FinishSpawningItem's drop: settle onto the ground below
CREATE OR ALTER PROCEDURE drop_to_floor (eid INTEGER)
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  SELECT e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz FROM ents e WHERE e.id = :eid
    INTO px, py, pz, mnx, mny, mnz, mxx, mxy, mxz;
  EXECUTE PROCEDURE trace_move(eid, mnx, mny, mnz, mxx, mxy, mxz, px, py, pz + 1, px, py, pz - 4096, 1)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 AND als = 0) THEN
    UPDATE ents e SET e.z = :ez, e.flags = BIN_OR(e.flags, 512) WHERE e.id = :eid;
  ELSE IF (als = 1) THEN
    UPDATE ents e SET e.flags = BIN_OR(e.flags, 512) WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
END^

-- SetMoverState / InitMover: start moving a pusher toward a destination at `spd` units per second
CREATE OR ALTER PROCEDURE calc_move (eid INTEGER, tx DOUBLE PRECISION, ty DOUBLE PRECISION, tz DOUBLE PRECISION,
  spd DOUBLE PRECISION, done VARCHAR(24))
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION; DECLARE lt DOUBLE PRECISION;
DECLARE len DOUBLE PRECISION; DECLARE tt DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.z, e.ltime FROM ents e WHERE e.id = :eid INTO px, py, pz, lt;
  len = vlen(tx - px, ty - py, tz - pz);
  IF (spd <= 0) THEN spd = 100;
  tt = len / spd;
  IF (tt < 0.05e0) THEN
  BEGIN
    UPDATE ents e SET e.vx = 0, e.vy = 0, e.vz = 0, e.dstx = :tx, e.dsty = :ty, e.dstz = :tz,
           e.mv_done = :done, e.mv_time = :lt + 0.05e0, e.nextthink = NULL, e.think = NULL WHERE e.id = :eid;
    EXIT;
  END
  UPDATE ents e SET e.vx = (:tx - :px) / :tt, e.vy = (:ty - :py) / :tt, e.vz = (:tz - :pz) / :tt,
         e.dstx = :tx, e.dsty = :ty, e.dstz = :tz, e.mv_done = :done, e.mv_time = :lt + :tt, e.nextthink = NULL, e.think = NULL
   WHERE e.id = :eid;
END^

-- ── doors (g_mover.c) ─────────────────────────────────────────────────────
-- A door's "team" moves together: linked_id is the team master.
CREATE OR ALTER PROCEDURE door_go_down (eid INTEGER)
AS
DECLARE n1 VARCHAR(64); DECLARE spd DOUBLE PRECISION;
BEGIN
  SELECT e.noise1, e.speed FROM ents e WHERE e.id = :eid INTO n1, spd;
  EXECUTE PROCEDURE snd(eid, 0, n1, 1, 1);
  UPDATE ents e SET e.mv_state = 3 WHERE e.id = :eid;
  EXECUTE PROCEDURE calc_move(eid, (SELECT e.p1x FROM ents e WHERE e.id = :eid), (SELECT e.p1y FROM ents e WHERE e.id = :eid),
    (SELECT e.p1z FROM ents e WHERE e.id = :eid), spd, 'door_hit_bottom');
END^

CREATE OR ALTER PROCEDURE door_go_up (eid INTEGER, activator INTEGER)
AS
DECLARE n1 VARCHAR(64); DECLARE spd DOUBLE PRECISION; DECLARE st SMALLINT;
BEGIN
  SELECT e.noise1, e.speed, e.mv_state FROM ents e WHERE e.id = :eid INTO n1, spd, st;
  IF (st = 2) THEN EXIT;                         -- already going up
  IF (st = 0) THEN                               -- reset top wait time
  BEGIN
    UPDATE ents e SET e.nextthink = e.ltime + e.wait_, e.think = 'door_go_down' WHERE e.id = :eid AND e.wait_ >= 0;
    EXIT;
  END
  EXECUTE PROCEDURE snd(eid, 0, n1, 1, 1);
  UPDATE ents e SET e.mv_state = 2 WHERE e.id = :eid;
  EXECUTE PROCEDURE calc_move(eid, (SELECT e.p2x FROM ents e WHERE e.id = :eid), (SELECT e.p2y FROM ents e WHERE e.id = :eid),
    (SELECT e.p2z FROM ents e WHERE e.id = :eid), spd, 'door_hit_top');
  EXECUTE PROCEDURE use_targets(eid, activator);
END^

CREATE OR ALTER PROCEDURE door_hit_top (eid INTEGER)
AS
DECLARE n3 VARCHAR(64);
BEGIN
  SELECT e.noise3 FROM ents e WHERE e.id = :eid INTO n3;
  EXECUTE PROCEDURE snd(eid, 0, n3, 1, 1);
  UPDATE ents e SET e.mv_state = 0 WHERE e.id = :eid;
  UPDATE ents e SET e.nextthink = e.ltime + e.wait_, e.think = 'door_go_down' WHERE e.id = :eid AND e.wait_ >= 0;
END^

CREATE OR ALTER PROCEDURE door_hit_bottom (eid INTEGER)
AS
DECLARE n3 VARCHAR(64);
BEGIN
  SELECT e.noise3 FROM ents e WHERE e.id = :eid INTO n3;
  EXECUTE PROCEDURE snd(eid, 0, n3, 1, 1);
  UPDATE ents e SET e.mv_state = 1 WHERE e.id = :eid;
END^

-- door_use: fire the whole team
CREATE OR ALTER PROCEDURE door_use (eid INTEGER, activator INTEGER)
AS
DECLARE master INTEGER; DECLARE d INTEGER;
BEGIN
  SELECT COALESCE(e.linked_id, e.id) FROM ents e WHERE e.id = :eid INTO master;
  FOR SELECT e.id FROM ents e WHERE COALESCE(e.linked_id, e.id) = :master AND e.classname = 'func_door' INTO d DO
    EXECUTE PROCEDURE door_go_up(d, activator);
END^

-- Blocked_Door / Blocked_Mover: hurt and reverse (crushers don't reverse)
CREATE OR ALTER PROCEDURE mover_blocked (eid INTEGER, other INTEGER)
AS
DECLARE cls VARCHAR(40); DECLARE st SMALLINT; DECLARE dmg INTEGER; DECLARE wt DOUBLE PRECISION; DECLARE sf INTEGER; DECLARE d INTEGER; DECLARE master INTEGER;
BEGIN
  SELECT e.classname, e.mv_state, e.dmg, e.wait_, e.spawnflags, COALESCE(e.linked_id, e.id) FROM ents e WHERE e.id = :eid INTO cls, st, dmg, wt, sf, master;
  -- items and corpses in the way are crushed out of the way
  IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :other AND (e.solid IN (0, 1) OR e.classname IN ('corpse', 'gib')))) THEN
  BEGIN
    DELETE FROM ents e WHERE e.id = :other AND e.classname IN ('corpse', 'gib');
    EXIT;
  END
  EXECUTE PROCEDURE t_damage(other, eid, eid, dmg, 0, 0, 12);
  IF (cls = 'func_door') THEN
  BEGIN
    IF (BIN_AND(sf, 4) <> 0) THEN EXIT;          -- CRUSHER
    IF (wt >= 0) THEN
    FOR SELECT e.id FROM ents e WHERE COALESCE(e.linked_id, e.id) = :master AND e.classname = :cls INTO d DO
    BEGIN
      IF (st = 3) THEN EXECUTE PROCEDURE door_go_up(d, other); ELSE EXECUTE PROCEDURE door_go_down(d);
    END
  END
  ELSE IF (cls = 'func_plat') THEN
  BEGIN
    IF (st = 2) THEN EXECUTE PROCEDURE plat_go_down(eid); ELSE EXECUTE PROCEDURE plat_go_up(eid);
  END
END^

-- ── plats ────────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE plat_go_down (eid INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise1 FROM ents e WHERE e.id = :eid), 1, 1);
  UPDATE ents e SET e.mv_state = 3 WHERE e.id = :eid;
  EXECUTE PROCEDURE calc_move(eid, (SELECT e.p1x FROM ents e WHERE e.id = :eid), (SELECT e.p1y FROM ents e WHERE e.id = :eid),
    (SELECT e.p1z FROM ents e WHERE e.id = :eid), (SELECT e.speed FROM ents e WHERE e.id = :eid), 'plat_hit_bottom');
END^

CREATE OR ALTER PROCEDURE plat_go_up (eid INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise1 FROM ents e WHERE e.id = :eid), 1, 1);
  UPDATE ents e SET e.mv_state = 2 WHERE e.id = :eid;
  EXECUTE PROCEDURE calc_move(eid, (SELECT e.p2x FROM ents e WHERE e.id = :eid), (SELECT e.p2y FROM ents e WHERE e.id = :eid),
    (SELECT e.p2z FROM ents e WHERE e.id = :eid), (SELECT e.speed FROM ents e WHERE e.id = :eid), 'plat_hit_top');
END^

CREATE OR ALTER PROCEDURE plat_hit_top (eid INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise3 FROM ents e WHERE e.id = :eid), 1, 1);
  UPDATE ents e SET e.mv_state = 0, e.think = 'plat_go_down', e.nextthink = e.ltime + e.wait_ WHERE e.id = :eid;
END^

CREATE OR ALTER PROCEDURE plat_hit_bottom (eid INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise3 FROM ents e WHERE e.id = :eid), 1, 1);
  UPDATE ents e SET e.mv_state = 1 WHERE e.id = :eid;
END^

-- ── buttons ─────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE button_fire (eid INTEGER, activator INTEGER)
AS
DECLARE st SMALLINT;
BEGIN
  SELECT e.mv_state FROM ents e WHERE e.id = :eid INTO st;
  IF (st IN (2, 0)) THEN EXIT;
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise1 FROM ents e WHERE e.id = :eid), 1, 2);
  UPDATE ents e SET e.mv_state = 2, e.enemy_id = :activator WHERE e.id = :eid;
  EXECUTE PROCEDURE calc_move(eid, (SELECT e.p2x FROM ents e WHERE e.id = :eid), (SELECT e.p2y FROM ents e WHERE e.id = :eid),
    (SELECT e.p2z FROM ents e WHERE e.id = :eid), (SELECT e.speed FROM ents e WHERE e.id = :eid), 'button_wait');
END^

CREATE OR ALTER PROCEDURE button_wait (eid INTEGER)
AS
DECLARE act INTEGER;
BEGIN
  SELECT e.enemy_id FROM ents e WHERE e.id = :eid INTO act;
  UPDATE ents e SET e.mv_state = 0 WHERE e.id = :eid;
  EXECUTE PROCEDURE use_targets(eid, COALESCE(act, player_ent()));
  UPDATE ents e SET e.think = 'button_return', e.nextthink = e.ltime + e.wait_ WHERE e.id = :eid AND e.wait_ >= 0;
END^

CREATE OR ALTER PROCEDURE button_return (eid INTEGER)
AS
BEGIN
  UPDATE ents e SET e.mv_state = 3 WHERE e.id = :eid;
  EXECUTE PROCEDURE calc_move(eid, (SELECT e.p1x FROM ents e WHERE e.id = :eid), (SELECT e.p1y FROM ents e WHERE e.id = :eid),
    (SELECT e.p1z FROM ents e WHERE e.id = :eid), (SELECT e.speed FROM ents e WHERE e.id = :eid), 'button_done');
END^

CREATE OR ALTER PROCEDURE button_done (eid INTEGER)
AS
BEGIN
  UPDATE ents e SET e.mv_state = 1 WHERE e.id = :eid;
END^

-- ── trains ──────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE train_next (eid INTEGER)
AS
DECLARE tgt VARCHAR(40); DECLARE cx DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION;
DECLARE ctarget VARCHAR(40); DECLARE cwait DOUBLE PRECISION; DECLARE cid INTEGER; DECLARE cspeed DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION; DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
BEGIN
  SELECT e.target, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz FROM ents e WHERE e.id = :eid INTO tgt, mnx, mny, mnz, mxx, mxy, mxz;
  SELECT FIRST 1 e.id, e.x, e.y, e.z, e.target, e.wait_, e.speed FROM ents e WHERE e.targetname = :tgt AND e.classname = 'path_corner'
    INTO cid, cx, cy, cz, ctarget, cwait, cspeed;
  IF (cx IS NULL) THEN EXIT;
  -- Q3 trains move their centre to the corner
  UPDATE ents e SET e.target = :ctarget, e.wait_ = COALESCE(:cwait, 0), e.goal_id = :cid, e.speed = IIF(COALESCE(:cspeed, 0) > 0, :cspeed, e.speed) WHERE e.id = :eid;
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise1 FROM ents e WHERE e.id = :eid), 1, 1);
  EXECUTE PROCEDURE calc_move(eid, cx - (mnx + mxx) / 2, cy - (mny + mxy) / 2, cz - (mnz + mxz) / 2, (SELECT e.speed FROM ents e WHERE e.id = :eid), 'train_wait');
END^

CREATE OR ALTER PROCEDURE train_wait (eid INTEGER)
AS
DECLARE wt DOUBLE PRECISION;
BEGIN
  SELECT e.wait_ FROM ents e WHERE e.id = :eid INTO wt;
  EXECUTE PROCEDURE snd(eid, 0, (SELECT e.noise3 FROM ents e WHERE e.id = :eid), 1, 1);
  IF (wt < 0) THEN EXIT;                                        -- wait for a trigger
  UPDATE ents e SET e.think = 'train_next', e.nextthink = e.ltime + IIF(:wt > 0, :wt, 0.1e0) WHERE e.id = :eid;
END^

CREATE OR ALTER PROCEDURE train_find (eid INTEGER)
AS
DECLARE tgt VARCHAR(40); DECLARE cx DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION;
BEGIN
  SELECT e.target FROM ents e WHERE e.id = :eid INTO tgt;
  SELECT FIRST 1 e.x, e.y, e.z FROM ents e WHERE e.targetname = :tgt AND e.classname = 'path_corner' INTO cx, cy, cz;
  IF (cx IS NOT NULL) THEN
    UPDATE ents e SET e.x = :cx - (e.minx + e.maxx) / 2, e.y = :cy - (e.miny + e.maxy) / 2, e.z = :cz - (e.minz + e.maxz) / 2, e.think = NULL, e.nextthink = NULL WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
  EXECUTE PROCEDURE train_next(eid);
END^

-- func_timer: fire the target every wait (± random) seconds
CREATE OR ALTER PROCEDURE timer_think (eid INTEGER)
AS
DECLARE wt DOUBLE PRECISION; DECLARE rnd DOUBLE PRECISION;
BEGIN
  SELECT e.wait_, e.random_ FROM ents e WHERE e.id = :eid INTO wt, rnd;
  EXECUTE PROCEDURE use_targets(eid, player_ent());
  UPDATE ents e SET e.think = 'timer_think', e.nextthink = now_() + :wt + crand() * :rnd WHERE e.id = :eid;
END^

-- target_speaker with a wait: a random ambient sound every wait ± random seconds
CREATE OR ALTER PROCEDURE speaker_think (eid INTEGER)
AS
DECLARE wt DOUBLE PRECISION; DECLARE rnd DOUBLE PRECISION; DECLARE n VARCHAR(64); DECLARE vol DOUBLE PRECISION; DECLARE attn DOUBLE PRECISION;
BEGIN
  SELECT e.wait_, e.random_, e.noise1, e.speed, e.height FROM ents e WHERE e.id = :eid INTO wt, rnd, n, vol, attn;
  EXECUTE PROCEDURE snd(eid, 0, n, vol, attn);
  UPDATE ents e SET e.think = 'speaker_think', e.nextthink = now_() + :wt + crand() * :rnd WHERE e.id = :eid;
END^

-- ── teleporters and jump pads ──────────────────────────────────────────
-- TeleportPlayer: move to the destination, face its angle, and spit the entity out at 400
CREATE OR ALTER PROCEDURE teleport_ent (eid INTEGER, dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, dyaw DOUBLE PRECISION)
AS
DECLARE v INTEGER; DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE oz DOUBLE PRECISION; DECLARE spec SMALLINT = 0;
BEGIN
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO ox, oy, oz;
  -- a spectator goes through unseen and kills nobody (TeleportPlayer)
  IF (eid = player_ent()) THEN SELECT p.spectator FROM player p WHERE p.id = 1 INTO spec;
  IF (spec = 0) THEN
  BEGIN
    EXECUTE PROCEDURE snd_at(ox, oy, oz, 'sound/world/teleout.wav', 1, 1);
    EXECUTE PROCEDURE fx(5, ox, oy, oz, 0, 0, 0, 0);
  END
  -- telefrag anything at the destination
  IF (spec = 0) THEN
  FOR SELECT e.id FROM ents e JOIN ents o ON o.id = :eid
       WHERE e.id <> :eid AND e.takedamage > 0 AND e.health > 0 AND e.solid = 3
         AND e.x + e.maxx >= :dx + o.minx AND e.x + e.minx <= :dx + o.maxx
         AND e.y + e.maxy >= :dy + o.miny AND e.y + e.miny <= :dy + o.maxy
         AND e.z + e.maxz >= :dz + 1 + o.minz AND e.z + e.minz <= :dz + 1 + o.maxz INTO v DO
    EXECUTE PROCEDURE t_damage(v, eid, eid, 100000, 0, 8, 10);
  UPDATE ents e SET e.x = :dx, e.y = :dy, e.z = :dz + 1, e.yaw = :dyaw, e.pitch = 0,
         e.vx = COS(:dyaw * 0.0174532925e0) * 400, e.vy = SIN(:dyaw * 0.0174532925e0) * 400, e.vz = 0,
         e.flags = BIN_AND(e.flags, BIN_NOT(512)), e.teleport_time = now_() + 0.7e0, e.ideal_yaw = :dyaw WHERE e.id = :eid;
  IF (eid = player_ent()) THEN UPDATE player p SET p.pitch = 0 WHERE p.id = 1;
  EXECUTE PROCEDURE link_ent(eid);
  IF (spec = 1) THEN EXIT;
  EXECUTE PROCEDURE snd_at(dx, dy, dz, 'sound/world/telein.wav', 1, 1);
  EXECUTE PROCEDURE fx(5, dx, dy, dz + 1, 0, 0, 0, 1);
END^

-- trigger_teleport: to the misc_teleporter_dest it targets
CREATE OR ALTER PROCEDURE teleport_touch (trig INTEGER, other INTEGER)
AS
DECLARE tgt VARCHAR(40);
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE dyaw DOUBLE PRECISION;
BEGIN
  SELECT e.target FROM ents e WHERE e.id = :trig INTO tgt;
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :other AND e.classname IN ('player', 'bot') AND e.health > 0)) THEN EXIT;
  SELECT FIRST 1 e.x, e.y, e.z, e.yaw FROM ents e WHERE e.targetname = :tgt AND e.classname IN ('misc_teleporter_dest', 'target_position', 'info_notnull') INTO dx, dy, dz, dyaw;
  IF (dx IS NULL) THEN EXIT;
  EXECUTE PROCEDURE teleport_ent(other, dx, dy, dz, COALESCE(dyaw, 0));
END^

-- trigger_push: a jump pad throws the toucher at its target_position (AimAtTarget's velocity, p1 = the velocity)
CREATE OR ALTER PROCEDURE push_touch (trig INTEGER, other INTEGER)
AS
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION; DECLARE tt DOUBLE PRECISION; DECLARE cls VARCHAR(40);
BEGIN
  SELECT e.p1x, e.p1y, e.p1z FROM ents e WHERE e.id = :trig INTO vx, vy, vz;
  SELECT e.teleport_time, e.classname FROM ents e WHERE e.id = :other INTO tt, cls;
  IF (cls NOT IN ('player', 'bot') OR tt > now_()) THEN EXIT;
  UPDATE ents e SET e.vx = :vx, e.vy = :vy, e.vz = :vz, e.flags = BIN_AND(e.flags, BIN_NOT(512)), e.teleport_time = now_() + 0.2e0 WHERE e.id = :other;
  EXECUTE PROCEDURE set_anims(other, 20, NULL);   -- LEGS_JUMPB
  EXECUTE PROCEDURE snd(other, 0, 'sound/world/jumppad.wav', 1, 1);
  EXECUTE PROCEDURE fx(14, (SELECT e.x FROM ents e WHERE e.id = :trig), (SELECT e.y FROM ents e WHERE e.id = :trig), (SELECT e.z FROM ents e WHERE e.id = :trig), 0, 0, 0, 0);
END^

-- trigger_hurt: dmg every tic (or every second with SLOW); 8 = NO_PROTECTION
CREATE OR ALTER PROCEDURE hurt_touch (trig INTEGER, other INTEGER)
AS
DECLARE nt DOUBLE PRECISION; DECLARE dmg INTEGER; DECLARE sf INTEGER; DECLARE t DOUBLE PRECISION;
BEGIN
  t = now_();
  SELECT e.nextthink, e.dmg, e.spawnflags FROM ents e WHERE e.id = :trig INTO nt, dmg, sf;
  IF (nt IS NOT NULL AND nt > t) THEN EXIT;
  UPDATE ents e SET e.nextthink = :t + IIF(BIN_AND(:sf, 16) <> 0, 1, 0.1e0) WHERE e.id = :trig;
  IF (BIN_AND(sf, 4) = 0) THEN EXECUTE PROCEDURE snd(other, 2, 'sound/world/electro.wav', 1, 1);
  EXECUTE PROCEDURE t_damage(other, trig, trig, dmg, 0, IIF(BIN_AND(:sf, 8) <> 0, 8, 0), 11);
END^

-- G_TouchTriggers for one player or bot: triggers and items whose box it is in
CREATE OR ALTER PROCEDURE touch_triggers (eid INTEGER)
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE tid INTEGER; DECLARE tcls VARCHAR(40); DECLARE tst SMALLINT; DECLARE tn VARCHAR(40); DECLARE pe INTEGER; DECLARE spec SMALLINT = 0;
BEGIN
  pe = player_ent();
  -- a spectator only goes through teleporters and opens doors (G_TouchTriggers)
  IF (eid = pe) THEN SELECT p.spectator FROM player p WHERE p.id = 1 INTO spec;
  SELECT e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz FROM ents e WHERE e.id = :eid AND e.health > 0 INTO px, py, pz, mnx, mny, mnz, mxx, mxy, mxz;
  IF (px IS NULL) THEN EXIT;
  FOR SELECT e.id, e.classname FROM ents e
       WHERE e.solid = 1 AND e.id <> :eid
         AND e.x + e.maxx >= :px + :mnx AND e.x + e.minx <= :px + :mxx
         AND e.y + e.maxy >= :py + :mny AND e.y + e.miny <= :py + :mxy
         AND e.z + e.maxz >= :pz + :mnz AND e.z + e.minz <= :pz + :mxz
       ORDER BY e.id INTO tid, tcls
  DO
  BEGIN
    IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :tid)) THEN CONTINUE;
    IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid)) THEN EXIT;
    IF (spec = 1 AND tcls NOT IN ('trigger_teleport', 'door_trigger')) THEN CONTINUE;
    IF (tcls IN ('trigger_multiple', 'trigger_once')) THEN EXECUTE PROCEDURE trigger_fire(tid, eid);
    ELSE IF (tcls = 'trigger_teleport') THEN EXECUTE PROCEDURE teleport_touch(tid, eid);
    ELSE IF (tcls = 'trigger_push') THEN EXECUTE PROCEDURE push_touch(tid, eid);
    ELSE IF (tcls = 'trigger_hurt') THEN EXECUTE PROCEDURE hurt_touch(tid, eid);
    ELSE IF (tcls = 'item') THEN EXECUTE PROCEDURE item_touch(tid, eid);
    ELSE IF (tcls = 'door_trigger') THEN
    BEGIN
      SELECT e.mv_state FROM ents e WHERE e.id = (SELECT d.owner_id FROM ents d WHERE d.id = :tid) INTO tst;
      IF (tst = 1 OR tst = 3) THEN EXECUTE PROCEDURE door_use((SELECT d.owner_id FROM ents d WHERE d.id = :tid), eid);
      ELSE IF (tst = 0) THEN UPDATE ents e SET e.nextthink = e.ltime + e.wait_ WHERE COALESCE(e.linked_id, e.id) = (SELECT d.owner_id FROM ents d WHERE d.id = :tid) AND e.think = 'door_go_down';
    END
    ELSE IF (tcls = 'plat_trigger') THEN
    BEGIN
      SELECT e.mv_state FROM ents e WHERE e.id = (SELECT d.owner_id FROM ents d WHERE d.id = :tid) INTO tst;
      IF (tst = 1) THEN EXECUTE PROCEDURE plat_go_up((SELECT d.owner_id FROM ents d WHERE d.id = :tid));
      ELSE IF (tst = 0) THEN UPDATE ents e SET e.nextthink = e.ltime + e.wait_ WHERE e.id = (SELECT d.owner_id FROM ents d WHERE d.id = :tid) AND e.think = 'plat_go_down';
    END
  END
  -- buttons are fired by touching the brush itself
  IF (spec = 1) THEN EXIT;
  FOR SELECT e.id FROM ents e
       WHERE e.classname = 'func_button' AND e.mv_state = 1
         AND e.x + e.maxx + 2 >= :px + :mnx AND e.x + e.minx - 2 <= :px + :mxx
         AND e.y + e.maxy + 2 >= :py + :mny AND e.y + e.miny - 2 <= :py + :mxy
         AND e.z + e.maxz + 2 >= :pz + :mnz AND e.z + e.minz - 2 <= :pz + :mxz
       INTO tid DO
    EXECUTE PROCEDURE button_fire(tid, eid);
END^

-- ── triggers and targets ───────────────────────────────────────────────
-- G_UseTargets: fire everything named by `target`
CREATE OR ALTER PROCEDURE use_targets (eid INTEGER, activator INTEGER)
AS
DECLARE tgt VARCHAR(40); DECLARE msg VARCHAR(400); DECLARE dl DOUBLE PRECISION; DECLARE cls VARCHAR(40);
DECLARE t INTEGER; DECLARE tcls VARCHAR(40); DECLARE tid INTEGER; DECLARE st SMALLINT; DECLARE sf INTEGER; DECLARE n VARCHAR(64);
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE d INTEGER; DECLARE vol DOUBLE PRECISION; DECLARE attn DOUBLE PRECISION;
DECLARE yaw DOUBLE PRECISION; DECLARE tgt2 VARCHAR(40);
BEGIN
  SELECT e.target, e.message, e.delay, e.classname FROM ents e WHERE e.id = :eid INTO tgt, msg, dl, cls;
  IF (dl > 0) THEN
  BEGIN
    -- create a temporary object to fire at a later time
    EXECUTE PROCEDURE spawn_ent('DelayedUse', 0, 0, 0) RETURNING_VALUES tid;
    UPDATE ents e SET e.target = :tgt, e.message = :msg, e.think = 'delayed_use', e.nextthink = now_() + :dl, e.enemy_id = :activator WHERE e.id = :tid;
    EXIT;
  END
  IF (msg IS NOT NULL AND msg <> '' AND activator = player_ent() AND cls NOT IN ('func_door')) THEN
    EXECUTE PROCEDURE cprint(msg);
  IF (tgt IS NULL OR tgt = '') THEN EXIT;
  FOR SELECT e.id, e.classname FROM ents e WHERE e.targetname = :tgt AND e.id <> :eid INTO t, tcls DO
  BEGIN
    IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :t)) THEN CONTINUE;
    IF (tcls = 'func_door') THEN EXECUTE PROCEDURE door_use(t, activator);
    ELSE IF (tcls = 'func_plat') THEN
    BEGIN
      SELECT e.mv_state FROM ents e WHERE e.id = :t INTO st;
      IF (st = 0) THEN EXECUTE PROCEDURE plat_go_down(t); ELSE IF (st = 1) THEN EXECUTE PROCEDURE plat_go_up(t);
    END
    ELSE IF (tcls = 'func_button') THEN EXECUTE PROCEDURE button_fire(t, activator);
    ELSE IF (tcls = 'func_train') THEN
    BEGIN
      SELECT e.mv_state FROM ents e WHERE e.id = :t INTO st;
      IF (st = 1) THEN BEGIN UPDATE ents e SET e.mv_state = 2 WHERE e.id = :t; EXECUTE PROCEDURE train_next(t); END
    END
    ELSE IF (tcls = 'func_timer') THEN
    BEGIN
      IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :t AND e.nextthink IS NOT NULL)) THEN
        UPDATE ents e SET e.nextthink = NULL, e.think = NULL WHERE e.id = :t;     -- turn it off
      ELSE
        UPDATE ents e SET e.think = 'timer_think', e.nextthink = now_() + e.delay WHERE e.id = :t;
    END
    ELSE IF (tcls = 'func_rotating') THEN
      UPDATE ents e SET e.avel_yaw = IIF(e.avel_yaw = 0, e.speed, 0) WHERE e.id = :t;
    ELSE IF (tcls IN ('trigger_relay', 'trigger_once', 'trigger_multiple', 'trigger_always', 'target_relay')) THEN
      EXECUTE PROCEDURE trigger_fire(t, activator);
    ELSE IF (tcls = 'target_delay') THEN
    BEGIN
      EXECUTE PROCEDURE spawn_ent('DelayedUse', 0, 0, 0) RETURNING_VALUES tid;
      UPDATE ents e SET e.target = (SELECT d.target FROM ents d WHERE d.id = :t), e.think = 'delayed_use',
             e.nextthink = now_() + (SELECT MAXVALUE(d.wait_, 0.1e0) + crand() * d.random_ FROM ents d WHERE d.id = :t), e.enemy_id = :activator WHERE e.id = :tid;
    END
    ELSE IF (tcls = 'trigger_hurt') THEN UPDATE ents e SET e.solid = IIF(e.solid = 1, 0, 1) WHERE e.id = :t;   -- toggle
    ELSE IF (tcls = 'target_speaker') THEN
    BEGIN
      SELECT e.noise1, e.x, e.y, e.z, e.speed, e.height, e.spawnflags FROM ents e WHERE e.id = :t INTO n, x, y, z, vol, attn, sf;
      -- a "*" sound is the activator's player model's (CG_CustomSound): q3dm17's void screams "*falling1.wav"
      IF (n STARTING WITH '*') THEN n = 'sound/player/' || COALESCE((SELECT a.pmodel FROM ents a WHERE a.id = :activator), 'sarge') || '/' || SUBSTRING(n FROM 2);
      IF (BIN_AND(sf, 3) <> 0) THEN
        UPDATE ents e SET e.count_ = 1 - e.count_ WHERE e.id = :t;      -- a looped speaker toggles: the browser follows ents.count_
      ELSE IF (BIN_AND(sf, 8) <> 0 OR attn = 0) THEN EXECUTE PROCEDURE snd_local(n);   -- GLOBAL
      ELSE EXECUTE PROCEDURE snd_at(x, y, z, n, vol, attn);
    END
    ELSE IF (tcls = 'target_print') THEN
      EXECUTE PROCEDURE cprint((SELECT e.message FROM ents e WHERE e.id = :t));
    ELSE IF (tcls = 'target_kill') THEN
      EXECUTE PROCEDURE t_damage(activator, t, t, 100000, 0, 8, 11);
    ELSE IF (tcls = 'target_teleporter') THEN
    BEGIN
      SELECT e.target FROM ents e WHERE e.id = :t INTO tgt2;
      SELECT FIRST 1 e.x, e.y, e.z, e.yaw FROM ents e WHERE e.targetname = :tgt2 INTO x, y, z, yaw;
      IF (x IS NOT NULL) THEN EXECUTE PROCEDURE teleport_ent(activator, x, y, z, COALESCE(yaw, 0));
    END
    ELSE IF (tcls = 'target_give') THEN
    BEGIN
      -- give the activator every item the target_give targets
      SELECT e.target FROM ents e WHERE e.id = :t INTO tgt2;
      FOR SELECT e.id FROM ents e WHERE e.targetname = :tgt2 AND e.classname = 'item' INTO d DO EXECUTE PROCEDURE item_touch(d, activator);
    END
    ELSE IF (tcls = 'target_remove_powerups') THEN
      UPDATE player p SET p.quad_finished = 0, p.haste_finished = 0, p.invis_finished = 0, p.regen_finished = 0, p.enviro_finished = 0, p.flight_finished = 0 WHERE p.id = 1 AND p.ent_id = :activator;
    ELSE IF (tcls = 'target_position' OR tcls = 'info_notnull' OR tcls = 'misc_teleporter_dest' OR tcls = 'path_corner' OR tcls = 'target_location') THEN BEGIN END
    ELSE EXECUTE PROCEDURE use_targets(t, activator);               -- anything with a target of its own
  END
END^

CREATE OR ALTER PROCEDURE delayed_use (eid INTEGER)
AS
DECLARE act INTEGER;
BEGIN
  SELECT e.enemy_id FROM ents e WHERE e.id = :eid INTO act;
  UPDATE ents e SET e.delay = 0 WHERE e.id = :eid;
  EXECUTE PROCEDURE use_targets(eid, COALESCE(act, player_ent()));
  DELETE FROM ents e WHERE e.id = :eid;
END^

-- multi_trigger: targets, then wait or die
CREATE OR ALTER PROCEDURE trigger_fire (eid INTEGER, activator INTEGER)
AS
DECLARE wt DOUBLE PRECISION; DECLARE nt DOUBLE PRECISION; DECLARE cls VARCHAR(40); DECLARE n1 VARCHAR(64);
BEGIN
  SELECT e.wait_, e.nextthink, e.classname, e.noise1 FROM ents e WHERE e.id = :eid INTO wt, nt, cls, n1;
  IF (nt IS NOT NULL AND nt > now_() AND cls NOT IN ('trigger_relay', 'target_relay')) THEN EXIT;    -- already been triggered
  IF (n1 IS NOT NULL) THEN EXECUTE PROCEDURE snd(activator, 2, n1, 1, 1);
  EXECUTE PROCEDURE use_targets(eid, activator);
  IF (cls IN ('trigger_relay', 'target_relay')) THEN EXIT;
  IF (wt > 0) THEN
    UPDATE ents e SET e.nextthink = now_() + :wt + crand() * e.random_, e.think = 'multi_wait' WHERE e.id = :eid;
  ELSE IF (wt < 0) THEN
    DELETE FROM ents e WHERE e.id = :eid;
END^

CREATE OR ALTER PROCEDURE multi_wait (eid INTEGER)
AS
BEGIN
  UPDATE ents e SET e.nextthink = NULL, e.think = NULL WHERE e.id = :eid;
END^

-- ── items (g_items.c) ────────────────────────────────────────────────────
CREATE OR ALTER FUNCTION ammo_count (idx SMALLINT) RETURNS INTEGER
AS
DECLARE n INTEGER;
BEGIN
  SELECT CASE :idx WHEN 2 THEN p.bullets WHEN 3 THEN p.shells WHEN 4 THEN p.grenades WHEN 5 THEN p.rockets WHEN 6 THEN p.lightning WHEN 7 THEN p.slugs WHEN 8 THEN p.cells WHEN 9 THEN p.bfg ELSE -1 END
    FROM player p WHERE p.id = 1 INTO n;
  RETURN COALESCE(n, 0);
END^

-- the ammo index of a weapon bit (0: the gauntlet needs none)
CREATE OR ALTER FUNCTION weapon_ammo (w INTEGER) RETURNS SMALLINT
AS
BEGIN
  RETURN CASE w WHEN 2 THEN 2 WHEN 4 THEN 3 WHEN 8 THEN 4 WHEN 16 THEN 5 WHEN 32 THEN 6 WHEN 64 THEN 7 WHEN 128 THEN 8 WHEN 256 THEN 9 ELSE 0 END;
END^

CREATE OR ALTER FUNCTION weapon_name (w INTEGER) RETURNS VARCHAR(24)
AS
BEGIN
  RETURN TRIM(CASE w WHEN 1 THEN 'Gauntlet' WHEN 2 THEN 'Machinegun' WHEN 4 THEN 'Shotgun' WHEN 8 THEN 'Grenade Launcher' WHEN 16 THEN 'Rocket Launcher'
    WHEN 32 THEN 'Lightning Gun' WHEN 64 THEN 'Railgun' WHEN 128 THEN 'Plasma Gun' WHEN 256 THEN 'BFG10K' ELSE '' END);
END^

-- Add_Ammo: up to 200
CREATE OR ALTER PROCEDURE add_ammo (idx SMALLINT, n INTEGER)
AS
BEGIN
  UPDATE player p SET
    p.bullets = IIF(:idx = 2, MINVALUE(200, p.bullets + :n), p.bullets), p.shells = IIF(:idx = 3, MINVALUE(200, p.shells + :n), p.shells),
    p.grenades = IIF(:idx = 4, MINVALUE(200, p.grenades + :n), p.grenades), p.rockets = IIF(:idx = 5, MINVALUE(200, p.rockets + :n), p.rockets),
    p.lightning = IIF(:idx = 6, MINVALUE(200, p.lightning + :n), p.lightning), p.slugs = IIF(:idx = 7, MINVALUE(200, p.slugs + :n), p.slugs),
    p.cells = IIF(:idx = 8, MINVALUE(200, p.cells + :n), p.cells), p.bfg = IIF(:idx = 9, MINVALUE(200, p.bfg + :n), p.bfg)
   WHERE p.id = 1;
END^

-- the best weapon the player holds with ammo (the order cg_autoswitch and the bots prefer)
CREATE OR ALTER FUNCTION best_weapon () RETURNS INTEGER
AS
DECLARE w INTEGER;
BEGIN
  SELECT p.weapons FROM player p WHERE p.id = 1 INTO w;
  IF (BIN_AND(w, 16) <> 0 AND ammo_count(5) > 0) THEN RETURN 16;
  IF (BIN_AND(w, 64) <> 0 AND ammo_count(7) > 0) THEN RETURN 64;
  IF (BIN_AND(w, 32) <> 0 AND ammo_count(6) > 0) THEN RETURN 32;
  IF (BIN_AND(w, 128) <> 0 AND ammo_count(8) > 0) THEN RETURN 128;
  IF (BIN_AND(w, 256) <> 0 AND ammo_count(9) > 0) THEN RETURN 256;
  IF (BIN_AND(w, 4) <> 0 AND ammo_count(3) > 0) THEN RETURN 4;
  IF (BIN_AND(w, 8) <> 0 AND ammo_count(4) > 0) THEN RETURN 8;
  IF (BIN_AND(w, 2) <> 0 AND ammo_count(2) > 0) THEN RETURN 2;
  RETURN 1;
END^

-- a picked-up item hides until it respawns
CREATE OR ALTER PROCEDURE item_taken (item INTEGER, respawn DOUBLE PRECISION)
AS
BEGIN
  UPDATE ents e SET e.solid = 0, e.alpha = 1, e.think = 'item_respawn', e.nextthink = now_() + :respawn WHERE e.id = :item;
END^

CREATE OR ALTER PROCEDURE item_respawn (eid INTEGER)
AS
DECLARE kind CHAR(1);
BEGIN
  SELECT d.kind FROM ents e JOIN item_defs d ON d.cls = e.item WHERE e.id = :eid INTO kind;
  UPDATE ents e SET e.solid = 1, e.alpha = 0, e.think = NULL, e.nextthink = NULL, e.teleport_time = now_() WHERE e.id = :eid;
  EXECUTE PROCEDURE snd(eid, 0, IIF(kind = 'P', 'sound/items/poweruprespawn.wav', 'sound/items/respawn1.wav'), 1, 1);
END^

-- Touch_Item for the player (bots have bot_item_touch in bots.sql)
CREATE OR ALTER PROCEDURE item_touch (item INTEGER, other INTEGER)
AS
DECLARE cls VARCHAR(40); DECLARE kind CHAR(1); DECLARE qty INTEGER; DECLARE resp DOUBLE PRECISION; DECLARE bit_ INTEGER; DECLARE snd_ VARCHAR(64); DECLARE nm VARCHAR(40);
DECLARE hp INTEGER; DECLARE mhp INTEGER; DECLARE t DOUBLE PRECISION; DECLARE have INTEGER; DECLARE cnt INTEGER; DECLARE av INTEGER; DECLARE w INTEGER;
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :item AND e.solid = 1)) THEN EXIT;
  IF (other <> player_ent()) THEN
  BEGIN
    EXECUTE PROCEDURE bot_item_touch(item, other);
    EXIT;
  END
  SELECT d.cls, d.kind, IIF(e.count_ > 0, e.count_, d.qty), d.respawn, d.bit, d.snd, d.name FROM ents e JOIN item_defs d ON d.cls = e.item WHERE e.id = :item
    INTO cls, kind, qty, resp, bit_, snd_, nm;
  IF (cls IS NULL) THEN EXIT;
  SELECT e.health, e.max_health FROM ents e WHERE e.id = :other INTO hp, mhp;
  IF (hp <= 0) THEN EXIT;
  SELECT p.weapons, p.armor, p.weapon FROM player p WHERE p.id = 1 INTO have, av, w;
  t = now_();

  IF (kind = 'H') THEN
  BEGIN
    -- Pickup_Health: the small and the mega go up to twice the maximum
    IF (hp >= IIF(qty = 5 OR qty = 100, mhp * 2, mhp)) THEN EXIT;
    UPDATE ents e SET e.health = MINVALUE(e.health + :qty, IIF(:qty = 5 OR :qty = 100, e.max_health * 2, e.max_health)) WHERE e.id = :other;
  END
  ELSE IF (kind = 'A') THEN
  BEGIN
    IF (av >= mhp * 2) THEN EXIT;
    UPDATE player p SET p.armor = MINVALUE(p.armor + :qty, :mhp * 2) WHERE p.id = 1;
  END
  ELSE IF (kind = 'M') THEN
  BEGIN
    IF (ammo_count(bit_) >= 200) THEN EXIT;
    EXECUTE PROCEDURE add_ammo(bit_, qty);
  END
  ELSE IF (kind = 'W') THEN
  BEGIN
    -- Pickup_Weapon: the weapon and its ammo (at least the quantity when it is new)
    IF (BIN_AND(have, bit_) = 0) THEN
    BEGIN
      UPDATE player p SET p.weapons = BIN_OR(p.weapons, :bit_) WHERE p.id = 1;
      IF (ammo_count(weapon_ammo(bit_)) < qty) THEN EXECUTE PROCEDURE add_ammo(weapon_ammo(bit_), qty - ammo_count(weapon_ammo(bit_)));
      -- cg_autoswitch: a new weapon comes up
      IF (w <> bit_ AND bit_ > 2) THEN UPDATE player p SET p.pending_weapon = :bit_, p.weapon_time = :t + 0.2e0, p.weaponstate = 2 WHERE p.id = 1 AND p.pending_weapon = 0;
    END
    ELSE EXECUTE PROCEDURE add_ammo(weapon_ammo(bit_), IIF(bit_ = 2, 40, qty));
  END
  ELSE IF (kind = 'P') THEN
  BEGIN
    UPDATE player p SET p.quad_finished = IIF(:bit_ = 1, MAXVALUE(p.quad_finished, :t) + :qty, p.quad_finished),
           p.enviro_finished = IIF(:bit_ = 2, MAXVALUE(p.enviro_finished, :t) + :qty, p.enviro_finished),
           p.haste_finished = IIF(:bit_ = 4, MAXVALUE(p.haste_finished, :t) + :qty, p.haste_finished),
           p.invis_finished = IIF(:bit_ = 8, MAXVALUE(p.invis_finished, :t) + :qty, p.invis_finished),
           p.regen_finished = IIF(:bit_ = 16, MAXVALUE(p.regen_finished, :t) + :qty, p.regen_finished),
           p.flight_finished = IIF(:bit_ = 32, MAXVALUE(p.flight_finished, :t) + :qty, p.flight_finished) WHERE p.id = 1;
  END
  ELSE IF (kind = 'O') THEN
  BEGIN
    IF (EXISTS (SELECT 1 FROM player p WHERE p.id = 1 AND p.holdable <> 0)) THEN EXIT;
    UPDATE player p SET p.holdable = :bit_ WHERE p.id = 1;
  END
  ELSE EXIT;

  EXECUTE PROCEDURE sprint('Picked up ' || IIF(kind = 'W' OR kind = 'P' OR kind = 'O', 'the ', '') || nm);
  EXECUTE PROCEDURE snd(other, 3, snd_, 1, 1);
  UPDATE player p SET p.bonus_time = :t WHERE p.id = 1;
  EXECUTE PROCEDURE use_targets(item, other);
  EXECUTE PROCEDURE item_taken(item, IIF(kind = 'W', 5, resp));
END^

-- ── damage (g_combat.c) ──────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE throw_gib (eid INTEGER, model VARCHAR(64), dmg INTEGER)
AS
DECLARE g INTEGER; DECLARE spd DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
BEGIN
  SELECT e.x + crand() * 8, e.y + crand() * 8, e.z + (e.minz + e.maxz) / 2 + crand() * 16 FROM ents e WHERE e.id = :eid INTO x, y, z;
  EXECUTE PROCEDURE spawn_ent('gib', x, y, z) RETURNING_VALUES g;
  EXECUTE PROCEDURE set_model(g, model);
  spd = IIF(dmg < 50, 0.7e0, 1.2e0) * 300;
  UPDATE ents e SET e.movetype = 10, e.solid = 0, e.clipmask = 1, e.effects = 2, e.minx = -4, e.miny = -4, e.minz = -4, e.maxx = 4, e.maxy = 4, e.maxz = 4,
         e.vx = crand() * :spd, e.vy = crand() * :spd, e.vz = (RAND() + 0.5e0) * :spd,
         e.avel_yaw = RAND() * 600, e.avel_pitch = RAND() * 600, e.think = 'remove', e.nextthink = now_() + 5 + RAND() * 3 WHERE e.id = :g;
END^

-- GibEntity: the body bursts into the gib models
CREATE OR ALTER PROCEDURE gib_ent (eid INTEGER, dmg INTEGER)
AS
DECLARE m VARCHAR(64); DECLARE i INTEGER = 0;
BEGIN
  EXECUTE PROCEDURE snd(eid, 2, 'sound/player/gibsplt1.wav', 1, 1);
  EXECUTE PROCEDURE fx(13, (SELECT e.x FROM ents e WHERE e.id = :eid), (SELECT e.y FROM ents e WHERE e.id = :eid), (SELECT e.z FROM ents e WHERE e.id = :eid), 0, 0, 0, 0);
  WHILE (i < 11) DO
  BEGIN
    m = CASE i WHEN 0 THEN 'models/gibs/abdomen.md3' WHEN 1 THEN 'models/gibs/arm.md3' WHEN 2 THEN 'models/gibs/chest.md3' WHEN 3 THEN 'models/gibs/fist.md3'
         WHEN 4 THEN 'models/gibs/foot.md3' WHEN 5 THEN 'models/gibs/forearm.md3' WHEN 6 THEN 'models/gibs/intestine.md3' WHEN 7 THEN 'models/gibs/leg.md3'
         WHEN 8 THEN 'models/gibs/leg.md3' WHEN 9 THEN 'models/gibs/skull.md3' ELSE 'models/gibs/brain.md3' END;
    EXECUTE PROCEDURE throw_gib(eid, TRIM(m), dmg);
    i = i + 1;
  END
END^

-- the obituary (means of death: 1 gauntlet 2 machinegun 3 shotgun 4 grenade 5 grenade splash 6 rocket 7 rocket splash
-- 8 plasma 9 plasma splash 10 telefrag 11 trigger hurt / unknown 12 crushed 13 falling 14 lava 15 slime 16 lightning 17 railgun 18 bfg 19 bfg splash 20 suicide 21 water)
CREATE OR ALTER FUNCTION obituary (victim INTEGER, attacker INTEGER, mod_ SMALLINT) RETURNS VARCHAR(200)
AS
DECLARE v VARCHAR(32); DECLARE a VARCHAR(32); DECLARE s VARCHAR(120); DECLARE own VARCHAR(32);
BEGIN
  v = ent_name(victim); a = ent_name(attacker);
  IF (v = 'You') THEN v = 'You';
  IF (attacker IS NULL OR attacker <= 0 OR attacker = victim) THEN
  BEGIN
    s = CASE mod_ WHEN 14 THEN ' does a back flip into the lava' WHEN 15 THEN ' melted' WHEN 13 THEN ' cratered' WHEN 21 THEN ' sank like a rock'
          WHEN 12 THEN ' was squished' WHEN 5 THEN ' tripped on ' || IIF(:v = 'You', 'your', 'its') || ' own grenade' WHEN 7 THEN ' blew ' || IIF(:v = 'You', 'yourself', 'itself') || ' up'
          WHEN 9 THEN ' melted ' || IIF(:v = 'You', 'yourself', 'itself') WHEN 19 THEN ' should have used a smaller gun' WHEN 20 THEN ' killed ' || IIF(:v = 'You', 'yourself', 'itself')
          ELSE ' was in the wrong place' END;
    IF (v = 'You') THEN s = REPLACE(s, ' was ', ' were ');
    RETURN v || TRIM(s) || '.';
  END
  own = IIF(a = 'You', 'your', a || '''s');
  s = CASE mod_ WHEN 1 THEN ' was pummeled by ' || a WHEN 2 THEN ' was machinegunned by ' || a WHEN 3 THEN ' was gunned down by ' || a
        WHEN 4 THEN ' ate ' || own || ' grenade' WHEN 5 THEN ' was shredded by ' || own || ' shrapnel' WHEN 6 THEN ' ate ' || own || ' rocket'
        WHEN 7 THEN ' almost dodged ' || own || ' rocket' WHEN 8 THEN ' was melted by ' || own || ' plasmagun' WHEN 9 THEN ' was melted by ' || own || ' plasmagun'
        WHEN 10 THEN ' tried to invade ' || own || ' personal space' WHEN 16 THEN ' was electrocuted by ' || a WHEN 17 THEN ' was railed by ' || a
        WHEN 18 THEN ' was blasted by ' || own || ' BFG' WHEN 19 THEN ' was blasted by ' || own || ' BFG' ELSE ' was killed by ' || a END;
  IF (v = 'You') THEN s = REPLACE(s, ' was ', ' were ');
  RETURN v || ' ' || TRIM(s) || '.';
END^

-- Killed: the target's health fell to zero
CREATE OR ALTER PROCEDURE killed (targ INTEGER, inflictor INTEGER, attacker INTEGER, mod_ SMALLINT)
AS
DECLARE cls VARCHAR(40); DECLARE hp INTEGER;
BEGIN
  SELECT e.classname, e.health FROM ents e WHERE e.id = :targ INTO cls, hp;
  IF (hp < -999) THEN UPDATE ents e SET e.health = -999 WHERE e.id = :targ;
  IF (cls = 'player') THEN
  BEGIN
    EXECUTE PROCEDURE player_die(attacker, mod_);
    EXIT;
  END
  IF (cls = 'bot') THEN
  BEGIN
    EXECUTE PROCEDURE bot_die(targ, attacker, mod_);
    EXIT;
  END
  IF (cls = 'func_button') THEN
  BEGIN
    UPDATE ents e SET e.takedamage = 0 WHERE e.id = :targ;
    EXECUTE PROCEDURE button_fire(targ, attacker);
  END
  ELSE IF (cls IN ('trigger_multiple', 'trigger_once')) THEN
  BEGIN
    UPDATE ents e SET e.takedamage = 0 WHERE e.id = :targ;
    EXECUTE PROCEDURE trigger_fire(targ, attacker);
  END
END^

-- G_Damage. dflags: 1 radius 2 no armour 4 no knockback 8 no protection
CREATE OR ALTER PROCEDURE t_damage (targ INTEGER, inflictor INTEGER, attacker INTEGER, damage INTEGER, knockback INTEGER, dflags INTEGER, mod_ SMALLINT)
AS
DECLARE td SMALLINT; DECLARE cls VARCHAR(40); DECLARE flags INTEGER; DECLARE hp INTEGER; DECLARE mass INTEGER; DECLARE mt SMALLINT;
DECLARE save INTEGER; DECLARE take INTEGER; DECLARE av INTEGER; DECLARE inv DOUBLE PRECISION; DECLARE dead SMALLINT;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE dl DOUBLE PRECISION; DECLARE kv DOUBLE PRECISION;
DECLARE pe INTEGER; DECLARE qf DOUBLE PRECISION; DECLARE pf DOUBLE PRECISION; DECLARE acls VARCHAR(40);
DECLARE sx DOUBLE PRECISION; DECLARE sy DOUBLE PRECISION; DECLARE sz DOUBLE PRECISION; DECLARE sworld SMALLINT;
BEGIN
  SELECT e.takedamage, e.classname, e.flags, e.health, e.movetype, e.mass, e.deadflag FROM ents e WHERE e.id = :targ INTO td, cls, flags, hp, mt, mass, dead;
  IF (td IS NULL OR td = 0) THEN EXIT;
  IF (hp <= 0 AND cls NOT IN ('player', 'bot')) THEN EXIT;
  pe = player_ent();
  -- quad damage: ×3
  IF (attacker = pe) THEN
  BEGIN
    SELECT p.quad_finished FROM player p WHERE p.id = 1 INTO qf;
    IF (qf > now_()) THEN BEGIN damage = damage * 3; knockback = knockback * 3; END
  END
  ELSE IF (attacker > 0 AND EXISTS (SELECT 1 FROM ents e WHERE e.id = :attacker AND e.quad_finished > now_())) THEN
  BEGIN
    damage = damage * 3; knockback = knockback * 3;
  END

  -- knockback: kvel = knockback * g_knockback (1000) / mass
  IF (BIN_AND(dflags, 4) = 0 AND knockback > 0 AND mt IN (3, 4, 5, 6) AND inflictor IS NOT NULL AND inflictor > 0 AND BIN_AND(flags, 4096) = 0) THEN
  BEGIN
    SELECT e1.x - (e2.x + (e2.minx + e2.maxx) / 2), e1.y - (e2.y + (e2.miny + e2.maxy) / 2), e1.z + (e1.minz + e1.maxz) / 2 - (e2.z + (e2.minz + e2.maxz) / 2)
      FROM ents e1 CROSS JOIN ents e2 WHERE e1.id = :targ AND e2.id = :inflictor INTO dx, dy, dz;
    IF (inflictor = targ) THEN BEGIN dx = 0; dy = 0; dz = 1; END
    dl = vlen(dx, dy, dz);
    IF (dl > 0) THEN
    BEGIN
      kv = 1000e0 * knockback / MAXVALUE(50, mass);
      -- for a while the knock carries: no ground friction (G_Damage's pm_time, PMF_TIME_KNOCKBACK)
      IF (cls = 'player') THEN UPDATE player p SET p.knockback_until = MAXVALUE(p.knockback_until, now_() + MINVALUE(0.2e0, MAXVALUE(0.05e0, :knockback * 0.002e0))) WHERE p.id = 1;
      UPDATE ents e SET e.vx = e.vx + :dx / :dl * :kv, e.vy = e.vy + :dy / :dl * :kv, e.vz = e.vz + :dz / :dl * :kv,
             e.flags = IIF(:dz / :dl * :kv > 50, BIN_AND(e.flags, BIN_NOT(512)), e.flags) WHERE e.id = :targ;
    END
  END

  -- no friendly fire (g_friendlyFire 0): a teammate's shot knocks, it does not hurt
  IF (targ <> attacker AND BIN_AND(dflags, 8) = 0 AND on_same_team(targ, attacker) = 1) THEN EXIT;
  IF (cls = 'player' AND BIN_AND(flags, 16) <> 0 AND BIN_AND(dflags, 8) = 0) THEN EXIT;   -- god mode
  -- the battle suit halves damage and ignores splash
  IF (cls = 'player' AND BIN_AND(dflags, 8) = 0) THEN
  BEGIN
    SELECT p.enviro_finished FROM player p WHERE p.id = 1 INTO inv;
    IF (inv > now_()) THEN
    BEGIN
      IF (BIN_AND(dflags, 1) <> 0 OR mod_ IN (14, 15)) THEN EXIT;
      damage = damage / 2;
      EXECUTE PROCEDURE snd(targ, 3, 'sound/items/protect3.wav', 1, 1);
    END
  END
  -- "always give half damage if hurting self; calculated after knockback, so rocket jumping works"
  IF (targ = attacker) THEN damage = MAXVALUE(1, TRUNC(damage * 0.5e0));
  -- CheckArmor: armour takes 66 percent
  save = 0;
  IF (BIN_AND(dflags, 2) = 0) THEN
  BEGIN
    IF (cls = 'player') THEN SELECT p.armor FROM player p WHERE p.id = 1 INTO av;
    ELSE SELECT e.armor FROM ents e WHERE e.id = :targ INTO av;
    av = COALESCE(av, 0);
    IF (av > 0) THEN
    BEGIN
      save = CEILING(damage * 0.66e0);
      IF (save >= av) THEN save = av;
      IF (cls = 'player') THEN UPDATE player p SET p.armor = p.armor - :save WHERE p.id = 1;
      ELSE UPDATE ents e SET e.armor = e.armor - :save WHERE e.id = :targ;
    END
  END
  take = damage - save;
  IF (cls = 'player') THEN
  BEGIN
    -- where it came from (G_Damage's damage_from): the inflictor (a rocket where it blew up, the shooter of
    -- a bullet), else the attacker; the world's damage (falling, lava, slime, drowning, crushing, a hurt
    -- trigger) comes from no direction, and the view kicks straight up (damage_fromWorld)
    sworld = 1; sx = NULL;
    IF (mod_ NOT IN (11, 12, 13, 14, 15, 21)) THEN
    BEGIN
      SELECT e.x, e.y, e.z + (e.minz + e.maxz) / 2 FROM ents e WHERE e.id = :inflictor AND e.id <> :targ INTO sx, sy, sz;
      IF (sx IS NULL) THEN SELECT e.x, e.y, e.z + (e.minz + e.maxz) / 2 FROM ents e WHERE e.id = :attacker AND e.id <> :targ INTO sx, sy, sz;
      IF (sx IS NOT NULL) THEN sworld = 0;
    END
    UPDATE player p SET p.dmg_take = p.dmg_take + :take, p.dmg_save = p.dmg_save + :save, p.dmg_time = now_(),
           p.dmg_x = COALESCE(:sx, 0), p.dmg_y = COALESCE(:sy, 0), p.dmg_z = COALESCE(:sz, 0), p.dmg_world = :sworld WHERE p.id = 1;
  END
  IF (take <= 0) THEN EXIT;
  -- the shooter hears a hit
  IF (attacker = pe AND targ <> pe AND cls = 'bot' AND hp > 0) THEN EXECUTE PROCEDURE snd_local('sound/feedback/hit.wav');

  UPDATE ents e SET e.health = e.health - :take WHERE e.id = :targ RETURNING e.health INTO hp;
  IF (hp <= 0) THEN
  BEGIN
    IF (dead = 1) THEN
    BEGIN
      -- already dead: gib the corpse
      IF (hp < -40 AND cls IN ('player', 'bot', 'corpse')) THEN
      BEGIN
        EXECUTE PROCEDURE gib_ent(targ, take);
        IF (cls = 'corpse') THEN DELETE FROM ents e WHERE e.id = :targ;
        ELSE UPDATE ents e SET e.model_id = NULL, e.pmodel = NULL, e.takedamage = 0 WHERE e.id = :targ;
      END
      EXIT;
    END
    IF (cls IN ('player', 'bot')) THEN UPDATE ents e SET e.flags = BIN_OR(e.flags, 4096) WHERE e.id = :targ;   -- no more knockback
    EXECUTE PROCEDURE killed(targ, inflictor, attacker, mod_);
    EXIT;
  END
  -- a bot that hurts someone without killing them may say so (BotChat_HitNoKill)
  IF (attacker IS NOT NULL AND attacker <> targ AND cls IN ('player', 'bot') AND EXISTS (SELECT 1 FROM ents a WHERE a.id = :attacker AND a.classname = 'bot')) THEN
    EXECUTE PROCEDURE bot_chat_event(attacker, 'hit_nokill', targ, mod_);
  IF (cls = 'player') THEN
  BEGIN
    SELECT p.pain_finished FROM player p WHERE p.id = 1 INTO pf;
    IF (pf < now_()) THEN
    BEGIN
      EXECUTE PROCEDURE snd(targ, 2, 'sound/player/' || (SELECT e.pmodel FROM ents e WHERE e.id = :targ) || '/pain' || TRIM(CASE WHEN hp < 25 THEN '25' WHEN hp < 50 THEN '50' WHEN hp < 75 THEN '75' ELSE '100' END) || '_1.wav', 1, 1);
      UPDATE player p SET p.pain_finished = now_() + 0.7e0, p.punchangle = -2 WHERE p.id = 1;
    END
    EXIT;
  END
  IF (cls = 'bot') THEN EXECUTE PROCEDURE bot_pain(targ, attacker, take, mod_);
END^

-- G_RadiusDamage
CREATE OR ALTER PROCEDURE t_radius_damage (inflictor INTEGER, attacker INTEGER, damage DOUBLE PRECISION, ignore INTEGER, radius DOUBLE PRECISION, mod_ SMALLINT)
AS
DECLARE ix DOUBLE PRECISION; DECLARE iy DOUBLE PRECISION; DECLARE iz DOUBLE PRECISION;
DECLARE eid INTEGER; DECLARE d DOUBLE PRECISION; DECLARE pts DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
DECLARE cx DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION;
DECLARE bx DOUBLE PRECISION; DECLARE by_ DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :inflictor INTO ix, iy, iz;
  IF (ix IS NULL) THEN EXIT;
  FOR SELECT e.id, e.x + (e.minx + e.maxx) / 2, e.y + (e.miny + e.maxy) / 2, e.z + (e.minz + e.maxz) / 2,
             -- the nearest point of the box, as G_RadiusDamage measures
             MAXVALUE(e.x + e.minx, MINVALUE(:ix, e.x + e.maxx)), MAXVALUE(e.y + e.miny, MINVALUE(:iy, e.y + e.maxy)), MAXVALUE(e.z + e.minz, MINVALUE(:iz, e.z + e.maxz))
        FROM ents e
       WHERE e.takedamage > 0 AND (:ignore IS NULL OR e.id <> :ignore)
         AND ABS(e.x - :ix) < :radius + 40 AND ABS(e.y - :iy) < :radius + 40 AND ABS(e.z - :iz) < :radius + 60
        INTO eid, cx, cy, cz, bx, by_, bz
  DO
  BEGIN
    d = vlen(bx - ix, by_ - iy, bz - iz);
    IF (d >= radius) THEN CONTINUE;
    pts = damage * (1 - d / radius);
    IF (pts <= 0) THEN CONTINUE;
    -- CanDamage: a clear line to the centre
    EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, ix, iy, iz, cx, cy, cz, 1)
      RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
    IF (f = 1 OR als = 1 OR hit = eid) THEN EXECUTE PROCEDURE t_damage(eid, inflictor, attacker, CAST(pts AS INTEGER), CAST(pts AS INTEGER), 1, mod_);
  END
END^

-- ── projectiles (g_missile.c) ───────────────────────────────────────────
CREATE OR ALTER PROCEDURE launch_missile (owner INTEGER, cls VARCHAR(40), model VARCHAR(64), ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, spd DOUBLE PRECISION, dmg INTEGER, splash INTEGER, radius DOUBLE PRECISION, effect INTEGER, life DOUBLE PRECISION)
AS
DECLARE s INTEGER; DECLARE dl DOUBLE PRECISION;
BEGIN
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN EXIT;
  EXECUTE PROCEDURE spawn_ent(cls, ox, oy, oz) RETURNING_VALUES s;
  EXECUTE PROCEDURE set_model(s, model);
  UPDATE ents e SET e.owner_id = :owner, e.movetype = 9, e.solid = 2, e.clipmask = 100663297, e.effects = :effect,
         e.vx = :dx / :dl * :spd, e.vy = :dy / :dl * :spd, e.vz = :dz / :dl * :spd,
         e.yaw = vectoyaw(:dx, :dy), e.pitch = ATAN2(:dz, vlen(:dx, :dy, 0)) * 57.29577951e0, e.dmg = :dmg, e.count_ = :splash, e.dmg_radius = :radius,
         e.quad_finished = IIF(:owner = player_ent(), (SELECT p.quad_finished FROM player p WHERE p.id = 1), (SELECT o.quad_finished FROM ents o WHERE o.id = :owner)),
         e.think = 'missile_explode', e.nextthink = now_() + :life WHERE e.id = :s;
  EXECUTE PROCEDURE link_ent(s);
END^

CREATE OR ALTER PROCEDURE launch_grenade (owner INTEGER, ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION)
AS
DECLARE s INTEGER; DECLARE dl DOUBLE PRECISION;
BEGIN
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN EXIT;
  EXECUTE PROCEDURE spawn_ent('grenade', ox, oy, oz) RETURNING_VALUES s;
  EXECUTE PROCEDURE set_model(s, 'models/ammo/grenade1.md3');
  UPDATE ents e SET e.owner_id = :owner, e.movetype = 10, e.solid = 2, e.clipmask = 100663297, e.effects = 32,
         e.vx = :dx / :dl * 700, e.vy = :dy / :dl * 700, e.vz = :dz / :dl * 700 + 200,
         e.yaw = vectoyaw(:dx, :dy), e.avel_yaw = 300, e.avel_pitch = 300, e.dmg = 100, e.count_ = 100, e.dmg_radius = 150,
         e.think = 'missile_explode', e.nextthink = now_() + 2.5e0 WHERE e.id = :s;
  EXECUTE PROCEDURE link_ent(s);
END^

-- a missile goes off: splash damage, the effect and the sound of its kind
CREATE OR ALTER PROCEDURE missile_explode (eid INTEGER)
AS
DECLARE own INTEGER; DECLARE splash INTEGER; DECLARE rad DOUBLE PRECISION; DECLARE cls VARCHAR(40);
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
BEGIN
  SELECT e.owner_id, e.count_, e.dmg_radius, e.x, e.y, e.z, e.classname FROM ents e WHERE e.id = :eid INTO own, splash, rad, x, y, z, cls;
  IF (x IS NULL) THEN EXIT;
  IF (cls = 'rocket') THEN
  BEGIN
    EXECUTE PROCEDURE snd_at(x, y, z, 'sound/weapons/rocket/rocklx1a.wav', 1, 1);
    EXECUTE PROCEDURE fx(2, x, y, z, 0, 0, 0, 0);
    EXECUTE PROCEDURE t_radius_damage(eid, own, splash, NULL, rad, 7);
  END
  ELSE IF (cls = 'grenade') THEN
  BEGIN
    EXECUTE PROCEDURE snd_at(x, y, z, 'sound/weapons/rocket/rocklx1a.wav', 1, 1);
    EXECUTE PROCEDURE fx(9, x, y, z, 0, 0, 0, 0);
    EXECUTE PROCEDURE t_radius_damage(eid, own, splash, NULL, rad, 5);
  END
  ELSE IF (cls = 'plasma') THEN
  BEGIN
    EXECUTE PROCEDURE snd_at(x, y, z, 'sound/weapons/plasma/plasmx1a.wav', 1, 1);
    EXECUTE PROCEDURE fx(6, x, y, z, 0, 0, 0, 0);
    EXECUTE PROCEDURE t_radius_damage(eid, own, splash, NULL, rad, 9);
  END
  ELSE IF (cls = 'bfg') THEN
  BEGIN
    EXECUTE PROCEDURE snd_at(x, y, z, 'sound/weapons/rocket/rocklx1a.wav', 1, 1);
    EXECUTE PROCEDURE fx(8, x, y, z, 0, 0, 0, 0);
    EXECUTE PROCEDURE t_radius_damage(eid, own, splash, NULL, rad, 19);
  END
  DELETE FROM ents e WHERE e.id = :eid;
END^

-- PM_CrashLand, and what g_active.c and cg_event.c make of its events: the speed at the moment of contact,
-- solved from the tic's start (dist = vel t + acc t² / 2, as bg_pmove.c solves it from the frame's), squared
-- (delta = v² / 10000), doubled crouched, halved knee-deep, quartered waist-deep, nothing with the head under
-- or on a SURF_NODAMAGE floor; then above 60 EV_FALL_FAR (10 damage, the model's *fall1), above 40
-- EV_FALL_MEDIUM (5, its *pain100_1, not when dead), above 7 EV_FALL_SHORT (land1), else a footstep. The
-- damage holds the normal pain sound back (pain_debounce_time); the legs land
CREATE OR ALTER PROCEDURE crash_land (eid INTEGER, vel DOUBLE PRECISION, dist DOUBLE PRECISION, grav DOUBLE PRECISION, ducked SMALLINT, wl SMALLINT, sflags INTEGER)
AS
DECLARE a DOUBLE PRECISION; DECLARE den DOUBLE PRECISION; DECLARE tc DOUBLE PRECISION; DECLARE delta DOUBLE PRECISION;
DECLARE pm VARCHAR(16); DECLARE hp INTEGER; DECLARE pe INTEGER; DECLARE change DOUBLE PRECISION = 0;
BEGIN
  pe = player_ent();
  a = -grav / 2;
  den = vel * vel - 4 * a * (-dist);
  IF (den < 0 OR a = 0) THEN EXIT;
  tc = (-vel - SQRT(den)) / (2 * a);
  delta = vel - grav * tc;
  delta = delta * delta * 0.0001e0;
  IF (ducked = 1) THEN delta = delta * 2;
  IF (wl = 3) THEN EXIT;
  IF (wl = 2) THEN delta = delta * 0.25e0;
  IF (wl = 1) THEN delta = delta * 0.5e0;
  EXECUTE PROCEDURE set_anims(eid, 19, NULL);   -- LEGS_LAND
  IF (delta < 1 OR BIN_AND(COALESCE(sflags, 0), 1) <> 0) THEN EXIT;
  SELECT e.pmodel, e.health FROM ents e WHERE e.id = :eid INTO pm, hp;
  pm = COALESCE(pm, 'sarge');
  IF (delta > 60) THEN
  BEGIN
    change = -24;
    EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || pm || '/fall1.wav', 1, 1);
    IF (eid = pe) THEN UPDATE player p SET p.pain_finished = now_() + 0.2e0 WHERE p.id = 1;
    ELSE UPDATE ents e SET e.pain_finished = now_() + 0.2e0 WHERE e.id = :eid;
    EXECUTE PROCEDURE t_damage(eid, 0, 0, 10, 0, 4, 13);
  END
  ELSE IF (delta > 40) THEN
  BEGIN
    change = -16;
    IF (hp > 0) THEN
    BEGIN
      EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || pm || '/pain100_1.wav', 1, 1);
      IF (eid = pe) THEN UPDATE player p SET p.pain_finished = now_() + 0.2e0 WHERE p.id = 1;
      ELSE UPDATE ents e SET e.pain_finished = now_() + 0.2e0 WHERE e.id = :eid;
      EXECUTE PROCEDURE t_damage(eid, 0, 0, 5, 0, 4, 13);
    END
  END
  ELSE IF (delta > 7) THEN
  BEGIN
    change = -8;
    EXECUTE PROCEDURE snd(eid, 2, 'sound/player/land1.wav', 1, 1);
  END
  ELSE EXECUTE PROCEDURE snd(eid, 2, 'sound/player/footsteps/step' || CAST(1 + FLOOR(RAND() * 4) AS INTEGER) || '.wav', 0.6e0, 1);
  -- the view's dip (CG_EntityEvent: EV_FALL_FAR -24, EV_FALL_MEDIUM -16, EV_FALL_SHORT -8)
  IF (eid = pe AND change < 0) THEN UPDATE player p SET p.land_time = now_(), p.land_change = :change WHERE p.id = 1;
END^

-- ── touching ────────────────────────────────────────────────────────────
-- SV_Impact: e1 moved into e2 (e2 = 0 is the world); sflags are the surface flags hit
CREATE OR ALTER PROCEDURE impact (e1 INTEGER, e2 INTEGER, sflags INTEGER)
AS
DECLARE c1 VARCHAR(40); DECLARE c2 VARCHAR(40); DECLARE own INTEGER; DECLARE dmg INTEGER; DECLARE td2 SMALLINT;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION; DECLARE hp2 INTEGER;
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION; DECLARE m SMALLINT;
BEGIN
  SELECT e.classname, e.owner_id, e.dmg, e.x, e.y, e.z, e.vx, e.vy, e.vz FROM ents e WHERE e.id = :e1 INTO c1, own, dmg, x, y, z, vx, vy, vz;
  IF (c1 IS NULL) THEN EXIT;
  IF (e2 > 0) THEN SELECT e.classname, e.takedamage, e.health FROM ents e WHERE e.id = :e2 INTO c2, td2, hp2;
  ELSE BEGIN c2 = 'worldspawn'; td2 = 0; END
  IF (e2 = own) THEN EXIT;

  IF (c1 IN ('rocket', 'plasma', 'bfg')) THEN
  BEGIN
    IF (BIN_AND(sflags, 4) <> 0) THEN BEGIN DELETE FROM ents e WHERE e.id = :e1; EXIT; END   -- sky
    m = CASE c1 WHEN 'rocket' THEN 6 WHEN 'plasma' THEN 8 ELSE 18 END;
    IF (td2 > 0 AND hp2 > 0) THEN
    BEGIN
      EXECUTE PROCEDURE fx(3, x, y, z, 0, 0, 0, dmg);
      EXECUTE PROCEDURE t_damage(e2, e1, own, dmg, dmg, 0, m);
      -- the direct hit is not also splashed
      UPDATE ents e SET e.count_ = IIF(:c1 = 'plasma', 0, e.count_) WHERE e.id = :e1;
      IF (c1 = 'plasma') THEN
      BEGIN
        EXECUTE PROCEDURE snd_at(x, y, z, 'sound/weapons/plasma/plasmx1a.wav', 1, 1);
        DELETE FROM ents e WHERE e.id = :e1;
        EXIT;
      END
    END
    EXECUTE PROCEDURE missile_explode(e1);
  END
  ELSE IF (c1 = 'grenade') THEN
  BEGIN
    IF (BIN_AND(sflags, 4) <> 0) THEN BEGIN DELETE FROM ents e WHERE e.id = :e1; EXIT; END
    IF (td2 > 0 AND hp2 > 0 AND c2 IN ('player', 'bot')) THEN
    BEGIN
      EXECUTE PROCEDURE t_damage(e2, e1, own, dmg, dmg, 0, 4);
      EXECUTE PROCEDURE missile_explode(e1);
    END
    ELSE
    BEGIN
      spd = vlen(vx, vy, vz);
      IF (spd > 60) THEN EXECUTE PROCEDURE snd_at(x, y, z, 'sound/weapons/grenade/hgrenb1a.wav', 1, 1);
    END
  END
  ELSE IF (c1 = 'gib' AND e2 = 0 AND vlen(vx, vy, vz) > 100) THEN
    EXECUTE PROCEDURE snd_at(x, y, z, 'sound/player/gibimp' || CAST(1 + FLOOR(RAND() * 3) AS INTEGER) || '.wav', 0.6e0, 1);
END^

-- ── map setup ───────────────────────────────────────────────────────────
-- spawn an item of an item_defs class at a spot (FinishSpawningItem)
CREATE OR ALTER PROCEDURE spawn_item (cls VARCHAR(40), x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, suspended SMALLINT, cnt INTEGER, delay_ DOUBLE PRECISION)
RETURNS (id INTEGER)
AS
DECLARE mdl VARCHAR(64);
BEGIN
  SELECT d.model FROM item_defs d WHERE d.cls = :cls INTO mdl;
  IF (mdl IS NULL) THEN EXIT;
  EXECUTE PROCEDURE spawn_ent('item', x, y, z) RETURNING_VALUES id;
  EXECUTE PROCEDURE set_model(id, mdl);
  UPDATE ents e SET e.item = :cls, e.solid = 1, e.movetype = 0, e.clipmask = 1, e.effects = 1, e.count_ = COALESCE(:cnt, 0),
         e.minx = -15, e.miny = -15, e.minz = -15, e.maxx = 15, e.maxy = 15, e.maxz = 15, e.teleport_time = -10 WHERE e.id = :id;
  IF (suspended = 0) THEN EXECUTE PROCEDURE drop_to_floor(id); ELSE EXECUTE PROCEDURE link_ent(id);
  -- powerups appear a while after the match starts
  IF (delay_ > 0) THEN UPDATE ents e SET e.solid = 0, e.alpha = 1, e.think = 'item_respawn', e.nextthink = :delay_ WHERE e.id = :id;
  SUSPEND;
END^

-- SelectRandomDeathmatchSpawnPoint: one of the info_player_deathmatch spots not too near anyone
CREATE OR ALTER PROCEDURE select_spawn (avoid INTEGER)
RETURNS (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, yaw DOUBLE PRECISION)
AS
DECLARE n INTEGER; DECLARE k INTEGER; DECLARE tries INTEGER = 0; DECLARE ok SMALLINT;
BEGIN
  SELECT COUNT(*) FROM ents e WHERE e.classname = 'info_player_deathmatch' INTO n;
  IF (n = 0) THEN
  BEGIN
    SELECT FIRST 1 e.x, e.y, e.z, e.yaw FROM ents e WHERE e.classname IN ('info_player_start', 'info_player_intermission') INTO x, y, z, yaw;
    SUSPEND; EXIT;
  END
  WHILE (tries < 8) DO
  BEGIN
    k = FLOOR(RAND() * n);
    SELECT FIRST 1 SKIP (:k) e.x, e.y, e.z, e.yaw FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY e.id INTO x, y, z, yaw;
    ok = 1;
    IF (EXISTS (SELECT 1 FROM ents o WHERE o.classname IN ('player', 'bot') AND o.health > 0 AND (:avoid IS NULL OR o.id <> :avoid)
                  AND ABS(o.x - :x) < 128 AND ABS(o.y - :y) < 128 AND ABS(o.z - :z) < 128)) THEN ok = 0;
    IF (ok = 1) THEN LEAVE;
    tries = tries + 1;
  END
  SUSPEND;
END^

-- spawn_map_ents: the spawn functions for every classname we know
CREATE OR ALTER PROCEDURE spawn_map_ents
AS
DECLARE mid INTEGER; DECLARE cls VARCHAR(40); DECLARE tn VARCHAR(40); DECLARE tg VARCHAR(40); DECLARE mdl VARCHAR(64); DECLARE team VARCHAR(40);
DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE oz DOUBLE PRECISION; DECLARE ang DOUBLE PRECISION;
DECLARE ap DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE ar DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE msg VARCHAR(400); DECLARE wt DOUBLE PRECISION; DECLARE dl DOUBLE PRECISION; DECLARE rnd DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION;
DECLARE lip DOUBLE PRECISION; DECLARE hgt DOUBLE PRECISION; DECLARE hp INTEGER; DECLARE dmg INTEGER; DECLARE cnt INTEGER; DECLARE noise VARCHAR(64);
DECLARE phase DOUBLE PRECISION; DECLARE grav DOUBLE PRECISION; DECLARE music VARCHAR(64); DECLARE notfree INTEGER;
DECLARE eid INTEGER; DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION;
DECLARE sx DOUBLE PRECISION; DECLARE sy DOUBLE PRECISION; DECLARE sz DOUBLE PRECISION; DECLARE d DOUBLE PRECISION; DECLARE t2 DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE best SMALLINT; DECLARE trig INTEGER;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION; DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE kind CHAR(1); DECLARE n1 VARCHAR(64); DECLARE n3 VARCHAR(64); DECLARE skyname VARCHAR(64);
BEGIN
  FOR SELECT m.id, m.classname, m.targetname, m.target, m.team, m.model, m.ox, m.oy, m.oz, m.angle, m.apitch, m.ayaw, m.aroll,
             m.spawnflags, m.message, m.wait_, m.delay, m.random_, m.speed, m.lip, m.height, m.health, m.dmg, m.count_, m.noise, m.phase, m.gravity, m.music, m.notfree
        FROM map_ents m ORDER BY m.id
        INTO mid, cls, tn, tg, team, mdl, ox, oy, oz, ang, ap, ay, ar, sf, msg, wt, dl, rnd, spd, lip, hgt, hp, dmg, cnt, noise, phase, grav, music, notfree
  DO
  BEGIN
    IF (cls = 'worldspawn') THEN
    BEGIN
      UPDATE game g SET g.level_msg = :msg, g.music = :music, g.gravity = COALESCE(NULLIF(:grav, 0), 800) WHERE g.id = 1;
      CONTINUE;
    END
    IF (notfree = 1) THEN CONTINUE;                                     -- not in free for all
    -- "angles" overrides "angle"
    IF (ay IS NOT NULL AND ang IS NULL) THEN ang = ay;
    IF (cls IN ('light', 'misc_model', 'func_group', 'target_location', 'info_player_intermission', 'team_CTF_redplayer', 'team_CTF_blueplayer', 'team_CTF_redspawn', 'team_CTF_bluespawn', 'item_botroam', 'misc_portal_surface', 'misc_portal_camera')) THEN CONTINUE;

    EXECUTE PROCEDURE spawn_ent(cls, ox, oy, oz) RETURNING_VALUES eid;
    UPDATE ents e SET e.targetname = :tn, e.target = :tg, e.team = :team,
           e.spawnflags = :sf, e.message = :msg, e.wait_ = COALESCE(:wt, 0), e.delay = COALESCE(:dl, 0), e.random_ = COALESCE(:rnd, 0), e.speed = COALESCE(:spd, 0),
           e.lip = COALESCE(:lip, 0), e.height = COALESCE(:hgt, 0), e.health = COALESCE(:hp, 0), e.max_health = COALESCE(:hp, 0),
           e.dmg = COALESCE(:dmg, 0), e.count_ = COALESCE(:cnt, 0), e.phase = COALESCE(:phase, 0), e.yaw = COALESCE(:ang, 0), e.spawn_x = :ox, e.spawn_y = :oy, e.spawn_z = :oz, e.noise1 = :noise
     WHERE e.id = :eid;
    IF (mdl IS NOT NULL AND mdl STARTING WITH '*') THEN EXECUTE PROCEDURE set_model(eid, mdl);
    SELECT e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz FROM ents e WHERE e.id = :eid INTO mnx, mny, mnz, mxx, mxy, mxz;
    sx = mxx - mnx; sy = mxy - mny; sz = mxz - mnz;

    -- ── spawn points ──
    IF (cls IN ('info_player_deathmatch', 'info_player_start')) THEN
    BEGIN
      UPDATE ents e SET e.solid = 0 WHERE e.id = :eid;
    END
    -- ── doors ──
    ELSE IF (cls = 'func_door') THEN
    BEGIN
      n1 = 'sound/movers/doors/dr1_strt.wav'; n3 = 'sound/movers/doors/dr1_end.wav';
      IF (spd IS NULL OR spd = 0) THEN spd = 400;
      IF (wt IS NULL) THEN wt = 2;
      EXECUTE PROCEDURE movedir(COALESCE(ang, 0)) RETURNING_VALUES dx, dy, dz;
      IF (lip IS NULL OR lip = 0) THEN lip = 8;
      IF (dmg IS NULL OR dmg = 0) THEN dmg = 2;
      d = ABS(dx * sx + dy * sy + dz * sz) - lip;
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.wait_ = :wt, e.lip = :lip, e.dmg = :dmg,
             e.noise1 = :n1, e.noise3 = :n3, e.takedamage = IIF(:hp > 0, 1, 0),
             e.p1x = e.x, e.p1y = e.y, e.p1z = e.z, e.p2x = e.x + :dx * :d, e.p2y = e.y + :dy * :d, e.p2z = e.z + :dz * :d, e.mv_state = 1 WHERE e.id = :eid;
      IF (BIN_AND(sf, 1) <> 0) THEN     -- START_OPEN
        UPDATE ents e SET e.x = e.p2x, e.y = e.p2y, e.z = e.p2z, e.p2x = e.p1x, e.p2y = e.p1y, e.p2z = e.p1z,
               e.p1x = e.x, e.p1y = e.y, e.p1z = e.z WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
    END
    -- ── plats ──
    ELSE IF (cls = 'func_plat') THEN
    BEGIN
      IF (spd IS NULL OR spd = 0) THEN spd = 200;
      IF (wt IS NULL OR wt = 0) THEN wt = 1;
      IF (lip IS NULL OR lip = 0) THEN lip = 8;
      IF (hgt IS NULL OR hgt = 0) THEN hgt = sz - lip;
      IF (dmg IS NULL OR dmg = 0) THEN dmg = 2;
      -- pos2 (top) is where it was placed; pos1 (bottom) height below; it starts at the bottom
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.wait_ = :wt, e.noise1 = 'sound/movers/plats/pt1_strt.wav', e.noise3 = 'sound/movers/plats/pt1_end.wav', e.height = :hgt,
             e.p2x = e.x, e.p2y = e.y, e.p2z = e.z, e.p1x = e.x, e.p1y = e.y, e.p1z = e.z - :hgt, e.dmg = :dmg, e.z = e.z - :hgt, e.mv_state = 1 WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
      -- SpawnPlatTrigger: the body at the bottom plus 8 above the top, 33 in from the sides
      EXECUTE PROCEDURE spawn_ent('plat_trigger', ox, oy, oz - hgt) RETURNING_VALUES trig;
      UPDATE ents e SET e.solid = 1, e.owner_id = :eid, e.minx = :mnx + 33, e.miny = :mny + 33, e.minz = :mnz, e.maxx = :mxx - 33, e.maxy = :mxy - 33, e.maxz = :mxz + 8 WHERE e.id = :trig;
      UPDATE ents e SET e.minx = (:mnx + :mxx) / 2 - 1, e.maxx = (:mnx + :mxx) / 2 + 1 WHERE e.id = :trig AND e.maxx <= e.minx;
      UPDATE ents e SET e.miny = (:mny + :mxy) / 2 - 1, e.maxy = (:mny + :mxy) / 2 + 1 WHERE e.id = :trig AND e.maxy <= e.miny;
    END
    -- ── buttons ──
    ELSE IF (cls = 'func_button') THEN
    BEGIN
      EXECUTE PROCEDURE movedir(COALESCE(ang, 0)) RETURNING_VALUES dx, dy, dz;
      IF (spd IS NULL OR spd = 0) THEN spd = 40;
      IF (wt IS NULL OR wt = 0) THEN wt = 1;
      IF (lip IS NULL OR lip = 0) THEN lip = 4;
      d = ABS(dx * sx + dy * sy + dz * sz) - lip;
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.wait_ = :wt, e.noise1 = 'sound/movers/switches/butn2.wav', e.takedamage = IIF(:hp > 0, 1, 0),
             e.p1x = e.x, e.p1y = e.y, e.p1z = e.z, e.p2x = e.x + :dx * :d, e.p2y = e.y + :dy * :d, e.p2z = e.z + :dz * :d, e.mv_state = 1 WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
    END
    -- ── trains ──
    ELSE IF (cls = 'func_train') THEN
    BEGIN
      IF (spd IS NULL OR spd = 0) THEN spd = 100;
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.dmg = IIF(COALESCE(:dmg, 0) = 0, 2, :dmg),
             e.mv_state = 2, e.think = 'train_find', e.nextthink = 0.1e0 WHERE e.id = :eid;
    END
    ELSE IF (cls = 'path_corner') THEN UPDATE ents e SET e.solid = 0 WHERE e.id = :eid;
    -- ── bobbing, rotating, pendulums, statics ──
    ELSE IF (cls = 'func_bobbing') THEN
    BEGIN
      -- bobs `height` units along an axis (1 X, 2 Y, else Z) with period `speed` seconds, from `phase`
      IF (spd IS NULL OR spd = 0) THEN spd = 4;
      IF (hgt IS NULL OR hgt = 0) THEN hgt = 32;
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.height = :hgt, e.dmg = IIF(COALESCE(:dmg, 0) = 0, 2, :dmg),
             e.p1x = e.x, e.p1y = e.y, e.p1z = e.z, e.think = 'bob_think', e.nextthink = 0.05e0,
             e.p2x = IIF(BIN_AND(:sf, 1) <> 0, 1, 0), e.p2y = IIF(BIN_AND(:sf, 2) <> 0, 1, 0), e.p2z = IIF(BIN_AND(:sf, 3) = 0, 1, 0) WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
    END
    ELSE IF (cls = 'func_rotating') THEN
    BEGIN
      IF (spd IS NULL OR spd = 0) THEN spd = 100;
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.avel_yaw = :spd, e.dmg = IIF(COALESCE(:dmg, 0) = 0, 2, :dmg) WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
    END
    ELSE IF (cls = 'func_pendulum') THEN
    BEGIN
      -- swings `speed` degrees about its origin; the period follows from the pendulum's length
      IF (spd IS NULL OR spd = 0) THEN spd = 30;
      d = SQRT(ABS(mnz) / 400e0) * 2 * 3.14159265e0;   -- length / 400 (the simplified gravity Q3 uses)
      IF (d < 0.5e0) THEN d = 2;
      UPDATE ents e SET e.solid = 4, e.movetype = 7, e.yaw = 0, e.speed = :spd, e.height = :d, e.p1x = COALESCE(:ang, 0), e.dmg = IIF(COALESCE(:dmg, 0) = 0, 2, :dmg),
             e.think = 'pendulum_think', e.nextthink = 0.05e0 WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
    END
    ELSE IF (cls = 'func_static') THEN
    BEGIN
      UPDATE ents e SET e.solid = 4, e.movetype = 0, e.yaw = 0 WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
    END
    ELSE IF (cls = 'func_timer') THEN
    BEGIN
      IF (wt IS NULL OR wt = 0) THEN wt = 1;
      UPDATE ents e SET e.solid = 0, e.wait_ = :wt WHERE e.id = :eid;
      IF (BIN_AND(sf, 1) <> 0) THEN UPDATE ents e SET e.think = 'timer_think', e.nextthink = 1 + RAND() * :wt WHERE e.id = :eid;   -- START_ON
    END
    -- ── triggers ──
    ELSE IF (cls IN ('trigger_multiple', 'trigger_once', 'trigger_push', 'trigger_hurt', 'trigger_teleport')) THEN
    BEGIN
      UPDATE ents e SET e.model_id = NULL, e.solid = IIF(:mdl IS NULL, 0, 1), e.movetype = 0, e.yaw = 0 WHERE e.id = :eid;
      IF (cls IN ('trigger_multiple', 'trigger_once')) THEN
        UPDATE ents e SET e.wait_ = IIF(:cls = 'trigger_once', -1, IIF(COALESCE(:wt, 0) = 0, 0.5e0, :wt)), e.takedamage = IIF(:hp > 0, 1, 0), e.solid = IIF(:hp > 0, 2, e.solid) WHERE e.id = :eid;
      ELSE IF (cls = 'trigger_push') THEN
      BEGIN
        -- AimAtTarget: the velocity that lands the centre of the pad on its target_position
        SELECT FIRST 1 m.ox, m.oy, m.oz FROM map_ents m WHERE m.targetname = :tg INTO tx, ty, tz;
        IF (tx IS NULL) THEN BEGIN DELETE FROM ents e WHERE e.id = :eid; CONTINUE; END
        d = tz - (oz + (mnz + mxz) / 2);
        IF (d <= 0) THEN d = 1;
        t2 = SQRT(d / 400e0);                     -- time = sqrt(height / (gravity / 2))
        dx = tx - (ox + (mnx + mxx) / 2); dy = ty - (oy + (mny + mxy) / 2);
        UPDATE ents e SET e.p1x = :dx / :t2, e.p1y = :dy / :t2, e.p1z = :t2 * 800 WHERE e.id = :eid;
      END
      ELSE IF (cls = 'trigger_hurt') THEN
        UPDATE ents e SET e.dmg = IIF(COALESCE(:dmg, 0) = 0, 5, :dmg), e.solid = IIF(BIN_AND(:sf, 1) <> 0, 0, e.solid) WHERE e.id = :eid;   -- START_OFF
    END
    ELSE IF (cls IN ('trigger_relay', 'trigger_always', 'target_relay', 'target_delay', 'target_kill', 'target_print', 'target_teleporter', 'target_give', 'target_remove_powerups', 'target_position', 'info_notnull', 'misc_teleporter_dest', 'target_score')) THEN
    BEGIN
      UPDATE ents e SET e.solid = 0, e.model_id = NULL WHERE e.id = :eid;
      IF (cls = 'trigger_always') THEN UPDATE ents e SET e.think = 'always_fire', e.nextthink = 0.2e0 + MAXVALUE(e.delay, 0), e.delay = 0 WHERE e.id = :eid;
    END
    ELSE IF (cls = 'target_speaker') THEN
    BEGIN
      -- noise1 holds the sound; speed = volume, height = attenuation; count_ = 1 while a looped speaker plays
      UPDATE ents e SET e.solid = 0, e.model_id = NULL, e.speed = 1, e.height = IIF(BIN_AND(:sf, 8) <> 0, 0, 1),
             e.count_ = IIF(BIN_AND(:sf, 1) <> 0, 1, 0), e.noise1 = IIF(POSITION('.', :noise) = 0, :noise || '.wav', :noise) WHERE e.id = :eid;
      IF (BIN_AND(sf, 3) = 0 AND COALESCE(wt, 0) > 0) THEN UPDATE ents e SET e.think = 'speaker_think', e.nextthink = :wt + RAND() * :wt WHERE e.id = :eid;
    END
    -- ── items ──
    ELSE IF (cls LIKE 'item_%' OR cls LIKE 'weapon_%' OR cls LIKE 'ammo_%' OR cls LIKE 'holdable_%') THEN
    BEGIN
      DELETE FROM ents e WHERE e.id = :eid;
      SELECT d.kind FROM item_defs d WHERE d.cls = :cls INTO kind;
      IF (kind IS NULL) THEN CONTINUE;
      EXECUTE PROCEDURE spawn_item(cls, ox, oy, oz, IIF(BIN_AND(sf, 1) <> 0, 1, 0), cnt, IIF(kind = 'P', 30 + RAND() * 30, 0)) RETURNING_VALUES eid;
      IF (eid IS NOT NULL) THEN UPDATE ents e SET e.targetname = :tn, e.target = :tg WHERE e.id = :eid;
    END
    ELSE
      UPDATE ents e SET e.solid = 0 WHERE e.id = :eid;
    kind = NULL;
  END

  -- G_FindTeams: movers with the same team move together; the first spawned is the master
  FOR SELECT e.id FROM ents e WHERE e.team IS NOT NULL AND e.team <> '' AND e.movetype = 7 ORDER BY e.id INTO eid DO
  BEGIN
    SELECT MIN(o.id) FROM ents o WHERE o.team = (SELECT e.team FROM ents e WHERE e.id = :eid) AND o.movetype = 7 AND o.id < :eid INTO mid;
    IF (mid IS NOT NULL) THEN
    BEGIN
      UPDATE ents e SET e.linked_id = :mid, e.flags = BIN_OR(e.flags, 2048) WHERE e.id = :eid;
      UPDATE ents m SET m.targetname = COALESCE(m.targetname, (SELECT e.targetname FROM ents e WHERE e.id = :eid)) WHERE m.id = :mid;
    END
  END
  -- Think_SpawnNewDoorTrigger: an untargeted door (team) opens when something comes within 120 units along its thinnest axis
  FOR SELECT e.id, MIN(e.x + e.minx), MIN(e.y + e.miny), MIN(e.z + e.minz), MAX(e.x + e.maxx), MAX(e.y + e.maxy), MAX(e.z + e.maxz)
        FROM ents e WHERE e.classname = 'func_door' AND e.linked_id IS NULL AND (e.targetname IS NULL OR e.targetname = '') AND e.max_health = 0
       GROUP BY e.id INTO eid, mnx, mny, mnz, mxx, mxy, mxz DO
  BEGIN
    SELECT MIN(o.x + o.minx), MIN(o.y + o.miny), MIN(o.z + o.minz), MAX(o.x + o.maxx), MAX(o.y + o.maxy), MAX(o.z + o.maxz)
      FROM ents o WHERE COALESCE(o.linked_id, o.id) = :eid INTO mnx, mny, mnz, mxx, mxy, mxz;
    best = 0;
    IF (mxy - mny < mxx - mnx) THEN best = 1;
    IF (mxz - mnz < IIF(best = 1, mxy - mny, mxx - mnx)) THEN best = 2;
    EXECUTE PROCEDURE spawn_ent('door_trigger', 0, 0, 0) RETURNING_VALUES trig;
    UPDATE ents e SET e.solid = 1, e.owner_id = :eid,
           e.minx = :mnx - IIF(:best = 0, 120, 0), e.maxx = :mxx + IIF(:best = 0, 120, 0),
           e.miny = :mny - IIF(:best = 1, 120, 0), e.maxy = :mxy + IIF(:best = 1, 120, 0),
           e.minz = :mnz - IIF(:best = 2, 120, 0), e.maxz = :mxz + IIF(:best = 2, 120, 0) WHERE e.id = :trig;
  END
END^

CREATE OR ALTER PROCEDURE always_fire (eid INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE use_targets(eid, player_ent());
  DELETE FROM ents e WHERE e.id = :eid;
END^

SET TERM ; ^
