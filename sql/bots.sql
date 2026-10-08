-- bots.sql – the opponents (a small AI in the spirit of ai_main.c: see,
-- chase, strafe, shoot, pick things up, respawn), the scoring and the
-- announcer, the pushers (g_mover.c's G_RunMover), and the per-tic driver
-- (G_RunFrame) and level setup (G_InitGame / ClientBegin).

SET TERM ^ ;

CREATE OR ALTER PROCEDURE run_think (eid INTEGER, think VARCHAR(24)) AS BEGIN END^
CREATE OR ALTER PROCEDURE mover_blocked (eid INTEGER, other INTEGER) AS BEGIN END^

-- ── the bots' chat (ai_chat.c, be_ai_chat.c) ─────────────────────────────
-- what the bots call someone: a bot's name, or the player's
CREATE OR ALTER FUNCTION chat_name (eid INTEGER) RETURNS VARCHAR(32)
AS
DECLARE n VARCHAR(32);
BEGIN
  SELECT IIF(e.classname = 'player', (SELECT p.name FROM player p WHERE p.id = 1), e.bot) FROM ents e WHERE e.id = :eid INTO n;
  RETURN COALESCE(n, 'someone');
END^

-- BotRandomOpponentName: anyone in the arena but the bot itself
CREATE OR ALTER FUNCTION chat_opponent (eid INTEGER) RETURNS VARCHAR(32)
AS
DECLARE n INTEGER; DECLARE k INTEGER; DECLARE o INTEGER;
BEGIN
  SELECT COUNT(*) FROM ents e WHERE e.classname IN ('player', 'bot') AND e.id <> :eid AND BIN_AND(e.flags, 64) = 0 INTO n;
  IF (n = 0) THEN RETURN '[invalid var]';
  k = CAST(FLOOR(RAND() * n) AS INTEGER);
  SELECT FIRST 1 SKIP (:k) e.id FROM ents e WHERE e.classname IN ('player', 'bot') AND e.id <> :eid AND BIN_AND(e.flags, 64) = 0 ORDER BY e.id INTO o;
  RETURN chat_name(o);
END^

-- BotWeaponNameForMeansOfDeath
CREATE OR ALTER FUNCTION chat_weapon (mod_ SMALLINT) RETURNS VARCHAR(24)
AS
BEGIN
  RETURN TRIM(CASE mod_ WHEN 1 THEN 'Gauntlet' WHEN 2 THEN 'Machinegun' WHEN 3 THEN 'Shotgun' WHEN 4 THEN 'Grenade Launcher' WHEN 5 THEN 'Grenade Launcher'
    WHEN 6 THEN 'Rocket Launcher' WHEN 7 THEN 'Rocket Launcher' WHEN 8 THEN 'Plasmagun' WHEN 9 THEN 'Plasmagun' WHEN 16 THEN 'Lightning Gun'
    WHEN 17 THEN 'Railgun' WHEN 18 THEN 'BFG10K' WHEN 19 THEN 'BFG10K' ELSE '[unknown weapon]' END);
END^

-- a chat characteristic of the bot's character at its skill (CHARACTERISTIC_CHAT_*)
CREATE OR ALTER FUNCTION chat_char (eid INTEGER, k VARCHAR(24)) RETURNS DOUBLE PRECISION
AS
DECLARE v DOUBLE PRECISION;
BEGIN
  SELECT c.val FROM ents e JOIN bot_defs b ON b.name = e.bot JOIN bot_chatchar c ON c.bot = e.bot AND c.skill = b.skill AND c.ckey = :k
   WHERE e.id = :eid INTO v;
  RETURN COALESCE(v, 0);
END^

-- BotAI_BotInitialChat and BotExpandChatMessage: a random line of the type from the bot's chat file,
-- its random strings drawn from rnd.c until none is left (they nest), the variables put in, the
-- tildes (words kept from the synonyms) and the colour codes taken out; said to everyone, with the
-- talk sound. Returns nothing when the bot's file has no line of the type, as botlib does
CREATE OR ALTER PROCEDURE bot_say (eid INTEGER, ctype VARCHAR(32), v0 VARCHAR(40), v1 VARCHAR(40), v2 VARCHAR(40), v3 VARCHAR(40), v4 VARCHAR(64), v5 VARCHAR(40))
AS
DECLARE bname VARCHAR(16); DECLARE n INTEGER; DECLARE k INTEGER; DECLARE msg VARCHAR(2000); DECLARE pick VARCHAR(600);
DECLARE p INTEGER; DECLARE q INTEGER; DECLARE rname VARCHAR(40); DECLARE guard INTEGER = 0;
BEGIN
  SELECT e.bot FROM ents e WHERE e.id = :eid INTO bname;
  IF (bname IS NULL) THEN EXIT;
  SELECT COUNT(*) FROM bot_chat c WHERE c.bot = :bname AND c.ctype = :ctype INTO n;
  IF (n = 0) THEN EXIT;
  k = CAST(FLOOR(RAND() * n) AS INTEGER);
  SELECT FIRST 1 SKIP (:k) c.msg FROM bot_chat c WHERE c.bot = :bname AND c.ctype = :ctype ORDER BY c.idx INTO msg;
  p = POSITION('{r:', msg);
  WHILE (p > 0 AND guard < 24) DO
  BEGIN
    q = POSITION('}', msg, p);
    IF (q = 0) THEN LEAVE;
    rname = SUBSTRING(msg FROM p + 3 FOR q - p - 3);
    SELECT COUNT(*) FROM bot_rnd r WHERE r.name = :rname INTO n;
    pick = '';
    IF (n > 0) THEN
    BEGIN
      k = CAST(FLOOR(RAND() * n) AS INTEGER);
      SELECT FIRST 1 SKIP (:k) r.msg FROM bot_rnd r WHERE r.name = :rname ORDER BY r.idx INTO pick;
    END
    msg = SUBSTRING(msg FROM 1 FOR p - 1) || pick || SUBSTRING(msg FROM q + 1);
    guard = guard + 1;
    p = POSITION('{r:', msg);
  END
  msg = REPLACE(REPLACE(REPLACE(msg, '{0}', COALESCE(v0, '[invalid var]')), '{1}', COALESCE(v1, '[invalid var]')), '{2}', COALESCE(v2, '[invalid var]'));
  msg = REPLACE(REPLACE(REPLACE(msg, '{3}', COALESCE(v3, '[invalid var]')), '{4}', COALESCE(v4, '[invalid var]')), '{5}', COALESCE(v5, '[invalid var]'));
  msg = REPLACE(REPLACE(REPLACE(msg, '{6}', '[invalid var]'), '{7}', '[invalid var]'), '~', '');
  p = POSITION('^', msg);
  WHILE (p > 0) DO
  BEGIN
    msg = SUBSTRING(msg FROM 1 FOR p - 1) || SUBSTRING(msg FROM p + 2);
    p = POSITION('^', msg);
  END
  EXECUTE PROCEDURE say(SUBSTRING(bname || ': ' || TRIM(msg) FROM 1 FOR 200));
  EXECUTE PROCEDURE snd_local('sound/player/talk.wav');
  UPDATE ents e SET e.last_chat = now_() WHERE e.id = :eid;
END^

-- the BotChat_* functions of ai_chat.c: when a bot says what, with which variables, how likely by its
-- character, and no more than once every 25 seconds (TIME_BETWEENCHATTING) except at the start and
-- the end of a level. `other` is the one the event is about (the killer, the victim, the shooter)
CREATE OR ALTER PROCEDURE bot_chat_event (eid INTEGER, ev VARCHAR(16), other INTEGER, mod_ SMALLINT)
AS
DECLARE t DOUBLE PRECISION; DECLARE lc DOUBLE PRECISION; DECLARE ctype VARCHAR(32); DECLARE me VARCHAR(32); DECLARE mine INTEGER;
DECLARE v0 VARCHAR(40); DECLARE v1 VARCHAR(40); DECLARE v3 VARCHAR(40); DECLARE v4 VARCHAR(64); DECLARE v5 VARCHAR(40);
DECLARE pf INTEGER; DECLARE top INTEGER; DECLARE low INTEGER; DECLARE first_ VARCHAR(32); DECLARE last_ VARCHAR(32);
BEGIN
  t = now_();
  SELECT e.last_chat, e.frags FROM ents e WHERE e.id = :eid AND e.classname = 'bot' INTO lc, mine;
  IF (lc IS NULL) THEN EXIT;
  me = chat_name(eid);
  SELECT g.level_msg FROM game g WHERE g.id = 1 INTO v4;
  IF (ev = 'level_start') THEN
  BEGIN
    IF (RAND() > chat_char(eid, 'startendlevel')) THEN EXIT;
    ctype = 'level_start'; v0 = me;
  END
  ELSE IF (ev = 'game_enter') THEN
  BEGIN
    IF (RAND() > chat_char(eid, 'enterexitgame')) THEN EXIT;
    ctype = 'game_enter'; v0 = me; v1 = chat_opponent(eid);
  END
  ELSE IF (ev = 'level_end') THEN
  BEGIN
    IF (RAND() > chat_char(eid, 'startendlevel')) THEN EXIT;
    -- the rankings: the player and the bots by frags
    SELECT p.frags, p.name FROM player p WHERE p.id = 1 INTO pf, first_;
    SELECT MAX(e.frags), MIN(e.frags) FROM ents e WHERE e.classname = 'bot' INTO top, low;
    last_ = first_;
    IF (top > pf) THEN SELECT FIRST 1 e.bot FROM ents e WHERE e.classname = 'bot' ORDER BY e.frags DESC INTO first_;
    IF (low < pf) THEN SELECT FIRST 1 e.bot FROM ents e WHERE e.classname = 'bot' ORDER BY e.frags INTO last_;
    top = MAXVALUE(top, pf); low = MINVALUE(low, pf);
    IF (mine = top) THEN BEGIN ctype = 'level_end_victory'; v3 = last_; END
    ELSE IF (mine = low) THEN BEGIN ctype = 'level_end_lose'; v3 = first_; END
    ELSE BEGIN ctype = 'level_end'; v3 = first_; END
    v0 = me; v1 = chat_opponent(eid);
  END
  ELSE
  BEGIN
    IF (t - lc < 25) THEN EXIT;
    IF (ev = 'death') THEN
    BEGIN
      IF (RAND() > chat_char(eid, 'death')) THEN EXIT;
      ctype = TRIM(CASE WHEN mod_ = 21 THEN 'death_drown' WHEN mod_ = 15 THEN 'death_slime' WHEN mod_ = 14 THEN 'death_lava' WHEN mod_ = 13 THEN 'death_cratered'
                        WHEN other IS NULL OR other <= 0 OR other = eid OR mod_ IN (11, 12, 20) THEN 'death_suicide' WHEN mod_ = 10 THEN 'death_telefrag' ELSE '' END);
      IF (ctype <> '') THEN v0 = chat_opponent(eid);
      ELSE
      BEGIN
        v0 = chat_name(other); v1 = chat_weapon(mod_);
        IF (mod_ IN (1, 17, 18, 19) AND RAND() < 0.5e0) THEN ctype = TRIM(CASE WHEN mod_ = 1 THEN 'death_gauntlet' WHEN mod_ = 17 THEN 'death_rail' ELSE 'death_bfg' END);
        ELSE ctype = TRIM(IIF(RAND() < chat_char(eid, 'insult'), 'death_insult', 'death_praise'));
      END
    END
    ELSE IF (ev = 'kill') THEN
    BEGIN
      IF (RAND() > chat_char(eid, 'kill')) THEN EXIT;
      v0 = chat_name(other);
      ctype = TRIM(CASE WHEN mod_ = 1 THEN 'kill_gauntlet' WHEN mod_ = 17 THEN 'kill_rail' WHEN mod_ = 10 THEN 'kill_telefrag'
                        WHEN RAND() < chat_char(eid, 'insult') THEN 'kill_insult' ELSE 'kill_praise' END);
    END
    ELSE IF (ev = 'enemy_suicide') THEN
    BEGIN
      IF (RAND() > chat_char(eid, 'enemysuicide')) THEN EXIT;
      ctype = 'enemy_suicide'; v0 = chat_name(other);
    END
    ELSE IF (ev = 'hit_nodeath') THEN
    BEGIN
      IF (RAND() > chat_char(eid, 'hitnodeath')) THEN EXIT;
      ctype = 'hit_nodeath'; v0 = chat_name(other); v1 = chat_weapon(mod_);
    END
    ELSE IF (ev = 'hit_nokill') THEN
    BEGIN
      IF (RAND() > chat_char(eid, 'hitnokill') * 0.5e0) THEN EXIT;
      ctype = 'hit_nokill'; v0 = chat_name(other); v1 = chat_weapon(mod_);
    END
    ELSE IF (ev = 'random') THEN
    BEGIN
      IF (RAND() > chat_char(eid, 'random')) THEN EXIT;
      ctype = TRIM(IIF(RAND() < chat_char(eid, 'misc'), 'random_misc', 'random_insult'));
      v0 = chat_opponent(eid); v1 = me;
      v5 = chat_weapon(CAST(TRIM(CASE CAST(FLOOR(RAND() * 8) AS INTEGER) WHEN 0 THEN '1' WHEN 1 THEN '2' WHEN 2 THEN '3' WHEN 3 THEN '4' WHEN 4 THEN '6' WHEN 5 THEN '8' WHEN 6 THEN '16' ELSE '17' END) AS SMALLINT));
    END
    ELSE EXIT;
  END
  EXECUTE PROCEDURE bot_say(eid, ctype, v0, v1, NULL, v3, v4, v5);
END^


-- ── player model animation ───────────────────────────────────────────────
-- the legs and torso animations of a player or bot (animNumber_t), restarted when they change
CREATE OR ALTER PROCEDURE set_anims (eid INTEGER, legs INTEGER, torso INTEGER)
AS
DECLARE t DOUBLE PRECISION;
BEGIN
  t = now_();
  IF (legs IS NOT NULL) THEN UPDATE ents e SET e.legs_anim = :legs, e.legs_time = :t WHERE e.id = :eid AND e.legs_anim <> :legs;
  IF (torso IS NOT NULL) THEN UPDATE ents e SET e.torso_anim = :torso, e.torso_time = :t WHERE e.id = :eid AND (e.torso_anim <> :torso OR :torso IN (7, 8));
END^

-- ── movement helpers (g_ai.c, as Quake 2 had them) ──────────────────────
CREATE OR ALTER PROCEDURE change_yaw (eid INTEGER)
AS
DECLARE cur DOUBLE PRECISION; DECLARE ideal DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION; DECLARE mv DOUBLE PRECISION;
BEGIN
  SELECT anglemod(e.yaw), e.ideal_yaw, e.yaw_speed FROM ents e WHERE e.id = :eid INTO cur, ideal, spd;
  IF (cur = ideal) THEN EXIT;
  mv = ideal - cur;
  IF (ideal > cur) THEN BEGIN IF (mv >= 180) THEN mv = mv - 360; END
  ELSE BEGIN IF (mv <= -180) THEN mv = mv + 360; END
  IF (mv > 0) THEN BEGIN IF (mv > spd) THEN mv = spd; END
  ELSE BEGIN IF (mv < -spd) THEN mv = -spd; END
  UPDATE ents e SET e.yaw = anglemod(:cur + :mv) WHERE e.id = :eid;
END^

-- SV_StepDirection: turn to yaw and try to step dist that way
CREATE OR ALTER FUNCTION step_direction (eid INTEGER, yaw DOUBLE PRECISION, dist DOUBLE PRECISION) RETURNS SMALLINT
AS
BEGIN
  RETURN move_step(eid, COS(yaw * 0.0174532925e0) * dist, SIN(yaw * 0.0174532925e0) * dist, 0);
END^

-- SV_NewChaseDir: pick a direction toward the goal, trying the sides
CREATE OR ALTER PROCEDURE new_chase_dir (eid INTEGER, goal INTEGER, dist DOUBLE PRECISION)
AS
DECLARE olddir DOUBLE PRECISION; DECLARE turnaround DOUBLE PRECISION;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE d1 DOUBLE PRECISION; DECLARE d2 DOUBLE PRECISION; DECLARE tdir DOUBLE PRECISION;
DECLARE nodir DOUBLE PRECISION = -1;
BEGIN
  SELECT anglemod(FLOOR(e.ideal_yaw / 45) * 45) FROM ents e WHERE e.id = :eid INTO olddir;
  turnaround = anglemod(olddir - 180);
  SELECT g.x - e.x, g.y - e.y FROM ents e CROSS JOIN ents g WHERE e.id = :eid AND g.id = :goal INTO dx, dy;
  IF (dx IS NULL) THEN EXIT;
  d1 = IIF(dx > 10, 0, IIF(dx < -10, 180, nodir));
  d2 = IIF(dy < -10, 270, IIF(dy > 10, 90, nodir));
  IF (d1 <> nodir AND d2 <> nodir) THEN
  BEGIN
    tdir = IIF(d1 = 0, IIF(d2 = 90, 45, 315), IIF(d2 = 90, 135, 215));
    IF (tdir <> turnaround AND step_direction(eid, tdir, dist) = 1) THEN BEGIN UPDATE ents e SET e.ideal_yaw = :tdir WHERE e.id = :eid; EXIT; END
  END
  IF (RAND() < 0.5e0 OR ABS(dy) > ABS(dx)) THEN BEGIN tdir = d1; d1 = d2; d2 = tdir; END
  IF (d1 <> nodir AND d1 <> turnaround AND step_direction(eid, d1, dist) = 1) THEN BEGIN UPDATE ents e SET e.ideal_yaw = :d1 WHERE e.id = :eid; EXIT; END
  IF (d2 <> nodir AND d2 <> turnaround AND step_direction(eid, d2, dist) = 1) THEN BEGIN UPDATE ents e SET e.ideal_yaw = :d2 WHERE e.id = :eid; EXIT; END
  IF (olddir <> nodir AND step_direction(eid, olddir, dist) = 1) THEN BEGIN UPDATE ents e SET e.ideal_yaw = :olddir WHERE e.id = :eid; EXIT; END
  tdir = IIF(RAND() < 0.5e0, 0, 315);
  d1 = 0;
  WHILE (d1 < 8) DO
  BEGIN
    d2 = anglemod(tdir + IIF(tdir = 0, 45, -45) * d1);
    IF (step_direction(eid, d2, dist) = 1) THEN BEGIN UPDATE ents e SET e.ideal_yaw = :d2 WHERE e.id = :eid; EXIT; END
    d1 = d1 + 1;
  END
  IF (turnaround <> nodir AND step_direction(eid, turnaround, dist) = 1) THEN BEGIN UPDATE ents e SET e.ideal_yaw = :turnaround WHERE e.id = :eid; EXIT; END
END^

-- M_MoveToGoal: a step toward the goal entity
CREATE OR ALTER PROCEDURE move_to_goal (eid INTEGER, goal INTEGER, dist DOUBLE PRECISION)
AS
DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION;
BEGIN
  SELECT g.x, g.y FROM ents g WHERE g.id = :goal INTO gx, gy;
  IF (gx IS NULL) THEN EXIT;
  SELECT vectoyaw(:gx - e.x, :gy - e.y) FROM ents e WHERE e.id = :eid INTO yaw;
  IF (FLOOR(RAND() * 4) = 1 OR step_direction(eid, yaw, dist) = 0) THEN
    EXECUTE PROCEDURE new_chase_dir(eid, goal, dist);
END^

-- BotMoveToGoal over the waypoint graph (waypoints.sql): a step along the route to the target entity.
-- Returns 1 when it stepped, 0 when the step was blocked, -1 when there is no route at all
-- BotCanAndWantsToRocketJump: a rocket launcher, 60 health at least and 90 unless it has 40 armour, no quad,
-- and a character that likes weapon jumping (0.5 or more). The bots' ammunition is not counted here
CREATE OR ALTER FUNCTION bot_can_rj (eid INTEGER) RETURNS SMALLINT
AS
DECLARE w INTEGER; DECLARE hp INTEGER; DECLARE av INTEGER; DECLARE qf DOUBLE PRECISION;
BEGIN
  SELECT e.weapons, e.health, e.armor, e.quad_finished FROM ents e WHERE e.id = :eid INTO w, hp, av, qf;
  IF (w IS NULL OR BIN_AND(w, 16) = 0 OR hp < 60 OR (hp < 90 AND COALESCE(av, 0) < 40) OR qf > now_()) THEN RETURN 0;
  IF (EXISTS (SELECT 1 FROM ents e JOIN bot_defs b ON b.name = e.bot JOIN bot_chatchar c ON c.bot = e.bot AND c.skill = b.skill AND c.ckey = 'weaponjumping'
               WHERE e.id = :eid AND c.val < 0.5e0)) THEN RETURN 0;
  RETURN 1;
END^

-- BotTravel_RocketJump at the start: face the landing, the rocket launcher up, look straight down, jump and
-- fire; BotFinishTravel_WeaponJump steers the flight (bot_air_steer, from run_physics) to (tx, ty, tz)
CREATE OR ALTER PROCEDURE bot_rocket_jump (eid INTEGER, tx DOUBLE PRECISION, ty DOUBLE PRECISION, tz DOUBLE PRECISION)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE pm VARCHAR(16);
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE fx DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.pmodel FROM ents e WHERE e.id = :eid INTO x, y, pm;
  yaw = vectoyaw(tx - x, ty - y);
  UPDATE ents e SET e.weapon = 16, e.yaw = :yaw, e.ideal_yaw = :yaw, e.pitch = 90, e.vx = 0, e.vy = 0, e.vz = 270,
         e.flags = BIN_AND(e.flags, BIN_NOT(512)), e.attack_finished = now_() + 0.8e0 WHERE e.id = :eid;
  EXECUTE PROCEDURE eye_of(eid) RETURNING_VALUES ex, ey, ez, fx, fy, fz;
  EXECUTE PROCEDURE fire_weapon(eid, 16, ex, ey, ez - 14, 0, 0, -1, 1);
  EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || COALESCE(pm, 'sarge') || '/jump1.wav', 1, 1);
  EXECUTE PROCEDURE set_anims(eid, 18, 7);
  UPDATE bot_routes r SET r.rj_x = :tx, r.rj_y = :ty, r.rj_z = :tz, r.rj_until = now_() + 3 WHERE r.ent_id = :eid;
END^

-- the air control of a bot in a rocket jump's flight: the horizontal velocity that would bring it over the
-- landing as it comes down to it, approached at Quake III's air acceleration (1, at 320: 16 a tic)
CREATE OR ALTER PROCEDURE bot_air_steer (eid INTEGER, tx DOUBLE PRECISION, ty DOUBLE PRECISION, tz DOUBLE PRECISION, dt DOUBLE PRECISION)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION; DECLARE grav DOUBLE PRECISION;
DECLARE tl DOUBLE PRECISION; DECLARE wx DOUBLE PRECISION; DECLARE wy DOUBLE PRECISION; DECLARE l DOUBLE PRECISION; DECLARE d DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.z, e.vx, e.vy, e.vz FROM ents e WHERE e.id = :eid INTO x, y, z, vx, vy, vz;
  SELECT g.gravity FROM game g WHERE g.id = 1 INTO grav;
  -- the time left until it comes down to the landing's height: z + vz t - g t² / 2 = tz
  d = vz * vz + 2 * grav * (z - tz);
  tl = MAXVALUE(dt, IIF(d > 0, (vz + SQRT(d)) / grav, dt));
  wx = (tx - x) / tl; wy = (ty - y) / tl;
  l = vlen(wx, wy, 0);
  IF (l > 320) THEN BEGIN wx = wx * 320 / l; wy = wy * 320 / l; END
  wx = wx - vx; wy = wy - vy;
  l = vlen(wx, wy, 0);
  IF (l > 320 * dt) THEN BEGIN wx = wx * 320 * dt / l; wy = wy * 320 * dt / l; END
  UPDATE ents e SET e.vx = e.vx + :wx, e.vy = e.vy + :wy WHERE e.id = :eid;
END^

CREATE OR ALTER PROCEDURE bot_follow_route (eid INTEGER, target INTEGER, dist DOUBLE PRECISION)
RETURNS (moved SMALLINT)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION; DECLARE nk SMALLINT;
DECLARE path VARCHAR(400); DECLARE s VARCHAR(400); DECLARE cut VARCHAR(400); DECLARE built DOUBLE PRECISION; DECLARE rtarget INTEGER;
DECLARE dst INTEGER; DECLARE src INTEGER; DECLARE odst INTEGER; DECLARE nid INTEGER; DECLARE t DOUBLE PRECISION; DECLARE p INTEGER; DECLARE i INTEGER;
DECLARE fails SMALLINT; DECLARE yaw DOUBLE PRECISION; DECLARE reach DOUBLE PRECISION; DECLARE prog_d DOUBLE PRECISION; DECLARE prog_t DOUBLE PRECISION; DECLARE stuck SMALLINT = 0;
DECLARE last_n INTEGER; DECLARE cutn INTEGER; DECLARE rpath VARCHAR(400); DECLARE lx DOUBLE PRECISION; DECLARE ly DOUBLE PRECISION; DECLARE lz DOUBLE PRECISION;
BEGIN
  moved = 0;
  t = now_();
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO x, y, z;
  SELECT g.x, g.y, g.z FROM ents g WHERE g.id = :target INTO tx, ty, tz;
  IF (tx IS NULL OR x IS NULL) THEN EXIT;
  SELECT r.target, r.dst_node, r.path, r.built, r.fails, r.prog_d, r.prog_t, r.last_node FROM bot_routes r WHERE r.ent_id = :eid INTO rtarget, odst, path, built, fails, prog_d, prog_t, last_n;
  fails = COALESCE(fails, 0);
  -- no progress toward the next node for a while (a corpse, a mover, a corner the steps slide along): stuck
  IF (prog_t IS NOT NULL AND t - prog_t > 1.5e0) THEN BEGIN stuck = 1; fails = 3; END
  dst = wp_nearest(tx, ty, tz, 0);
  IF (dst IS NULL) THEN BEGIN moved = -1; EXIT; END
  -- a new route when the target is another one or stands at another node, when the old one ran out or
  -- was blocked, and every few seconds anyway
  IF (rtarget IS DISTINCT FROM target OR built IS NULL OR path IS NULL OR fails >= 3
      OR (dst <> odst AND t - built > 0.7e0) OR t - built > 4) THEN
  BEGIN
    src = wp_nearest(x, y, z, 1);
    path = wp_route(src, dst, 0);
    -- over the rocket jumps too, when it can and wants to; the AAS rates a rocket jump at five seconds of
    -- travel, so it is worth a dozen nodes of walk, or a ledge there is no walk to
    IF (bot_can_rj(eid) = 1 AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.kind = 4)) THEN
    BEGIN
      rpath = wp_route(src, dst, 1);
      IF (rpath IS NOT NULL AND (path IS NULL OR CHAR_LENGTH(path) - CHAR_LENGTH(REPLACE(path, ',', '')) > CHAR_LENGTH(rpath) - CHAR_LENGTH(REPLACE(rpath, ',', '')) + 12)) THEN
        path = rpath;
    END
    built = t; fails = 0; prog_d = NULL; prog_t = t; last_n = src;
    IF (path IS NULL) THEN
    BEGIN
      UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t) VALUES (:eid, :target, :dst, NULL, :t, 0, NULL, NULL) MATCHING (ent_id);
      moved = -1;
      EXIT;
    END
  END
  -- drop the nodes reached, looking up to four ahead: a jump pad lands the bot past the pad's node
  s = path; i = 0; cut = NULL;
  WHILE (i < 4) DO
  BEGIN
    p = POSITION(',', s, 2);
    IF (p = 0) THEN LEAVE;
    nid = CAST(SUBSTRING(s FROM 2 FOR p - 2) AS INTEGER);
    SELECT w.x, w.y, w.z, w.kind FROM waypoints w WHERE w.id = :nid INTO nx, ny, nz, nk;
    IF (nx IS NULL) THEN LEAVE;
    reach = IIF(nk = 4, 200, 40);
    IF (vlen(nx - x, ny - y, 0) < reach AND ABS(nz - z) < IIF(nk = 4, 90, 48)) THEN BEGIN cut = SUBSTRING(s FROM p); cutn = nid; END
    s = SUBSTRING(s FROM p);
    i = i + 1;
  END
  IF (cut IS NOT NULL) THEN BEGIN path = cut; prog_d = NULL; prog_t = t; last_n = cutn; END
  p = POSITION(',', path, 2);
  IF (p = 0) THEN
  BEGIN
    -- at the target's node: straight at it
    EXECUTE PROCEDURE move_to_goal(eid, target, dist);
    moved = 1;
  END
  ELSE
  BEGIN
    nid = CAST(SUBSTRING(path FROM 2 FOR p - 2) AS INTEGER);
    SELECT w.x, w.y, w.z FROM waypoints w WHERE w.id = :nid INTO nx, ny, nz;
    IF (last_n IS NOT NULL AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :last_n AND e.b = :nid AND e.kind = 4)) THEN
    BEGIN
      -- a rocket jump (BotTravel_RocketJump): onto its start, slowing as it nears it, then up
      SELECT w.x, w.y, w.z FROM waypoints w WHERE w.id = :last_n INTO lx, ly, lz;
      IF (bot_can_rj(eid) = 0) THEN BEGIN fails = 3; moved = 0; END
      ELSE IF (vlen(lx - x, ly - y, 0) > 12) THEN
      BEGIN
        yaw = vectoyaw(lx - x, ly - y);
        UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
        moved = step_direction(eid, yaw, MINVALUE(dist, vlen(lx - x, ly - y, 0)));
        IF (moved = 0) THEN fails = fails + 1; ELSE fails = 0;
      END
      ELSE
      BEGIN
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t + 2, :last_n) MATCHING (ent_id);
        EXECUTE PROCEDURE bot_rocket_jump(eid, nx, ny, nz);
        moved = 1;
        EXIT;
      END
      UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, :fails, NULL, :t, :last_n) MATCHING (ent_id);
      EXIT;
    END
    yaw = vectoyaw(nx - x, ny - y);
    UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
    -- progress: nearer to the node than ever, or not
    IF (prog_d IS NULL OR vlen(nx - x, ny - y, 0) < prog_d - 8) THEN BEGIN prog_d = vlen(nx - x, ny - y, 0); prog_t = t; END
    IF (stuck = 1) THEN
    BEGIN
      -- sidestep out of whatever holds it, then the route is rebuilt next think
      moved = step_direction(eid, anglemod(yaw + IIF(RAND() < 0.5e0, 90, -90)), dist);
      IF (moved = 0) THEN moved = step_direction(eid, anglemod(yaw + 180), dist);
      prog_d = NULL; prog_t = t;
    END
    ELSE moved = step_direction(eid, yaw, dist);
    IF (moved = 0 AND nz < z - 40 AND vlen(nx - x, ny - y, 0) < 320) THEN
    BEGIN
      -- the next node is down a ledge and the step "walked off an edge": jump down, as the AAS's
      -- jump-down reachability does; gravity and fly_move take it from here (run_physics)
      UPDATE ents e SET e.vx = COS(:yaw * 0.0174532925e0) * 320, e.vy = SIN(:yaw * 0.0174532925e0) * 320, e.vz = 40,
             e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
      moved = 1;
    END
    IF (moved = 0) THEN moved = step_direction(eid, anglemod(yaw + 35), dist);
    IF (moved = 0) THEN moved = step_direction(eid, anglemod(yaw - 35), dist);
    IF (moved = 0) THEN fails = fails + 1; ELSE fails = 0;
  END
  UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, :fails, :prog_d, :prog_t, :last_n) MATCHING (ent_id);
END^

-- ── the bot's senses ─────────────────────────────────────────────────────
-- the bot characteristics of the skill levels (the bots' *_c.c files, boiled down): the seconds before a
-- newly seen enemy is shot at, the aim's scatter as a fraction of the distance, how far and how wide it
-- notices things, how fast it turns (degrees per think), how often it sidesteps, hesitates and pauses
CREATE OR ALTER FUNCTION bot_char (skill SMALLINT, k VARCHAR(12)) RETURNS DOUBLE PRECISION
AS
DECLARE s SMALLINT;
BEGIN
  s = MAXVALUE(1, MINVALUE(5, COALESCE(skill, 2)));
  IF (k = 'reaction') THEN RETURN CASE s WHEN 1 THEN 2.0e0 WHEN 2 THEN 1.5e0 WHEN 3 THEN 0.8e0 WHEN 4 THEN 0.4e0 ELSE 0.15e0 END;
  IF (k = 'aim') THEN RETURN CASE s WHEN 1 THEN 0.14e0 WHEN 2 THEN 0.115e0 WHEN 3 THEN 0.065e0 WHEN 4 THEN 0.035e0 ELSE 0.012e0 END;
  IF (k = 'alert') THEN RETURN 900 + s * 800;
  IF (k = 'fov') THEN RETURN CASE s WHEN 1 THEN 0.5e0 WHEN 2 THEN 0.26e0 WHEN 3 THEN 0 WHEN 4 THEN -0.5e0 ELSE -1 END;   -- the cosine of the half field of view
  IF (k = 'turn') THEN RETURN 6 + s * 6;
  IF (k = 'strafe') THEN RETURN CASE s WHEN 1 THEN 0.35e0 WHEN 2 THEN 0.5e0 WHEN 3 THEN 0.7e0 WHEN 4 THEN 0.85e0 ELSE 1 END;
  IF (k = 'hesitate') THEN RETURN CASE s WHEN 1 THEN 0.35e0 WHEN 2 THEN 0.2e0 WHEN 3 THEN 0.1e0 WHEN 4 THEN 0.03e0 ELSE 0 END;
  IF (k = 'speed') THEN RETURN CASE s WHEN 1 THEN 26 WHEN 2 THEN 29 ELSE 32 END;       -- units per think: 260 to 320 a second (the player runs 320)
  IF (k = 'pause') THEN RETURN CASE s WHEN 1 THEN 0.25e0 WHEN 2 THEN 0.2e0 WHEN 3 THEN 0.08e0 WHEN 4 THEN 0.03e0 ELSE 0 END;
  IF (k = 'search') THEN RETURN 3 + s * 0.8e0;        -- seconds it hunts an enemy it lost sight of
  RETURN 0;
END^


-- the nearest player or bot the bot notices (BotFindEnemy): within its alertness range, inside its field
-- of view unless very close, and in sight
CREATE OR ALTER FUNCTION bot_find_target (eid INTEGER) RETURNS INTEGER
AS
DECLARE c INTEGER; DECLARE d DOUBLE PRECISION; DECLARE best INTEGER; DECLARE bestd DOUBLE PRECISION = 1e9; DECLARE inv DOUBLE PRECISION;
DECLARE skill SMALLINT; DECLARE alert DOUBLE PRECISION; DECLARE fov DOUBLE PRECISION; DECLARE cosang DOUBLE PRECISION;
BEGIN
  SELECT p.invis_finished FROM player p WHERE p.id = 1 INTO inv;
  SELECT COALESCE(b.skill, 2) FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO skill;
  alert = bot_char(skill, 'alert'); fov = bot_char(skill, 'fov');
  FOR SELECT o.id, vlen(o.x - e.x, o.y - e.y, o.z - e.z),
             (COS(e.yaw * 0.0174532925e0) * (o.x - e.x) + SIN(e.yaw * 0.0174532925e0) * (o.y - e.y)) / MAXVALUE(1e-3, vlen(o.x - e.x, o.y - e.y, 0))
        FROM ents o CROSS JOIN ents e
       WHERE e.id = :eid AND o.id <> :eid AND o.classname IN ('player', 'bot') AND o.health > 0 AND o.deadflag = 0 AND BIN_AND(o.flags, 64) = 0
         AND NOT (e.pteam > 0 AND o.pteam = e.pteam)
         AND NOT (o.classname = 'player' AND :inv > now_())
         AND ABS(o.x - e.x) < :alert AND ABS(o.y - e.y) < :alert AND ABS(o.z - e.z) < :alert
       ORDER BY 2 INTO c, d, cosang
  DO
  BEGIN
    IF (d >= bestd OR d > alert) THEN LEAVE;
    IF (d > 250 AND cosang < fov) THEN CONTINUE;      -- behind it
    IF (visible(eid, c) = 1) THEN BEGIN best = c; bestd = d; END
  END
  RETURN best;
END^

-- the weapon a bot likes best for the distance among those it holds
CREATE OR ALTER FUNCTION bot_best_weapon (eid INTEGER, dist DOUBLE PRECISION) RETURNS INTEGER
AS
DECLARE w INTEGER;
BEGIN
  SELECT e.weapons FROM ents e WHERE e.id = :eid INTO w;
  IF (BIN_AND(w, 64) <> 0 AND dist > 500) THEN RETURN 64;
  IF (BIN_AND(w, 16) <> 0 AND dist > 180) THEN RETURN 16;
  IF (BIN_AND(w, 32) <> 0 AND dist < 700) THEN RETURN 32;
  IF (BIN_AND(w, 128) <> 0) THEN RETURN 128;
  IF (BIN_AND(w, 4) <> 0 AND dist < 600) THEN RETURN 4;
  IF (BIN_AND(w, 64) <> 0) THEN RETURN 64;
  IF (BIN_AND(w, 16) <> 0) THEN RETURN 16;
  IF (BIN_AND(w, 8) <> 0 AND dist > 150) THEN RETURN 8;
  IF (BIN_AND(w, 4) <> 0) THEN RETURN 4;
  IF (BIN_AND(w, 2) <> 0) THEN RETURN 2;
  RETURN 1;
END^

-- aim at the enemy (leading projectiles when skilled enough), scattered by the aim accuracy, and fire
CREATE OR ALTER PROCEDURE bot_fire (eid INTEGER)
AS
DECLARE enemy INTEGER; DECLARE w INTEGER; DECLARE skill SMALLINT;
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE fx DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE dl DOUBLE PRECISION; DECLARE err DOUBLE PRECISION;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE lead DOUBLE PRECISION;
DECLARE tf DOUBLE PRECISION; DECLARE ttx DOUBLE PRECISION; DECLARE tty DOUBLE PRECISION; DECLARE ttz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION;
DECLARE tsf INTEGER; DECLARE tct INTEGER; DECLARE tas SMALLINT; DECLARE tss SMALLINT; DECLARE thit INTEGER;
BEGIN
  SELECT e.enemy_id, e.weapon, COALESCE(b.skill, 2) FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO enemy, w, skill;
  IF (enemy IS NULL) THEN EXIT;
  EXECUTE PROCEDURE eye_of(eid) RETURNING_VALUES ex, ey, ez, fx, fy, fz;
  -- aim at the chest; a skilled bot leads projectiles by the target's velocity, a poor one aims where it was
  lead = IIF(skill >= 3, CASE w WHEN 16 THEN 1 / 900e0 WHEN 128 THEN 1 / 2000e0 WHEN 8 THEN 1 / 700e0 ELSE 0 END, 0);
  SELECT o.x + o.vx * :lead * vlen(o.x - :ex, o.y - :ey, o.z - :ez) - IIF(:skill <= 2, o.vx * 0.1e0, 0),
         o.y + o.vy * :lead * vlen(o.x - :ex, o.y - :ey, o.z - :ez) - IIF(:skill <= 2, o.vy * 0.1e0, 0),
         o.z + (o.minz + o.maxz) / 2 + 8
    FROM ents o WHERE o.id = :enemy INTO tx, ty, tz;
  dx = tx - ex; dy = ty - ey; dz = tz - ez;
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN EXIT;
  -- the scatter: a fraction of the distance, by the aim accuracy of the skill
  err = dl * bot_char(skill, 'aim');
  dx = dx + crand() * err; dy = dy + crand() * err; dz = dz + crand() * err * 0.7e0;
  UPDATE ents e SET e.pitch = -ATAN2(:dz, vlen(:dx, :dy, 0)) * 57.29578e0 WHERE e.id = :eid;
  -- BotCheckAttack: a teammate in the line of fire holds it
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) >= 3) THEN
  BEGIN
    EXECUTE PROCEDURE trace_move(eid, 0, 0, 0, 0, 0, 0, ex, ey, ez, tx, ty, tz, 100663297)
      RETURNING_VALUES tf, ttx, tty, ttz, tnx, tny, tnz, tsf, tct, tas, tss, thit;
    IF (thit IS NOT NULL AND thit <> enemy AND on_same_team(eid, thit) = 1) THEN EXIT;
  END
  EXECUTE PROCEDURE fire_weapon(eid, w, ex + fx * 14, ey + fy * 14, ez + fz * 14, dx, dy, dz, 1);
  EXECUTE PROCEDURE set_anims(eid, NULL, IIF(w = 1, 8, 7));
END^

-- Touch_Item for a bot: no inventory beyond health, armour, weapons and the quad
CREATE OR ALTER PROCEDURE bot_item_touch (item INTEGER, other INTEGER)
AS
DECLARE cls VARCHAR(40); DECLARE kind CHAR(1); DECLARE qty INTEGER; DECLARE resp DOUBLE PRECISION; DECLARE bit_ INTEGER; DECLARE snd_ VARCHAR(64);
DECLARE hp INTEGER; DECLARE mhp INTEGER; DECLARE av INTEGER; DECLARE have INTEGER;
BEGIN
  SELECT d.cls, d.kind, IIF(e.count_ > 0, e.count_, d.qty), d.respawn, d.bit, d.snd FROM ents e JOIN item_defs d ON d.cls = e.item WHERE e.id = :item AND e.solid = 1
    INTO cls, kind, qty, resp, bit_, snd_;
  IF (cls IS NULL) THEN EXIT;
  SELECT e.health, e.max_health, e.armor, e.weapons FROM ents e WHERE e.id = :other AND e.classname = 'bot' AND e.health > 0 INTO hp, mhp, av, have;
  IF (hp IS NULL) THEN EXIT;
  IF (kind = 'H') THEN
  BEGIN
    IF (hp >= IIF(qty = 5 OR qty = 100, mhp * 2, mhp)) THEN EXIT;
    UPDATE ents e SET e.health = MINVALUE(e.health + :qty, IIF(:qty = 5 OR :qty = 100, e.max_health * 2, e.max_health)) WHERE e.id = :other;
  END
  ELSE IF (kind = 'A') THEN
  BEGIN
    IF (av >= mhp * 2) THEN EXIT;
    UPDATE ents e SET e.armor = MINVALUE(e.armor + :qty, e.max_health * 2) WHERE e.id = :other;
  END
  ELSE IF (kind = 'W') THEN
  BEGIN
    IF (BIN_AND(have, bit_) <> 0 AND RAND() < 0.7e0) THEN EXIT;   -- usually leaves what it has
    UPDATE ents e SET e.weapons = BIN_OR(e.weapons, :bit_) WHERE e.id = :other;
  END
  ELSE IF (kind = 'P' AND bit_ = 1) THEN
    UPDATE ents e SET e.quad_finished = MAXVALUE(e.quad_finished, now_()) + :qty WHERE e.id = :other;
  ELSE IF (kind = 'M') THEN
  BEGIN
    IF (RAND() < 0.5e0) THEN EXIT;
  END
  ELSE EXIT;
  EXECUTE PROCEDURE snd(other, 3, snd_, 1, 1);
  EXECUTE PROCEDURE item_taken(item, IIF(kind = 'W', 5, resp));
END^

-- ── pain, death, respawn ─────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE bot_pain (eid INTEGER, attacker INTEGER, damage INTEGER, mod_ SMALLINT)
AS
DECLARE pf DOUBLE PRECISION; DECLARE hp INTEGER; DECLARE pm VARCHAR(16); DECLARE enemy INTEGER; DECLARE skill SMALLINT;
BEGIN
  SELECT e.pain_finished, e.health, e.pmodel, e.enemy_id, COALESCE(b.skill, 2) FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO pf, hp, pm, enemy, skill;
  -- whoever hurt it is the enemy now; turning to a new one takes half the reaction time
  IF (attacker > 0 AND attacker <> eid AND EXISTS (SELECT 1 FROM ents a WHERE a.id = :attacker AND a.classname IN ('player', 'bot'))) THEN
    UPDATE ents e SET e.enemy_id = :attacker, e.search_time = now_() + bot_char(:skill, 'search'), e.st = 'run',
           e.ideal_yaw = vectoyaw((SELECT a.x FROM ents a WHERE a.id = :attacker) - e.x, (SELECT a.y FROM ents a WHERE a.id = :attacker) - e.y),
           e.attack_finished = IIF(:enemy IS DISTINCT FROM :attacker, MAXVALUE(e.attack_finished, now_() + bot_char(:skill, 'reaction') * 0.5e0), e.attack_finished) WHERE e.id = :eid;
  -- hit and still standing: it may say something about it (BotChat_HitNoDeath)
  IF (attacker > 0 AND attacker <> eid AND EXISTS (SELECT 1 FROM ents a WHERE a.id = :attacker AND a.classname IN ('player', 'bot'))) THEN
    EXECUTE PROCEDURE bot_chat_event(eid, 'hit_nodeath', attacker, mod_);
  IF (pf > now_()) THEN EXIT;
  UPDATE ents e SET e.pain_finished = now_() + 0.7e0 WHERE e.id = :eid;
  EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || pm || '/pain' || TRIM(CASE WHEN hp < 25 THEN '25' WHEN hp < 50 THEN '50' WHEN hp < 75 THEN '75' ELSE '100' END) || '_1.wav', 1, 1);
END^

CREATE OR ALTER PROCEDURE bot_die (eid INTEGER, attacker INTEGER, mod_ SMALLINT)
AS
DECLARE hp INTEGER; DECLARE pm VARCHAR(16); DECLARE ps VARCHAR(16); DECLARE t DOUBLE PRECISION; DECLARE c INTEGER;
BEGIN
  t = now_();
  SELECT e.health, e.pmodel, e.pskin FROM ents e WHERE e.id = :eid INTO hp, pm, ps;
  EXECUTE PROCEDURE say(obituary(eid, attacker, mod_));
  EXECUTE PROCEDURE score_frag(attacker, eid, mod_);
  EXECUTE PROCEDURE bot_chat_event(eid, 'death', attacker, mod_);   -- BotChat_Death
  UPDATE ents e SET e.deadflag = 1, e.st = 'dead', e.solid = 0, e.movetype = 0, e.takedamage = 0, e.alpha = 1, e.enemy_id = NULL, e.goal_id = NULL,
         e.respawn_time = :t + 2.5e0 + RAND() * 2, e.deaths = e.deaths + 1, e.vx = 0, e.vy = 0, e.vz = 0, e.quad_finished = 0, e.nextthink = :t + 0.5e0 WHERE e.id = :eid;
  IF (hp < -40) THEN
  BEGIN
    EXECUTE PROCEDURE gib_ent(eid, -hp);
    EXIT;
  END
  EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || pm || '/death' || CAST(1 + FLOOR(RAND() * 3) AS INTEGER) || '.wav', 1, 1);
  EXECUTE PROCEDURE spawn_ent('corpse', (SELECT e.x FROM ents e WHERE e.id = :eid), (SELECT e.y FROM ents e WHERE e.id = :eid), (SELECT e.z FROM ents e WHERE e.id = :eid)) RETURNING_VALUES c;
  UPDATE ents e SET e.pmodel = :pm, e.pskin = :ps, e.yaw = (SELECT o.yaw FROM ents o WHERE o.id = :eid), e.solid = 2, e.movetype = 6, e.clipmask = 65537, e.takedamage = 1, e.health = 0, e.deadflag = 1,
         e.minx = -15, e.miny = -15, e.minz = -24, e.maxx = 15, e.maxy = 15, e.maxz = -8, e.legs_anim = CAST(FLOOR(RAND() * 3) AS INTEGER) * 2, e.legs_time = :t, e.torso_anim = -1, e.weapon = 0,
         e.think = 'remove', e.nextthink = :t + 8 WHERE e.id = :c;
  EXECUTE PROCEDURE link_ent(c);
END^

CREATE OR ALTER PROCEDURE bot_respawn (eid INTEGER)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
BEGIN
  t = now_();
  EXECUTE PROCEDURE select_spawn(eid) RETURNING_VALUES x, y, z, yaw;
  UPDATE ents e SET e.x = :x, e.y = :y, e.z = :z + 9, e.yaw = COALESCE(:yaw, 0), e.ideal_yaw = COALESCE(:yaw, 0), e.pitch = 0, e.vx = 0, e.vy = 0, e.vz = 0,
         e.solid = 3, e.movetype = 4, e.takedamage = 2, e.alpha = 0, e.deadflag = 0, e.health = 125, e.armor = 0, e.weapons = 3, e.weapon = 2,
         e.flags = 32, e.st = 'stand', e.legs_anim = 22, e.legs_time = :t, e.torso_anim = 11, e.torso_time = :t, e.enemy_id = NULL, e.goal_id = NULL,
         e.attack_finished = :t + 1, e.teleport_time = :t + 0.3e0, e.lx = NULL, e.nextthink = :t + 0.1e0, e.think = 'bot_think', e.respawn_time = 0,
         e.yaw_speed = bot_char((SELECT b.skill FROM bot_defs b WHERE b.name = e.bot), 'turn') WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
  EXECUTE PROCEDURE snd_at(x, y, z, 'sound/world/telein.wav', 1, 1);
  EXECUTE PROCEDURE fx(5, x, y, z + 9, 0, 0, 0, 1);
END^

-- ── the 10 Hz bot frame ──────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE bot_think (eid INTEGER)
AS
DECLARE t DOUBLE PRECISION; DECLARE nt DOUBLE PRECISION; DECLARE st VARCHAR(12); DECLARE enemy INTEGER; DECLARE flags INTEGER; DECLARE goal INTEGER;
DECLARE rt DOUBLE PRECISION; DECLARE srch DOUBLE PRECISION; DECLARE af DOUBLE PRECISION; DECLARE lefty SMALLINT; DECLARE legs INTEGER; DECLARE skill SMALLINT; DECLARE tt DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE ehp INTEGER;
DECLARE d DOUBLE PRECISION; DECLARE vis SMALLINT; DECLARE yaw DOUBLE PRECISION; DECLARE moved SMALLINT = 0; DECLARE w INTEGER; DECLARE diff DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION;
DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE match_done SMALLINT; DECLARE waiting SMALLINT; DECLARE hp INTEGER; DECLARE hesitate SMALLINT = 0; DECLARE fresh SMALLINT = 0;
BEGIN
  t = now_();
  nt = t + 0.1e0;
  SELECT e.st, e.enemy_id, e.flags, e.goal_id, e.respawn_time, e.search_time, e.attack_finished, e.lefty, e.legs_anim, e.x, e.y, e.z, e.yaw, e.teleport_time, e.health, COALESCE(b.skill, 2)
    FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO st, enemy, flags, goal, rt, srch, af, lefty, legs, x, y, z, yaw, tt, hp, skill;
  IF (st IS NULL) THEN EXIT;
  SELECT g.match_over, IIF(g.warmup_end > :t, 1, 0) FROM game g WHERE g.id = 1 INTO match_done, waiting;
  IF (match_done = 1) THEN BEGIN UPDATE ents e SET e.nextthink = :t + 0.5e0, e.vx = 0, e.vy = 0 WHERE e.id = :eid; EXIT; END
  IF (waiting = 1) THEN BEGIN UPDATE ents e SET e.nextthink = :t + 0.1e0 WHERE e.id = :eid; EXIT; END   -- the countdown
  IF (st = 'dead') THEN
  BEGIN
    IF (rt <= t AND match_done = 0) THEN EXECUTE PROCEDURE bot_respawn(eid);
    ELSE UPDATE ents e SET e.nextthink = :t + 0.5e0 WHERE e.id = :eid;
    EXIT;
  END
  ox = x; oy = y;
  -- what we are standing in or on
  EXECUTE PROCEDURE touch_triggers(eid);
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.health > 0)) THEN EXIT;

  -- the enemy: lost when dead, or unseen for a while; a new one is noticed by the senses of the skill
  IF (enemy IS NOT NULL) THEN
  BEGIN
    SELECT IIF(BIN_AND(e.flags, 64) <> 0, 0, e.health) FROM ents e WHERE e.id = :enemy INTO ehp;   -- (a spectator is no enemy)
    IF (ehp IS NULL OR ehp <= 0) THEN enemy = NULL;
  END
  IF (enemy IS NOT NULL AND srch < t) THEN enemy = NULL;
  IF (enemy IS NULL OR MOD(CAST(t * 10 AS INTEGER), 10) = 0) THEN
  BEGIN
    w = bot_find_target(eid);
    IF (w IS NOT NULL AND (enemy IS NULL OR w <> enemy)) THEN
    BEGIN
      -- BotFindEnemy: the reaction time passes before the first shot
      enemy = w; srch = t + bot_char(skill, 'search'); fresh = 1;
      af = MAXVALUE(af, t + bot_char(skill, 'reaction'));
    END
  END
  -- a poor bot dawdles now and then
  IF (RAND() < bot_char(skill, 'hesitate')) THEN hesitate = 1;
  spd = bot_char(skill, 'speed');

  IF (enemy IS NOT NULL) THEN
  BEGIN
    SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :enemy INTO ex, ey, ez;
    d = vlen(ex - x, ey - y, ez - z);
    vis = visible(eid, enemy);
    IF (vis = 1) THEN srch = t + bot_char(skill, 'search');
    UPDATE ents e SET e.enemy_id = :enemy, e.search_time = :srch, e.st = 'run', e.ideal_yaw = vectoyaw(:ex - :x, :ey - :y), e.goal_id = IIF(:fresh = 1, NULL, e.goal_id),
           e.attack_finished = :af WHERE e.id = :eid;
    EXECUTE PROCEDURE change_yaw(eid);
    -- in the air (a jump pad, a knock): nothing to do but aim
    IF (BIN_AND(flags, 512) = 0 OR tt > t) THEN
    BEGIN
      IF (vis = 1 AND af <= t) THEN EXECUTE PROCEDURE bot_fire(eid);
      UPDATE ents e SET e.nextthink = :nt, e.attack_finished = IIF(:vis = 1 AND :af <= :t, :t + fire_time(e.weapon), e.attack_finished) WHERE e.id = :eid;
      EXIT;
    END
    w = bot_best_weapon(eid, d);
    IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.weapon <> :w)) THEN
    BEGIN
      UPDATE ents e SET e.weapon = :w WHERE e.id = :eid;
      EXECUTE PROCEDURE set_anims(eid, NULL, 10);   -- TORSO_RAISE: the new gun comes up (it ends standing)
    END
    -- hurt and a health item in sight: go for it (BotWantsToRetreat, roughly)
    SELECT e.goal_id FROM ents e WHERE e.id = :eid INTO goal;
    IF (hp < 40 AND goal IS NULL AND RAND() < 0.5e0) THEN
    BEGIN
      SELECT FIRST 1 g.id FROM ents g JOIN item_defs i ON i.cls = g.item WHERE g.classname = 'item' AND g.solid = 1 AND i.kind = 'H'
         AND ABS(g.x - :x) < 800 AND ABS(g.y - :y) < 800 AND ABS(g.z - :z) < 200 ORDER BY ABS(g.x - :x) + ABS(g.y - :y) INTO goal;
      IF (goal IS NOT NULL AND visible(eid, goal) = 0) THEN goal = NULL;
      UPDATE ents e SET e.goal_id = :goal WHERE e.id = :eid;
    END
    IF (goal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ents g WHERE g.id = :goal AND g.solid = 1)) THEN BEGIN goal = NULL; UPDATE ents e SET e.goal_id = NULL WHERE e.id = :eid; END
    IF (hesitate = 1) THEN BEGIN END
    ELSE IF (goal IS NOT NULL) THEN
    BEGIN
      EXECUTE PROCEDURE bot_follow_route(eid, goal, spd) RETURNING_VALUES moved;
      IF (moved <= 0) THEN EXECUTE PROCEDURE move_to_goal(eid, goal, spd);
    END
    ELSE IF (vis = 0 OR ABS(ez - z) > 48 OR d > 900) THEN
    BEGIN
      -- out of sight, or on another floor: hunt it along the waypoints (and over the jump pads)
      EXECUTE PROCEDURE bot_follow_route(eid, enemy, spd) RETURNING_VALUES moved;
      IF (moved <= 0) THEN EXECUTE PROCEDURE move_to_goal(eid, enemy, spd);
    END
    ELSE IF (d > 350 OR w = 1) THEN EXECUTE PROCEDURE move_to_goal(eid, enemy, spd);
    ELSE IF (RAND() < bot_char(skill, 'strafe')) THEN
    BEGIN
      -- close enough: circle-strafe, switching sides now and then or when blocked (BotAttackMove)
      IF (RAND() < 0.08e0) THEN BEGIN lefty = 1 - lefty; UPDATE ents e SET e.lefty = :lefty WHERE e.id = :eid; END
      IF (step_direction(eid, anglemod(vectoyaw(ex - x, ey - y) + IIF(lefty = 1, 90, -90)), spd * 0.8e0) = 0) THEN
      BEGIN
        lefty = 1 - lefty;
        UPDATE ents e SET e.lefty = :lefty WHERE e.id = :eid;
        IF (d < 120) THEN moved = step_direction(eid, anglemod(vectoyaw(ex - x, ey - y) + 180), spd);
      END
    END
    -- keep facing the enemy
    UPDATE ents e SET e.ideal_yaw = vectoyaw(:ex - e.x, :ey - e.y) WHERE e.id = :eid;
    EXECUTE PROCEDURE change_yaw(eid);
    -- fire when facing it; a poor bot fires in bursts with pauses between them
    SELECT anglemod(e.yaw - e.ideal_yaw) FROM ents e WHERE e.id = :eid INTO diff;
    IF (vis = 1 AND af <= t AND (diff < 25 OR diff > 335)) THEN
    BEGIN
      EXECUTE PROCEDURE bot_fire(eid);
      UPDATE ents e SET e.attack_finished = :t + fire_time(e.weapon) * (1 + RAND() * (5 - :skill) * 0.4e0) + IIF(RAND() < bot_char(:skill, 'pause'), 0.5e0 + RAND() * 0.8e0, 0) WHERE e.id = :eid;
    END
  END
  ELSE
  BEGIN
    -- nothing in sight: wander toward an item, or just roam
    UPDATE ents e SET e.enemy_id = NULL, e.st = 'stand' WHERE e.id = :eid AND e.enemy_id IS NOT NULL;
    IF (goal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ents g WHERE g.id = :goal AND g.solid = 1 AND vlen(g.x - :x, g.y - :y, 0) > 40)) THEN
    BEGIN
      goal = NULL;
      UPDATE ents e SET e.goal_id = NULL WHERE e.id = :eid;
    END
    IF (goal IS NULL AND RAND() < 0.3e0) THEN
    BEGIN
      -- roam to an item anywhere near, over the graph (BotRoamGoal); the good ones draw it, as Q3's item weights do
      SELECT FIRST 1 g.id FROM ents g JOIN item_defs i ON i.cls = g.item WHERE g.classname = 'item' AND g.solid = 1 AND ABS(g.x - :x) < 1800 AND ABS(g.y - :y) < 1800
       ORDER BY ABS(g.x - :x) + ABS(g.y - :y) + ABS(g.z - :z) * 2 + RAND() * 1200 - IIF(i.kind IN ('W', 'P', 'A'), 400, 0) INTO goal;
      UPDATE ents e SET e.goal_id = :goal WHERE e.id = :eid;
    END
    -- nothing to do but roam: now and then a word (BotChat_Random, a chance in a hundred a think, then the character's)
    IF (RAND() < 0.005e0) THEN EXECUTE PROCEDURE bot_chat_event(eid, 'random', NULL, 0);
    IF (BIN_AND(flags, 512) <> 0 AND tt < t AND hesitate = 0) THEN
    BEGIN
      IF (goal IS NOT NULL) THEN
      BEGIN
        EXECUTE PROCEDURE bot_follow_route(eid, goal, spd * 0.9e0) RETURNING_VALUES moved;
        IF (moved < 0) THEN BEGIN goal = NULL; UPDATE ents e SET e.goal_id = NULL WHERE e.id = :eid; END
        ELSE IF (moved = 0) THEN EXECUTE PROCEDURE move_to_goal(eid, goal, spd * 0.9e0);
      END
      IF (goal IS NULL) THEN
      BEGIN
        IF (RAND() < 0.1e0) THEN UPDATE ents e SET e.ideal_yaw = anglemod(e.ideal_yaw + crand() * 90) WHERE e.id = :eid;
        EXECUTE PROCEDURE change_yaw(eid);
        SELECT e.ideal_yaw FROM ents e WHERE e.id = :eid INTO yaw;
        IF (step_direction(eid, yaw, spd * 0.8e0) = 0) THEN UPDATE ents e SET e.ideal_yaw = anglemod(e.ideal_yaw + 90 + RAND() * 180) WHERE e.id = :eid;
      END
    END
  END
  -- the legs follow the feet
  SELECT e.x, e.y FROM ents e WHERE e.id = :eid INTO x, y;
  moved = IIF(ABS(x - ox) + ABS(y - oy) > 1, 1, 0);
  IF (BIN_AND(flags, 512) = 0) THEN BEGIN IF (legs NOT IN (18, 20)) THEN EXECUTE PROCEDURE set_anims(eid, 18, NULL); END
  ELSE IF (moved = 1 AND legs <> 15) THEN EXECUTE PROCEDURE set_anims(eid, 15, NULL);
  ELSE IF (moved = 0 AND legs <> 22) THEN EXECUTE PROCEDURE set_anims(eid, 22, NULL);
  UPDATE ents e SET e.nextthink = :nt WHERE e.id = :eid;
END^

-- PickTeam: the team with fewer players, else the one behind, else blue
CREATE OR ALTER FUNCTION pick_team RETURNS SMALLINT
AS
DECLARE r INTEGER; DECLARE b INTEGER; DECLARE rs INTEGER; DECLARE bs INTEGER;
BEGIN
  SELECT COUNT(*) FROM ents e WHERE e.classname IN ('player', 'bot') AND e.pteam = 1 AND NOT (e.classname = 'player' AND (SELECT p.spectator FROM player p WHERE p.id = 1) = 1) INTO r;
  SELECT COUNT(*) FROM ents e WHERE e.classname IN ('player', 'bot') AND e.pteam = 2 AND NOT (e.classname = 'player' AND (SELECT p.spectator FROM player p WHERE p.id = 1) = 1) INTO b;
  IF (b > r) THEN RETURN 1;
  IF (r > b) THEN RETURN 2;
  SELECT g.red_score, g.blue_score FROM game g WHERE g.id = 1 INTO rs, bs;
  IF (bs > rs) THEN RETURN 1;
  RETURN 2;
END^

-- a bot joins the arena
CREATE OR ALTER PROCEDURE spawn_bot (bname VARCHAR(16))
RETURNS (id INTEGER)
AS
DECLARE mdl VARCHAR(16); DECLARE sk VARCHAR(16); DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
DECLARE tm SMALLINT;
BEGIN
  SELECT b.model, b.skin FROM bot_defs b WHERE b.name = :bname INTO mdl, sk;
  IF (mdl IS NULL) THEN EXIT;
  t = now_();
  EXECUTE PROCEDURE select_spawn(NULL) RETURNING_VALUES x, y, z, yaw;
  EXECUTE PROCEDURE spawn_ent('bot', x, y, z + 9) RETURNING_VALUES id;
  UPDATE ents e SET e.bot = :bname, e.pmodel = :mdl, e.pskin = :sk, e.yaw = COALESCE(:yaw, 0), e.ideal_yaw = COALESCE(:yaw, 0),
         e.minx = -15, e.miny = -15, e.minz = -24, e.maxx = 15, e.maxy = 15, e.maxz = 32, e.viewheight = 26,
         e.solid = 3, e.movetype = 4, e.clipmask = 33619969, e.health = 125, e.max_health = 100, e.takedamage = 2, e.mass = 200, e.flags = 32,
         e.yaw_speed = bot_char((SELECT b.skill FROM bot_defs b WHERE b.name = :bname), 'turn'), e.st = 'stand', e.weapons = 3, e.weapon = 2, e.legs_time = :t, e.torso_time = :t,
         e.think = 'bot_think', e.nextthink = :t + 0.5e0 + RAND() * 0.5e0, e.attack_finished = :t + 2 WHERE e.id = :id;
  -- in a team game, a team (PickTeam) and its colours (the model's red or blue skin)
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) >= 3) THEN
  BEGIN
    tm = pick_team();
    UPDATE ents e SET e.pteam = :tm, e.pskin = IIF(:tm = 1, 'red', 'blue') WHERE e.id = :id;
  END
  EXECUTE PROCEDURE link_ent(id);
  EXECUTE PROCEDURE say(bname || ' entered the game' || COALESCE((SELECT TRIM(TRAILING FROM IIF(e.pteam = 1, ' (red)', IIF(e.pteam = 2, ' (blue)', ''))) FROM ents e WHERE e.id = :id), ''));
  IF ((SELECT g.tic FROM game g WHERE g.id = 1) > 0) THEN EXECUTE PROCEDURE bot_chat_event(id, 'game_enter', NULL, 0);   -- BotChat_EnterGame
  SUSPEND;
END^

-- ── scoring and the announcer ────────────────────────────────────────────
-- ── the end of a match ───────────────────────────────────────────────────
-- BeginIntermission, FindIntermissionPoint and MoveClientToIntermission: the view goes to the map's
-- info_player_intermission looking at its target (or a spawn point when there is none), the dead are
-- revived, and the players leave the arena: the bots vanish as Quake III's clients do, and nobody moves
CREATE OR ALTER PROCEDURE begin_intermission
AS
DECLARE pe INTEGER; DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE oz DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE tgt VARCHAR(40);
DECLARE ang DOUBLE PRECISION; DECLARE ap DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE pitch DOUBLE PRECISION;
BEGIN
  pe = player_ent();
  EXECUTE PROCEDURE intermission_point RETURNING_VALUES ox, oy, oz, yaw, pitch;
  UPDATE player p SET p.follow_id = NULL WHERE p.id = 1;
  -- the eye is the intermission point itself (CG_CalcViewValues under PM_INTERMISSION)
  UPDATE ents e SET e.x = :ox, e.y = :oy, e.z = :oz - 26, e.vx = 0, e.vy = 0, e.vz = 0, e.yaw = :yaw, e.pitch = :pitch,
         e.deadflag = 0, e.health = MAXVALUE(e.health, 1), e.solid = 0, e.takedamage = 0, e.movetype = 0,
         e.minz = -24, e.maxz = 32, e.viewheight = 26 WHERE e.id = :pe;
  UPDATE player p SET p.pitch = :pitch, p.punchangle = 0, p.stepz = 0, p.view_ofs = 26, p.ducked = 0, p.weapon_sound = 0 WHERE p.id = 1;
  EXECUTE PROCEDURE link_ent(pe);
  UPDATE ents e SET e.alpha = 1, e.solid = 0, e.vx = 0, e.vy = 0, e.vz = 0 WHERE e.classname = 'bot';
END^

-- the match is over: who won, the next arena of the rotation, and the intermission
CREATE OR ALTER PROCEDURE end_match (wname VARCHAR(32))
AS
DECLARE t DOUBLE PRECISION; DECLARE cur VARCHAR(32); DECLARE nm VARCHAR(32); DECLARE b INTEGER;
BEGIN
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.match_over = 1)) THEN EXIT;
  t = now_();
  SELECT g.map_name FROM game g WHERE g.id = 1 INTO cur;
  SELECT FIRST 1 m.name FROM map_list m WHERE m.ord > COALESCE((SELECT c.ord FROM map_list c WHERE c.name = :cur), -1) ORDER BY m.ord INTO nm;
  IF (nm IS NULL) THEN SELECT FIRST 1 m.name FROM map_list m ORDER BY m.ord INTO nm;
  UPDATE game g SET g.match_over = 1, g.winner = :wname, g.over_time = :t, g.next_map = COALESCE(:nm, :cur) WHERE g.id = 1;
  EXECUTE PROCEDURE cprint(IIF(wname = 'You', 'You win!', wname || ' wins'));
  EXECUTE PROCEDURE snd_local(IIF(wname = 'You' OR wname = (SELECT IIF(e.pteam = 1, 'Red team', 'Blue team') FROM ents e WHERE e.id = player_ent() AND e.pteam > 0), 'music/win.wav', 'music/loss.wav'));
  EXECUTE PROCEDURE begin_intermission;
  -- the bots have their say about it (BotChat_EndLevel)
  FOR SELECT e.id FROM ents e WHERE e.classname = 'bot' ORDER BY e.id INTO b DO EXECUTE PROCEDURE bot_chat_event(b, 'level_end', NULL, 0);
END^

-- CheckExitRules, every tic: the time limit with its warnings (CG_CheckLocalSounds) and sudden death
-- when the lead is tied as the clock runs out; during the intermission, CheckIntermissionExit's
-- timeout (the player's fire after five seconds is in PLAYER_THINK)
CREATE OR ALTER PROCEDURE check_exit_rules
AS
DECLARE t DOUBLE PRECISION; DECLARE tl INTEGER; DECLARE mo SMALLINT; DECLARE warn SMALLINT; DECLARE ot DOUBLE PRECISION; DECLARE ek SMALLINT;
DECLARE pf INTEGER; DECLARE bf INTEGER; DECLARE top INTEGER; DECLARE n INTEGER; DECLARE wname VARCHAR(32);
DECLARE we DOUBLE PRECISION; DECLARE ws SMALLINT; DECLARE sec INTEGER;
BEGIN
  SELECT g.time_, g.timelimit, g.match_over, g.time_warnings, g.over_time, g.exit_kind, g.warmup_end, g.warmup_said FROM game g WHERE g.id = 1
    INTO t, tl, mo, warn, ot, ek, we, ws;
  IF (mo = 1) THEN
  BEGIN
    IF (ek = 0 AND t > ot + 30) THEN UPDATE game g SET g.exit_kind = 1 WHERE g.id = 1;
    EXIT;
  END
  -- the countdown (CG_DrawWarmup, CG_MapRestart): three, two, one, and "fight!"
  IF (ws > 0) THEN
  BEGIN
    sec = CAST(CEILING(we - t) AS INTEGER);
    IF (sec <= 0) THEN
    BEGIN
      ws = 0;
      EXECUTE PROCEDURE snd_local('sound/feedback/fight.wav');
      EXECUTE PROCEDURE cprint('FIGHT!');
    END
    ELSE IF (sec < ws AND sec <= 3) THEN
    BEGIN
      ws = sec;
      EXECUTE PROCEDURE snd_local(TRIM(CASE sec WHEN 3 THEN 'sound/feedback/three.wav' WHEN 2 THEN 'sound/feedback/two.wav' ELSE 'sound/feedback/one.wav' END));
    END
    UPDATE game g SET g.warmup_said = :ws WHERE g.id = 1 AND g.warmup_said <> :ws;
    EXIT;
  END
  IF (tl IS NULL OR tl <= 0) THEN EXIT;
  t = t - we;   -- the match's clock starts at "fight!"
  IF (tl > 5 AND BIN_AND(warn, 1) = 0 AND t >= (tl - 5) * 60) THEN BEGIN warn = BIN_OR(warn, 1); EXECUTE PROCEDURE snd_local('sound/feedback/5_minute.wav'); END
  IF (tl > 1 AND BIN_AND(warn, 2) = 0 AND t >= (tl - 1) * 60) THEN BEGIN warn = BIN_OR(warn, 2); EXECUTE PROCEDURE snd_local('sound/feedback/1_minute.wav'); END
  IF (t >= tl * 60 AND (SELECT g.gametype FROM game g WHERE g.id = 1) >= 3) THEN
  BEGIN
    -- a team game: ScoreIsTied is the teams' scores
    SELECT g.red_score, g.blue_score FROM game g WHERE g.id = 1 INTO pf, bf;
    IF (pf = bf) THEN
    BEGIN
      IF (BIN_AND(warn, 4) = 0 AND t >= tl * 60 + 2) THEN
      BEGIN
        warn = BIN_OR(warn, 4);
        EXECUTE PROCEDURE snd_local('sound/feedback/sudden_death.wav');
        EXECUTE PROCEDURE cprint('Sudden Death!');
      END
    END
    ELSE
    BEGIN
      EXECUTE PROCEDURE sprint('Timelimit hit.');
      EXECUTE PROCEDURE end_match(TRIM(IIF(pf > bf, 'Red team', 'Blue team')));
    END
  END
  ELSE IF (t >= tl * 60) THEN
  BEGIN
    SELECT IIF(p.spectator = 1, -1000000, p.frags) FROM player p WHERE p.id = 1 INTO pf;   -- a spectator is not ranked
    SELECT MAX(e.frags) FROM ents e WHERE e.classname = 'bot' INTO bf;
    top = MAXVALUE(pf, COALESCE(bf, pf));
    n = IIF(pf = top, 1, 0) + (SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot' AND e.frags = :top);
    IF (n > 1) THEN
    BEGIN
      -- ScoreIsTied: play on, the next frag at the top wins
      IF (BIN_AND(warn, 4) = 0 AND t >= tl * 60 + 2) THEN
      BEGIN
        warn = BIN_OR(warn, 4);
        EXECUTE PROCEDURE snd_local('sound/feedback/sudden_death.wav');
        EXECUTE PROCEDURE cprint('Sudden Death!');
      END
    END
    ELSE
    BEGIN
      IF (pf = top) THEN wname = 'You'; ELSE SELECT FIRST 1 e.bot FROM ents e WHERE e.classname = 'bot' ORDER BY e.frags DESC INTO wname;
      EXECUTE PROCEDURE sprint('Timelimit hit.');
      EXECUTE PROCEDURE end_match(wname);
    END
  END
  UPDATE game g SET g.time_warnings = :warn WHERE g.id = 1 AND g.time_warnings <> :warn;
END^

-- AddScore: the player's or the bot's frags, and in a team game its team's score with them
CREATE OR ALTER PROCEDURE add_score (eid INTEGER, delta INTEGER)
AS
DECLARE tm SMALLINT;
BEGIN
  IF (eid = player_ent()) THEN UPDATE player p SET p.frags = p.frags + :delta WHERE p.id = 1;
  ELSE UPDATE ents e SET e.frags = e.frags + :delta WHERE e.id = :eid;
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) < 3) THEN EXIT;
  SELECT e.pteam FROM ents e WHERE e.id = :eid INTO tm;
  IF (tm = 1) THEN UPDATE game g SET g.red_score = g.red_score + :delta WHERE g.id = 1;
  ELSE IF (tm = 2) THEN UPDATE game g SET g.blue_score = g.blue_score + :delta WHERE g.id = 1;
END^

CREATE OR ALTER PROCEDURE score_frag (attacker INTEGER, victim INTEGER, mod_ SMALLINT)
AS
DECLARE pe INTEGER; DECLARE t DOUBLE PRECISION; DECLARE pf INTEGER; DECLARE bf INTEGER; DECLARE lead SMALLINT; DECLARE oldlead SMALLINT; DECLARE lim INTEGER;
DECLARE lk DOUBLE PRECISION; DECLARE wname VARCHAR(32); DECLARE top INTEGER; DECLARE left_ INTEGER; DECLARE bot_ INTEGER;
DECLARE gt SMALLINT; DECLARE mate SMALLINT; DECLARE rs INTEGER; DECLARE bs INTEGER; DECLARE tl SMALLINT; DECLARE otl SMALLINT; DECLARE atm SMALLINT;
BEGIN
  pe = player_ent();
  t = now_();
  SELECT g.gametype FROM game g WHERE g.id = 1 INTO gt;
  mate = on_same_team(attacker, victim);
  IF (attacker IS NULL OR attacker <= 0 OR attacker = victim) THEN
    EXECUTE PROCEDURE add_score(victim, -1);      -- a suicide costs a frag
  ELSE IF (mate = 1) THEN
    EXECUTE PROCEDURE add_score(attacker, -1);    -- so does a teammate
  ELSE
  BEGIN
    EXECUTE PROCEDURE add_score(attacker, 1);
    IF (attacker = pe) THEN EXECUTE PROCEDURE sprint('You fragged ' || ent_name(victim));
  END
  -- the rewards (player_die in g_combat.c): a gauntlet frag, and a frag within 3 s of the last one
  -- (CARNAGE_REWARD_TIME); the gauntlet's victim hears "humiliation" too
  IF (attacker > 0 AND attacker <> victim AND mate = 0) THEN
  BEGIN
    SELECT e.last_kill FROM ents e WHERE e.id = :attacker INTO lk;
    IF (mod_ = 1) THEN
    BEGIN
      EXECUTE PROCEDURE give_award(attacker, 3);
      IF (victim = pe) THEN EXECUTE PROCEDURE snd_local('sound/feedback/humiliation.wav');
    END
    IF (t - lk < 3) THEN EXECUTE PROCEDURE give_award(attacker, 1);
    UPDATE ents e SET e.last_kill = :t WHERE e.id = :attacker;
  END
  -- the bots' say: the killer about the kill (BotChat_Kill), or those after the victim about its suicide
  IF (attacker > 0 AND attacker <> victim AND EXISTS (SELECT 1 FROM ents a WHERE a.id = :attacker AND a.classname = 'bot')) THEN
    EXECUTE PROCEDURE bot_chat_event(attacker, 'kill', victim, mod_);
  ELSE IF (attacker IS NULL OR attacker <= 0 OR attacker = victim) THEN
  BEGIN
    bot_ = NULL;
    SELECT FIRST 1 e.id FROM ents e WHERE e.classname = 'bot' AND e.enemy_id = :victim AND e.id <> :victim INTO bot_;
    IF (bot_ IS NOT NULL) THEN EXECUTE PROCEDURE bot_chat_event(bot_, 'enemy_suicide', victim, mod_);
  END
  SELECT g.fraglimit, g.red_score, g.blue_score, g.team_lead FROM game g WHERE g.id = 1 INTO lim, rs, bs, otl;
  IF (gt >= 3) THEN
  BEGIN
    -- a team game: the announcer calls the team that leads ("red leads", "blue leads", "teams are tied"),
    -- the fraglimit is the team's (CheckExitRules: "Red hit the fraglimit.")
    tl = IIF(rs > bs, 1, IIF(bs > rs, 2, 0));
    IF (tl <> otl) THEN
    BEGIN
      UPDATE game g SET g.team_lead = :tl WHERE g.id = 1;
      EXECUTE PROCEDURE snd_local(CASE tl WHEN 1 THEN 'sound/feedback/redleads.wav' WHEN 2 THEN 'sound/feedback/blueleads.wav' ELSE 'sound/feedback/teamstied.wav' END);
    END
    top = MAXVALUE(rs, bs);
    SELECT e.pteam FROM ents e WHERE e.id = :attacker INTO atm;
    left_ = lim - top;
    IF (lim > 0 AND left_ IN (1, 2, 3) AND mate = 0 AND IIF(atm = 1, rs, IIF(atm = 2, bs, -1)) = top) THEN
      EXECUTE PROCEDURE snd_local(CASE left_ WHEN 1 THEN 'sound/feedback/1_frag.wav' WHEN 2 THEN 'sound/feedback/2_frags.wav' ELSE 'sound/feedback/3_frags.wav' END);
    IF (lim > 0 AND top >= lim) THEN
    BEGIN
      EXECUTE PROCEDURE sprint(TRIM(IIF(rs >= lim, 'Red', 'Blue')) || ' hit the fraglimit.');
      EXECUTE PROCEDURE end_match(TRIM(IIF(rs >= lim, 'Red team', 'Blue team')));
    END
    EXIT;
  END
  -- the lead
  SELECT p.frags, p.lead_state FROM player p WHERE p.id = 1 INTO pf, oldlead;
  SELECT COALESCE(MAX(e.frags), 0) FROM ents e WHERE e.classname = 'bot' INTO bf;
  lead = IIF(pf > bf, 2, IIF(pf = bf, 1, 0));
  IF (lead <> oldlead AND (attacker = pe OR victim = pe OR oldlead = 2 OR lead = 2)) THEN
  BEGIN
    UPDATE player p SET p.lead_state = :lead WHERE p.id = 1;
    EXECUTE PROCEDURE snd_local(CASE lead WHEN 2 THEN 'sound/feedback/takenlead.wav' WHEN 1 THEN 'sound/feedback/tiedlead.wav' ELSE 'sound/feedback/lostlead.wav' END);
  END
  -- frags left, and the end of the match
  top = MAXVALUE(pf, bf);
  left_ = lim - top;
  IF (lim > 0 AND left_ IN (1, 2, 3) AND ((attacker = pe AND pf = top) OR (attacker <> pe AND bf = top))) THEN
    EXECUTE PROCEDURE snd_local(CASE left_ WHEN 1 THEN 'sound/feedback/1_frag.wav' WHEN 2 THEN 'sound/feedback/2_frags.wav' ELSE 'sound/feedback/3_frags.wav' END);
  IF (lim > 0 AND top >= lim) THEN
  BEGIN
    IF (pf >= lim) THEN wname = 'You'; ELSE SELECT FIRST 1 e.bot FROM ents e WHERE e.classname = 'bot' ORDER BY e.frags DESC INTO wname;
    EXECUTE PROCEDURE sprint('Fraglimit hit.');
    EXECUTE PROCEDURE end_match(wname);
  END
END^

-- ── the pushers (G_RunMover) ─────────────────────────────────────────────
SET TERM ; ^
CREATE GLOBAL TEMPORARY TABLE pushed (
  ent INTEGER NOT NULL PRIMARY KEY,
  ox DOUBLE PRECISION NOT NULL, oy DOUBLE PRECISION NOT NULL, oz DOUBLE PRECISION NOT NULL,
  oyaw DOUBLE PRECISION DEFAULT 0 NOT NULL,
  rider SMALLINT DEFAULT 0 NOT NULL                -- standing on the pusher before it turned
) ON COMMIT DELETE ROWS;
SET TERM ^ ;

CREATE OR ALTER PROCEDURE push_move (eid INTEGER, movetime DOUBLE PRECISION)
AS
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION;
DECLARE ap DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE ar DOUBLE PRECISION;
DECLARE mx DOUBLE PRECISION; DECLARE my DOUBLE PRECISION; DECLARE mz DOUBLE PRECISION;
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE c INTEGER; DECLARE cmt SMALLINT; DECLARE cx DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION;
DECLARE csolid SMALLINT; DECLARE pe INTEGER; DECLARE r INTEGER; DECLARE grow DOUBLE PRECISION;
DECLARE cyaw DOUBLE PRECISION; DECLARE rider SMALLINT; DECLARE cmask INTEGER;
DECLARE bmnx DOUBLE PRECISION; DECLARE bmny DOUBLE PRECISION; DECLARE bmnz DOUBLE PRECISION;
DECLARE bmxx DOUBLE PRECISION; DECLARE bmxy DOUBLE PRECISION; DECLARE bmxz DOUBLE PRECISION;
DECLARE tf DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION;
DECLARE tsf INTEGER; DECLARE tct INTEGER; DECLARE tas SMALLINT; DECLARE tss SMALLINT; DECLARE thit INTEGER;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION;
DECLARE m00 DOUBLE PRECISION; DECLARE m01 DOUBLE PRECISION; DECLARE m02 DOUBLE PRECISION;
DECLARE m10 DOUBLE PRECISION; DECLARE m11 DOUBLE PRECISION; DECLARE m12 DOUBLE PRECISION;
DECLARE m20 DOUBLE PRECISION; DECLARE m21 DOUBLE PRECISION; DECLARE m22 DOUBLE PRECISION;
BEGIN
  SELECT e.vx, e.vy, e.vz, e.avel_pitch, e.avel_yaw, e.avel_roll, e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz FROM ents e WHERE e.id = :eid
    INTO vx, vy, vz, ap, ay, ar, px, py, pz, mnx, mny, mnz, mxx, mxy, mxz;
  IF (vx = 0 AND vy = 0 AND vz = 0 AND ap = 0 AND ay = 0 AND ar = 0) THEN
  BEGIN
    UPDATE ents e SET e.ltime = e.ltime + :movetime WHERE e.id = :eid;
    EXIT;
  END
  pe = player_ent();

  -- rotation (G_MoverPush with an amove): who stands on it before it turns (a short trace down hits it:
  -- their groundEntityNum) is carried round its origin, and so is anything the turned pusher is now
  -- inside; players and bots turn with it (delta_angles[YAW]). What cannot go stops it: everything
  -- back where it was, the pusher too, and mover_blocked
  IF (ap <> 0 OR ay <> 0 OR ar <> 0) THEN
  BEGIN
    grow = MAXVALUE(mxx - mnx, MAXVALUE(mxy - mny, mxz - mnz));
    DELETE FROM pushed;
    FOR SELECT e.id, e.x, e.y, e.z, e.yaw, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.clipmask FROM ents e
         WHERE e.id <> :eid AND e.movetype NOT IN (0, 7, 8) AND e.solid <> 0 AND e.health > -1
           AND e.x + e.maxx >= :px + :mnx - :grow AND e.x + e.minx <= :px + :mxx + :grow
           AND e.y + e.maxy >= :py + :mny - :grow AND e.y + e.miny <= :py + :mxy + :grow
           AND e.z + e.maxz >= :pz + :mnz - :grow AND e.z + e.minz <= :pz + :mxz + :grow
          INTO c, cx, cy, cz, cyaw, bmnx, bmny, bmnz, bmxx, bmxy, bmxz, cmask
    DO
    BEGIN
      EXECUTE PROCEDURE trace_move(c, bmnx, bmny, bmnz, bmxx, bmxy, bmxz, cx, cy, cz, cx, cy, cz - 1, cmask)
        RETURNING_VALUES tf, tx, ty, tz, tnx, tny, tnz, tsf, tct, tas, tss, thit;
      INSERT INTO pushed (ent, ox, oy, oz, oyaw, rider) VALUES (:c, :cx, :cy, :cz, :cyaw, IIF(:tf < 1 AND :thit = :eid AND :tnz > 0.7e0, 1, 0));
    END
    UPDATE ents e SET e.pitch = e.pitch + :ap * :movetime, e.yaw = e.yaw + :ay * :movetime, e.roll = e.roll + :ar * :movetime, e.ltime = e.ltime + :movetime WHERE e.id = :eid;
    -- the turn of this move, as a matrix (G_CreateRotationMatrix transposed: model to world)
    EXECUTE PROCEDURE angle_matrix(ap * movetime, ay * movetime, ar * movetime) RETURNING_VALUES m00, m01, m02, m10, m11, m12, m20, m21, m22;
    FOR SELECT p.ent, p.ox, p.oy, p.oz, p.oyaw, p.rider FROM pushed p INTO c, cx, cy, cz, cyaw, rider DO
    BEGIN
      -- not on it and not in its way: left alone
      IF (rider = 0 AND test_position(c, cx, cy, cz) = 0) THEN
      BEGIN
        DELETE FROM pushed p WHERE p.ent = :c;
        CONTINUE;
      END
      dx = cx - px; dy = cy - py; dz = cz - pz;
      tx = px + m00 * dx + m01 * dy + m02 * dz;
      ty = py + m10 * dx + m11 * dy + m12 * dz;
      tz = pz + m20 * dx + m21 * dy + m22 * dz;
      UPDATE ents e SET e.x = :tx, e.y = :ty, e.z = :tz,
             e.yaw = IIF(e.classname IN ('player', 'bot'), anglemod(e.yaw + :ay * :movetime), e.yaw) WHERE e.id = :c;
      IF (test_position(c, tx, ty, tz) = 0) THEN
      BEGIN
        EXECUTE PROCEDURE link_ent(c);
        IF (c = pe) THEN UPDATE player p SET p.mover_yaw = p.mover_yaw + :ay * :movetime, p.oldz = p.oldz + (:tz - :cz) WHERE p.id = 1;
        CONTINUE;
      END
      -- the pusher may have turned out of it: then it stays
      UPDATE ents e SET e.x = :cx, e.y = :cy, e.z = :cz, e.yaw = :cyaw WHERE e.id = :c;
      IF (test_position(c, cx, cy, cz) = 0) THEN
      BEGIN
        DELETE FROM pushed p WHERE p.ent = :c;
        CONTINUE;
      END
      -- blocked: everything back, the pusher too
      FOR SELECT p.ent, p.ox, p.oy, p.oz, p.oyaw FROM pushed p WHERE p.ent <> :c INTO r, tx, ty, tz, cyaw DO
      BEGIN
        UPDATE ents e SET e.x = :tx, e.y = :ty, e.z = :tz, e.yaw = :cyaw WHERE e.id = :r;
        EXECUTE PROCEDURE link_ent(r);
      END
      UPDATE player p SET p.mover_yaw = p.mover_yaw - :ay * :movetime WHERE p.id = 1 AND EXISTS (SELECT 1 FROM pushed q WHERE q.ent = :pe AND q.ent <> :c);
      UPDATE ents e SET e.pitch = e.pitch - :ap * :movetime, e.yaw = e.yaw - :ay * :movetime, e.roll = e.roll - :ar * :movetime, e.ltime = e.ltime - :movetime WHERE e.id = :eid;
      EXECUTE PROCEDURE mover_blocked(eid, c);
      EXIT;
    END
    IF (vx = 0 AND vy = 0 AND vz = 0) THEN EXIT;
    UPDATE ents e SET e.ltime = e.ltime - :movetime WHERE e.id = :eid;   -- the translation below adds it back
  END

  mx = vx * movetime; my = vy * movetime; mz = vz * movetime;
  UPDATE ents e SET e.x = e.x + :mx, e.y = e.y + :my, e.z = e.z + :mz, e.ltime = e.ltime + :movetime WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
  DELETE FROM pushed;

  FOR SELECT e.id, e.movetype, e.x, e.y, e.z, e.solid FROM ents e
       WHERE e.id <> :eid AND e.movetype NOT IN (0, 7, 8) AND e.solid <> 0 AND e.health > -1
         AND e.x + e.maxx >= :px + :mnx + MINVALUE(0, :mx) - 1 AND e.x + e.minx <= :px + :mxx + MAXVALUE(0, :mx) + 1
         AND e.y + e.maxy >= :py + :mny + MINVALUE(0, :my) - 1 AND e.y + e.miny <= :py + :mxy + MAXVALUE(0, :my) + 1
         AND e.z + e.maxz >= :pz + :mnz + MINVALUE(0, :mz) - 1 AND e.z + e.minz <= :pz + :mxz + MAXVALUE(0, :mz) + 1
        INTO c, cmt, cx, cy, cz, csolid
  DO
  BEGIN
    -- riding on top, or now inside the pusher?
    IF (test_position(c, cx, cy, cz) = 0 AND NOT (cz + 1 >= pz - mz + mxz - 0.5e0 AND cz - 1 <= pz - mz + mxz + 0.5e0 AND mz <> 0)) THEN
    BEGIN
      IF (cz + (SELECT e.minz FROM ents e WHERE e.id = :c) < pz - mz + mxz - 2 OR cz + (SELECT e.minz FROM ents e WHERE e.id = :c) > pz - mz + mxz + 2) THEN CONTINUE;
      IF (cx + (SELECT e.maxx FROM ents e WHERE e.id = :c) < px + mnx OR cx + (SELECT e.minx FROM ents e WHERE e.id = :c) > px + mxx) THEN CONTINUE;
      IF (cy + (SELECT e.maxy FROM ents e WHERE e.id = :c) < py + mny OR cy + (SELECT e.miny FROM ents e WHERE e.id = :c) > py + mxy) THEN CONTINUE;
      IF (mz < 0) THEN CONTINUE;         -- standing on a sinking plat: gravity brings us down
    END
    INSERT INTO pushed (ent, ox, oy, oz) VALUES (:c, :cx, :cy, :cz);
    UPDATE ents e SET e.x = e.x + :mx, e.y = e.y + :my, e.z = e.z + :mz WHERE e.id = :c;
    IF (test_position(c, cx + mx, cy + my, cz + mz) = 0) THEN
    BEGIN
      EXECUTE PROCEDURE link_ent(c);
      IF (c = pe) THEN UPDATE player p SET p.oldz = p.oldz + :mz WHERE p.id = 1;
      CONTINUE;
    END
    -- if it is ok to leave in the old position, do it
    IF (cmt <> 3) THEN
    BEGIN
      UPDATE ents e SET e.x = :cx, e.y = :cy, e.z = :cz WHERE e.id = :c;
      IF (test_position(c, cx, cy, cz) = 0) THEN
      BEGIN
        DELETE FROM pushed WHERE ent = :c;
        CONTINUE;
      END
    END
    -- corpses and items get crushed out of the way
    IF (csolid IN (0, 1) OR cmt IN (6, 10)) THEN
    BEGIN
      UPDATE ents e SET e.solid = 0, e.minx = 0, e.miny = 0, e.minz = 0, e.maxx = 0, e.maxy = 0, e.maxz = 0 WHERE e.id = :c;
      CONTINUE;
    END
    -- blocked: move everything back
    UPDATE ents e SET e.x = :cx, e.y = :cy, e.z = :cz WHERE e.id = :c;
    UPDATE ents e SET e.x = e.x - :mx, e.y = e.y - :my, e.z = e.z - :mz, e.ltime = e.ltime - :movetime WHERE e.id = :eid;
    EXECUTE PROCEDURE link_ent(eid);
    FOR SELECT p.ent, p.ox, p.oy, p.oz FROM pushed p WHERE p.ent <> :c INTO r, cx, cy, cz DO
    BEGIN
      UPDATE ents e SET e.x = :cx, e.y = :cy, e.z = :cz WHERE e.id = :r;
      EXECUTE PROCEDURE link_ent(r);
    END
    EXECUTE PROCEDURE mover_blocked(eid, c);
    EXIT;
  END
END^

-- func_bobbing: the velocity that puts it on its sine next tic
CREATE OR ALTER PROCEDURE bob_think (eid INTEGER)
AS
DECLARE t DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION; DECLARE hgt DOUBLE PRECISION; DECLARE ph DOUBLE PRECISION; DECLARE s DOUBLE PRECISION;
BEGIN
  t = now_() + 0.05e0;
  SELECT e.speed, e.height, e.phase FROM ents e WHERE e.id = :eid INTO spd, hgt, ph;
  s = hgt * SIN(6.2831853e0 * (t / spd + ph));
  UPDATE ents e SET e.vx = (e.p1x + e.p2x * :s - e.x) / 0.05e0, e.vy = (e.p1y + e.p2y * :s - e.y) / 0.05e0, e.vz = (e.p1z + e.p2z * :s - e.z) / 0.05e0,
         e.think = 'bob_think', e.nextthink = e.ltime + 0.05e0 WHERE e.id = :eid;
END^

-- func_pendulum: the roll that puts it on its swing next tic
CREATE OR ALTER PROCEDURE pendulum_think (eid INTEGER)
AS
DECLARE t DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION; DECLARE per DOUBLE PRECISION; DECLARE ph DOUBLE PRECISION; DECLARE s DOUBLE PRECISION;
BEGIN
  t = now_() + 0.05e0;
  SELECT e.speed, e.height, e.phase FROM ents e WHERE e.id = :eid INTO spd, per, ph;
  s = spd * SIN(6.2831853e0 * (t / per + ph));
  UPDATE ents e SET e.avel_roll = (:s - e.roll) / 0.05e0, e.think = 'pendulum_think', e.nextthink = e.ltime + 0.05e0 WHERE e.id = :eid;
END^

CREATE OR ALTER PROCEDURE run_pushers (dt DOUBLE PRECISION)
AS
DECLARE eid INTEGER; DECLARE lt DOUBLE PRECISION; DECLARE mvt DOUBLE PRECISION; DECLARE done VARCHAR(24); DECLARE movetime DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE think VARCHAR(24); DECLARE nt DOUBLE PRECISION;
BEGIN
  FOR SELECT e.id FROM ents e WHERE e.movetype = 7 AND (e.mv_time IS NOT NULL OR e.think IS NOT NULL OR e.avel_pitch <> 0 OR e.avel_yaw <> 0 OR e.avel_roll <> 0 OR e.vx <> 0 OR e.vy <> 0 OR e.vz <> 0) INTO eid DO
  BEGIN
    SELECT e.ltime, e.mv_time, e.mv_done, e.dstx, e.dsty, e.dstz, e.think, e.nextthink FROM ents e WHERE e.id = :eid INTO lt, mvt, done, tx, ty, tz, think, nt;
    IF (mvt IS NOT NULL) THEN
    BEGIN
      movetime = MINVALUE(dt, MAXVALUE(0, mvt - lt));
      IF (movetime > 0) THEN EXECUTE PROCEDURE push_move(eid, movetime);
      ELSE UPDATE ents e SET e.ltime = e.ltime + :dt WHERE e.id = :eid;
      SELECT e.ltime, e.mv_time FROM ents e WHERE e.id = :eid INTO lt, mvt;
      IF (mvt IS NOT NULL AND lt >= mvt - 1e-6) THEN
      BEGIN
        -- Reached_*: snap to the destination and run the think
        UPDATE ents e SET e.x = :tx, e.y = :ty, e.z = :tz, e.vx = 0, e.vy = 0, e.vz = 0, e.mv_time = NULL, e.mv_done = NULL WHERE e.id = :eid;
        EXECUTE PROCEDURE link_ent(eid);
        EXECUTE PROCEDURE run_think(eid, done);
      END
    END
    ELSE
    BEGIN
      -- rotating, bobbing and swinging things move every tic; the rest just wait for their thinks
      IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND (e.avel_pitch <> 0 OR e.avel_yaw <> 0 OR e.avel_roll <> 0 OR e.vx <> 0 OR e.vy <> 0 OR e.vz <> 0))) THEN EXECUTE PROCEDURE push_move(eid, dt);
      ELSE UPDATE ents e SET e.ltime = e.ltime + :dt WHERE e.id = :eid;
      IF (think IS NOT NULL AND nt IS NOT NULL AND nt <= lt + dt + 1e-6) THEN
      BEGIN
        UPDATE ents e SET e.think = NULL, e.nextthink = NULL WHERE e.id = :eid;
        EXECUTE PROCEDURE run_think(eid, think);
      END
    END
  END
END^

-- dispatch a think by name
CREATE OR ALTER PROCEDURE run_think (eid INTEGER, think VARCHAR(24))
AS
BEGIN
  IF (think IS NULL) THEN EXIT;
  IF (think = 'door_go_down') THEN EXECUTE PROCEDURE door_go_down(eid);
  ELSE IF (think = 'door_go_up') THEN EXECUTE PROCEDURE door_go_up(eid, player_ent());
  ELSE IF (think = 'door_hit_top') THEN EXECUTE PROCEDURE door_hit_top(eid);
  ELSE IF (think = 'door_hit_bottom') THEN EXECUTE PROCEDURE door_hit_bottom(eid);
  ELSE IF (think = 'plat_go_down') THEN EXECUTE PROCEDURE plat_go_down(eid);
  ELSE IF (think = 'plat_go_up') THEN EXECUTE PROCEDURE plat_go_up(eid);
  ELSE IF (think = 'plat_hit_top') THEN EXECUTE PROCEDURE plat_hit_top(eid);
  ELSE IF (think = 'plat_hit_bottom') THEN EXECUTE PROCEDURE plat_hit_bottom(eid);
  ELSE IF (think = 'button_wait') THEN EXECUTE PROCEDURE button_wait(eid);
  ELSE IF (think = 'button_return') THEN EXECUTE PROCEDURE button_return(eid);
  ELSE IF (think = 'button_done') THEN EXECUTE PROCEDURE button_done(eid);
  ELSE IF (think = 'train_next') THEN EXECUTE PROCEDURE train_next(eid);
  ELSE IF (think = 'train_wait') THEN EXECUTE PROCEDURE train_wait(eid);
  ELSE IF (think = 'train_find') THEN EXECUTE PROCEDURE train_find(eid);
  ELSE IF (think = 'bob_think') THEN EXECUTE PROCEDURE bob_think(eid);
  ELSE IF (think = 'pendulum_think') THEN EXECUTE PROCEDURE pendulum_think(eid);
  ELSE IF (think = 'timer_think') THEN EXECUTE PROCEDURE timer_think(eid);
  ELSE IF (think = 'speaker_think') THEN EXECUTE PROCEDURE speaker_think(eid);
  ELSE IF (think = 'always_fire') THEN EXECUTE PROCEDURE always_fire(eid);
  ELSE IF (think = 'multi_wait') THEN EXECUTE PROCEDURE multi_wait(eid);
  ELSE IF (think = 'delayed_use') THEN EXECUTE PROCEDURE delayed_use(eid);
  ELSE IF (think = 'missile_explode') THEN EXECUTE PROCEDURE missile_explode(eid);
  ELSE IF (think = 'item_respawn') THEN EXECUTE PROCEDURE item_respawn(eid);
  ELSE IF (think = 'remove') THEN DELETE FROM ents e WHERE e.id = :eid;
  ELSE IF (think = 'bot_think') THEN EXECUTE PROCEDURE bot_think(eid);
END^

-- G_RunFrame's physics for everything but the player and the pushers
CREATE OR ALTER PROCEDURE run_physics (dt DOUBLE PRECISION)
AS
DECLARE eid INTEGER; DECLARE mt SMALLINT; DECLARE think VARCHAR(24); DECLARE t DOUBLE PRECISION;
DECLARE flags INTEGER; DECLARE wl SMALLINT; DECLARE tid INTEGER; DECLARE vz DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION; DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION; DECLARE ru DOUBLE PRECISION;
BEGIN
  t = now_();
  -- thinks that are due (non-pushers)
  FOR SELECT e.id, e.think FROM ents e WHERE e.nextthink IS NOT NULL AND e.nextthink <= :t + 1e-6 AND e.movetype <> 7 AND e.think IS NOT NULL ORDER BY e.id INTO eid, think DO
  BEGIN
    UPDATE ents e SET e.nextthink = NULL WHERE e.id = :eid AND e.think = :think AND e.think NOT IN ('bot_think');
    EXECUTE PROCEDURE run_think(eid, think);
  END
  -- missiles, grenades, gibs, corpses; and bots that are not on the ground fall
  FOR SELECT e.id, e.movetype, e.flags, e.vz, e.x, e.y, e.z FROM ents e WHERE e.movetype IN (6, 9, 10) OR (e.movetype = 4 AND e.health > 0 AND (BIN_AND(e.flags, 512) = 0 OR e.vz <> 0 OR e.vx <> 0 OR e.vy <> 0))
        INTO eid, mt, flags, vz, px, py, pz DO
  BEGIN
    IF (mt = 4) THEN
    BEGIN
      -- a bot in the air: gravity and a slide, until it lands
      -- (moved by the tic's average vertical speed, then given the tic's end: gravity as PM_SlideMove integrates it)
      SELECT r.rj_x, r.rj_y, r.rj_z, r.rj_until FROM bot_routes r WHERE r.ent_id = :eid INTO rx, ry, rz, ru;
      IF (ru > t) THEN EXECUTE PROCEDURE bot_air_steer(eid, rx, ry, rz, dt);
      UPDATE ents e SET e.vz = e.vz - (SELECT g.gravity FROM game g WHERE g.id = 1) * :dt / 2, e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
      EXECUTE PROCEDURE fly_move(eid, dt) RETURNING_VALUES wl, tid;
      IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid)) THEN CONTINUE;
      UPDATE ents e SET e.vz = e.vz - (SELECT g.gravity FROM game g WHERE g.id = 1) * :dt / 2 WHERE e.id = :eid AND BIN_AND(e.flags, 512) = 0;
      -- landed (PM_CrashLand): from the tic's start, the speed at the contact
      IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND BIN_AND(e.flags, 512) <> 0) AND BIN_AND(flags, 512) = 0) THEN
        EXECUTE PROCEDURE crash_land(eid, vz, (SELECT e.z FROM ents e WHERE e.id = :eid) - pz, (SELECT g.gravity FROM game g WHERE g.id = 1), 0,
                                     (SELECT e.waterlevel FROM ents e WHERE e.id = :eid), 0);
      IF (wl = 3) THEN UPDATE ents e SET e.flags = BIN_OR(e.flags, 512) WHERE e.id = :eid;   -- could not move at all: it is standing in the floor
      IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND BIN_AND(e.flags, 512) <> 0)) THEN
      BEGIN
        -- landed: shed the velocity (knocks fade on the ground), the legs land
        UPDATE ents e SET e.vx = e.vx * 0.5e0, e.vy = e.vy * 0.5e0, e.vz = 0 WHERE e.id = :eid;
        IF (ru > t) THEN UPDATE bot_routes r SET r.rj_until = 0 WHERE r.ent_id = :eid;
        UPDATE ents e SET e.vx = 0, e.vy = 0 WHERE e.id = :eid AND ABS(e.vx) + ABS(e.vy) < 30;
      END
      EXECUTE PROCEDURE link_ent(eid);
      CONTINUE;
    END
    IF (BIN_AND(flags, 512) <> 0 AND mt <> 9) THEN CONTINUE;      -- resting
    EXECUTE PROCEDURE toss_move(eid, dt);
  END
  -- items in lava or slime are not there; corpses in them burn away
  -- (nothing to do: Q3 removes things that fall into NODROP; the maps' hurt triggers do the rest)
END^

-- ── the tic ─────────────────────────────────────────────────────────────
CREATE OR ALTER PROCEDURE q3_tic (
  tics INTEGER, fwd DOUBLE PRECISION, side DOUBLE PRECISION, yaw_d DOUBLE PRECISION, pitch_d DOUBLE PRECISION,
  fire SMALLINT, jump SMALLINT, run SMALLINT, imp SMALLINT)
RETURNS (
  tic INTEGER, time_ DOUBLE PRECISION, health INTEGER, max_health INTEGER, armor INTEGER,
  bullets INTEGER, shells INTEGER, grenades INTEGER, rockets INTEGER, lightning INTEGER, slugs INTEGER, cells INTEGER, bfg INTEGER,
  weapons INTEGER, weapon INTEGER, pending_weapon INTEGER, weaponstate SMALLINT, weapon_time DOUBLE PRECISION, attack_start DOUBLE PRECISION, attack_finished DOUBLE PRECISION,
  px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION, yaw DOUBLE PRECISION, pitch DOUBLE PRECISION,
  view_z DOUBLE PRECISION, punch DOUBLE PRECISION,
  msg VARCHAR(200), cprint VARCHAR(400), dmg_take INTEGER, dmg_save INTEGER, dmg_time DOUBLE PRECISION, dmg_x DOUBLE PRECISION, dmg_y DOUBLE PRECISION, bonus_time DOUBLE PRECISION,
  dead SMALLINT, exit_kind SMALLINT, frags INTEGER, deaths INTEGER, waterlevel SMALLINT, watertype INTEGER, map_name VARCHAR(32),
  level_msg VARCHAR(200), quad DOUBLE PRECISION, haste DOUBLE PRECISION, invis DOUBLE PRECISION, regen DOUBLE PRECISION, enviro DOUBLE PRECISION, flight DOUBLE PRECISION, holdable SMALLINT,
  leaf INTEGER, cluster INTEGER, match_over SMALLINT, winner VARCHAR(32), land_time DOUBLE PRECISION, onground SMALLINT, move_speed DOUBLE PRECISION, weapon_sound SMALLINT, lead INTEGER, ducked SMALLINT,
  fraglimit INTEGER, timelimit INTEGER, over_time DOUBLE PRECISION, next_map VARCHAR(64),
  dmg_z DOUBLE PRECISION, dmg_world SMALLINT, land_change DOUBLE PRECISION, vx DOUBLE PRECISION, vy DOUBLE PRECISION,
  warmup_end DOUBLE PRECISION, award SMALLINT, award_time DOUBLE PRECISION, n_excellent SMALLINT, n_impressive SMALLINT, n_gauntlet SMALLINT,
  spectator SMALLINT, follow_name VARCHAR(32), mover_yaw DOUBLE PRECISION,
  gametype SMALLINT, red_score INTEGER, blue_score INTEGER, team SMALLINT)
AS
DECLARE i INTEGER = 0;
BEGIN
  SELECT g.tic FROM game g WHERE g.id = 1 INTO tic;
  UPDATE player p SET p.mover_yaw = 0 WHERE p.id = 1 AND p.mover_yaw <> 0;
  DELETE FROM sound_events s WHERE s.tic < :tic - 40;
  DELETE FROM fx_events f WHERE f.tic < :tic - 40;
  WHILE (i < tics) DO
  BEGIN
    UPDATE game g SET g.tic = g.tic + 1, g.time_ = g.time_ + 0.05e0 WHERE g.id = 1;
    EXECUTE PROCEDURE player_think(0.05e0, fwd, side, yaw_d / tics, pitch_d / tics, fire, jump, run, IIF(i = 0, imp, 0));
    EXECUTE PROCEDURE run_pushers(0.05e0);
    EXECUTE PROCEDURE run_physics(0.05e0);
    EXECUTE PROCEDURE check_exit_rules;
    i = i + 1;
  END
  SELECT g.tic, g.time_, e.health, e.max_health, IIF(p.follow_id IS NULL, p.armor, e.armor), p.bullets, p.shells, p.grenades, p.rockets, p.lightning, p.slugs, p.cells, p.bfg,
         p.weapons, IIF(p.follow_id IS NULL, p.weapon, e.weapon), p.pending_weapon, p.weaponstate, p.weapon_time, p.attack_start, p.attack_finished,
         e.x, e.y, e.z, e.yaw, IIF(p.follow_id IS NULL, p.pitch + p.punchangle, e.pitch), e.z + IIF(p.follow_id IS NULL, p.view_ofs - p.stepz, e.viewheight), p.punchangle,
         IIF(p.msg_time > g.time_, p.msg, NULL), IIF(p.cprint_time > g.time_, p.cprint, NULL),
         p.dmg_take, p.dmg_save, p.dmg_time, p.dmg_x, p.dmg_y, p.bonus_time, e.deadflag, g.exit_kind, p.frags, p.deaths, e.waterlevel, e.watertype, g.map_name, g.level_msg,
         MAXVALUE(0, p.quad_finished - g.time_), MAXVALUE(0, p.haste_finished - g.time_), MAXVALUE(0, p.invis_finished - g.time_), MAXVALUE(0, p.regen_finished - g.time_),
         MAXVALUE(0, p.enviro_finished - g.time_), MAXVALUE(0, p.flight_finished - g.time_), p.holdable,
         e.leaf, e.cluster, g.match_over, g.winner, p.land_time, IIF(p.follow_id IS NULL, p.onground, IIF(BIN_AND(e.flags, 512) <> 0, 1, 0)), p.move_speed, p.weapon_sound,
         (SELECT COALESCE(MAX(b.frags), 0) FROM ents b WHERE b.classname = 'bot'), p.ducked, g.fraglimit, g.timelimit, g.over_time, g.next_map,
         p.dmg_z, p.dmg_world, p.land_change, e.vx, e.vy, g.warmup_end, e.award, e.award_time, e.n_excellent, e.n_impressive, e.n_gauntlet, p.spectator, IIF(p.follow_id IS NULL, NULL, e.bot),
         p.mover_yaw / :tics, g.gametype, g.red_score, g.blue_score, (SELECT o.pteam FROM ents o WHERE o.id = p.ent_id)
    FROM game g CROSS JOIN player p JOIN ents e ON e.id = COALESCE(p.follow_id, p.ent_id)   -- following: the one followed
   WHERE g.id = 1 AND p.id = 1
    INTO tic, time_, health, max_health, armor, bullets, shells, grenades, rockets, lightning, slugs, cells, bfg,
         weapons, weapon, pending_weapon, weaponstate, weapon_time, attack_start, attack_finished,
         px, py, pz, yaw, pitch, view_z, punch, msg, cprint, dmg_take, dmg_save, dmg_time, dmg_x, dmg_y, bonus_time, dead, exit_kind, frags, deaths, waterlevel, watertype, map_name, level_msg,
         quad, haste, invis, regen, enviro, flight, holdable, leaf, cluster, match_over, winner, land_time, onground, move_speed, weapon_sound, lead, ducked, fraglimit, timelimit, over_time, next_map, dmg_z, dmg_world, land_change, vx, vy, warmup_end, award, award_time, n_excellent, n_impressive, n_gauntlet, spectator, follow_name, mover_yaw, gametype, red_score, blue_score, team;
  UPDATE player p SET p.dmg_take = 0, p.dmg_save = 0 WHERE p.id = 1 AND p.dmg_time < :time_ - 0.05e0;
  SUSPEND;
END^

-- the scoreboard: the player and the bots by frags
CREATE OR ALTER PROCEDURE scoreboard
RETURNS (name VARCHAR(32), frags INTEGER, deaths INTEGER, is_player SMALLINT, team SMALLINT)
AS
BEGIN
  FOR SELECT x.name, x.frags, x.deaths, x.is_player, x.team FROM (
        SELECT 'You' AS name, p.frags, p.deaths, 1 AS is_player, COALESCE((SELECT e.pteam FROM ents e WHERE e.id = p.ent_id), 0) AS team FROM player p WHERE p.id = 1
        UNION ALL
        SELECT e.bot, e.frags, e.deaths, 0, e.pteam FROM ents e WHERE e.classname = 'bot') x
      ORDER BY x.team, x.frags DESC, x.deaths INTO name, frags, deaths, is_player, team DO SUSPEND;
END^

-- G_InitGame + ClientBegin: the map's entities, the player and the bots
CREATE OR ALTER PROCEDURE init_map (map_name VARCHAR(32), world_model INTEGER, skill SMALLINT, new_game SMALLINT, num_bots INTEGER,
                                    fraglimit INTEGER DEFAULT 20, timelimit INTEGER DEFAULT 0, warmup DOUBLE PRECISION DEFAULT 0,
                                    gametype SMALLINT DEFAULT 0, team SMALLINT DEFAULT 0)
AS
DECLARE pe INTEGER; DECLARE b VARCHAR(16); DECLARE i INTEGER = 0; DECLARE n INTEGER; DECLARE skyname VARCHAR(64);
BEGIN
  UPDATE game g SET g.tic = 0, g.time_ = 0, g.map_name = :map_name, g.next_map = NULL, g.exit_kind = 0, g.skill = :skill, g.world_model = :world_model,
         g.level_msg = NULL, g.gravity = 800, g.match_over = 0, g.winner = NULL, g.over_time = 0, g.num_bots = :num_bots,
         g.fraglimit = COALESCE(:fraglimit, 20), g.timelimit = COALESCE(:timelimit, 0), g.time_warnings = 0,
         g.warmup_end = COALESCE(:warmup, 0), g.warmup_said = IIF(COALESCE(:warmup, 0) > 0, 4, 0),
         g.has_water = IIF(EXISTS (SELECT 1 FROM brushes b WHERE BIN_AND(b.contents, 32) <> 0), 1, 0),
         g.gametype = IIF(COALESCE(:gametype, 0) >= 3, 3, 0), g.red_score = 0, g.blue_score = 0, g.team_lead = 0 WHERE g.id = 1;
  -- the sky: the first sky shader the map's faces use
  SELECT FIRST 1 t.name FROM textures t WHERE BIN_AND(t.flags, 4) <> 0 INTO skyname;
  UPDATE game g SET g.sky = :skyname WHERE g.id = 1;
  UPDATE bot_defs b SET b.skill = :skill;
  EXECUTE PROCEDURE spawn_map_ents;
  EXECUTE PROCEDURE build_waypoints;
  DELETE FROM bot_routes;
  -- the player
  EXECUTE PROCEDURE spawn_ent('player', 0, 0, 0) RETURNING_VALUES pe;
  UPDATE ents e SET e.pmodel = 'sarge', e.pskin = 'default', e.viewheight = 26 WHERE e.id = :pe;
  -- a team game: the team asked for, else PickTeam's, and its colours
  IF (COALESCE(gametype, 0) >= 3) THEN
    UPDATE ents e SET e.pteam = IIF(:team IN (1, 2), :team, pick_team()) WHERE e.id = :pe;
  UPDATE ents e SET e.pskin = IIF(e.pteam = 1, 'red', 'blue') WHERE e.id = :pe AND e.pteam > 0;
  UPDATE player p SET p.ent_id = :pe, p.frags = 0, p.deaths = 0, p.lead_state = 1, p.last_kill = -10, p.msg = NULL, p.msg_time = 0, p.cprint = NULL, p.cprint_time = 0, p.step_time = 0, p.land_time = -10 WHERE p.id = 1;
  EXECUTE PROCEDURE player_respawn;
  UPDATE ents e SET e.teleport_time = 0 WHERE e.id = :pe;
  IF ((SELECT p.spectator FROM player p WHERE p.id = 1) = 1) THEN EXECUTE PROCEDURE make_spectator;   -- a spectator stays one
  -- the bots, in the order of bot_defs
  SELECT COUNT(*) FROM bot_defs INTO n;
  WHILE (i < num_bots AND i < n) DO
  BEGIN
    SELECT FIRST 1 SKIP (:i) d.name FROM bot_defs d ORDER BY d.name INTO b;
    EXECUTE PROCEDURE spawn_bot(b) RETURNING_VALUES pe;
    i = i + 1;
  END
  -- the bots' greetings (BotChat_StartLevel)
  FOR SELECT e.id FROM ents e WHERE e.classname = 'bot' ORDER BY e.id INTO pe DO EXECUTE PROCEDURE bot_chat_event(pe, 'level_start', NULL, 0);
  -- the level name, and "fight"
  UPDATE player p SET p.cprint = (SELECT g.level_msg FROM game g WHERE g.id = 1), p.cprint_time = 3 WHERE p.id = 1;
  EXECUTE PROCEDURE snd_local(IIF(COALESCE(warmup, 0) > 0, 'sound/feedback/prepare.wav', 'sound/feedback/fight.wav'));   -- "prepare to fight", or straight in
END^

SET TERM ; ^
