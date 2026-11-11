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

-- whether a player or bot plays on team `tm` (1 red, 2 blue): a spectating player does not, nor a
-- tournament's waiting bot (BotSameTeam, and the configstrings BotTeamOrders counts)
CREATE OR ALTER FUNCTION team_member (eid INTEGER, tm SMALLINT) RETURNS SMALLINT
AS
BEGIN
  IF (tm IS NULL OR tm NOT IN (1, 2)) THEN RETURN 0;
  RETURN IIF(EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.classname IN ('player', 'bot') AND e.pteam = :tm AND e.queued = 0
                       AND NOT (e.classname = 'player' AND (SELECT p.spectator FROM player p WHERE p.id = 1) = 1)), 1, 0);
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
-- tildes (words kept from the synonyms) and the colour codes taken out; with the talk sound. Returns
-- nothing when the bot's file has no line of the type, as botlib does. `to_` is who hears it (BotEnterChat):
-- 0 everyone ("Name: …"), -1 the team ("(Name): …", CHAT_TEAM), an entity that one alone ("[Name]: …",
-- CHAT_TELL); the player sees it when it is one of them. `chatted` 1: a BotChat_* line, which counts for
-- the 25 seconds between them (the team's orders and answers do not)
CREATE OR ALTER PROCEDURE bot_say (eid INTEGER, ctype VARCHAR(32), v0 VARCHAR(40), v1 VARCHAR(40), v2 VARCHAR(40), v3 VARCHAR(40), v4 VARCHAR(64), v5 VARCHAR(40),
                                   to_ INTEGER DEFAULT 0, chatted SMALLINT DEFAULT 1)
AS
DECLARE bname VARCHAR(16); DECLARE n INTEGER; DECLARE k INTEGER; DECLARE msg VARCHAR(2000); DECLARE pick VARCHAR(600);
DECLARE p INTEGER; DECLARE q INTEGER; DECLARE rname VARCHAR(40); DECLARE guard INTEGER = 0; DECLARE heard SMALLINT = 1;
BEGIN
  SELECT e.bot FROM ents e WHERE e.id = :eid INTO bname;
  IF (bname IS NULL) THEN EXIT;
  IF (to_ = -1) THEN
    heard = IIF(EXISTS (SELECT 1 FROM ents o JOIN ents e ON e.id = :eid WHERE o.id = player_ent() AND o.pteam = e.pteam AND o.pteam > 0
                                                                      AND (SELECT p.spectator FROM player p WHERE p.id = 1) = 0), 1, 0);
  ELSE IF (to_ > 0) THEN heard = IIF(to_ = player_ent(), 1, 0);
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
  IF (heard = 1) THEN
  BEGIN
    EXECUTE PROCEDURE say(SUBSTRING(TRIM(CASE WHEN to_ = -1 THEN '(' || bname || ')' WHEN to_ > 0 THEN '[' || bname || ']' ELSE bname END) || ': ' || TRIM(msg) FROM 1 FOR 200));
    EXECUTE PROCEDURE snd_local('sound/player/talk.wav');
  END
  IF (chatted = 1) THEN UPDATE ents e SET e.last_chat = now_() WHERE e.id = :eid;
END^

-- the BotChat_* functions of ai_chat.c: when a bot says what, with which variables, how likely by its
-- character, and no more than once every 25 seconds (TIME_BETWEENCHATTING) except at the start and
-- the end of a level. `other` is the one the event is about (the killer, the victim, the shooter)
CREATE OR ALTER PROCEDURE bot_chat_event (eid INTEGER, ev VARCHAR(16), other INTEGER, mod_ SMALLINT)
AS
DECLARE t DOUBLE PRECISION; DECLARE lc DOUBLE PRECISION; DECLARE ctype VARCHAR(32); DECLARE me VARCHAR(32); DECLARE mine INTEGER;
DECLARE v0 VARCHAR(40); DECLARE v1 VARCHAR(40); DECLARE v3 VARCHAR(40); DECLARE v4 VARCHAR(64); DECLARE v5 VARCHAR(40);
DECLARE pf INTEGER; DECLARE top INTEGER; DECLARE low INTEGER; DECLARE first_ VARCHAR(32); DECLARE last_ VARCHAR(32); DECLARE to_ INTEGER = 0;
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
  ELSE IF (ev = 'game_exit') THEN
  BEGIN
    -- BotChat_ExitGame, as it leaves
    IF (RAND() > chat_char(eid, 'enterexitgame')) THEN EXIT;
    ctype = 'game_exit'; v0 = me; v1 = chat_opponent(eid);
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
      ELSE IF (team_member(other, (SELECT e.pteam FROM ents e WHERE e.id = :eid)) = 1) THEN BEGIN ctype = 'death_teammate'; v0 = chat_name(other); to_ = -1; END
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
      IF (team_member(other, (SELECT e.pteam FROM ents e WHERE e.id = :eid)) = 1) THEN BEGIN ctype = 'kill_teammate'; to_ = -1; END
      ELSE ctype = TRIM(CASE WHEN mod_ = 1 THEN 'kill_gauntlet' WHEN mod_ = 17 THEN 'kill_rail' WHEN mod_ = 10 THEN 'kill_telefrag'
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
  EXECUTE PROCEDURE bot_say(eid, ctype, v0, v1, NULL, v3, v4, v5, to_);
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
-- BotChangeViewAngles: the view turns toward where the bot wants to look, by the view factor's share of the
-- angle left (a smooth slowdown) and no more than the turning a think allows (yaw_speed: the character's
-- VIEW_MAXCHANGE, 240 a second at least, a tenth of it a think); the pitch the same way toward ideal_pitch, or
-- level out of a fight
CREATE OR ALTER PROCEDURE change_yaw (eid INTEGER)
AS
DECLARE cur DOUBLE PRECISION; DECLARE ideal DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION; DECLARE mv DOUBLE PRECISION;
DECLARE vf DOUBLE PRECISION; DECLARE pc DOUBLE PRECISION; DECLARE pi_ DOUBLE PRECISION; DECLARE pm DOUBLE PRECISION;
BEGIN
  SELECT anglemod(e.yaw), e.ideal_yaw, e.yaw_speed, e.view_factor, e.pitch, COALESCE(e.ideal_pitch, 0) FROM ents e WHERE e.id = :eid INTO cur, ideal, spd, vf, pc, pi_;
  mv = ideal - cur;
  IF (ideal > cur) THEN BEGIN IF (mv >= 180) THEN mv = mv - 360; END
  ELSE BEGIN IF (mv <= -180) THEN mv = mv + 360; END
  mv = mv * vf;
  IF (mv > 0) THEN BEGIN IF (mv > spd) THEN mv = spd; END
  ELSE BEGIN IF (mv < -spd) THEN mv = -spd; END
  pm = (pi_ - COALESCE(pc, 0)) * vf;
  IF (pm > spd) THEN pm = spd; ELSE IF (pm < -spd) THEN pm = -spd;
  IF (mv <> 0 OR pm <> 0) THEN UPDATE ents e SET e.yaw = anglemod(:cur + :mv), e.pitch = COALESCE(e.pitch, 0) + :pm WHERE e.id = :eid;
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
-- and a character that likes weapon jumping (0.5 or more), with three rockets at least
CREATE OR ALTER FUNCTION bot_can_rj (eid INTEGER) RETURNS SMALLINT
AS
DECLARE w INTEGER; DECLARE hp INTEGER; DECLARE av INTEGER; DECLARE qf DOUBLE PRECISION;
BEGIN
  SELECT e.weapons, e.health, e.armor, e.quad_finished FROM ents e WHERE e.id = :eid INTO w, hp, av, qf;
  IF (w IS NULL OR BIN_AND(w, 16) = 0 OR ent_ammo(eid, 5) < 3 OR hp < 60 OR (hp < 90 AND COALESCE(av, 0) < 40) OR qf > now_()) THEN RETURN 0;
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
         e.flags = BIN_AND(e.flags, BIN_NOT(512)), e.attack_finished = MAXVALUE(e.attack_finished, now_() + 0.8e0) WHERE e.id = :eid;
  EXECUTE PROCEDURE eye_of(eid) RETURNING_VALUES ex, ey, ez, fx, fy, fz;
  EXECUTE PROCEDURE fire_weapon(eid, 16, ex, ey, ez - 14, 0, 0, -1, 1);
  EXECUTE PROCEDURE bot_add_ammo(eid, 5, -1);
  EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || COALESCE(pm, 'sarge') || '/jump1.wav', 1, 1);
  EXECUTE PROCEDURE set_anims(eid, 18, 7);
  UPDATE bot_routes r SET r.rj_x = :tx, r.rj_y = :ty, r.rj_z = :tz, r.rj_until = now_() + 3, r.rj_hold = NULL WHERE r.ent_id = :eid;
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

-- the func_bobbing an entity stands on, or NULL
CREATE OR ALTER FUNCTION bob_under (eid INTEGER) RETURNS INTEGER
AS
DECLARE b INTEGER;
BEGIN
  SELECT FIRST 1 p.id FROM ents p JOIN ents e ON e.id = :eid
   WHERE p.classname = 'func_bobbing' AND ABS(e.x - p.x - (p.minx + p.maxx) / 2) < (p.maxx - p.minx) / 2 + 15
     AND ABS(e.y - p.y - (p.miny + p.maxy) / 2) < (p.maxy - p.miny) / 2 + 15 AND ABS(e.z + e.minz - p.z - p.maxz) < 12 INTO b;
  RETURN b;
END^

-- a step toward (tx, ty); where it will not leave the edge of a func_bobbing (or onto one
-- it, from within 96), off at run speed with a hop of 100 as a player runs across (6 over the lip 50 on: a slider flush with
-- the floor would catch a flat run on its side); run_physics flies it
CREATE OR ALTER FUNCTION bob_step (eid INTEGER, tx DOUBLE PRECISION, ty DOUBLE PRECISION, dist DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE moved SMALLINT;
BEGIN
  SELECT e.x, e.y FROM ents e WHERE e.id = :eid INTO x, y;
  yaw = vectoyaw(tx - x, ty - y);
  UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
  moved = step_direction(eid, yaw, MINVALUE(dist, vlen(tx - x, ty - y, 0)));
  IF (moved = 0) THEN
  BEGIN
    UPDATE ents e SET e.vx = COS(:yaw * 0.0174532925e0) * 320, e.vy = SIN(:yaw * 0.0174532925e0) * 320, e.vz = 100,
           e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
    moved = 1;
  END
  RETURN moved;
END^

-- where a bot goes to set off a button or a trigger (BotGetActivateGoal, BotFuncButtonActivateGoal): before a
-- button on a wall, a player's box (and one unit) out from its face along the way it is pushed (one to shoot, 64 more), on the floor there; on a button in the
-- floor, or in a trigger, its middle. (cx, cy, cz) is the middle, which the bot walks into from there
CREATE OR ALTER PROCEDURE bot_act_spot (act INTEGER)
RETURNS (sx DOUBLE PRECISION, sy DOUBLE PRECISION, sz DOUBLE PRECISION, cx DOUBLE PRECISION, cy DOUBLE PRECISION, cz DOUBLE PRECISION)
AS
DECLARE cls VARCHAR(40); DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE l DOUBLE PRECISION;
DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE f DOUBLE PRECISION;
BEGIN
  SELECT e.classname, e.x + (e.minx + e.maxx) / 2, e.y + (e.miny + e.maxy) / 2, e.z + (e.minz + e.maxz) / 2, e.p2x - e.p1x, e.p2y - e.p1y, e.p2z - e.p1z,
         (e.maxx - e.minx) / 2, (e.maxy - e.miny) / 2
    FROM ents e WHERE e.id = :act INTO cls, cx, cy, cz, dx, dy, dz, hx, hy;
  IF (cls IS NULL) THEN EXIT;
  sx = cx; sy = cy;
  l = vlen(dx, dy, dz);
  IF (cls = 'func_button' AND l > 1e-3 AND ABS(dz) / l < 0.7e0) THEN
  BEGIN
    dx = dx / l; dy = dy / l;
    sx = cx - dx * (ABS(dx) * hx + ABS(dy) * hy + 16 + IIF(EXISTS (SELECT 1 FROM ents b WHERE b.id = :act AND b.takedamage > 0), 64, 0));
    sy = cy - dy * (ABS(dx) * hx + ABS(dy) * hy + 16 + IIF(EXISTS (SELECT 1 FROM ents b WHERE b.id = :act AND b.takedamage > 0), 64, 0));
  END
  f = wp_floor(sx, sy, cz, 300);
  sz = COALESCE(f + 25, cz);
END^

-- (declared here, defined with the learned fight moves before the bot's think)
CREATE OR ALTER PROCEDURE bot_rl_end (eid INTEGER) AS BEGIN END^

-- (declared here, defined with the bot's aim below: the way to a button shoots one that wants shooting)
CREATE OR ALTER PROCEDURE bot_w_shot (eid INTEGER) AS BEGIN END^
CREATE OR ALTER PROCEDURE bot_fire (eid INTEGER) AS BEGIN END^

-- (declared here: it calls itself, for the way to a button)
CREATE OR ALTER PROCEDURE bot_follow_route (eid INTEGER, target INTEGER, dist DOUBLE PRECISION)
RETURNS (moved SMALLINT)
AS
BEGIN
  moved = 0;
END^

CREATE OR ALTER PROCEDURE bot_follow_route (eid INTEGER, target INTEGER, dist DOUBLE PRECISION)
RETURNS (moved SMALLINT)
AS
DECLARE act INTEGER; DECLARE act_t DOUBLE PRECISION; DECLARE dr INTEGER; DECLARE da INTEGER;
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE fx DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE hz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
DECLARE cx DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE cz DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION; DECLARE nk SMALLINT;
DECLARE path VARCHAR(400); DECLARE s VARCHAR(400); DECLARE cut VARCHAR(400); DECLARE built DOUBLE PRECISION; DECLARE rtarget INTEGER;
DECLARE dst INTEGER; DECLARE src INTEGER; DECLARE odst INTEGER; DECLARE nid INTEGER; DECLARE t DOUBLE PRECISION; DECLARE p INTEGER; DECLARE i INTEGER;
DECLARE fails SMALLINT; DECLARE yaw DOUBLE PRECISION; DECLARE reach DOUBLE PRECISION; DECLARE prog_d DOUBLE PRECISION; DECLARE prog_t DOUBLE PRECISION; DECLARE stuck SMALLINT = 0;
DECLARE last_n INTEGER; DECLARE cutn INTEGER; DECLARE rpath VARCHAR(400); DECLARE lx DOUBLE PRECISION; DECLARE ly DOUBLE PRECISION; DECLARE lz DOUBLE PRECISION;
DECLARE p2 INTEGER; DECLARE n2 INTEGER;
DECLARE plat INTEGER; DECLARE pst SMALLINT; DECLARE ptop DOUBLE PRECISION; DECLARE pcx DOUBLE PRECISION; DECLARE pcy DOUBLE PRECISION;
DECLARE phx DOUBLE PRECISION; DECLARE phy DOUBLE PRECISION; DECLARE onplat SMALLINT; DECLARE riding SMALLINT; DECLARE bob INTEGER; DECLARE nxt INTEGER;
BEGIN
  moved = 0;
  t = now_();
  SELECT e.x, e.y, e.z, e.act_id, e.act_until FROM ents e WHERE e.id = :eid INTO x, y, z, act, act_t;
  -- an activate goal (BotGoForActivateGoal): to the button first, until the door it opens is open (or 20 s
  -- went by: then no other for 10, BotIsGoingToActivateEntity's memory)
  IF (act IS NOT NULL AND target IS DISTINCT FROM act) THEN
  BEGIN
    IF (act_t < t) THEN UPDATE ents e SET e.act_id = NULL, e.act_until = :t + 10 WHERE e.id = :eid;
    ELSE IF (NOT EXISTS (SELECT 1 FROM ents a JOIN ents d ON d.targetname = a.target AND d.classname = 'func_door' AND d.mv_state IN (1, 3) WHERE a.id = :act)) THEN
      UPDATE ents e SET e.act_id = NULL, e.act_until = NULL, e.ideal_pitch = NULL WHERE e.id = :eid;
    ELSE
    BEGIN
      EXECUTE PROCEDURE bot_follow_route(eid, act, dist) RETURNING_VALUES moved;
      EXIT;
    END
    act = NULL;
  END
  IF (act IS NOT NULL AND target = act) THEN EXECUTE PROCEDURE bot_act_spot(target) RETURNING_VALUES tx, ty, tz, cx, cy, cz;
  ELSE SELECT g.x, g.y, g.z FROM ents g WHERE g.id = :target INTO tx, ty, tz;
  IF (tx IS NULL OR x IS NULL) THEN EXIT;
  -- a button to be shot (the activate goal's shoot): in sight within 1000, the view turned onto its middle and
  -- the gun fired once the view is there (BotAimAtEnemy, BotCheckAttack with the button for the enemy)
  IF (act IS NOT NULL AND target = act AND EXISTS (SELECT 1 FROM ents b WHERE b.id = :act AND b.classname = 'func_button' AND b.takedamage > 0)) THEN
  BEGIN
    EXECUTE PROCEDURE eye_of(eid) RETURNING_VALUES ex, ey, ez, fx, fy, fz;
    IF (vlen(cx - ex, cy - ey, cz - ez) < 1000) THEN
    BEGIN
      EXECUTE PROCEDURE trace_move(eid, 0, 0, 0, 0, 0, 0, ex, ey, ez, cx, cy, cz, 1) RETURNING_VALUES f, hx, hy, hz, nx, ny, nz, sf, ct, als, sts, hit;
      IF (hit = act OR f >= 0.999e0) THEN
      BEGIN
        yaw = vectoyaw(cx - ex, cy - ey);
        UPDATE ents e SET e.ideal_yaw = :yaw, e.ideal_pitch = -ATAN2(:cz - :ez, vlen(:cx - :ex, :cy - :ey, 0)) * 57.29578e0 WHERE e.id = :eid;
        EXECUTE PROCEDURE change_yaw(eid);
        IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.attack_finished <= :t
                      AND ABS(anglemod(e.yaw - :yaw + 180) - 180) < 8 AND ABS(e.pitch - COALESCE(e.ideal_pitch, 0)) < 8)) THEN
        BEGIN
          UPDATE ents e SET e.enemy_id = :act WHERE e.id = :eid;
          EXECUTE PROCEDURE bot_fire(eid);
          UPDATE ents e SET e.enemy_id = NULL, e.attack_finished = :t + fire_time(e.weapon) WHERE e.id = :eid;
        END
        moved = 1;
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t) VALUES (:eid, :target, NULL, NULL, :t, 0, NULL, :t) MATCHING (ent_id);
        EXIT;
      END
    END
  END
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
    -- at the target's node: straight at it (off a func_bobbing as off one anywhere)
    IF (act IS NOT NULL AND target = act) THEN
    BEGIN
      -- the button: to the spot before it, then into it (a trigger or a floor button: into its middle)
      IF (vlen(tx - x, ty - y, 0) > 12) THEN yaw = vectoyaw(tx - x, ty - y); ELSE yaw = vectoyaw(cx - x, cy - y);
      UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
      moved = step_direction(eid, yaw, MINVALUE(dist, MAXVALUE(8, vlen(tx - x, ty - y, 0))));
      -- (a step is all or nothing: the last one up against it short, so the box comes within 2 and sets it off)
      IF (moved = 0) THEN moved = step_direction(eid, yaw, 2);
    END
    ELSE IF (bob_under(eid) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM waypoints w WHERE w.id = :dst AND w.kind = 9)) THEN moved = bob_step(eid, tx, ty, dist);
    ELSE EXECUTE PROCEDURE move_to_goal(eid, target, dist);
    moved = 1;
  END
  ELSE
  BEGIN
    nid = CAST(SUBSTRING(path FROM 2 FOR p - 2) AS INTEGER);
    SELECT w.x, w.y, w.z FROM waypoints w WHERE w.id = :nid INTO nx, ny, nz;
    -- the way on is through a door that is shut (BotAIBlocked, BotGetActivateGoal): standing in the trigger that
    -- opens it, the bot waits for it; else off to the button that does, and back
    IF (last_n IS NOT NULL AND (act IS NULL OR target <> act)) THEN
      SELECT e.door_id, e.act_id FROM wp_edges e WHERE e.a = :last_n AND e.b = :nid INTO dr, da;
    IF (dr IS NOT NULL AND EXISTS (SELECT 1 FROM ents d WHERE d.id = :dr AND d.mv_state IN (1, 3))) THEN
    BEGIN
      IF (EXISTS (SELECT 1 FROM ents a WHERE a.id = :da AND a.classname <> 'func_button'
                    AND a.x + a.maxx >= :x - 15 AND a.x + a.minx <= :x + 15 AND a.y + a.maxy >= :y - 15 AND a.y + a.miny <= :y + 15
                    AND a.z + a.maxz >= :z - 24 AND a.z + a.minz <= :z + 32)) THEN
      BEGIN
        UPDATE ents e SET e.ideal_yaw = vectoyaw(:nx - :x, :ny - :y) WHERE e.id = :eid;
        moved = 1;
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t, :last_n) MATCHING (ent_id);
        EXIT;
      END
      IF (COALESCE(act_t, 0) < t) THEN
      BEGIN
        UPDATE ents e SET e.act_id = :da, e.act_until = :t + 20 WHERE e.id = :eid;
        EXECUTE PROCEDURE bot_follow_route(eid, da, dist) RETURNING_VALUES moved;
        EXIT;
      END
      -- (it gave up on that button a moment ago: no way on for now)
      UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t) VALUES (:eid, :target, :dst, NULL, :t, 0, NULL, NULL) MATCHING (ent_id);
      moved = -1;
      EXIT;
    END
    -- the next node a pad and the one after its landing, or a place a straight-up pad's throw is steered to
    -- (BotFinishTravel_JumpPad's air control, every pad's): run_physics steers the flight there (bot_air_steer)
    -- once over the landing's height or coming down (or the pad already reached, standing on it, and the place
    -- the next node)
    p2 = POSITION(',', path, p + 1);
    n2 = NULL;
    IF (p2 > 0) THEN n2 = CAST(SUBSTRING(path FROM p + 1 FOR p2 - p - 1) AS INTEGER);
    IF (n2 IS NOT NULL AND vlen(nx - x, ny - y, 0) < 300 AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :nid AND e.b = :n2 AND e.kind IN (1, 6))) THEN n2 = n2;
    ELSE IF (last_n IS NOT NULL AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :last_n AND e.b = :nid AND e.kind IN (1, 6))) THEN n2 = nid;
    ELSE n2 = NULL;
    IF (n2 IS NOT NULL) THEN
    BEGIN
      SELECT w.x, w.y, w.z FROM waypoints w WHERE w.id = :n2 INTO lx, ly, lz;
      UPDATE OR INSERT INTO bot_routes (ent_id, rj_x, rj_y, rj_z, rj_until, rj_hold) VALUES (:eid, :lx, :ly, :lz, :t + 4, :lz + 8) MATCHING (ent_id);
    END
    -- a plat (BotTravel_Elevator): coming to it, the bot waits off it unless it is down; on it, to the middle,
    -- and it stands there while the plat takes it up (the plat's trigger starts it); at the top the next node
    -- is a walk off. `riding`: the ride's start reached, its end the next node
    plat = NULL; riding = 0;
    IF (last_n IS NOT NULL AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :last_n AND e.b = :nid AND e.kind = 7)) THEN
    BEGIN
      riding = 1;
      SELECT w.ent_id FROM waypoints w WHERE w.id = :last_n INTO plat;
    END
    ELSE IF (n2 IS NULL AND p2 > 0 AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :nid AND e.b = CAST(SUBSTRING(:path FROM :p + 1 FOR :p2 - :p - 1) AS INTEGER) AND e.kind = 7)) THEN
      SELECT w.ent_id FROM waypoints w WHERE w.id = :nid INTO plat;
    IF (plat IS NOT NULL) THEN
    BEGIN
      SELECT p.mv_state, p.z + p.maxz, p.x + (p.minx + p.maxx) / 2, p.y + (p.miny + p.maxy) / 2, (p.maxx - p.minx) / 2, (p.maxy - p.miny) / 2
        FROM ents p WHERE p.id = :plat INTO pst, ptop, pcx, pcy, phx, phy;
      onplat = IIF(ABS(x - pcx) < phx + 15 AND ABS(y - pcy) < phy + 15 AND ABS(z - 24 - ptop) < 12, 1, 0);
      IF (onplat = 1 OR (pst = 1 AND riding = 1)) THEN
      BEGIN
        -- onto it and to the middle; still there, it waits for the top
        IF (vlen(pcx - x, pcy - y, 0) > 12) THEN
        BEGIN
          yaw = vectoyaw(pcx - x, pcy - y);
          UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
          moved = step_direction(eid, yaw, MINVALUE(dist, vlen(pcx - x, pcy - y, 0)));
        END
        ELSE moved = 1;
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t, :last_n) MATCHING (ent_id);
        EXIT;
      END
      IF (pst <> 1 AND vlen(pcx - x, pcy - y, 0) < MAXVALUE(phx, phy) + 96) THEN
      BEGIN
        -- not down: wait by it, facing it (stepping on now would be a fall into the shaft)
        UPDATE ents e SET e.ideal_yaw = vectoyaw(:pcx - :x, :pcy - :y) WHERE e.id = :eid;
        moved = 1;
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t, :last_n) MATCHING (ent_id);
        EXIT;
      END
    END
    -- a func_bobbing (BotTravel_FuncBobbing): coming to an end of its swing, the bot waits by it until the
    -- swing is within 16 of that end, then steps on; on it, to the middle and stands until it is within 24 of
    -- the other end, where the next node is a walk off
    bob = NULL; riding = 0;
    IF (last_n IS NOT NULL AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :last_n AND e.b = :nid AND e.kind = 8)) THEN
    BEGIN
      riding = 1;
      SELECT w.ent_id FROM waypoints w WHERE w.id = :nid INTO bob;
    END
    ELSE IF (bob_under(eid) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM waypoints w WHERE w.id = :nid AND w.kind = 9 AND w.ent_id = bob_under(:eid))) THEN
      riding = 2;   -- (on one, ridden to its end or stepped on in passing, the next node off it)
    ELSE IF (p2 > 0) THEN
    BEGIN
      nxt = CAST(SUBSTRING(path FROM p + 1 FOR p2 - p - 1) AS INTEGER);
      IF (EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :nid AND e.b = :nxt AND e.kind = 8)) THEN SELECT w.ent_id FROM waypoints w WHERE w.id = :nid INTO bob;
    END
    IF (riding = 2) THEN bob = bob_under(eid);
    IF (bob IS NOT NULL) THEN
    BEGIN
      SELECT p.z + p.maxz, p.x + (p.minx + p.maxx) / 2, p.y + (p.miny + p.maxy) / 2, (p.maxx - p.minx) / 2, (p.maxy - p.miny) / 2
        FROM ents p WHERE p.id = :bob INTO ptop, pcx, pcy, phx, phy;
      onplat = IIF(ABS(x - pcx) < phx + 15 AND ABS(y - pcy) < phy + 15 AND ABS(z - 24 - ptop) < 12, 1, 0);
      lx = NULL;
      IF (riding = 2) THEN
      BEGIN
        -- off it: a step or a run across to the next node
        lx = nx; ly = ny;
      END
      ELSE IF (onplat = 1 AND riding = 1 AND wp_bob_gap(nid) < 24) THEN
      BEGIN
        -- at the far end: off onto the node after the ride's end
        IF (p2 > 0) THEN SELECT w.x, w.y FROM waypoints w WHERE w.id = CAST(SUBSTRING(:path FROM :p + 1 FOR :p2 - :p - 1) AS INTEGER) INTO lx, ly;
      END
      ELSE IF (onplat = 1) THEN
      BEGIN
        -- on it, not yet at the far end: to the middle, and stand
        IF (vlen(pcx - x, pcy - y, 0) > 10) THEN
        BEGIN
          yaw = vectoyaw(pcx - x, pcy - y);
          UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
          moved = step_direction(eid, yaw, MINVALUE(dist, vlen(pcx - x, pcy - y, 0)));
        END
        ELSE moved = 1;
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t, :last_n) MATCHING (ent_id);
        EXIT;
      END
      ELSE IF (wp_bob_gap(IIF(:riding = 1, :last_n, :nid)) > 16) THEN
      BEGIN
        IF (vlen(pcx - x, pcy - y, 0) < MAXVALUE(phx, phy) + 256) THEN
        BEGIN
          -- off it, the swing elsewhere: wait for it at the floor's edge (RESULTTYPE_WAITFORFUNCBOBBING; reach->start
          -- is on the edge): on toward it until a step will not go (or it is underfoot, and stood on)
          yaw = vectoyaw(pcx - x, pcy - y);
          UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
          IF (vlen(MAXVALUE(0, ABS(x - pcx) - phx), MAXVALUE(0, ABS(y - pcy) - phy), 0) > 24) THEN moved = step_direction(eid, yaw, dist);
          moved = 1;
          UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t, :last_n) MATCHING (ent_id);
          EXIT;
        END
      END
      ELSE IF (vlen(pcx - x, pcy - y, 0) < MAXVALUE(phx, phy) + 160) THEN
      BEGIN
        -- the swing at this end: onto it, to the middle
        lx = pcx; ly = pcy;
      END
      IF (lx IS NOT NULL) THEN
      BEGIN
        -- a step, or where a step will not leave the edge (the swing never quite meets the floor: oa_dm2's
        -- slider leaves 35 units), off it at run speed as a player runs across (run_physics flies it)
        -- (a run across only from within 96 of the platform's edge, getting on: oa_dm2's slider leaves 49 at one end)
        IF (riding = 2 OR onplat = 1 OR vlen(MAXVALUE(0, ABS(x - pcx) - phx), MAXVALUE(0, ABS(y - pcy) - phy), 0) < 96) THEN moved = bob_step(eid, lx, ly, dist);
        ELSE
        BEGIN
          yaw = vectoyaw(lx - x, ly - y);
          UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
          moved = step_direction(eid, yaw, MINVALUE(dist, vlen(lx - x, ly - y, 0)));
        END
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t, :last_n) MATCHING (ent_id);
        EXIT;
      END
    END
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
    IF (last_n IS NOT NULL AND EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :last_n AND e.b = :nid AND e.kind = 5)) THEN
    BEGIN
      -- a jump across a gap (BotTravel_Jump): onto its start, then off it with the speed that lands it on
      -- the far node (320 at most, 270 up; in the air run_physics flies it, as a drop's)
      SELECT w.x, w.y, w.z FROM waypoints w WHERE w.id = :last_n INTO lx, ly, lz;
      IF (vlen(lx - x, ly - y, 0) > 16 AND vlen(nx - x, ny - y, 0) > vlen(nx - lx, ny - ly, 0)) THEN
      BEGIN
        yaw = vectoyaw(lx - x, ly - y);
        UPDATE ents e SET e.ideal_yaw = :yaw WHERE e.id = :eid;
        moved = step_direction(eid, yaw, MINVALUE(dist, vlen(lx - x, ly - y, 0)));
        IF (moved = 0) THEN fails = fails + 1; ELSE fails = 0;
        UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node) VALUES (:eid, :target, :dst, :path, :built, :fails, NULL, :t, :last_n) MATCHING (ent_id);
        EXIT;
      END
      yaw = vectoyaw(nx - x, ny - y);
      reach = MINVALUE(320, vlen(nx - x, ny - y, 0) * 800 / (270 + SQRT(MAXVALUE(0, 270e0 * 270 - 1600 * (nz - z)))));
      UPDATE ents e SET e.ideal_yaw = :yaw, e.yaw = :yaw, e.vx = COS(:yaw * 0.0174532925e0) * :reach, e.vy = SIN(:yaw * 0.0174532925e0) * :reach, e.vz = 270,
             e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
      EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || COALESCE((SELECT e.pmodel FROM ents e WHERE e.id = :eid), 'sarge') || '/jump1.wav', 1, 1);
      -- (BotFinishTravel_Jump: in the air it steers for the far node, run_physics's bot_air_steer, until it lands)
      UPDATE OR INSERT INTO bot_routes (ent_id, target, dst_node, path, built, fails, prog_d, prog_t, last_node, rj_x, rj_y, rj_z, rj_until, rj_hold)
        VALUES (:eid, :target, :dst, :path, :built, 0, NULL, :t + 1.5e0, :last_n, :nx, :ny, :nz, :t + 2, NULL) MATCHING (ent_id);
      moved = 1;
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
    IF (moved = 0 AND nz < z - 24 AND vlen(nx - x, ny - y, 0) < 320) THEN
    BEGIN
      -- the next node is down a ledge (more than a step, 18, and the node 25 over its floor: 24) and the step "walked off an edge": jump down, as the AAS's
      -- jump-down reachability does; gravity and fly_move take it from here (run_physics), steered in the air for
      -- the node below (BotFinishTravel_WalkOffLedge's air control) until it lands
      UPDATE ents e SET e.vx = COS(:yaw * 0.0174532925e0) * 320, e.vy = SIN(:yaw * 0.0174532925e0) * 320, e.vz = 40,
             e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
      UPDATE OR INSERT INTO bot_routes (ent_id, rj_x, rj_y, rj_z, rj_until, rj_hold) VALUES (:eid, :nx, :ny, :nz, :t + 3, NULL) MATCHING (ent_id);
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

-- A characteristic of the bot's own character file at its skill (botlib's Characteristic_Float over
-- bots/NAME_c.c, the skill's block or the two around it interpolated, read by src/botchat.js into
-- bot_chatchar): reactiontime, aim_accuracy and aim_skill (and their _rocketlauncher … per gun),
-- alertness, view_maxchange, attack_skill, firethrottle, bounded as botlib bounds them. `dflt` when the file has none
CREATE OR ALTER FUNCTION bot_cv (eid INTEGER, k VARCHAR(40), dflt DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
DECLARE v DOUBLE PRECISION;
BEGIN
  SELECT c.val FROM ents e JOIN bot_defs b ON b.name = e.bot JOIN bot_chatchar c ON c.bot = e.bot AND c.skill = b.skill AND c.ckey = :k
   WHERE e.id = :eid INTO v;
  IF (v IS NULL) THEN RETURN dflt;
  -- Characteristic_BFloat's bounds: the turning 1 to 360 degrees a second, the rest 0 to 1 (a reaction time
  -- of 3.5 in a file is a second)
  IF (k = 'view_maxchange') THEN RETURN MAXVALUE(1, MINVALUE(360, v));
  RETURN MAXVALUE(0, MINVALUE(1, v));
END^

-- a gun's name in the characteristics (CHARACTERISTIC_AIM_ACCURACY_ROCKETLAUNCHER …)
CREATE OR ALTER FUNCTION weapon_char_name (w INTEGER) RETURNS VARCHAR(20)
AS
BEGIN
  RETURN TRIM(CASE w WHEN 1 THEN 'gauntlet' WHEN 2 THEN 'machinegun' WHEN 4 THEN 'shotgun' WHEN 8 THEN 'grenadelauncher' WHEN 16 THEN 'rocketlauncher'
                     WHEN 32 THEN 'lightning' WHEN 64 THEN 'railgun' WHEN 128 THEN 'plasmagun' WHEN 256 THEN 'bfg10k' ELSE '' END);
END^


-- the nearest player or bot the bot notices (BotFindEnemy): within its alertness range, inside its field
-- of view unless very close, in sight, and not invisible unless it is shooting (its refire still running)
-- (declared here, defined below with the retreat)
CREATE OR ALTER FUNCTION bot_aggression (eid INTEGER, enemy INTEGER) RETURNS INTEGER AS BEGIN RETURN 100; END^

CREATE OR ALTER FUNCTION bot_find_target (eid INTEGER) RETURNS INTEGER
AS
DECLARE c INTEGER; DECLARE d DOUBLE PRECISION; DECLARE best INTEGER; DECLARE bestd DOUBLE PRECISION = 1e9; DECLARE inv DOUBLE PRECISION; DECLARE paf DOUBLE PRECISION;
DECLARE skill SMALLINT; DECLARE alert DOUBLE PRECISION; DECLARE fov DOUBLE PRECISION; DECLARE cosang DOUBLE PRECISION; DECLARE al DOUBLE PRECISION;
DECLARE shooting SMALLINT; DECLARE facing DOUBLE PRECISION; DECLARE cur SMALLINT; DECLARE hd SMALLINT;
DECLARE tt DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
BEGIN
  SELECT p.invis_finished, p.attack_finished FROM player p WHERE p.id = 1 INTO inv, paf;
  -- "check if the health decreased" since it last looked, and remember it (bs->lasthealth)
  SELECT IIF(COALESCE(e.last_health, e.health) > e.health, 1, 0) FROM ents e WHERE e.id = :eid INTO hd;
  UPDATE ents e SET e.last_health = e.health WHERE e.id = :eid;
  -- the last arrival by teleport or spawn: anyone within 70 units of it is let be for 3 s
  SELECT COALESCE(g.tele_time, -1e9), g.tele_x, g.tele_y, g.tele_z FROM game g WHERE g.id = 1 INTO tt, tx, ty, tz;
  -- an enemy now (curenemy >= 0): one alive, not lost
  cur = IIF(EXISTS (SELECT 1 FROM ents e JOIN ents o ON o.id = e.enemy_id WHERE e.id = :eid AND o.health > 0 AND o.deadflag = 0 AND e.search_time >= now_()), 1, 0);
  SELECT COALESCE(b.skill, 2) FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO skill;
  -- BotFindEnemy: no farther than 900 + 4000 × the character's alertness
  al = bot_cv(eid, 'alertness', NULL);
  alert = IIF(al IS NULL, bot_char(skill, 'alert'), 900 + 4000 * al); fov = bot_char(skill, 'fov');
  FOR SELECT o.id, vlen(o.x - e.x, o.y - e.y, o.z - e.z),
             (COS(e.yaw * 0.0174532925e0) * (o.x - e.x) + SIN(e.yaw * 0.0174532925e0) * (o.y - e.y)) / MAXVALUE(1e-3, vlen(o.x - e.x, o.y - e.y, 0)),
             -- (EntityIsShooting: its trigger held, the gun's refire running)
             IIF(IIF(o.classname = 'player', :paf, o.attack_finished) > now_(), 1, 0),
             -- the other's view toward the bot (the cosine of the angle off its facing)
             (COS(o.yaw * 0.0174532925e0) * (e.x - o.x) + SIN(o.yaw * 0.0174532925e0) * (e.y - o.y)) / MAXVALUE(1e-3, vlen(o.x - e.x, o.y - e.y, 0))
        FROM ents o CROSS JOIN ents e
       WHERE e.id = :eid AND o.id <> :eid AND o.classname IN ('player', 'bot') AND o.health > 0 AND o.deadflag = 0 AND BIN_AND(o.flags, 64) = 0
         AND NOT (e.pteam > 0 AND o.pteam = e.pteam)
         -- (BotFindEnemy: "if the enemy is invisible and not shooting")
         AND NOT (IIF(o.classname = 'player', :inv, o.invis_finished) > now_() AND IIF(o.classname = 'player', :paf, o.attack_finished) <= now_())
         AND ABS(o.x - e.x) < :alert AND ABS(o.y - e.y) < :alert AND ABS(o.z - e.z) < :alert
         AND NOT (:tt > now_() - 3 AND vlen(o.x - :tx, o.y - :ty, o.z - :tz) < 70)
       ORDER BY 2 INTO c, d, cosang, shooting, facing
  DO
  BEGIN
    IF (d >= bestd OR d > alert) THEN LEAVE;
    -- behind it: BotFindEnemy's field of view, 90 degrees close, widening to 180 at 810 and past (with the
    -- character files; without them the skill's); all round, while the bot has no enemy, for one shooting or
    -- when its health went down
    IF (NOT (cur = 0 AND (shooting = 1 OR hd = 1))) THEN
    BEGIN
      IF (al IS NOT NULL AND cosang < COS((90 + MINVALUE(d * d, 656100) / 7290) * 0.00872664626e0)) THEN CONTINUE;
      IF (al IS NULL AND d > 250 AND cosang < fov) THEN CONTINUE;
    END
    IF (visible(eid, c) = 1) THEN
    BEGIN
      -- "check if we can avoid this enemy": with no enemy yet, one past 100 units, not shooting, that has not
      -- the bot in its 90 degrees, is let be by a bot that would rather retreat from it (BotWantsToRetreat)
      -- (not when it was hurt)
      IF (cur = 0 AND d > 100 AND shooting = 0 AND hd = 0 AND facing < 0.70710678e0 AND bot_aggression(eid, c) < 50) THEN CONTINUE;
      best = c; bestd = d;
    END
  END
  RETURN best;
END^

-- An inventory value of the botfiles' (inv.h's INVENTORY_*) for a bot: health, armour, a gun held (1 or 0),
-- the powerups it carries; its ammunition of each kind
CREATE OR ALTER FUNCTION bot_inv (eid INTEGER, v VARCHAR(32)) RETURNS DOUBLE PRECISION
AS
DECLARE hp INTEGER; DECLARE av INTEGER; DECLARE w INTEGER; DECLARE bit_ INTEGER; DECLARE t DOUBLE PRECISION;
DECLARE qf DOUBLE PRECISION; DECLARE hf DOUBLE PRECISION; DECLARE inf DOUBLE PRECISION; DECLARE rf DOUBLE PRECISION; DECLARE ef DOUBLE PRECISION;
BEGIN
  SELECT e.health, e.armor, e.weapons, e.quad_finished, e.haste_finished, e.invis_finished, e.regen_finished, e.enviro_finished FROM ents e WHERE e.id = :eid
    INTO hp, av, w, qf, hf, inf, rf, ef;
  t = now_();
  -- the enemy's distance across and its height over the bot (the weapon weights' ENEMY_HORIZONTAL_DIST)
  IF (v = 'ENEMY_HORIZONTAL_DIST') THEN RETURN COALESCE((SELECT vlen(o.x - e.x, o.y - e.y, 0) FROM ents e JOIN ents o ON o.id = e.enemy_id WHERE e.id = :eid), 0);
  IF (v = 'ENEMY_HEIGHT') THEN RETURN COALESCE((SELECT o.z - e.z FROM ents e JOIN ents o ON o.id = e.enemy_id WHERE e.id = :eid), 0);
  IF (v = 'INVENTORY_HEALTH') THEN RETURN hp;
  IF (v = 'INVENTORY_ARMOR') THEN RETURN av;
  bit_ = CASE v WHEN 'INVENTORY_GAUNTLET' THEN 1 WHEN 'INVENTORY_MACHINEGUN' THEN 2 WHEN 'INVENTORY_SHOTGUN' THEN 4 WHEN 'INVENTORY_GRENADELAUNCHER' THEN 8
                WHEN 'INVENTORY_ROCKETLAUNCHER' THEN 16 WHEN 'INVENTORY_LIGHTNING' THEN 32 WHEN 'INVENTORY_RAILGUN' THEN 64 WHEN 'INVENTORY_PLASMAGUN' THEN 128
                WHEN 'INVENTORY_BFG10K' THEN 256 ELSE 0 END;
  IF (bit_ > 0) THEN RETURN IIF(BIN_AND(w, bit_) <> 0, 1, 0);
  bit_ = CASE v WHEN 'INVENTORY_BULLETS' THEN 2 WHEN 'INVENTORY_SHELLS' THEN 3 WHEN 'INVENTORY_GRENADES' THEN 4 WHEN 'INVENTORY_ROCKETS' THEN 5
                WHEN 'INVENTORY_LIGHTNINGAMMO' THEN 6 WHEN 'INVENTORY_SLUGS' THEN 7 WHEN 'INVENTORY_CELLS' THEN 8 WHEN 'INVENTORY_BFGAMMO' THEN 9 ELSE 0 END;
  IF (bit_ > 0) THEN RETURN ent_ammo(eid, bit_);
  IF (v = 'INVENTORY_TELEPORTER') THEN RETURN IIF((SELECT e.hold_item FROM ents e WHERE e.id = :eid) = 1, 1, 0);
  IF (v = 'INVENTORY_MEDKIT') THEN RETURN IIF((SELECT e.hold_item FROM ents e WHERE e.id = :eid) = 2, 1, 0);
  RETURN CASE v WHEN 'INVENTORY_QUAD' THEN IIF(qf > t, 1, 0) WHEN 'INVENTORY_HASTE' THEN IIF(hf > t, 1, 0) WHEN 'INVENTORY_INVISIBILITY' THEN IIF(inf > t, 1, 0)
                WHEN 'INVENTORY_REGEN' THEN IIF(rf > t, 1, 0) WHEN 'INVENTORY_ENVIRONMENTSUIT' THEN IIF(ef > t, 1, 0) ELSE 0 END;
END^

-- FuzzyWeight (be_ai_weight.c): the bot's weight for an item class or a gun ('weapon:BIT') from its
-- character's weights (bot_iw), the first case its inventory is under, three levels deep
CREATE OR ALTER FUNCTION bot_item_weight (eid INTEGER, cls VARCHAR(40)) RETURNS DOUBLE PRECISION
AS
DECLARE bn VARCHAR(16); DECLARE v VARCHAR(32); DECLARE o1 INTEGER; DECLARE o2 INTEGER; DECLARE inv DOUBLE PRECISION; DECLARE w DOUBLE PRECISION;
BEGIN
  SELECT e.bot FROM ents e WHERE e.id = :eid INTO bn;
  IF (NOT EXISTS (SELECT 1 FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls)) THEN RETURN 0;
  SELECT FIRST 1 r.v1 FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls INTO v;
  inv = IIF(v IS NULL, 0, bot_inv(eid, v));
  SELECT MIN(r.o1) FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls AND :inv < r.b1 INTO o1;
  IF (o1 IS NULL) THEN RETURN 0;
  v = NULL;
  SELECT FIRST 1 r.v2 FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls AND r.o1 = :o1 INTO v;
  inv = IIF(v IS NULL, 0, bot_inv(eid, v));
  SELECT MIN(r.o2) FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls AND r.o1 = :o1 AND :inv < r.b2 INTO o2;
  IF (o2 IS NULL) THEN RETURN 0;
  v = NULL;
  SELECT FIRST 1 r.v3 FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls AND r.o1 = :o1 AND r.o2 = :o2 INTO v;
  inv = IIF(v IS NULL, 0, bot_inv(eid, v));
  SELECT FIRST 1 r.w FROM bot_iw r WHERE r.bot = :bn AND r.cls = :cls AND r.o1 = :o1 AND r.o2 = :o2 AND :inv < r.b3 ORDER BY r.o3 INTO w;
  RETURN COALESCE(w, 0);
END^

-- BotChooseLTGItem (be_ai_goal.c): the item worth the most for its travel time, the weight over the seconds it
-- takes to get there (a straight line at run speed, height counted twice, for the AAS's travel time). One it
-- went for or took itself and that is still to come back is a goal when the trip takes longer than the wait
-- (avoid time minus 0.9 of the travel time, as botlib has it): the bot times it. One another took is not known
-- to be gone: the bot learns it on seeing its place empty (bot_goal_reached). A powerup not yet in the arena
-- is no goal (botlib's level item has no entity yet). The flight is left out (they have no use for it);
-- ammunition is weighed by how much of it the bot has (fw_items.c's INVENTORY_ROCKETS …), a holdable by whether
-- it carries one
-- botlib's avoid goal for an item (BotChooseLTGItem, BotChooseNBGItem, BotSetAvoidGoalTime): avoided for its
-- respawntime of botfiles/items.c, 30 s without one, 10 at least; a dropped one 10
CREATE OR ALTER PROCEDURE bot_avoid_item (eid INTEGER, item INTEGER)
AS
DECLARE r DOUBLE PRECISION; DECLARE th VARCHAR(24); DECLARE found SMALLINT = 0;
BEGIN
  SELECT COALESCE(d.bot_respawn, 0), g.think, 1 FROM ents g JOIN item_defs d ON d.cls = g.item WHERE g.id = :item INTO r, th, found;
  IF (found = 0) THEN EXIT;
  r = IIF(th = 'remove', 10, MAXVALUE(10, IIF(r = 0, 30, r)));
  UPDATE OR INSERT INTO bot_avoid (ent_id, item_id, avoid_until) VALUES (:eid, :item, now_() + :r) MATCHING (ent_id, item_id);
END^

-- BotReachedGoal for an item: 0 not yet; 1 gone from the arena (a dropped one removed); 2 touched; 3 its place
-- in sight from the eye and the item not there (BotItemGoalInVisButNotVisible: how a bot learns an item it went
-- for was taken; it does not know otherwise)
CREATE OR ALTER FUNCTION bot_goal_reached (eid INTEGER, gid INTEGER) RETURNS SMALLINT
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE vh DOUBLE PRECISION;
DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION; DECLARE gz DOUBLE PRECISION; DECLARE sol SMALLINT;
DECLARE tf DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION; DECLARE tsf INTEGER; DECLARE tct INTEGER;
DECLARE tals SMALLINT; DECLARE tsts SMALLINT; DECLARE thit INTEGER;
BEGIN
  SELECT g.x, g.y, g.z, g.solid FROM ents g WHERE g.id = :gid INTO gx, gy, gz, sol;
  IF (gx IS NULL) THEN RETURN 1;
  SELECT e.x, e.y, e.z, e.viewheight FROM ents e WHERE e.id = :eid INTO x, y, z, vh;
  IF (vlen(gx - x, gy - y, 0) <= 40 AND ABS(gz - z) < 64) THEN RETURN 2;
  IF (sol = 1) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(eid, 0, 0, 0, 0, 0, 0, x, y, z + vh, gx, gy, gz, 1)
    RETURNING_VALUES tf, tx, ty, tz, tnx, tny, tnz, tsf, tct, tals, tsts, thit;
  RETURN IIF(tf >= 1, 3, 0);
END^

CREATE OR ALTER FUNCTION bot_choose_ltg (eid INTEGER) RETURNS INTEGER
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
DECLARE gid INTEGER; DECLARE cls VARCHAR(40); DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION; DECLARE gz DOUBLE PRECISION;
DECLARE sol SMALLINT; DECLARE av DOUBLE PRECISION; DECLARE w DOUBLE PRECISION; DECLARE tt DOUBLE PRECISION;
DECLARE best INTEGER; DECLARE bestw DOUBLE PRECISION = 0;
DECLARE graph SMALLINT = 0; DECLARE rj SMALLINT; DECLARE src INTEGER; DECLARE d0 DOUBLE PRECISION; DECLARE rd DOUBLE PRECISION; DECLARE gn INTEGER;
BEGIN
  t = now_();
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO x, y, z;
  -- the travel time along the graph once it is built (the AAS's travel time to the goal's area): the way to the
  -- bot's node, then the graph's way to the item's; an item the graph does not reach is no goal
  -- (BotChooseLTGItem skips a goal with no travel time). Before the graph is done, and for an item with no
  -- node of its own (one dropped), the straight line
  IF (EXISTS (SELECT 1 FROM wp_build b WHERE b.id = 1 AND b.phase = 2)) THEN
  BEGIN
    src = wp_nearest(x, y, z, 1);
    IF (src IS NOT NULL) THEN
    BEGIN
      rj = bot_can_rj(eid);
      EXECUTE PROCEDURE wp_travel_cached(src, rj);
      SELECT vlen(w.x - :x, w.y - :y, w.z - :z) FROM waypoints w WHERE w.id = :src INTO d0;
      graph = 1;
    END
  END
  FOR SELECT g.id, g.item, g.x, g.y, g.z, g.item_seen, (SELECT a.avoid_until FROM bot_avoid a WHERE a.ent_id = :eid AND a.item_id = g.id)
        FROM ents g JOIN item_defs i ON i.cls = g.item
       WHERE g.classname = 'item' AND i.kind IN ('H', 'A', 'W', 'P', 'M', 'O') AND NOT (i.kind = 'P' AND i.bit = 32)
        INTO gid, cls, gx, gy, gz, sol, av
  DO
  BEGIN
    IF (sol = 0) THEN CONTINUE;
    tt = vlen(gx - x, gy - y, (gz - z) * 2) / 320 + 0.1e0;
    IF (graph = 1) THEN
    BEGIN
      gn = NULL; rd = NULL;
      SELECT FIRST 1 w.id, c.dist FROM waypoints w LEFT JOIN wp_tcache c ON c.src = :src AND c.rj = :rj AND c.node = w.id WHERE w.ent_id = :gid AND w.kind = 2 INTO gn, rd;
      IF (gn IS NOT NULL AND rd IS NULL) THEN CONTINUE;
      IF (gn IS NOT NULL) THEN tt = (d0 + rd) / 320 + 0.1e0;
    END
    IF (av IS NOT NULL AND av - t - tt * 0.9e0 > 0) THEN CONTINUE;
    w = bot_item_weight(eid, cls);
    IF (w > 0 AND w / tt > bestw) THEN BEGIN bestw = w / tt; best = gid; END
  END
  RETURN best;
END^

-- BotChooseNBGItem (be_ai_goal.c): a nearby goal on the way, the item worth the most for its travel time among
-- those under `range` seconds away (AINode_Seek_LTG's 150 hundredths) whose trip on to the long-term goal (`ltg`,
-- an entity: the item sought, the teammate accompanied) takes no longer than going there straight; any item
-- near enough when there is none. Travel times and the items considered are bot_choose_ltg's
CREATE OR ALTER FUNCTION bot_choose_nbg (eid INTEGER, ltg INTEGER, range_ DOUBLE PRECISION) RETURNS INTEGER
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
DECLARE lx DOUBLE PRECISION; DECLARE ly DOUBLE PRECISION; DECLARE lz DOUBLE PRECISION; DECLARE ltg_t DOUBLE PRECISION = 99999;
DECLARE gid INTEGER; DECLARE cls VARCHAR(40); DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION; DECLARE gz DOUBLE PRECISION;
DECLARE sol SMALLINT; DECLARE av DOUBLE PRECISION; DECLARE w DOUBLE PRECISION; DECLARE tt DOUBLE PRECISION;
DECLARE best INTEGER; DECLARE bestw DOUBLE PRECISION = 0;
BEGIN
  t = now_();
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO x, y, z;
  IF (ltg IS NOT NULL) THEN
  BEGIN
    SELECT g.x, g.y, g.z FROM ents g WHERE g.id = :ltg INTO lx, ly, lz;
    IF (lx IS NOT NULL) THEN ltg_t = vlen(lx - x, ly - y, (lz - z) * 2) / 320 + 0.1e0;
  END
  FOR SELECT g.id, g.item, g.x, g.y, g.z, g.item_seen, (SELECT a.avoid_until FROM bot_avoid a WHERE a.ent_id = :eid AND a.item_id = g.id)
        FROM ents g JOIN item_defs i ON i.cls = g.item
       WHERE g.classname = 'item' AND i.kind IN ('H', 'A', 'W', 'P', 'M', 'O') AND NOT (i.kind = 'P' AND i.bit = 32)
         AND ABS(g.x - :x) < :range_ * 320 AND ABS(g.y - :y) < :range_ * 320
        INTO gid, cls, gx, gy, gz, sol, av
  DO
  BEGIN
    IF (sol = 0) THEN CONTINUE;
    tt = vlen(gx - x, gy - y, (gz - z) * 2) / 320 + 0.1e0;
    IF (tt >= range_) THEN CONTINUE;
    IF (av IS NOT NULL AND av - t - tt * 0.9e0 > 0) THEN CONTINUE;
    w = bot_item_weight(eid, cls);
    IF (w > 0 AND w / tt > bestw) THEN
    BEGIN
      -- the trip back to the long-term goal must not take longer than going there now
      IF (lx IS NULL OR vlen(lx - gx, ly - gy, (lz - gz) * 2) / 320 + 0.1e0 <= ltg_t) THEN
      BEGIN
        bestw = w / tt; best = gid;
      END
    END
  END
  RETURN best;
END^

-- the weapon a bot likes best among those it holds
CREATE OR ALTER FUNCTION bot_best_weapon (eid INTEGER, dist DOUBLE PRECISION) RETURNS INTEGER
AS
DECLARE w INTEGER; DECLARE bit_ INTEGER = 1; DECLARE best INTEGER; DECLARE bestw DOUBLE PRECISION = 0; DECLARE ww DOUBLE PRECISION;
BEGIN
  SELECT e.weapons FROM ents e WHERE e.id = :eid INTO w;
  -- BotChooseBestFightWeapon: the gun held its character weighs the most (bots/NAME_w.c with fw_weap.c:
  -- each gun's own weight, the lightning gun's a tenth past 768 across); without the files, by distance
  IF (EXISTS (SELECT 1 FROM bot_iw r JOIN ents e ON e.bot = r.bot WHERE e.id = :eid AND r.cls STARTING WITH 'weapon:')) THEN
  BEGIN
    WHILE (bit_ <= 256) DO
    BEGIN
      IF (BIN_AND(w, bit_) <> 0) THEN
      BEGIN
        ww = bot_item_weight(eid, 'weapon:' || bit_);
        IF (ww > bestw) THEN BEGIN bestw = ww; best = bit_; END
      END
      bit_ = bit_ * 2;
    END
    IF (best IS NOT NULL) THEN RETURN best;
  END
  -- (without the files: the guns with ammunition, by distance)
  w = BIN_AND(w, 1 + IIF(ent_ammo(eid, 2) > 0, 2, 0) + IIF(ent_ammo(eid, 3) > 0, 4, 0) + IIF(ent_ammo(eid, 4) > 0, 8, 0) + IIF(ent_ammo(eid, 5) > 0, 16, 0)
                   + IIF(ent_ammo(eid, 6) > 0, 32, 0) + IIF(ent_ammo(eid, 7) > 0, 64, 0) + IIF(ent_ammo(eid, 8) > 0, 128, 0) + IIF(ent_ammo(eid, 9) > 0, 256, 0));
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

-- ── the gun for the distance, by what was measured ─────────────────────────────────────────────────────────────
-- botlib's bots fight with their character's favourite of the guns they hold, whatever the distance (but for the
-- lightning gun's reach). Which gun does the most at which distance can be measured: in self-play with
-- game.bot_wsel 2 every bot fights with a gun at random of those it holds, changed every 3 s, and bot_wdps counts
-- for each gun and distance band the seconds of fire (bot_w_shot: a shot is the gun's time between two) and the
-- health taken off (bot_w_damage, from t_damage, by the means of death). With game.bot_wsel 1 (or ents.wsel) a
-- bot takes the gun with the most damage a second of fire at its enemy's distance, of those it holds with
-- ammunition and that were fired for 30 s or more there; where nothing is known, its character's favourite.

-- The distance band: 0 under 150 units, 1 under 300, 2 under 500, 3 under 800, 4 under 1200, 5 beyond
CREATE OR ALTER FUNCTION bot_wband (d DOUBLE PRECISION) RETURNS SMALLINT
AS
BEGIN
  RETURN CASE WHEN d < 150 THEN 0 WHEN d < 300 THEN 1 WHEN d < 500 THEN 2 WHEN d < 800 THEN 3 WHEN d < 1200 THEN 4 ELSE 5 END;
END^

-- The gun of a means of death (the WP bit), NULL for those that are no gun's
CREATE OR ALTER FUNCTION mod_weapon (mod_ SMALLINT) RETURNS INTEGER
AS
BEGIN
  RETURN CASE WHEN mod_ = 1 THEN 1 WHEN mod_ = 2 THEN 2 WHEN mod_ = 3 THEN 4 WHEN mod_ IN (4, 5) THEN 8 WHEN mod_ IN (6, 7) THEN 16
              WHEN mod_ = 16 THEN 32 WHEN mod_ = 17 THEN 64 WHEN mod_ IN (8, 9) THEN 128 WHEN mod_ IN (18, 19) THEN 256 END;
END^

-- How a bot chooses its gun: its own setting, else the game's
CREATE OR ALTER FUNCTION bot_wsel_mode (eid INTEGER) RETURNS SMALLINT
AS
BEGIN
  RETURN COALESCE((SELECT e.wsel FROM ents e WHERE e.id = :eid), (SELECT g.bot_wsel FROM game g WHERE g.id = 1), 0);
END^

-- A shot of a bot that is measuring: the gun's time between two shots, at the enemy's distance
CREATE OR ALTER PROCEDURE bot_w_shot (eid INTEGER)
AS
DECLARE w INTEGER; DECLARE d DOUBLE PRECISION; DECLARE b SMALLINT; DECLARE s DOUBLE PRECISION;
BEGIN
  IF (bot_wsel_mode(eid) <> 2) THEN EXIT;
  SELECT e.weapon, vlen(o.x - e.x, o.y - e.y, o.z - e.z) FROM ents e JOIN ents o ON o.id = e.enemy_id WHERE e.id = :eid INTO w, d;
  IF (d IS NULL) THEN EXIT;
  b = bot_wband(d);
  -- (a bot thinks ten times a second and fires once a think at most: the lightning gun's 0.05 s between two
  -- shots is 0.1 s in its hands. Counted at 0.05, the gun looked twice what it is, and bots choosing by that lost)
  s = MAXVALUE(fire_time(w), 0.1e0);
  UPDATE bot_wdps p SET p.secs = p.secs + :s WHERE p.w = :w AND p.band = :b;
  IF (ROW_COUNT = 0) THEN INSERT INTO bot_wdps (w, band, secs, dmg) VALUES (:w, :b, :s, 0);
END^

-- The health a measuring bot's shot took off another player, to its gun at that distance
CREATE OR ALTER PROCEDURE bot_w_damage (attacker INTEGER, targ INTEGER, mod_ SMALLINT, take INTEGER)
AS
DECLARE w INTEGER; DECLARE d DOUBLE PRECISION; DECLARE b SMALLINT;
BEGIN
  IF (take <= 0 OR attacker IS NULL) THEN EXIT;
  IF ((SELECT e.classname FROM ents e WHERE e.id = :attacker) IS DISTINCT FROM 'bot') THEN EXIT;
  IF (bot_wsel_mode(attacker) <> 2) THEN EXIT;
  w = mod_weapon(mod_);
  IF (w IS NULL) THEN EXIT;
  SELECT vlen(o.x - e.x, o.y - e.y, o.z - e.z) FROM ents e JOIN ents o ON o.id = :targ WHERE e.id = :attacker INTO d;
  IF (d IS NULL) THEN EXIT;
  b = bot_wband(d);
  UPDATE bot_wdps p SET p.dmg = p.dmg + :take WHERE p.w = :w AND p.band = :b;
  IF (ROW_COUNT = 0) THEN INSERT INTO bot_wdps (w, band, secs, dmg) VALUES (:w, :b, 0, :take);
END^

-- The gun a bot fights with at this distance (see above)
CREATE OR ALTER FUNCTION bot_pick_weapon (eid INTEGER, dist DOUBLE PRECISION) RETURNS INTEGER
AS
DECLARE mode SMALLINT; DECLARE held INTEGER; DECLARE t DOUBLE PRECISION; DECLARE w INTEGER; DECLARE until_ DOUBLE PRECISION;
DECLARE n INTEGER; DECLARE k INTEGER; DECLARE bit_ INTEGER; DECLARE b SMALLINT; DECLARE best DOUBLE PRECISION; DECLARE cur DOUBLE PRECISION;
BEGIN
  mode = bot_wsel_mode(eid);
  IF (mode = 0) THEN RETURN bot_best_weapon(eid, dist);
  -- the guns held that have ammunition (the gauntlet needs none)
  SELECT BIN_AND(e.weapons, 1 + IIF(e.ammo2 > 0, 2, 0) + IIF(e.ammo3 > 0, 4, 0) + IIF(e.ammo4 > 0, 8, 0) + IIF(e.ammo5 > 0, 16, 0)
                 + IIF(e.ammo6 > 0, 32, 0) + IIF(e.ammo7 > 0, 64, 0) + IIF(e.ammo8 > 0, 128, 0) + IIF(e.ammo9 > 0, 256, 0)), e.w_pick, e.w_until
    FROM ents e WHERE e.id = :eid INTO held, w, until_;
  IF (mode = 2) THEN
  BEGIN
    -- measuring: one of them at random, kept for 3 s
    t = now_();
    IF (w IS NOT NULL AND until_ > t AND BIN_AND(held, w) <> 0) THEN RETURN w;
    n = 0; bit_ = 1;
    WHILE (bit_ <= 256) DO BEGIN IF (BIN_AND(held, bit_) <> 0) THEN n = n + 1; bit_ = bit_ * 2; END
    k = CAST(FLOOR(RAND() * n) AS INTEGER); bit_ = 1; w = 1;
    WHILE (bit_ <= 256) DO
    BEGIN
      IF (BIN_AND(held, bit_) <> 0) THEN
      BEGIN
        IF (k = 0) THEN BEGIN w = bit_; LEAVE; END
        k = k - 1;
      END
      bit_ = bit_ * 2;
    END
    UPDATE ents e SET e.w_pick = :w, e.w_until = :t + 3 WHERE e.id = :eid;
    RETURN w;
  END
  -- by what was measured: the most damage a second of fire at this distance; the gun in hand is kept unless the
  -- best does a fifth more (a change of guns is half a second without a shot, and an enemy at the edge of a band
  -- would have the bot change at every step)
  b = bot_wband(dist);
  w = NULL;
  SELECT FIRST 1 p.w, p.dmg / p.secs FROM bot_wdps p WHERE p.band = :b AND p.secs >= 30 AND BIN_AND(:held, p.w) <> 0 ORDER BY p.dmg / p.secs DESC, p.w DESC INTO w, best;
  IF (w IS NULL) THEN RETURN bot_best_weapon(eid, dist);
  SELECT p.dmg / p.secs FROM bot_wdps p JOIN ents e ON e.id = :eid AND p.w = e.weapon WHERE p.band = :b AND p.secs >= 30 AND BIN_AND(:held, p.w) <> 0 INTO cur;
  IF (cur IS NOT NULL AND best < cur * 1.2e0) THEN RETURN (SELECT e.weapon FROM ents e WHERE e.id = :eid);
  RETURN w;
END^

-- aim at the enemy (leading projectiles when skilled enough), scattered by the aim accuracy, and fire
-- BotAggression (ai_dmq3.c): how keen on a fight the bot is, 0 to 100. With the quad 70 (unless it holds the
-- gauntlet far from the enemy); none with the enemy 200 above, under 60 health, or under 80 without 40 armour;
-- else by the best gun it holds: BFG 100, railgun 95, lightning and rockets 90, plasma 85, grenades 80,
-- shotgun 50, nothing better 0; each gun with enough ammunition for a fight (more than 7 for the BFG, 5 slugs,
-- 50 lightning, 5 rockets, 40 cells, 10 grenades, 10 shells).
-- BotWantsToRetreat is under 50, BotWantsToChase over 50.
CREATE OR ALTER FUNCTION bot_aggression (eid INTEGER, enemy INTEGER) RETURNS INTEGER
AS
DECLARE hp INTEGER; DECLARE av INTEGER; DECLARE w INTEGER; DECLARE wn INTEGER; DECLARE qf DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
BEGIN
  SELECT e.health, e.armor, e.weapons, e.weapon, COALESCE(e.quad_finished, 0), e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO hp, av, w, wn, qf, x, y, z;
  SELECT o.x, o.y, o.z FROM ents o WHERE o.id = :enemy INTO ex, ey, ez;
  IF (qf > now_() AND (wn <> 1 OR vlen(ex - x, ey - y, 0) < 80)) THEN RETURN 70;
  IF (ez - z > 200) THEN RETURN 0;
  IF (hp < 60) THEN RETURN 0;
  IF (hp < 80 AND COALESCE(av, 0) < 40) THEN RETURN 0;
  -- (a gun with enough ammunition for a fight)
  IF (BIN_AND(w, 256) <> 0 AND ent_ammo(eid, 9) > 7) THEN RETURN 100;
  IF (BIN_AND(w, 64) <> 0 AND ent_ammo(eid, 7) > 5) THEN RETURN 95;
  IF (BIN_AND(w, 32) <> 0 AND ent_ammo(eid, 6) > 50) THEN RETURN 90;
  IF (BIN_AND(w, 16) <> 0 AND ent_ammo(eid, 5) > 5) THEN RETURN 90;
  IF (BIN_AND(w, 128) <> 0 AND ent_ammo(eid, 8) > 40) THEN RETURN 85;
  IF (BIN_AND(w, 8) <> 0 AND ent_ammo(eid, 4) > 10) THEN RETURN 80;
  IF (BIN_AND(w, 4) <> 0 AND ent_ammo(eid, 3) > 10) THEN RETURN 50;
  RETURN 0;
END^

-- AINode_Battle_Retreat's goal: an item to run for while keeping the enemy under fire, the nearest that is
-- worth it the most (health the more the lower the bot's, armour, a gun it lacks, a powerup). botlib takes the
-- long-term goal anywhere through the AAS; here it is one in sight on about the same level, as the waypoint
-- routes over q3dm17's void lose too many bots to falls
CREATE OR ALTER FUNCTION bot_retreat_goal (eid INTEGER) RETURNS INTEGER
AS
DECLARE hp INTEGER; DECLARE w INTEGER; DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE g INTEGER;
BEGIN
  SELECT e.health, e.weapons, e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO hp, w, x, y, z;
  SELECT FIRST 1 g.id FROM ents g JOIN item_defs i ON i.cls = g.item
   WHERE g.classname = 'item' AND g.solid = 1 AND ABS(g.x - :x) < 1200 AND ABS(g.y - :y) < 1200 AND ABS(g.z - :z) < 150
     AND (i.kind <> 'W' OR BIN_AND(:w, i.bit) = 0) AND i.kind IN ('H', 'A', 'W', 'P') AND (i.kind <> 'H' OR :hp < 100) AND NOT (i.kind = 'P' AND i.bit = 32)
   ORDER BY ABS(g.x - :x) + ABS(g.y - :y) + ABS(g.z - :z) * 2
            - CASE i.kind WHEN 'H' THEN (125 - :hp) * 8 WHEN 'A' THEN 300 WHEN 'W' THEN 500 ELSE 800 END
    INTO g;
  IF (g IS NOT NULL AND visible(eid, g) = 0) THEN g = NULL;
  RETURN g;
END^

-- BotCheckSnapshot's avoid spots: a grenade in flight or lying about keeps a bot 160 units off
-- (trap_BotAddAvoidSpot, AVOID_ALWAYS); here the bot steps straight away from the nearest. 1 when it did
CREATE OR ALTER FUNCTION bot_avoid_grenade (eid INTEGER, spd DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO x, y, z;
  SELECT FIRST 1 g.x, g.y FROM ents g WHERE g.classname = 'grenade' AND ABS(g.x - :x) < 160 AND ABS(g.y - :y) < 160 AND ABS(g.z - :z) < 160
     AND vlen(g.x - :x, g.y - :y, g.z - :z) < 160 ORDER BY vlen(g.x - :x, g.y - :y, g.z - :z) INTO gx, gy;
  IF (gx IS NULL) THEN RETURN 0;
  IF (step_direction(eid, vectoyaw(x - gx + 0.01e0, y - gy), spd) = 1) THEN RETURN 1;
  -- straight away is blocked: either side of it
  IF (step_direction(eid, anglemod(vectoyaw(x - gx + 0.01e0, y - gy) + 60), spd) = 1) THEN RETURN 1;
  RETURN step_direction(eid, anglemod(vectoyaw(x - gx + 0.01e0, y - gy) - 60), spd);
END^

CREATE OR ALTER PROCEDURE bot_fire (eid INTEGER)
AS
DECLARE enemy INTEGER; DECLARE w INTEGER; DECLARE skill SMALLINT;
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE fx DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE dl DOUBLE PRECISION; DECLARE err DOUBLE PRECISION;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION; DECLARE lead DOUBLE PRECISION;
DECLARE tf DOUBLE PRECISION; DECLARE ttx DOUBLE PRECISION; DECLARE tty DOUBLE PRECISION; DECLARE ttz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION;
DECLARE tsf INTEGER; DECLARE tct INTEGER; DECLARE tas SMALLINT; DECLARE tss SMALLINT; DECLARE thit INTEGER;
DECLARE acc DOUBLE PRECISION; DECLARE askill DOUBLE PRECISION;
DECLARE vyaw DOUBLE PRECISION; DECLARE vpitch DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE ap DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE bot_w_shot(eid);   -- (counted, when the guns are being measured)
  SELECT e.enemy_id, e.weapon, COALESCE(b.skill, 2) FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO enemy, w, skill;
  IF (enemy IS NULL) THEN EXIT;
  EXECUTE PROCEDURE eye_of(eid) RETURNING_VALUES ex, ey, ez, fx, fy, fz;
  -- the character's aim for this gun (CHARACTERISTIC_AIM_ACCURACY_ROCKETLAUNCHER …, else the general one)
  acc = bot_cv(eid, 'aim_accuracy_' || weapon_char_name(w), bot_cv(eid, 'aim_accuracy', NULL));
  askill = bot_cv(eid, 'aim_skill_' || weapon_char_name(w), bot_cv(eid, 'aim_skill', NULL));
  -- aim at the chest; a skilled bot leads projectiles by the target's velocity, a poor one aims where it was
  -- (an aim skill over 0.5 predicts the movement; without the character files, skill 3 and up)
  lead = IIF(IIF(askill IS NULL, skill >= 3, askill > 0.5e0), CASE w WHEN 16 THEN 1 / 900e0 WHEN 128 THEN 1 / 2000e0 WHEN 8 THEN 1 / 700e0 ELSE 0 END, 0);
  SELECT o.x + o.vx * :lead * vlen(o.x - :ex, o.y - :ey, o.z - :ez) - IIF(:skill <= 2, o.vx * 0.1e0, 0) + IIF(o.solid = 4, (o.minx + o.maxx) / 2, 0),
         o.y + o.vy * :lead * vlen(o.x - :ex, o.y - :ey, o.z - :ez) - IIF(:skill <= 2, o.vy * 0.1e0, 0) + IIF(o.solid = 4, (o.miny + o.maxy) / 2, 0),
         o.z + (o.minz + o.maxz) / 2 + IIF(o.solid = 4, 0, 8)   -- (a brush model, a button shot at: its middle)
    FROM ents o WHERE o.id = :enemy INTO tx, ty, tz;
  dx = tx - ex; dy = ty - ey; dz = tz - ez;
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN EXIT;
  -- the scatter (BotAimAtEnemy): under 0.8 accuracy each part of the aim's direction is off by up to
  -- 0.3 × (1 - accuracy); a bullet, a shotgun blast, the lightning and the rail are less accurate up close
  -- (× 0.6 at the muzzle to × 1 at 150). Without the character files, a fraction of the distance by skill
  IF (acc IS NULL) THEN err = dl * bot_char(skill, 'aim');
  ELSE
  BEGIN
    IF (w IN (2, 4, 32, 64)) THEN acc = acc * (0.6e0 + MINVALUE(dl, 150) / 150 * 0.4e0);
    err = dl * IIF(acc < 0.8e0, 0.3e0 * (1 - MAXVALUE(acc, 0.0001e0)), 0);
  END
  -- BotAimAtEnemy: at an invisible enemy the aim is 0.4 as good, nine times in ten
  IF (RAND() > 0.1e0 AND EXISTS (SELECT 1 FROM ents o LEFT JOIN player p ON p.ent_id = o.id WHERE o.id = :enemy AND IIF(o.classname = 'player', p.invis_finished, o.invis_finished) > now_())) THEN err = err / 0.4e0;
  -- the shot goes where the view looks (FireWeapon takes the client's view angles; the view turns toward the
  -- aim by BotChangeViewAngles, change_yaw), the scatter taken as an angle off it: once the view is on the
  -- target the shot is the aim, while it is still turning the shot falls behind
  SELECT e.yaw, COALESCE(e.pitch, 0) FROM ents e WHERE e.id = :eid INTO vyaw, vpitch;
  ay = vectoyaw(dx, dy); ap = -ATAN2(dz, vlen(dx, dy, 0)) * 57.29578e0;
  dx = dx + crand() * err; dy = dy + crand() * err; dz = dz + crand() * err * 0.7e0;
  vyaw = vyaw + anglemod(vectoyaw(dx, dy) - ay + 180) - 180;
  vpitch = vpitch + (-ATAN2(dz, vlen(dx, dy, 0)) * 57.29578e0 - ap);
  dx = COS(vpitch * 0.0174532925e0) * COS(vyaw * 0.0174532925e0) * dl;
  dy = COS(vpitch * 0.0174532925e0) * SIN(vyaw * 0.0174532925e0) * dl;
  dz = -SIN(vpitch * 0.0174532925e0) * dl;
  -- BotCheckAttack: a teammate in the line of fire holds it
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) >= 3) THEN
  BEGIN
    EXECUTE PROCEDURE trace_move(eid, 0, 0, 0, 0, 0, 0, ex, ey, ez, tx, ty, tz, 100663297)
      RETURNING_VALUES tf, ttx, tty, ttz, tnx, tny, tnz, tsf, tct, tas, tss, thit;
    IF (thit IS NOT NULL AND thit <> enemy AND on_same_team(eid, thit) = 1) THEN EXIT;
  END
  -- PM_Weapon: a gun out of ammunition does not fire (EV_NOAMMO) and loses half a second; BotChooseWeapon's
  -- weights, which count the ammunition, take another. A shot uses one
  IF (weapon_ammo(w) > 0) THEN
  BEGIN
    IF (ent_ammo(eid, weapon_ammo(w)) <= 0) THEN
    BEGIN
      UPDATE ents e SET e.attack_finished = now_() + 0.5e0 WHERE e.id = :eid;
      EXIT;
    END
    EXECUTE PROCEDURE bot_add_ammo(eid, weapon_ammo(w), -1);
  END
  EXECUTE PROCEDURE fire_weapon(eid, w, ex + fx * 14, ey + fy * 14, ez + fz * 14, dx, dy, dz, 1);
  EXECUTE PROCEDURE set_anims(eid, NULL, IIF(w = 1, 8, 7));
END^

-- Touch_Item for a bot: no inventory beyond health, armour, weapons and the powerups (flight left to the player)
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
    -- Pickup_Weapon: the gun and its quantity of ammunition; a gun of the map's (not one dropped, not in team
    -- play) gives only what is short of that quantity, or a single shot when the bot has as much already
    IF (NOT EXISTS (SELECT 1 FROM ents i WHERE i.id = :item AND i.think = 'remove') AND (SELECT g.gametype FROM game g WHERE g.id = 1) <> 3) THEN
      qty = IIF(ent_ammo(other, weapon_ammo(bit_)) < qty, qty - ent_ammo(other, weapon_ammo(bit_)), 1);
    UPDATE ents e SET e.weapons = BIN_OR(e.weapons, :bit_) WHERE e.id = :other;
    IF (weapon_ammo(bit_) > 0) THEN EXECUTE PROCEDURE bot_add_ammo(other, weapon_ammo(bit_), qty);
  END
  ELSE IF (kind = 'P' AND bit_ <> 32) THEN
    UPDATE ents e SET e.quad_finished = IIF(:bit_ = 1, MAXVALUE(e.quad_finished, now_()) + :qty, e.quad_finished),
           e.enviro_finished = IIF(:bit_ = 2, MAXVALUE(e.enviro_finished, now_()) + :qty, e.enviro_finished),
           e.haste_finished = IIF(:bit_ = 4, MAXVALUE(e.haste_finished, now_()) + :qty, e.haste_finished),
           e.invis_finished = IIF(:bit_ = 8, MAXVALUE(e.invis_finished, now_()) + :qty, e.invis_finished),
           e.regen_finished = IIF(:bit_ = 16, MAXVALUE(e.regen_finished, now_()) + :qty, e.regen_finished) WHERE e.id = :other;
  ELSE IF (kind = 'O') THEN
  BEGIN
    -- Pickup_Holdable; BG_CanItemBeGrabbed: one at a time
    IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :other AND e.hold_item <> 0)) THEN EXIT;
    UPDATE ents e SET e.hold_item = :bit_ WHERE e.id = :other;
  END
  ELSE IF (kind = 'M') THEN
  BEGIN
    -- Pickup_Ammo; BG_CanItemBeGrabbed leaves it at 200
    IF (ent_ammo(other, bit_) >= 200) THEN EXIT;
    EXECUTE PROCEDURE bot_add_ammo(other, bit_, qty);
  END
  ELSE EXIT;
  EXECUTE PROCEDURE snd(other, 3, snd_, 1, 1);
  EXECUTE PROCEDURE item_taken(item, IIF(kind = 'W', 5, resp));
  -- botlib's avoid goal (BotReachedGoal touching it: BotSetAvoidGoalTime by its items.c respawntime)
  EXECUTE PROCEDURE bot_avoid_item(other, item);
END^

-- BotBattleUseItems (ai_dmq3.c): in a fight, under 40 health a bot with the personal teleporter uses it (to a
-- spawn point, SelectSpawnPoint), under 60 one with the medkit (its health to the maximum + 25). Returns 1
-- when it teleported (the think is over: it is elsewhere)
CREATE OR ALTER FUNCTION bot_use_items (eid INTEGER) RETURNS SMALLINT
AS
DECLARE hp INTEGER; DECLARE h SMALLINT; DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION;
BEGIN
  SELECT e.health, e.hold_item FROM ents e WHERE e.id = :eid INTO hp, h;
  IF (h = 1 AND hp < 40) THEN
  BEGIN
    UPDATE ents e SET e.hold_item = 0 WHERE e.id = :eid;
    EXECUTE PROCEDURE select_spawn(eid) RETURNING_VALUES x, y, z, yaw;
    IF (x IS NOT NULL) THEN EXECUTE PROCEDURE teleport_ent(eid, x, y, z, COALESCE(yaw, 0));
    RETURN 1;
  END
  IF (h = 2 AND hp < 60) THEN
  BEGIN
    UPDATE ents e SET e.hold_item = 0, e.health = e.max_health + 25 WHERE e.id = :eid;
    EXECUTE PROCEDURE snd(eid, 3, 'sound/items/use_medkit.wav', 1, 1);
  END
  RETURN 0;
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
           e.attack_finished = IIF(:enemy IS DISTINCT FROM :attacker, MAXVALUE(e.attack_finished, now_() + bot_cv(:eid, 'reactiontime', bot_char(:skill, 'reaction')) * 0.5e0), e.attack_finished) WHERE e.id = :eid;
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
  -- (the learned fight moves: the fight's end for the dead, 50 for the frag to a bot that made it)
  EXECUTE PROCEDURE bot_rl_end(eid);
  UPDATE ents e SET e.rl_given = e.rl_given + 50 WHERE e.id = :attacker AND e.classname = 'bot' AND e.id <> :eid;
  EXECUTE PROCEDURE bot_chat_event(eid, 'death', attacker, mod_);   -- BotChat_Death
  UPDATE ents e SET e.solid = 0 WHERE e.id = :eid;
  EXECUTE PROCEDURE toss_client_items(eid);   -- the gun and the powerups fall (TossClientItems)
  UPDATE ents e SET e.deadflag = 1, e.st = 'dead', e.solid = 0, e.movetype = 0, e.takedamage = 0, e.alpha = 1, e.enemy_id = NULL, e.goal_id = NULL, e.nbg_id = NULL, e.viewheight = -16,
         e.respawn_time = :t + 2.5e0 + RAND() * 2, e.deaths = e.deaths + 1, e.vx = 0, e.vy = 0, e.vz = 0, e.quad_finished = 0,
         e.haste_finished = 0, e.invis_finished = 0, e.regen_finished = 0, e.enviro_finished = 0, e.nextthink = :t + 0.5e0 WHERE e.id = :eid;
  IF (hp < -40) THEN
  BEGIN
    EXECUTE PROCEDURE gib_ent(eid, -hp);
    EXIT;
  END
  EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || pm || '/death' || CAST(1 + FLOOR(RAND() * 3) AS INTEGER) || '.wav', 1, 1);
  EXECUTE PROCEDURE spawn_ent('corpse', (SELECT e.x FROM ents e WHERE e.id = :eid), (SELECT e.y FROM ents e WHERE e.id = :eid), (SELECT e.z FROM ents e WHERE e.id = :eid)) RETURNING_VALUES c;
  UPDATE ents e SET e.pmodel = :pm, e.pskin = :ps, e.yaw = (SELECT o.yaw FROM ents o WHERE o.id = :eid), e.solid = 2, e.movetype = 6, e.clipmask = 65537, e.takedamage = 1, e.health = 0, e.deadflag = 1,
         e.minx = -15, e.miny = -15, e.minz = -24, e.maxx = 15, e.maxy = 15, e.maxz = -8, e.legs_anim = CAST(FLOOR(RAND() * 3) AS INTEGER) * 2, e.legs_time = :t, e.torso_anim = -1, e.weapon = 0 WHERE e.id = :c;
  EXECUTE PROCEDURE body_queue(c, eid);
  EXECUTE PROCEDURE link_ent(c);
END^

CREATE OR ALTER PROCEDURE bot_respawn (eid INTEGER)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
BEGIN
  t = now_();
  EXECUTE PROCEDURE body_release(eid);
  EXECUTE PROCEDURE select_spawn(eid) RETURNING_VALUES x, y, z, yaw;
  UPDATE ents e SET e.x = :x, e.y = :y, e.z = :z + 9, e.yaw = COALESCE(:yaw, 0), e.ideal_yaw = COALESCE(:yaw, 0), e.pitch = 0, e.vx = 0, e.vy = 0, e.vz = 0,
         e.solid = 3, e.movetype = 4, e.takedamage = 2, e.alpha = 0, e.deadflag = 0, e.viewheight = 26, e.maxz = 32, e.attack_crouch = NULL, e.hold_item = 0, e.health = 125, e.armor = 0, e.weapons = 3, e.weapon = 2,
         e.ammo2 = IIF((SELECT g.gametype FROM game g WHERE g.id = 1) = 3, 50, 100), e.ammo3 = 0, e.ammo4 = 0, e.ammo5 = 0, e.ammo6 = 0, e.ammo7 = 0, e.ammo8 = 0, e.ammo9 = 0,
         e.flags = 32, e.st = 'stand', e.legs_anim = 22, e.legs_time = :t, e.torso_anim = 11, e.torso_time = :t, e.enemy_id = NULL, e.goal_id = NULL, e.nbg_id = NULL, e.nbg_check = NULL, e.act_id = NULL, e.act_until = NULL, e.rl_a = NULL, e.def_away = 0,
         e.camp_id = IIF(EXISTS (SELECT 1 FROM ents c WHERE c.id = e.camp_id AND c.classname = 'camp_order'), e.camp_id, NULL),
         e.camp_until = IIF(EXISTS (SELECT 1 FROM ents c WHERE c.id = e.camp_id AND c.classname = 'camp_order'), e.camp_until, NULL),
         e.attack_finished = :t + 1, e.teleport_time = :t + 0.3e0, e.lx = NULL, e.nextthink = :t + 0.1e0, e.think = 'bot_think', e.respawn_time = 0,
         e.quad_finished = 0, e.haste_finished = 0, e.invis_finished = 0, e.regen_finished = 0, e.enviro_finished = 0, e.health_tick = :t + 1,
         e.yaw_speed = COALESCE(MAXVALUE(240, bot_cv(:eid, 'view_maxchange', NULL)) / 10, bot_char((SELECT b.skill FROM bot_defs b WHERE b.name = e.bot), 'turn')),
         e.view_factor = bot_cv(:eid, 'view_factor', 1), e.ideal_pitch = NULL WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
  EXECUTE PROCEDURE kill_box(eid);   -- (ClientSpawn's G_KillBox: whoever stands in the spot is telefragged)
  EXECUTE PROCEDURE snd_at(x, y, z, 'sound/world/telein.wav', 1, 1);
  EXECUTE PROCEDURE fx(5, x, y, z + 9, 0, 0, 0, 1);
END^

-- ── the 10 Hz bot frame ──────────────────────────────────────────────────
-- ── team play (ai_team.c) ────────────────────────────────────────────────
-- the team's k-th member (0 first) in client order: the player, then the bots as they came
CREATE OR ALTER FUNCTION team_mate_at (tm SMALLINT, k INTEGER) RETURNS INTEGER
AS
DECLARE id INTEGER;
BEGIN
  SELECT FIRST 1 SKIP (:k) e.id FROM ents e WHERE e.classname IN ('player', 'bot') AND team_member(e.id, :tm) = 1
   ORDER BY IIF(e.classname = 'player', 0, 1), e.id INTO id;
  RETURN id;
END^

-- BotMatch_HelpAccompany: a bot told to accompany a teammate (LTG_TEAMACCOMPANY) for TEAM_ACCOMPANY_TIME,
-- 600 seconds; it answers within two (accompany_start, to the one who ordered it). Not itself
CREATE OR ALTER PROCEDURE bot_order_accompany (eid INTEGER, mate INTEGER, by_ INTEGER)
AS
DECLARE t DOUBLE PRECISION;
BEGIN
  IF (eid = mate OR NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.classname = 'bot')) THEN EXIT;
  t = now_();
  UPDATE ents e SET e.acc_id = :mate, e.acc_by = :by_, e.acc_until = :t + 600, e.acc_msg = :t + 2 * RAND(), e.acc_arrived = 0, e.acc_arrive_t = NULL WHERE e.id = :eid;
END^

-- BotCreateGroup: the others of the group follow its first; the leader tells each (cmd_accompanyme when
-- it is the first itself, else cmd_accompany), BotSayTeamOrderAlways
CREATE OR ALTER PROCEDURE bot_create_group (eid INTEGER, tm SMALLINT, k0 INTEGER, size_ INTEGER)
AS
DECLARE g0 INTEGER; DECLARE m INTEGER; DECLARE i INTEGER = 1;
BEGIN
  g0 = team_mate_at(tm, k0);
  WHILE (i < size_) DO
  BEGIN
    m = team_mate_at(tm, k0 + i);
    IF (g0 IS NOT NULL AND m IS NOT NULL) THEN
    BEGIN
      IF (g0 = eid) THEN EXECUTE PROCEDURE bot_say(eid, 'cmd_accompanyme', chat_name(m), NULL, NULL, NULL, NULL, NULL, m, 0);
      ELSE EXECUTE PROCEDURE bot_say(eid, 'cmd_accompany', chat_name(m), chat_name(g0), NULL, NULL, NULL, NULL, m, 0);
      EXECUTE PROCEDURE bot_order_accompany(m, g0, eid);
    END
    i = i + 1;
  END
END^

-- BotTeamOrders (team deathmatch): three make a pair and one roams, four two pairs, five a pair and a
-- three, six to ten pairs, more nothing
CREATE OR ALTER PROCEDURE bot_team_orders (eid INTEGER)
AS
DECLARE tm SMALLINT; DECLARE n INTEGER; DECLARE i INTEGER = 0;
BEGIN
  SELECT e.pteam FROM ents e WHERE e.id = :eid INTO tm;
  SELECT COUNT(*) FROM ents e WHERE e.classname IN ('player', 'bot') AND team_member(e.id, :tm) = 1 INTO n;
  IF (n = 3) THEN EXECUTE PROCEDURE bot_create_group(eid, tm, 0, 2);
  ELSE IF (n = 4) THEN BEGIN EXECUTE PROCEDURE bot_create_group(eid, tm, 0, 2); EXECUTE PROCEDURE bot_create_group(eid, tm, 2, 2); END
  ELSE IF (n = 5) THEN BEGIN EXECUTE PROCEDURE bot_create_group(eid, tm, 0, 2); EXECUTE PROCEDURE bot_create_group(eid, tm, 2, 3); END
  ELSE IF (n >= 6 AND n <= 10) THEN
    WHILE (i < n / 2) DO BEGIN EXECUTE PROCEDURE bot_create_group(eid, tm, i * 2, 2); i = i + 1; END
END^

-- BotTeamAI (team deathmatch): with no leader the team's human leads (FindHumanTeamLeader); without one a
-- bot that came in the first ten seconds asks who leads after 5 to 15 (whoisteamleader) and takes the lead
-- 8 to 18 later (iamteamleader), a later one takes it 5 to 15 seconds on; the first to say it leads. The
-- leader gives its orders 5 seconds after the team's size changes, and again every 120
CREATE OR ALTER PROCEDURE bot_team_ai (eid INTEGER)
AS
DECLARE t DOUBLE PRECISION; DECLARE tm SMALLINT; DECLARE leader INTEGER; DECLARE ask DOUBLE PRECISION; DECLARE become DOUBLE PRECISION;
DECLARE orders DOUBLE PRECISION; DECLARE mates SMALLINT; DECLARE enter DOUBLE PRECISION; DECLARE n INTEGER;
BEGIN
  t = now_();
  SELECT e.pteam, e.tl_ask, e.tl_become, e.tl_orders, e.tl_mates, e.enter_time FROM ents e WHERE e.id = :eid INTO tm, ask, become, orders, mates, enter;
  IF (team_member(eid, tm) = 0) THEN EXIT;
  SELECT IIF(:tm = 1, g.red_leader, g.blue_leader) FROM game g WHERE g.id = 1 INTO leader;
  IF (leader IS NOT NULL AND team_member(leader, tm) = 0) THEN leader = NULL;   -- BotValidTeamLeader
  IF (leader IS NULL AND (SELECT g.not_leader FROM game g WHERE g.id = 1) = 0) THEN
    SELECT e.id FROM ents e WHERE e.classname = 'player' AND team_member(e.id, :tm) = 1 INTO leader;
  IF (leader IS NULL) THEN
  BEGIN
    IF (ask = 0 AND become = 0) THEN
    BEGIN
      IF (enter + 10 > t) THEN ask = t + 5 + RAND() * 10;
      ELSE become = t + 5 + RAND() * 10;
    END
    IF (ask > 0 AND ask < t) THEN
    BEGIN
      EXECUTE PROCEDURE bot_say(eid, 'whoisteamleader', NULL, NULL, NULL, NULL, NULL, NULL, -1, 0);
      ask = 0; become = t + 8 + RAND() * 10;
    END
    IF (become > 0 AND become < t) THEN
    BEGIN
      EXECUTE PROCEDURE bot_say(eid, 'iamteamleader', NULL, NULL, NULL, NULL, NULL, NULL, -1, 0);
      leader = eid; become = 0;
      UPDATE game g SET g.red_leader = IIF(:tm = 1, :eid, g.red_leader), g.blue_leader = IIF(:tm = 2, :eid, g.blue_leader) WHERE g.id = 1;
    END
    UPDATE ents e SET e.tl_ask = :ask, e.tl_become = :become WHERE e.id = :eid;
    EXIT;
  END
  UPDATE game g SET g.red_leader = IIF(:tm = 1, :leader, g.red_leader), g.blue_leader = IIF(:tm = 2, :leader, g.blue_leader) WHERE g.id = 1;
  IF (leader <> eid) THEN
  BEGIN
    UPDATE ents e SET e.tl_ask = 0, e.tl_become = 0 WHERE e.id = :eid AND (e.tl_ask <> 0 OR e.tl_become <> 0);
    EXIT;
  END
  SELECT COUNT(*) FROM ents e WHERE e.classname IN ('player', 'bot') AND team_member(e.id, :tm) = 1 INTO n;
  IF (n <> mates) THEN BEGIN orders = t; mates = n; END
  IF (orders > 0 AND orders < t - 5) THEN
  BEGIN
    EXECUTE PROCEDURE bot_team_orders(eid);
    orders = t + 120;
  END
  UPDATE ents e SET e.tl_ask = 0, e.tl_become = 0, e.tl_orders = :orders, e.tl_mates = :mates WHERE e.id = :eid;
END^

-- BotGetLongTermGoal for LTG_TEAMACCOMPANY: says it will (to the one who ordered it), gives up after the
-- 600 seconds (accompany_stop, to the companion), and while the companion is alive, in sight and within
-- the formation distance (3.5 × 32) stands by looking where it looks, saying once that it arrived
-- (accompany_arrive); else goes to it. `busy` 0: no companion, the bot picks its own goal; `go` the
-- companion to go to, NULL to stay; `crouch` 1 while it crouches by it
-- Standing by (BotGetLongTermGoal's LTG_TEAMACCOMPANY, within the formation distance): bumped into by the
-- companion looking its way, it backs off; it crouches now and then (croucher, as camping); 2 s after arriving
-- it looks at the companion, then about for enemies (BotRoamGoal); a gesture on arriving and now and then
CREATE OR ALTER FUNCTION bot_roam_yaw (eid INTEGER) RETURNS DOUBLE PRECISION AS BEGIN RETURN 0; END^

CREATE OR ALTER PROCEDURE bot_accompany (eid INTEGER)
RETURNS (busy SMALLINT, go INTEGER, crouch SMALLINT)
AS
DECLARE t DOUBLE PRECISION; DECLARE mate INTEGER; DECLARE by_ INTEGER; DECLARE until_ DOUBLE PRECISION; DECLARE msg_t DOUBLE PRECISION;
DECLARE arrived SMALLINT; DECLARE tm SMALLINT; DECLARE d DOUBLE PRECISION; DECLARE mhp INTEGER; DECLARE myaw DOUBLE PRECISION;
DECLARE at_ DOUBLE PRECISION; DECLARE ct_ DOUBLE PRECISION; DECLARE cr DOUBLE PRECISION; DECLARE touch SMALLINT; DECLARE ux DOUBLE PRECISION; DECLARE uy DOUBLE PRECISION;
DECLARE ul DOUBLE PRECISION; DECLARE moved SMALLINT;
BEGIN
  busy = 0; go = NULL; crouch = 0;
  SELECT e.acc_id, e.acc_by, e.acc_until, e.acc_msg, e.acc_arrived, e.pteam, e.acc_arrive_t, e.attack_crouch FROM ents e WHERE e.id = :eid
    INTO mate, by_, until_, msg_t, arrived, tm, at_, ct_;
  IF (mate IS NULL) THEN EXIT;
  t = now_();
  IF (team_member(mate, tm) = 0 OR team_member(eid, tm) = 0) THEN
  BEGIN
    UPDATE ents e SET e.acc_id = NULL WHERE e.id = :eid;
    EXIT;
  END
  IF (msg_t > 0 AND msg_t < t) THEN
  BEGIN
    EXECUTE PROCEDURE bot_say(eid, 'accompany_start', chat_name(mate), NULL, NULL, NULL, NULL, NULL, COALESCE(by_, mate), 0);
    UPDATE ents e SET e.acc_msg = 0 WHERE e.id = :eid;
  END
  IF (until_ < t) THEN
  BEGIN
    EXECUTE PROCEDURE bot_say(eid, 'accompany_stop', chat_name(mate), NULL, NULL, NULL, NULL, NULL, mate, 0);
    UPDATE ents e SET e.acc_id = NULL WHERE e.id = :eid;
    EXIT;
  END
  busy = 1;
  SELECT vlen(m.x - e.x, m.y - e.y, m.z - e.z), m.health, m.yaw, e.x - m.x, e.y - m.y,
         IIF(e.z + e.maxz > m.z + m.minz AND e.x + e.maxx > m.x + m.minx - 4 AND e.x + e.minx < m.x + m.maxx + 4
             AND e.y + e.maxy > m.y + m.miny - 4 AND e.y + e.miny < m.y + m.maxy + 4
             AND e.z + e.maxz > m.z + m.minz - 4 AND e.z + e.minz < m.z + m.maxz + 4, 1, 0)
    FROM ents m JOIN ents e ON e.id = :eid WHERE m.id = :mate INTO d, mhp, myaw, ux, uy, touch;
  IF (mhp > 0 AND d < 112 AND visible(eid, mate) = 1) THEN
  BEGIN
    -- bumped into by the companion, its look this way (within 45 degrees): back off
    ul = vlen(ux, uy, 0);
    IF (touch = 1 AND ul > 0 AND (COS(myaw * 0.0174532925e0) * ux + SIN(myaw * 0.0174532925e0) * uy) / ul > 0.7e0) THEN
      moved = step_direction(eid, vectoyaw(ux, uy), 20);
    -- a crouch now and then, not within 5 s of the last (croucher, a chance of it a second)
    IF (COALESCE(ct_, 0) < t - 5) THEN
    BEGIN
      cr = bot_cv(eid, 'croucher', 0);
      IF (RAND() < 0.1e0 * cr) THEN
      BEGIN
        ct_ = t + 5 + cr * 15;
        UPDATE ents e SET e.attack_crouch = :ct_ WHERE e.id = :eid;
      END
    END
    IF (at_ IS NULL OR at_ < t - 2) THEN
    BEGIN
      IF (arrived = 0) THEN
      BEGIN
        -- arrived: a gesture (TORSO_GESTURE, EV_TAUNT's taunt) and the word
        EXECUTE PROCEDURE set_anims(eid, NULL, 6);
        EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || COALESCE((SELECT e.pmodel FROM ents e WHERE e.id = :eid), 'sarge') || '/taunt.wav', 1, 1);
        EXECUTE PROCEDURE bot_say(eid, 'accompany_arrive', chat_name(mate), NULL, NULL, NULL, NULL, NULL, mate, 0);
        UPDATE ents e SET e.acc_arrived = 1, e.acc_arrive_t = :t WHERE e.id = :eid;
        at_ = t;
      END
      ELSE IF (COALESCE(ct_, 0) > t) THEN crouch = 1;
      ELSE IF (RAND() < 0.005e0) THEN
      BEGIN
        EXECUTE PROCEDURE set_anims(eid, NULL, 6);
        EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || COALESCE((SELECT e.pmodel FROM ents e WHERE e.id = :eid), 'sarge') || '/taunt.wav', 1, 1);
      END
    END
    -- just arrived: look at the companion; then about for enemies, now and then (0.8 × the think's 0.1 s)
    IF (at_ > t - 2) THEN UPDATE ents e SET e.ideal_yaw = vectoyaw(-:ux, -:uy) WHERE e.id = :eid;
    ELSE IF (RAND() < 0.08e0) THEN UPDATE ents e SET e.ideal_yaw = bot_roam_yaw(:eid) WHERE e.id = :eid;
    EXECUTE PROCEDURE change_yaw(eid);
    EXIT;
  END
  go = mate;
END^

-- BotRoamGoal: where a camping bot looks, a point 100 to 900 units off on x, y or both (and up to 96 up or down),
-- short of the wall the line meets, over a floor that is not lava or slime; ten tries, else the last. Its yaw
CREATE OR ALTER FUNCTION bot_roam_yaw (eid INTEGER) RETURNS DOUBLE PRECISION
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE i INTEGER = 0; DECLARE rnd DOUBLE PRECISION;
DECLARE bx DOUBLE PRECISION; DECLARE by_ DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION; DECLARE len DOUBLE PRECISION; DECLARE k DOUBLE PRECISION;
DECLARE tf DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION; DECLARE tsf INTEGER; DECLARE tct INTEGER;
DECLARE tals SMALLINT; DECLARE tsts SMALLINT; DECLARE thit INTEGER;
BEGIN
  SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO x, y, z;
  WHILE (i < 10) DO
  BEGIN
    i = i + 1;
    bx = x; by_ = y; bz = z;
    rnd = RAND();
    IF (rnd > 0.25e0) THEN bx = bx + IIF(RAND() < 0.5e0, -1, 1) * (800 * RAND() + 100);
    IF (rnd < 0.75e0) THEN by_ = by_ + IIF(RAND() < 0.5e0, -1, 1) * (800 * RAND() + 100);
    bz = bz + 2 * 48 * crand();
    EXECUTE PROCEDURE trace_move(eid, 0, 0, 0, 0, 0, 0, x, y, z, bx, by_, bz, 1)
      RETURNING_VALUES tf, tx, ty, tz, tnx, tny, tnz, tsf, tct, tals, tsts, thit;
    len = vlen(tx - x, ty - y, tz - z);
    IF (len > 200) THEN
    BEGIN
      -- (the direction scaled by len × fraction − 40, as the game has it)
      k = (len * tf - 40) / len;
      bx = x + (tx - x) * k; by_ = y + (ty - y) * k; bz = z + (tz - z) * k;
      EXECUTE PROCEDURE trace_move(eid, 0, 0, 0, 0, 0, 0, bx, by_, bz, bx, by_, bz - 800, 1)
        RETURNING_VALUES tf, tx, ty, tz, tnx, tny, tnz, tsf, tct, tals, tsts, thit;
      IF (tsts = 0 AND BIN_AND(point_contents(tx, ty, tz + 1), 8 + 16) = 0) THEN LEAVE;
    END
  END
  RETURN vectoyaw(bx - x, by_ - y);
END^

-- BotWantsToCamp, every half second while seeking a long-term goal: a bot with a camper characteristic of 0.1
-- or more, not camping or on a team goal, not camped too recently (within 60 − 300 × (1 − camper) s), with a
-- chance of its camper, an aggression of 50 or more and the rocket launcher, the railgun or the BFG with ten
-- shots, goes to the nearest info_camp within 1.5 s (BotGoCamp) to stay 120 + 180 × camper + up to 15 s, for
-- ever over 0.99. The spot, or NULL
CREATE OR ALTER FUNCTION bot_wants_to_camp (eid INTEGER) RETURNS INTEGER
AS
DECLARE camper DOUBLE PRECISION; DECLARE t DOUBLE PRECISION; DECLARE ct DOUBLE PRECISION; DECLARE w INTEGER;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE best INTEGER; DECLARE bt DOUBLE PRECISION = 99999; DECLARE cid INTEGER; DECLARE tt DOUBLE PRECISION;
BEGIN
  camper = bot_cv(eid, 'camper', 0);
  IF (camper < 0.1e0) THEN RETURN NULL;
  t = now_();
  SELECT e.camp_time, e.weapons, e.x, e.y, e.z FROM ents e WHERE e.id = :eid AND e.camp_id IS NULL AND e.acc_id IS NULL INTO ct, w, x, y, z;
  IF (w IS NULL) THEN RETURN NULL;
  IF (COALESCE(ct, 0) > t - 60 + 300 * (1 - camper)) THEN RETURN NULL;
  IF (RAND() > camper) THEN
  BEGIN
    UPDATE ents e SET e.camp_time = :t WHERE e.id = :eid;
    RETURN NULL;
  END
  IF (bot_aggression(eid, NULL) < 50) THEN RETURN NULL;
  IF ((BIN_AND(w, 16) = 0 OR ent_ammo(eid, 5) < 10) AND (BIN_AND(w, 64) = 0 OR ent_ammo(eid, 7) < 10)
      AND (BIN_AND(w, 256) = 0 OR ent_ammo(eid, 9) < 10)) THEN RETURN NULL;
  -- the nearest spot (travel times as bot_choose_ltg's)
  FOR SELECT c.id, vlen(c.x - :x, c.y - :y, (c.z - :z) * 2) / 320 + 0.1e0 FROM ents c WHERE c.classname = 'info_camp' INTO cid, tt
  DO IF (tt < bt) THEN BEGIN bt = tt; best = cid; END
  IF (bt > 1.5e0) THEN RETURN NULL;
  UPDATE ents e SET e.camp_id = :best, e.camp_time = :t,
         e.camp_until = :t + IIF(:camper > 0.99e0, 99999, 120 + 180 * :camper + RAND() * 15) WHERE e.id = :eid;
  RETURN best;
END^

-- BotGetLongTermGoal for LTG_CAMP: the spot is the goal until the time is up; within 60 units of it the bot
-- stays, now and then looking somewhere else (BotRoamGoal, a chance of 0.8 × the think's 0.1 s), crouching for
-- 5 + 15 × croucher s with a chance of croucher × 0.1 when it has not crouched for 5 s, and gives up with its
-- head in a liquid. `go` the spot to go to, NULL there; `camping` 0 when not camping
CREATE OR ALTER PROCEDURE bot_camp (eid INTEGER)
RETURNS (camping SMALLINT, go INTEGER, crouch SMALLINT)
AS
DECLARE t DOUBLE PRECISION; DECLARE until_ DOUBLE PRECISION; DECLARE d DOUBLE PRECISION; DECLARE ct_ DOUBLE PRECISION; DECLARE cr DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE vh DOUBLE PRECISION;
BEGIN
  camping = 0; go = NULL; crouch = 0;
  SELECT e.camp_id, e.camp_until, e.attack_crouch, e.x, e.y, e.z, e.viewheight FROM ents e WHERE e.id = :eid INTO go, until_, ct_, x, y, z, vh;
  IF (go IS NULL) THEN EXIT;
  t = now_();
  SELECT vlen(c.x - :x, c.y - :y, c.z - :z) FROM ents c WHERE c.id = :go INTO d;
  IF (d IS NULL) THEN BEGIN UPDATE ents e SET e.camp_id = NULL WHERE e.id = :eid; go = NULL; EXIT; END
  camping = 1;
  -- (the time up: no longer camping, though it stays this think)
  IF (until_ < t) THEN UPDATE ents e SET e.camp_id = NULL WHERE e.id = :eid;
  IF (d >= 60) THEN EXIT;
  go = NULL;
  IF (RAND() < 0.08e0) THEN UPDATE ents e SET e.ideal_yaw = bot_roam_yaw(:eid) WHERE e.id = :eid;
  EXECUTE PROCEDURE change_yaw(eid);
  IF (COALESCE(ct_, 0) < t - 5) THEN
  BEGIN
    cr = bot_cv(eid, 'croucher', 0);
    IF (RAND() < 0.1e0 * cr) THEN
    BEGIN
      ct_ = t + 5 + cr * 15;
      UPDATE ents e SET e.attack_crouch = :ct_ WHERE e.id = :eid;
    END
  END
  IF (COALESCE(ct_, 0) > t) THEN crouch = 1;
  -- (no camping under water, slime or lava)
  IF (BIN_AND(point_contents(x, y, z + vh), 8 + 16 + 32) <> 0) THEN
    UPDATE ents e SET e.camp_id = NULL, e.attack_crouch = NULL WHERE e.id = :eid;
END^

-- ── the learned fight moves (reinforcement learning) ─────────────────────
-- The state of a fight as the Q table keys it: the bot's gun (0 gauntlet, 1 machinegun, shotgun or lightning, 2
-- railgun, 3 a missile gun), the enemy's (0 gauntlet, 1 a hitscan gun, 2 a missile gun), the distance (under 150,
-- 350, 700, beyond), the bot's health (under 50, under 100, more) and the enemy below, level or above (48 units)
CREATE OR ALTER FUNCTION bot_rl_state (w INTEGER, ew INTEGER, d DOUBLE PRECISION, hp INTEGER, dz DOUBLE PRECISION) RETURNS INTEGER
AS
BEGIN
  RETURN (((IIF(w = 1, 0, IIF(w IN (2, 4, 32), 1, IIF(w = 64, 2, 3))) * 3
          + IIF(ew = 1, 0, IIF(ew IN (2, 4, 32, 64), 1, 2))) * 4
          + IIF(d < 150, 0, IIF(d < 350, 1, IIF(d < 700, 2, 3)))) * 3
          + IIF(hp < 50, 0, IIF(hp < 100, 1, 2))) * 3
          + IIF(dz < -48, 0, IIF(dz > 48, 2, 1));
END^

-- the Q-learning step for the move a bot was on: Q(s, a) moves a tenth of the way to the reward (the health it
-- gave less what it took since it chose, `bonus` added) plus 0.8 of the best the state it is in now promises
-- (`s2`, NULL at the end of a fight: nothing more to come). While logging, the move's row gets its reward and
-- the row that follows (`nxt`)
CREATE OR ALTER PROCEDURE bot_rl_learn (eid INTEGER, s2 INTEGER, bonus DOUBLE PRECISION, nxt INTEGER DEFAULT NULL)
AS
DECLARE s INTEGER; DECLARE a SMALLINT; DECLARE r DOUBLE PRECISION; DECLARE best DOUBLE PRECISION = 0; DECLARE q0 DOUBLE PRECISION; DECLARE lg INTEGER;
BEGIN
  SELECT e.rl_s, e.rl_a, e.rl_given - e.rl_g0 - (e.rl_taken - e.rl_t0) + :bonus, e.rl_log FROM ents e WHERE e.id = :eid INTO s, a, r, lg;
  IF (a IS NULL) THEN EXIT;
  IF (lg IS NOT NULL) THEN
  BEGIN
    UPDATE bot_rl_log g SET g.r = :r, g.nxt = :nxt WHERE g.id = :lg;
    UPDATE ents e SET e.rl_log = NULL WHERE e.id = :eid;
  END
  IF (s2 IS NOT NULL) THEN SELECT COALESCE(MAX(b.q), 0) FROM bot_q b WHERE b.s = :s2 INTO best;
  SELECT b.q FROM bot_q b WHERE b.s = :s AND b.a = :a INTO q0;
  IF (q0 IS NULL) THEN INSERT INTO bot_q (s, a, q, n) VALUES (:s, :a, 0.1e0 * (:r + 0.8e0 * :best), 1);
  ELSE UPDATE bot_q b SET b.q = b.q + 0.1e0 * (:r + 0.8e0 * :best - b.q), b.n = b.n + 1 WHERE b.s = :s AND b.a = :a;
END^

-- a fight's end for a bot (its death): the last move learns from it, 50 off for dying
CREATE OR ALTER PROCEDURE bot_rl_end (eid INTEGER)
AS
BEGIN
  IF (COALESCE((SELECT e.rl FROM ents e WHERE e.id = :eid), (SELECT g.bot_rl FROM game g WHERE g.id = 1)) = 2) THEN
    EXECUTE PROCEDURE bot_rl_learn(eid, NULL, -50);
  UPDATE ents e SET e.rl_a = NULL, e.rl_log = NULL WHERE e.id = :eid;
END^

-- The network's choice (deep Q-learning: bot_nn): its forward pass over the twelve features, a layer a join of
-- the weights with the layer before and a sum for each unit, ReLU on the hidden ones; then Quake III's move (5)
-- unless another's value is 3 health points or more above it. NULL when there is no network
CREATE OR ALTER FUNCTION bot_nn_best (f0 DOUBLE PRECISION, f1 DOUBLE PRECISION, f2 DOUBLE PRECISION, f3 DOUBLE PRECISION, f4 DOUBLE PRECISION, f5 DOUBLE PRECISION, f6 DOUBLE PRECISION, f7 DOUBLE PRECISION, f8 DOUBLE PRECISION, f9 DOUBLE PRECISION, f10 DOUBLE PRECISION, f11 DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE l SMALLINT = 1; DECLARE last_ SMALLINT; DECLARE a SMALLINT; DECLARE q5 DOUBLE PRECISION;
BEGIN
  SELECT MAX(w.l) FROM bot_nn w INTO last_;
  IF (last_ IS NULL) THEN RETURN NULL;
  DELETE FROM nn_x;
  INSERT INTO nn_x (l, i, v) VALUES (0, 0, :f0);
  INSERT INTO nn_x (l, i, v) VALUES (0, 1, :f1);
  INSERT INTO nn_x (l, i, v) VALUES (0, 2, :f2);
  INSERT INTO nn_x (l, i, v) VALUES (0, 3, :f3);
  INSERT INTO nn_x (l, i, v) VALUES (0, 4, :f4);
  INSERT INTO nn_x (l, i, v) VALUES (0, 5, :f5);
  INSERT INTO nn_x (l, i, v) VALUES (0, 6, :f6);
  INSERT INTO nn_x (l, i, v) VALUES (0, 7, :f7);
  INSERT INTO nn_x (l, i, v) VALUES (0, 8, :f8);
  INSERT INTO nn_x (l, i, v) VALUES (0, 9, :f9);
  INSERT INTO nn_x (l, i, v) VALUES (0, 10, :f10);
  INSERT INTO nn_x (l, i, v) VALUES (0, 11, :f11);
  WHILE (l <= last_) DO
  BEGIN
    -- (the bias is input -1, always 1; an input at 0, as half are after the ReLU, has nothing to add: the join
    -- goes from the inputs to their weights, a range of the index each)
    INSERT INTO nn_x (l, i, v) VALUES (:l - 1, -1, 1);
    INSERT INTO nn_x (l, i, v)
    SELECT :l, w.j, IIF(:l < :last_, MAXVALUE(0, SUM(w.w * x.v)), SUM(w.w * x.v))
      FROM nn_x x LEFT JOIN bot_nn w ON w.l = :l AND w.i = x.i
     WHERE x.l = :l - 1 AND x.v <> 0 GROUP BY w.j;
    l = l + 1;
  END
  SELECT x.v FROM nn_x x WHERE x.l = :last_ AND x.i = 5 INTO q5;
  SELECT FIRST 1 x.i FROM nn_x x WHERE x.l = :last_ AND x.i < 5 AND x.v >= :q5 + 3 ORDER BY x.v DESC, x.i INTO a;
  RETURN COALESCE(a, 5);
END^

-- The move of a bot fighting an enemy in sight, learned: every 0.4 s it chooses among advance (0), strafe left (1),
-- strafe right (2), back off (3), hold (4) and Quake III's own attack move (5: BotAttackMove as bot_think has it),
-- and makes it each think until the next choice. `mode` 3 asks the network (bot_nn_best). `mode` 1 plays the
-- table (bot_q): Quake III's move, unless another has been tried 15 times or more in this state and is rated 3
-- health points or more above it. Both make a move at random now and then by the skill (one in two at skill 1
-- down to one in thirty at 5). `mode` 2 learns the table as it plays: the move just finished is scored
-- (bot_rl_learn), two moves in five are tried at random, an untried one first; and with game.rl_logging on every
-- move is written to bot_rl_log. Returns 1 when it moved the bot, 0 for Quake III's move
CREATE OR ALTER FUNCTION bot_rl_move (eid INTEGER, enemy INTEGER, vis SMALLINT, mode SMALLINT, d DOUBLE PRECISION, dz DOUBLE PRECISION,
                                      w INTEGER, spd DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE t DOUBLE PRECISION; DECLARE s INTEGER; DECLARE a SMALLINT; DECLARE until_ DOUBLE PRECISION; DECLARE hp INTEGER; DECLARE ew INTEGER;
DECLARE skill SMALLINT; DECLARE eps DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE moved SMALLINT;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION;
DECLARE q5 DOUBLE PRECISION; DECLARE n5 INTEGER; DECLARE av INTEGER; DECLARE quad DOUBLE PRECISION; DECLARE lg INTEGER;
DECLARE wc SMALLINT; DECLARE ec SMALLINT;
BEGIN
  IF (vis = 0 OR mode = 0 OR enemy IS NULL) THEN RETURN 0;
  t = now_();
  SELECT e.rl_a, e.rl_until, e.health, e.x, e.y, COALESCE(b.skill, 2), e.armor, e.quad_finished FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid
    INTO a, until_, hp, x, y, skill, av, quad;
  SELECT o.x, o.y, IIF(o.classname = 'player', (SELECT p.weapon FROM player p WHERE p.id = 1), o.weapon) FROM ents o WHERE o.id = :enemy INTO ex, ey, ew;
  IF (ex IS NULL) THEN RETURN 0;
  IF (a IS NULL OR until_ <= t) THEN
  BEGIN
    s = bot_rl_state(w, ew, d, hp, dz);
    wc = IIF(w = 1, 0, IIF(w IN (2, 4, 32), 1, IIF(w = 64, 2, 3)));
    ec = IIF(ew = 1, 0, IIF(ew IN (2, 4, 32, 64), 1, 2));
    IF (mode = 2) THEN
    BEGIN
      -- (logging: this choice's row first, so that the move before can point to it)
      IF ((SELECT g.rl_logging FROM game g WHERE g.id = 1) = 1) THEN lg = NEXT VALUE FOR rl_log_seq;
      -- (a move left over from a fight that ended more than a second ago learns with nothing to follow)
      IF (a IS NOT NULL) THEN EXECUTE PROCEDURE bot_rl_learn(eid, IIF(t - until_ > 1, NULL, s), 0, IIF(t - until_ > 1, NULL, lg));
    END
    eps = IIF(mode = 2, 0.4e0, CASE skill WHEN 1 THEN 0.5e0 WHEN 2 THEN 0.35e0 WHEN 3 THEN 0.2e0 WHEN 4 THEN 0.1e0 ELSE 0.03e0 END);
    a = NULL;
    IF (mode = 2) THEN
    BEGIN
      -- learning: a move never tried here first, else the best rated, else one at random
      SELECT FIRST 1 m.a FROM (SELECT 0 a FROM rdb$database UNION ALL SELECT 1 FROM rdb$database UNION ALL SELECT 2 FROM rdb$database
                               UNION ALL SELECT 3 FROM rdb$database UNION ALL SELECT 4 FROM rdb$database UNION ALL SELECT 5 FROM rdb$database) m
       WHERE NOT EXISTS (SELECT 1 FROM bot_q b WHERE b.s = :s AND b.a = m.a) ORDER BY RAND() INTO a;
      IF (a IS NULL AND RAND() >= eps) THEN SELECT FIRST 1 b.a FROM bot_q b WHERE b.s = :s ORDER BY b.q DESC, b.a INTO a;
      IF (a IS NULL) THEN a = CAST(FLOOR(RAND() * 5.999e0) AS SMALLINT);
    END
    ELSE IF (RAND() < eps) THEN a = CAST(FLOOR(RAND() * 5.999e0) AS SMALLINT);
    ELSE IF (mode = 3) THEN
      a = COALESCE(bot_nn_best(IIF(wc = 0, 1, 0), IIF(wc = 1, 1, 0), IIF(wc = 2, 1, 0), IIF(wc = 3, 1, 0), IIF(ec = 0, 1, 0), IIF(ec = 1, 1, 0), IIF(ec = 2, 1, 0),
            MINVALUE(d, 1500) / 1000, MINVALUE(MAXVALUE(hp, 0), 200) / 100e0, MINVALUE(av, 200) / 100e0, MAXVALUE(-300, MINVALUE(300, dz)) / 200, IIF(quad > t, 1, 0)), 5);
    ELSE
    BEGIN
      a = 5;
      SELECT b.q, b.n FROM bot_q b WHERE b.s = :s AND b.a = 5 INTO q5, n5;
      IF (n5 >= 15) THEN
        SELECT FIRST 1 b.a FROM bot_q b WHERE b.s = :s AND b.a < 5 AND b.n >= 15 AND b.q >= :q5 + 3 ORDER BY b.q DESC, b.a INTO a;
      a = COALESCE(a, 5);
    END
    IF (lg IS NOT NULL) THEN
      INSERT INTO bot_rl_log (id, f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, a)
      VALUES (:lg, IIF(:wc = 0, 1, 0), IIF(:wc = 1, 1, 0), IIF(:wc = 2, 1, 0), IIF(:wc = 3, 1, 0), IIF(:ec = 0, 1, 0), IIF(:ec = 1, 1, 0), IIF(:ec = 2, 1, 0),
              MINVALUE(:d, 1500) / 1000, MINVALUE(MAXVALUE(:hp, 0), 200) / 100e0, MINVALUE(:av, 200) / 100e0, MAXVALUE(-300, MINVALUE(300, :dz)) / 200, IIF(:quad > :t, 1, 0), :a);
    UPDATE ents e SET e.rl_s = :s, e.rl_a = :a, e.rl_until = :t + 0.4e0, e.rl_g0 = e.rl_given, e.rl_t0 = e.rl_taken, e.rl_log = :lg WHERE e.id = :eid;
  END
  IF (a = 5) THEN RETURN 0;
  yaw = vectoyaw(ex - x, ey - y);
  IF (a = 0) THEN
  BEGIN
    -- advance: straight at it, or along the waypoints when it is on another floor or far off
    moved = 0;
    IF (ABS(dz) > 48 OR d > 900) THEN EXECUTE PROCEDURE bot_follow_route(eid, enemy, spd) RETURNING_VALUES moved;
    IF (moved <= 0) THEN EXECUTE PROCEDURE move_to_goal(eid, enemy, spd);
  END
  ELSE IF (a IN (1, 2)) THEN
  BEGIN
    -- strafe (the other way when blocked)
    IF (step_direction(eid, anglemod(yaw + IIF(a = 1, 90, -90)), spd * 0.8e0) = 0) THEN
      moved = step_direction(eid, anglemod(yaw + IIF(a = 1, -90, 90)), spd * 0.8e0);
  END
  ELSE IF (a = 3) THEN
  BEGIN
    -- back off (to a side when blocked)
    IF (step_direction(eid, anglemod(yaw + 180), spd) = 0) THEN moved = step_direction(eid, anglemod(yaw + 135), spd);
  END
  RETURN 1;
END^

CREATE OR ALTER PROCEDURE bot_think (eid INTEGER)
AS
DECLARE rlm SMALLINT; DECLARE getid INTEGER; DECLARE getu DOUBLE PRECISION;
DECLARE defid INTEGER; DECLARE defu DOUBLE PRECISION; DECLARE defa DOUBLE PRECISION; DECLARE defd DOUBLE PRECISION;
DECLARE t DOUBLE PRECISION; DECLARE nt DOUBLE PRECISION; DECLARE st VARCHAR(12); DECLARE enemy INTEGER; DECLARE flags INTEGER; DECLARE goal INTEGER;
DECLARE rt DOUBLE PRECISION; DECLARE srch DOUBLE PRECISION; DECLARE af DOUBLE PRECISION; DECLARE lefty SMALLINT; DECLARE legs INTEGER; DECLARE skill SMALLINT; DECLARE tt DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE ehp INTEGER;
DECLARE d DOUBLE PRECISION; DECLARE vis SMALLINT; DECLARE yaw DOUBLE PRECISION; DECLARE moved SMALLINT = 0; DECLARE w INTEGER; DECLARE diff DOUBLE PRECISION; DECLARE spd DOUBLE PRECISION;
DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE match_done SMALLINT; DECLARE waiting SMALLINT; DECLARE hp INTEGER; DECLARE hesitate SMALLINT = 0; DECLARE fresh SMALLINT = 0;
DECLARE aggr INTEGER; DECLARE ft DOUBLE PRECISION; DECLARE htick DOUBLE PRECISION; DECLARE haste DOUBLE PRECISION; DECLARE regen DOUBLE PRECISION;
DECLARE gt SMALLINT; DECLARE busy SMALLINT = 0; DECLARE mate INTEGER; DECLARE camping SMALLINT = 0; DECLARE ccr SMALLINT = 0; DECLARE reached SMALLINT;
DECLARE nbg INTEGER; DECLARE nbg_u DOUBLE PRECISION; DECLARE nbg_c DOUBLE PRECISION; DECLARE ltg INTEGER;
DECLARE jx DOUBLE PRECISION; DECLARE jy DOUBLE PRECISION; DECLARE jt DOUBLE PRECISION; DECLARE jf DOUBLE PRECISION;
DECLARE wjump SMALLINT = 0; DECLARE crouch SMALLINT = 0; DECLARE ct_ DOUBLE PRECISION; DECLARE mz DOUBLE PRECISION;
DECLARE tf DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION; DECLARE tsf INTEGER; DECLARE tct INTEGER;
DECLARE tals SMALLINT; DECLARE tsts SMALLINT; DECLARE thit INTEGER; DECLARE stepsnd VARCHAR(64);
BEGIN
  t = now_();
  nt = t + 0.1e0;
  SELECT e.st, e.enemy_id, e.flags, e.goal_id, e.respawn_time, e.search_time, e.attack_finished, e.lefty, e.legs_anim, e.x, e.y, e.z, e.yaw, e.teleport_time, e.health, COALESCE(b.skill, 2),
         e.health_tick, e.haste_finished, e.regen_finished
    FROM ents e LEFT JOIN bot_defs b ON b.name = e.bot WHERE e.id = :eid INTO st, enemy, flags, goal, rt, srch, af, lefty, legs, x, y, z, yaw, tt, hp, skill, htick, haste, regen;
  IF (st IS NULL) THEN EXIT;
  IF (st = 'queue') THEN BEGIN UPDATE ents e SET e.nextthink = :t + 0.5e0 WHERE e.id = :eid; EXIT; END   -- a tournament's spectator
  SELECT g.match_over, IIF(g.warmup_end > :t, 1, 0), g.gametype FROM game g WHERE g.id = 1 INTO match_done, waiting, gt;
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
  -- a team game: the leader's part (BotTeamAI)
  IF (gt = 3) THEN EXECUTE PROCEDURE bot_team_ai(eid);
  -- ClientTimerActions, once a second: regeneration counts the health up (15 to 110 percent, then 5 to
  -- twice the maximum), else health over the maximum counts down, and armour over it too
  IF (htick < t) THEN
  BEGIN
    IF (regen > t AND hp < 200) THEN
    BEGIN
      UPDATE ents e SET e.health = IIF(e.health < e.max_health, MINVALUE(e.health + 15, e.max_health * 1.1e0), MINVALUE(e.health + 5, e.max_health * 2)), e.health_tick = :t + 1 WHERE e.id = :eid;
      EXECUTE PROCEDURE snd(eid, 3, 'sound/items/regen.wav', 1, 1);
    END
    ELSE UPDATE ents e SET e.health = IIF(e.health > e.max_health AND :regen <= :t, e.health - 1, e.health), e.health_tick = :t + 1 WHERE e.id = :eid;
    UPDATE ents e SET e.armor = e.armor - 1 WHERE e.id = :eid AND e.armor > e.max_health;
  END

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
      af = MAXVALUE(af, t + bot_cv(eid, 'reactiontime', bot_char(skill, 'reaction')));
    END
  END
  -- a poor bot dawdles now and then
  IF (RAND() < bot_char(skill, 'hesitate')) THEN hesitate = 1;
  spd = bot_char(skill, 'speed') * IIF(haste > t, 1.3e0, 1);   -- haste: 1.3 times as fast

  IF (enemy IS NOT NULL) THEN
  BEGIN
    SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :enemy INTO ex, ey, ez;
    d = vlen(ex - x, ey - y, ez - z);
    vis = visible(eid, enemy);
    IF (vis = 1) THEN srch = t + bot_char(skill, 'search');
    -- (the view turns to it, up or down to its chest too: change_yaw's ideal_pitch)
    UPDATE ents e SET e.enemy_id = :enemy, e.search_time = :srch, e.st = 'run', e.ideal_yaw = vectoyaw(:ex - :x, :ey - :y), e.goal_id = IIF(:fresh = 1, NULL, e.goal_id),
           e.ideal_pitch = -ATAN2(:ez + 8 - (:z + e.viewheight), MAXVALUE(1, vlen(:ex - :x, :ey - :y, 0))) * 57.29578e0,
           e.attack_finished = :af WHERE e.id = :eid;
    EXECUTE PROCEDURE change_yaw(eid);
    -- BotBattleUseItems: under 40 health it teleports away, under 60 it uses its medkit
    IF (bot_use_items(eid) = 1) THEN
    BEGIN
      UPDATE ents e SET e.nextthink = :nt WHERE e.id = :eid;
      EXIT;
    END
    -- in the air (a jump pad, a knock): nothing to do but aim
    IF (BIN_AND(flags, 512) = 0 OR tt > t) THEN
    BEGIN
      IF (vis = 1 AND af <= t) THEN EXECUTE PROCEDURE bot_fire(eid);
      UPDATE ents e SET e.nextthink = :nt, e.attack_finished = IIF(:vis = 1 AND :af <= :t, :t + fire_time(e.weapon) / IIF(:haste > :t, 1.3e0, 1), e.attack_finished) WHERE e.id = :eid;
      EXIT;
    END
    w = bot_pick_weapon(eid, d);
    IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.weapon <> :w)) THEN
    BEGIN
      UPDATE ents e SET e.weapon = :w WHERE e.id = :eid;
      EXECUTE PROCEDURE set_anims(eid, NULL, 10);   -- TORSO_RAISE: the new gun comes up (it ends standing)
    END
    -- BotWantsToRetreat (aggression under 50): run for an item and keep shooting (AINode_Battle_Retreat);
    -- a keen one fights, and goes after the enemy out of sight only when it wants to chase (over 50)
    aggr = bot_aggression(eid, enemy);
    SELECT e.goal_id, COALESCE(e.rl, (SELECT g.bot_rl FROM game g WHERE g.id = 1)) FROM ents e WHERE e.id = :eid INTO goal, rlm;
    IF (goal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ents g WHERE g.id = :goal AND g.solid = 1)) THEN goal = NULL;
    IF (aggr >= 50) THEN goal = NULL;
    ELSE IF (goal IS NULL) THEN goal = bot_retreat_goal(eid);
    UPDATE ents e SET e.goal_id = :goal WHERE e.id = :eid;
    -- BotAttackMove's jump and crouch: fighting an enemy in sight (not running for an item) with an attack skill
    -- of 0.2 or more; a second after the last crouch, a chance of its jumper characteristic each think to jump,
    -- else of its croucher to crouch for croucher * 5 s (attackcrouch_time); crouched, it strafes at the
    -- crouched speed (pm_duckScale, a quarter) and does not jump
    IF (vis = 1 AND goal IS NULL AND bot_cv(eid, 'attack_skill', bot_char(skill, 'strafe')) >= 0.2e0) THEN
    BEGIN
      SELECT e.attack_crouch FROM ents e WHERE e.id = :eid INTO ct_;
      IF (COALESCE(ct_, 0) < t - 1) THEN
      BEGIN
        IF (RAND() < bot_cv(eid, 'jumper', 0)) THEN wjump = 1;
        ELSE IF (RAND() < bot_cv(eid, 'croucher', 0)) THEN
        BEGIN
          ct_ = t + bot_cv(eid, 'croucher', 0) * 5;
          UPDATE ents e SET e.attack_crouch = :ct_ WHERE e.id = :eid;
        END
      END
      IF (COALESCE(ct_, 0) > t) THEN
      BEGIN
        crouch = 1; wjump = 0; spd = spd * 0.25e0;
        -- PM_CheckDuck: the box's top at 16, the eye at CROUCH_VIEWHEIGHT, 12
        UPDATE ents e SET e.maxz = 16, e.viewheight = 12 WHERE e.id = :eid AND e.maxz <> 16;
      END
    END
    IF (bot_avoid_grenade(eid, spd) = 1) THEN BEGIN END
    ELSE IF (hesitate = 1) THEN BEGIN END
    ELSE IF (goal IS NOT NULL) THEN
    BEGIN
      EXECUTE PROCEDURE bot_follow_route(eid, goal, spd) RETURNING_VALUES moved;
      IF (moved <= 0) THEN EXECUTE PROCEDURE move_to_goal(eid, goal, spd);
    END
    ELSE IF ((vis = 0 OR ABS(ez - z) > 48 OR d > 900) AND aggr > 50) THEN
    BEGIN
      -- out of sight, or on another floor: hunt it along the waypoints (and over the jump pads)
      EXECUTE PROCEDURE bot_follow_route(eid, enemy, spd) RETURNING_VALUES moved;
      IF (moved <= 0) THEN EXECUTE PROCEDURE move_to_goal(eid, enemy, spd);
    END
    -- the learned fight move (bot_rl_move), with the enemy in sight and within reach on this floor (the hunt above
    -- is the way there, not a move of the fight); where it knows nothing, Quake III's below
    ELSE IF (bot_rl_move(eid, enemy, vis, rlm, d, ez - z, w, spd) = 1) THEN BEGIN END
    ELSE IF (vis = 0) THEN BEGIN END   -- no chase in it and nothing to run for: it waits where it is
    ELSE IF (d > 350 OR w = 1) THEN EXECUTE PROCEDURE move_to_goal(eid, enemy, spd);
    ELSE IF (RAND() < bot_cv(eid, 'attack_skill', bot_char(skill, 'strafe'))) THEN
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
    -- BotAttackMove's jump: fighting an enemy in sight (not running for an item), an attack skill of 0.2 or
    -- more, a chance of its jumper characteristic each think and not within a second of the last; it goes on
    -- the way it stepped (MOVE_JUMP with the strafe)
    SELECT e.attack_jump FROM ents e WHERE e.id = :eid INTO jt;
    IF (wjump = 1 AND COALESCE(jt, 0) <= t) THEN
    BEGIN
      SELECT e.x, e.y FROM ents e WHERE e.id = :eid INTO jx, jy;
      -- where it would come down (0.675 s in the air at 270 up): BotMoveInDirection predicts the move and makes
      -- none that falls off a ledge or into lava, so no jump without a floor there
      jf = wp_drop(jx + (jx - ox) * 6.75e0, jy + (jy - oy) * 6.75e0, z + 16, 160);
      IF (jf IS NOT NULL AND jf > -99999 AND BIN_AND(point_contents(jx + (jx - ox) * 6.75e0, jy + (jy - oy) * 6.75e0, jf + 1), 24) = 0) THEN
      BEGIN
        UPDATE ents e SET e.vx = (:jx - :ox) * 10, e.vy = (:jy - :oy) * 10, e.vz = 270, e.flags = BIN_AND(e.flags, BIN_NOT(512)),
               e.attack_jump = :t + 1 WHERE e.id = :eid;
        EXECUTE PROCEDURE snd(eid, 2, 'sound/player/' || COALESCE((SELECT e.pmodel FROM ents e WHERE e.id = :eid), 'sarge') || '/jump1.wav', 1, 1);
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
      -- (BotCheckAttack's fire throttle: with it, a pause of its length one shot in (1 - it))
      ft = bot_cv(eid, 'firethrottle', NULL);
      UPDATE ents e SET e.attack_finished = :t + fire_time(e.weapon) / IIF(:haste > :t, 1.3e0, 1) * IIF(:ft IS NULL, 1 + RAND() * (5 - :skill) * 0.4e0, 1)
             + IIF(:ft IS NULL, IIF(RAND() < bot_char(:skill, 'pause'), 0.5e0 + RAND() * 0.8e0, 0), IIF(RAND() > :ft, :ft, 0)) WHERE e.id = :eid;
    END
  END
  ELSE
  BEGIN
    -- nothing in sight: wander toward an item, or just roam
    UPDATE ents e SET e.enemy_id = NULL, e.st = 'stand', e.ideal_pitch = NULL WHERE e.id = :eid AND e.enemy_id IS NOT NULL;
    -- a teammate to accompany comes before the items (BotGetLongTermGoal)
    EXECUTE PROCEDURE bot_accompany(eid) RETURNING_VALUES busy, mate, ccr;
    IF (ccr = 1) THEN
    BEGIN
      crouch = 1;
      UPDATE ents e SET e.maxz = 16, e.viewheight = 12 WHERE e.id = :eid AND e.maxz <> 16;
    END
    -- then a camp spot (LTG_CAMP): gone to, or stayed at (no nearby goals then: BotLongTermGoal returns false)
    IF (busy = 0) THEN
    BEGIN
      EXECUTE PROCEDURE bot_camp(eid) RETURNING_VALUES camping, mate, ccr;
      IF (camping = 1) THEN busy = 2;
      IF (ccr = 1) THEN
      BEGIN
        crouch = 1;
        UPDATE ents e SET e.maxz = 16, e.viewheight = 12 WHERE e.id = :eid AND e.maxz <> 16;
      END
    END
    -- BotReachedGoal: the goal is done when touched (avoided then for its respawn time, a dropped one not), or
    -- when its place is in sight and it is not there
    IF (busy = 0 AND goal IS NOT NULL) THEN
    BEGIN
      reached = bot_goal_reached(eid, goal);
      -- (an item it was told to get is reached when it has taken it, not 40 units from it: on until it is gone)
      IF (reached = 2 AND EXISTS (SELECT 1 FROM ents e JOIN ents g ON g.id = e.get_id WHERE e.id = :eid AND e.get_id = :goal AND g.solid = 1)) THEN reached = 0;
      IF (reached > 0) THEN
      BEGIN
        IF (reached = 2 AND NOT EXISTS (SELECT 1 FROM ents g WHERE g.id = :goal AND g.think = 'remove')) THEN EXECUTE PROCEDURE bot_avoid_item(eid, goal);
        -- (the item it was told to get: "I got the …", or it isn't there; the order is done)
        IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.get_id = :goal)) THEN
        BEGIN
          EXECUTE PROCEDURE bot_say(eid, TRIM(IIF(reached = 2, 'getitem_gotit', 'getitem_notthere')),
            (SELECT i.name FROM ents g JOIN item_defs i ON i.cls = g.item WHERE g.id = :goal), NULL, NULL, NULL, NULL, NULL, player_ent(), 0);
          UPDATE ents e SET e.get_id = NULL WHERE e.id = :eid;
        END
        goal = NULL;
        UPDATE ents e SET e.goal_id = NULL WHERE e.id = :eid;
      END
    END
    -- an item it was told to get (LTG_GETITEM, chat.sql) is the goal until it has it or the 60 s are up
    IF (busy = 0) THEN
    BEGIN
      SELECT e.get_id, e.get_until FROM ents e WHERE e.id = :eid INTO getid, getu;
      IF (getid IS NOT NULL) THEN
      BEGIN
        IF (getu < t OR NOT EXISTS (SELECT 1 FROM ents g WHERE g.id = :getid)) THEN UPDATE ents e SET e.get_id = NULL WHERE e.id = :eid;
        ELSE IF (goal IS DISTINCT FROM getid) THEN
        BEGIN
          goal = getid;
          UPDATE ents e SET e.goal_id = :goal WHERE e.id = :eid;
        END
      END
    END
    -- a place it was told to defend (LTG_DEFENDKEYAREA in BotGetLongTermGoal): the item there is the goal until
    -- the bot is within 70 units of it; then it is off about its own goals for 3 to 6 s (defendaway_time), sooner
    -- back if those take it farther than defendaway_range (350 of the AAS's hundredths of a second: 3.5 s at a
    -- run, 1120 units here, as the crow flies); after the 600 s it says it stops
    IF (busy = 0 AND getid IS NULL) THEN
    BEGIN
      SELECT e.def_id, e.def_until, e.def_away, SQRT((g.x - e.x) * (g.x - e.x) + (g.y - e.y) * (g.y - e.y) + (g.z - e.z) * (g.z - e.z))
        FROM ents e LEFT JOIN ents g ON g.id = e.def_id WHERE e.id = :eid INTO defid, defu, defa, defd;
      IF (defid IS NOT NULL) THEN
      BEGIN
        IF (defd IS NULL OR defu < t) THEN
        BEGIN
          IF (defd IS NOT NULL) THEN
            EXECUTE PROCEDURE bot_say(eid, 'defend_stop', (SELECT i.name FROM ents g JOIN item_defs i ON i.cls = g.item WHERE g.id = :defid), NULL, NULL, NULL, NULL, NULL, -1, 0);
          UPDATE ents e SET e.def_id = NULL WHERE e.id = :eid;
        END
        ELSE
        BEGIN
          IF (defa >= t AND defd > 1120) THEN defa = 0;
          IF (defa < t) THEN
          BEGIN
            IF (defd < 70) THEN
            BEGIN
              defa = t + 3 + 3 * RAND();
              IF (goal = defid) THEN BEGIN goal = NULL; UPDATE ents e SET e.goal_id = NULL WHERE e.id = :eid; END
            END
            ELSE IF (goal IS DISTINCT FROM defid) THEN
            BEGIN
              goal = defid;
              UPDATE ents e SET e.goal_id = :goal WHERE e.id = :eid;
            END
          END
          UPDATE ents e SET e.def_away = :defa WHERE e.id = :eid;
        END
      END
    END
    IF (busy = 0 AND goal IS NULL AND RAND() < 0.3e0) THEN
    BEGIN
      -- the long-term goal (BotChooseLTGItem): the item worth the most for the trip, by the bot's item weights
      goal = bot_choose_ltg(eid);
      UPDATE ents e SET e.goal_id = :goal WHERE e.id = :eid;
      -- (and avoided for its respawn time: not chosen again straight away)
      IF (goal IS NOT NULL) THEN EXECUTE PROCEDURE bot_avoid_item(eid, goal);
    END
    -- BotNearbyGoal (AINode_Seek_LTG): every half second an item within 1.5 s on the way to the long-term goal
    -- (the item sought, or the teammate accompanied), gone for until it is taken or for 4 + 1.5 s (nbg_time)
    SELECT e.nbg_id, e.nbg_until, e.nbg_check, IIF(:busy = 1, e.acc_id, IIF(:busy = 2, e.camp_id, :goal)) FROM ents e WHERE e.id = :eid INTO nbg, nbg_u, nbg_c, ltg;
    IF (nbg IS NOT NULL) THEN
    BEGIN
      reached = IIF(nbg_u < t, 1, bot_goal_reached(eid, nbg));
      IF (reached > 0) THEN
      BEGIN
        IF (reached = 2 AND NOT EXISTS (SELECT 1 FROM ents g WHERE g.id = :nbg AND g.think = 'remove')) THEN EXECUTE PROCEDURE bot_avoid_item(eid, nbg);
        nbg = NULL;
        UPDATE ents e SET e.nbg_id = NULL WHERE e.id = :eid;
      END
    END
    IF (nbg IS NULL AND COALESCE(nbg_c, 0) < t AND NOT (busy = 2 AND mate IS NULL)) THEN
    BEGIN
      -- (BotWantsToCamp first, in the same check)
      IF (busy = 0) THEN
      BEGIN
        mate = bot_wants_to_camp(eid);
        IF (mate IS NOT NULL) THEN BEGIN busy = 2; ltg = mate; END
      END
      nbg = bot_choose_nbg(eid, ltg, 1.5e0);
      UPDATE ents e SET e.nbg_check = :t + 0.5e0, e.nbg_id = :nbg, e.nbg_until = IIF(:nbg IS NULL, NULL, :t + 5.5e0) WHERE e.id = :eid;
      IF (nbg IS NOT NULL) THEN EXECUTE PROCEDURE bot_avoid_item(eid, nbg);
    END
    -- nothing to do but roam: now and then a word (BotChat_Random, a chance in a hundred a think, then the character's)
    IF (RAND() < 0.005e0) THEN EXECUTE PROCEDURE bot_chat_event(eid, 'random', NULL, 0);
    IF (nbg IS NOT NULL) THEN
    BEGIN
      IF (BIN_AND(flags, 512) <> 0 AND tt < t AND hesitate = 0 AND bot_avoid_grenade(eid, spd) = 0) THEN
      BEGIN
        EXECUTE PROCEDURE bot_follow_route(eid, nbg, spd * 0.9e0) RETURNING_VALUES moved;
        IF (moved < 0) THEN UPDATE ents e SET e.nbg_id = NULL WHERE e.id = :eid;
        ELSE IF (moved = 0) THEN EXECUTE PROCEDURE move_to_goal(eid, nbg, spd * 0.9e0);
      END
    END
    ELSE IF (busy >= 1) THEN
    BEGIN
      -- (the companion, or the camp spot)
      IF (mate IS NOT NULL AND BIN_AND(flags, 512) <> 0 AND tt < t AND hesitate = 0 AND bot_avoid_grenade(eid, spd) = 0) THEN
      BEGIN
        EXECUTE PROCEDURE bot_follow_route(eid, mate, spd * 0.9e0) RETURNING_VALUES moved;
        IF (moved <= 0) THEN EXECUTE PROCEDURE move_to_goal(eid, mate, spd * 0.9e0);
      END
    END
    ELSE IF (BIN_AND(flags, 512) <> 0 AND tt < t AND hesitate = 0 AND bot_avoid_grenade(eid, spd) = 0) THEN
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
  -- out of the crouch when the fight's crouch is over, where the standing box fits (PM_CheckDuck)
  SELECT e.x, e.y, e.z, e.maxz FROM ents e WHERE e.id = :eid INTO x, y, z, mz;
  IF (crouch = 0 AND mz = 16) THEN
  BEGIN
    EXECUTE PROCEDURE trace_move(eid, -15, -15, -24, 15, 15, 32, x, y, z, x, y, z, 33619969)
      RETURNING_VALUES tf, tx, ty, tz, tnx, tny, tnz, tsf, tct, tals, tsts, thit;
    IF (tals = 0 AND tsts = 0) THEN BEGIN UPDATE ents e SET e.maxz = 32, e.viewheight = 26 WHERE e.id = :eid; mz = 32; END
  END
  -- the legs follow the feet (crouched: LEGS_WALKCR, LEGS_IDLECR)
  moved = IIF(ABS(x - ox) + ABS(y - oy) > 1, 1, 0);
  -- PM_Footsteps: running on the ground, a step every 0.3 s (half the run's bob cycle); none crouched
  IF (BIN_AND(flags, 512) <> 0 AND mz <> 16 AND vlen(x - ox, y - oy, 0) > 10 AND COALESCE((SELECT e.step_time FROM ents e WHERE e.id = :eid), 0) < t) THEN
  BEGIN
    UPDATE ents e SET e.step_time = :t + 0.3e0 WHERE e.id = :eid;
    stepsnd = footstep_sound(eid);
    IF (stepsnd IS NOT NULL) THEN EXECUTE PROCEDURE snd(eid, 2, stepsnd, 1, 1);
  END
  IF (BIN_AND(flags, 512) = 0) THEN BEGIN IF (legs NOT IN (18, 20)) THEN EXECUTE PROCEDURE set_anims(eid, 18, NULL); END
  ELSE IF (mz = 16) THEN EXECUTE PROCEDURE set_anims(eid, IIF(moved = 1, 13, 23), NULL);
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
         e.ammo2 = IIF((SELECT g.gametype FROM game g WHERE g.id = 1) = 3, 50, 100),
         e.think = 'bot_think', e.nextthink = :t + 0.5e0 + RAND() * 0.5e0, e.attack_finished = :t + 2, e.enter_time = :t WHERE e.id = :id;
  -- its turning from its character file (CHARACTERISTIC_VIEW_MAXCHANGE degrees a second, a think a tenth of it)
  UPDATE ents e SET e.yaw_speed = COALESCE(MAXVALUE(240, bot_cv(:id, 'view_maxchange', NULL)) / 10, e.yaw_speed),
         e.view_factor = bot_cv(:id, 'view_factor', 1) WHERE e.id = :id;
  -- in a team game, a team (PickTeam) and its colours (the model's red or blue skin)
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) >= 3) THEN
  BEGIN
    tm = pick_team();
    UPDATE ents e SET e.pteam = :tm, e.pskin = IIF(:tm = 1, 'red', 'blue') WHERE e.id = :id;
  END
  EXECUTE PROCEDURE link_ent(id);
  EXECUTE PROCEDURE kill_box(id);   -- (G_KillBox: whoever stands where it spawns)
  EXECUTE PROCEDURE say(bname || ' entered the game' || COALESCE((SELECT TRIM(TRAILING FROM IIF(e.pteam = 1, ' (red)', IIF(e.pteam = 2, ' (blue)', ''))) FROM ents e WHERE e.id = :id), ''));
  IF ((SELECT g.tic FROM game g WHERE g.id = 1) > 0) THEN EXECUTE PROCEDURE bot_chat_event(id, 'game_enter', NULL, 0);   -- BotChat_EnterGame
  SUSPEND;
END^

-- ── the tournament (GT_TOURNAMENT) ──────────────────────────────────────
-- how many play: the player unless spectating, and the bots not waiting their turn
CREATE OR ALTER FUNCTION duelists RETURNS INTEGER
AS
BEGIN
  RETURN (SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0)
       + (SELECT IIF(p.spectator = 1, 0, 1) FROM player p WHERE p.id = 1);
END^

-- the two who play, best first (level.sortedClients)
CREATE OR ALTER PROCEDURE duel_ranked
RETURNS (eid INTEGER, frags INTEGER)
AS
BEGIN
  FOR SELECT x.eid, x.frags FROM (
        SELECT p.ent_id AS eid, p.frags FROM player p WHERE p.id = 1 AND p.spectator = 0
        UNION ALL
        SELECT e.id, e.frags FROM ents e WHERE e.classname = 'bot' AND e.queued = 0) x
      ORDER BY x.frags DESC, x.eid INTO eid, frags DO SUSPEND;
END^

-- a bot to the spectators (SetTeam): out of sight and reach, waiting, and nobody's enemy or view
CREATE OR ALTER PROCEDURE bot_to_queue (eid INTEGER)
AS
BEGIN
  UPDATE ents e SET e.queued = 1, e.spec_time = now_(), e.st = 'queue', e.deadflag = 0, e.health = 100, e.solid = 0, e.takedamage = 0, e.alpha = 1,
         e.movetype = 0, e.vx = 0, e.vy = 0, e.vz = 0, e.flags = BIN_OR(e.flags, 64), e.enemy_id = NULL, e.goal_id = NULL,
         e.think = 'bot_think', e.nextthink = now_() + 0.5e0, e.respawn_time = 0 WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
  UPDATE ents e SET e.enemy_id = NULL WHERE e.enemy_id = :eid;
  UPDATE player p SET p.follow_id = NULL WHERE p.follow_id = :eid;
  EXECUTE PROCEDURE say((SELECT e.bot FROM ents e WHERE e.id = :eid) || ' joined the spectators.');
END^

-- AddTournamentPlayer: the spectator that has waited longest comes in
CREATE OR ALTER PROCEDURE tourney_pull
AS
DECLARE b INTEGER; DECLARE bt DOUBLE PRECISION; DECLARE pt DOUBLE PRECISION; DECLARE nm VARCHAR(32);
BEGIN
  SELECT FIRST 1 e.id, e.spec_time FROM ents e WHERE e.classname = 'bot' AND e.queued = 1 ORDER BY e.spec_time, e.id INTO b, bt;
  SELECT IIF(p.spectator = 1, e.spec_time, NULL), p.name FROM player p JOIN ents e ON e.id = p.ent_id WHERE p.id = 1 INTO pt, nm;
  IF (pt IS NOT NULL AND (b IS NULL OR pt <= bt)) THEN
  BEGIN
    UPDATE player p SET p.spectator = 0, p.follow_id = NULL WHERE p.id = 1;
    EXECUTE PROCEDURE player_respawn;
    EXECUTE PROCEDURE say(COALESCE(nm, 'Player') || ' entered the game');
  END
  ELSE IF (b IS NOT NULL) THEN
  BEGIN
    UPDATE ents e SET e.queued = 0, e.flags = BIN_AND(e.flags, BIN_NOT(64)) WHERE e.id = :b;
    EXECUTE PROCEDURE bot_respawn(b);
    EXECUTE PROCEDURE say((SELECT e.bot FROM ents e WHERE e.id = :b) || ' entered the game');
  END
END^

-- CheckTournament, every tic of a tournament's match: two to play, pulled from the queue; with fewer,
-- "waiting for players" (the countdown held off); with two, the countdown from scores of nothing
CREATE OR ALTER PROCEDURE tourney_check
AS
DECLARE we DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
BEGIN
  t = now_();
  -- a third come in (a bot added at the console): it waits its turn
  WHILE (duelists() > 2 AND EXISTS (SELECT 1 FROM ents e WHERE e.classname = 'bot' AND e.queued = 0)) DO
    EXECUTE PROCEDURE bot_to_queue((SELECT MAX(e.id) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0));
  IF (duelists() < 2) THEN EXECUTE PROCEDURE tourney_pull;
  IF (duelists() < 2) THEN EXECUTE PROCEDURE tourney_pull;
  SELECT g.warmup_end FROM game g WHERE g.id = 1 INTO we;
  IF (duelists() < 2) THEN
  BEGIN
    -- (on the screen for as long as it waits, as CG_DrawWarmup draws it)
    IF (we < 1e8) THEN UPDATE game g SET g.warmup_end = 1e9, g.warmup_said = 0 WHERE g.id = 1;
    IF (NOT EXISTS (SELECT 1 FROM player p WHERE p.id = 1 AND p.cprint = 'Waiting for players' AND p.cprint_time > :t + 1)) THEN
      EXECUTE PROCEDURE cprint('Waiting for players');
    EXIT;
  END
  IF (we >= 1e8) THEN
  BEGIN
    -- both here (the warmup, then map_restart's clean slate): scores from nothing, "prepare to fight"
    UPDATE game g SET g.warmup_end = :t + 4, g.warmup_said = 4, g.time_warnings = 0 WHERE g.id = 1;
    UPDATE player p SET p.frags = 0, p.deaths = 0, p.lead_state = 1 WHERE p.id = 1;
    UPDATE ents e SET e.frags = 0, e.deaths = 0 WHERE e.classname = 'bot';
    UPDATE ents e SET e.acc_shots = 0, e.acc_hits = 0, e.n_excellent = 0, e.n_impressive = 0, e.n_gauntlet = 0 WHERE e.classname IN ('player', 'bot');
    EXECUTE PROCEDURE snd_local('sound/feedback/prepare.wav');
    EXECUTE PROCEDURE cprint((SELECT LIST(TRIM(IIF(d.eid = player_ent(), (SELECT COALESCE(p.name, 'You') FROM player p WHERE p.id = 1), (SELECT e.bot FROM ents e WHERE e.id = d.eid))), ' vs ') FROM duel_ranked d));
  END
END^

-- ExitLevel: the intermission is over. A tournament does not change the arena: RemoveTournamentLoser
-- sends the second of the two to the back of the queue, and map_restart brings everything back for
-- the next duel (the next in the queue is pulled in by tourney_check); the rest go to the next map
CREATE OR ALTER PROCEDURE exit_level
AS
DECLARE loser INTEGER; DECLARE pe INTEGER; DECLARE b INTEGER;
BEGIN
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) <> 1) THEN
  BEGIN
    UPDATE game g SET g.exit_kind = 1 WHERE g.id = 1;
    EXIT;
  END
  IF (NOT EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.match_over = 1)) THEN EXIT;
  pe = player_ent();
  SELECT FIRST 1 SKIP 1 d.eid FROM duel_ranked d INTO loser;
  IF (loser = pe) THEN
  BEGIN
    EXECUTE PROCEDURE make_spectator;
    UPDATE ents e SET e.spec_time = now_() WHERE e.id = :pe;
    EXECUTE PROCEDURE say((SELECT COALESCE(p.name, 'Player') FROM player p WHERE p.id = 1) || ' joined the spectators.');
  END
  ELSE IF (loser IS NOT NULL) THEN EXECUTE PROCEDURE bot_to_queue(loser);
  -- map_restart: the items back, nothing in flight, the scores cleared by the next countdown
  UPDATE game g SET g.match_over = 0, g.winner = NULL, g.over_time = 0, g.exit_kind = 0, g.time_warnings = 0,
         g.warmup_end = 1e9, g.warmup_said = 0 WHERE g.id = 1;
  UPDATE ents e SET e.nextthink = now_() WHERE e.think = 'item_respawn';
  DELETE FROM ents e WHERE e.classname IN ('rocket', 'grenade', 'plasma', 'bfg');
  -- whoever stays back in the arena at a spawn point; the spectating player back to the spectators' place
  IF ((SELECT p.spectator FROM player p WHERE p.id = 1) = 1) THEN EXECUTE PROCEDURE make_spectator;
  ELSE EXECUTE PROCEDURE player_respawn;
  FOR SELECT e.id FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 INTO b DO EXECUTE PROCEDURE bot_respawn(b);
END^

-- ── joining and leaving mid-game ─────────────────────────────────────────
-- G_AddBot (the addbot command, the Add Bots menu): a bot of the roster that is not in the arena joins,
-- at the skill asked for; a team game puts it on PickTeam's team, a tournament queues it (tourney_check)
-- ClientUserinfoChanged's model: the player's model and skin, at once (a team game keeps its red or blue
-- skin, as the team's colours override the skin there)
-- the "color1" userinfo: the rail's colour, 1 to 7 (blue 1, green 2, red 4, summed); anything else is white, 7, as
-- CG_ColorFromString makes it
CREATE OR ALTER PROCEDURE set_player_color (c SMALLINT)
AS
BEGIN
  IF (c IS NULL OR c < 1 OR c > 7) THEN c = 7;
  UPDATE player p SET p.color1 = :c WHERE p.id = 1;
  UPDATE ents e SET e.color1 = :c WHERE e.id = player_ent();
END^

CREATE OR ALTER PROCEDURE set_player_model (m VARCHAR(16), s VARCHAR(16))
AS
BEGIN
  IF (m IS NULL OR TRIM(m) = '') THEN EXIT;
  UPDATE player p SET p.model = TRIM(:m), p.skin = TRIM(COALESCE(NULLIF(TRIM(:s), ''), 'default')) WHERE p.id = 1;
  UPDATE ents e SET e.pmodel = TRIM(:m), e.pskin = IIF(e.pteam > 0, e.pskin, TRIM(COALESCE(NULLIF(TRIM(:s), ''), 'default')))
   WHERE e.id = player_ent();
END^

CREATE OR ALTER PROCEDURE add_bot (bname VARCHAR(16), skill SMALLINT)
AS
DECLARE id INTEGER;
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM bot_defs b WHERE b.name = :bname)) THEN EXIT;
  IF (EXISTS (SELECT 1 FROM ents e WHERE e.classname = 'bot' AND e.bot = :bname)) THEN EXIT;   -- one of each
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.match_over = 1)) THEN EXIT;
  IF (skill IS NOT NULL) THEN UPDATE bot_defs b SET b.skill = MAXVALUE(1, MINVALUE(5, :skill)) WHERE b.name = :bname;
  EXECUTE PROCEDURE spawn_bot(bname) RETURNING_VALUES id;
  UPDATE game g SET g.num_bots = (SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot') WHERE g.id = 1;
END^

-- ClientDisconnect (clientkick, the Remove Bots menu): the bot says its goodbye (BotChat_ExitGame) and is
-- gone, with what it had in flight; nobody keeps it for an enemy or a view; in a tournament the one
-- behind who leaves mid-duel gives the other a win
CREATE OR ALTER PROCEDURE kick_bot (bname VARCHAR(16))
AS
DECLARE eid INTEGER; DECLARE first_ INTEGER; DECLARE second_ INTEGER;
BEGIN
  SELECT FIRST 1 e.id FROM ents e WHERE e.classname = 'bot' AND e.bot = :bname INTO eid;
  IF (eid IS NULL) THEN EXIT;
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.gametype = 1 AND g.match_over = 0 AND g.warmup_end <= g.time_)
      AND EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.queued = 0)) THEN
  BEGIN
    SELECT FIRST 1 d.eid FROM duel_ranked d INTO first_;
    SELECT FIRST 1 SKIP 1 d.eid FROM duel_ranked d INTO second_;
    IF (second_ = eid) THEN UPDATE ents e SET e.wins = e.wins + 1 WHERE e.id = :first_;
  END
  EXECUTE PROCEDURE bot_chat_event(eid, 'game_exit', NULL, 0);
  EXECUTE PROCEDURE say(bname || ' was kicked.');
  EXECUTE PROCEDURE body_release(eid);
  DELETE FROM ents e WHERE e.owner_id = :eid AND e.classname IN ('rocket', 'grenade', 'plasma', 'bfg');
  UPDATE ents e SET e.enemy_id = NULL WHERE e.enemy_id = :eid;
  UPDATE ents e SET e.acc_id = NULL WHERE e.acc_id = :eid;
  UPDATE player p SET p.follow_id = NULL WHERE p.follow_id = :eid;
  DELETE FROM bot_routes r WHERE r.ent_id = :eid;
  DELETE FROM ents e WHERE e.id = :eid;
  UPDATE game g SET g.num_bots = (SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot') WHERE g.id = 1;
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
  -- AdjustTournamentScores: a win for the first of the two, a loss for the second
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) = 1) THEN
  BEGIN
    UPDATE ents e SET e.wins = e.wins + 1 WHERE e.id = (SELECT FIRST 1 d.eid FROM duel_ranked d);
    UPDATE ents e SET e.losses = e.losses + 1 WHERE e.id = (SELECT FIRST 1 SKIP 1 d.eid FROM duel_ranked d);
  END
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
    IF (ek = 0 AND t > ot + 30) THEN EXECUTE PROCEDURE exit_level;
    EXIT;
  END
  IF ((SELECT g.gametype FROM game g WHERE g.id = 1) = 1) THEN
  BEGIN
    EXECUTE PROCEDURE tourney_check;
    SELECT g.warmup_end, g.warmup_said FROM game g WHERE g.id = 1 INTO we, ws;
    IF (we >= 1e8) THEN EXIT;
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
    SELECT MAX(e.frags) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 INTO bf;
    top = MAXVALUE(pf, COALESCE(bf, pf));
    n = IIF(pf = top, 1, 0) + (SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 AND e.frags = :top);
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
      IF (pf = top) THEN wname = 'You'; ELSE SELECT FIRST 1 e.bot FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 ORDER BY e.frags DESC INTO wname;
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
  SELECT IIF(p.spectator = 1, -1000000, p.frags), p.lead_state FROM player p WHERE p.id = 1 INTO pf, oldlead;
  SELECT COALESCE(MAX(e.frags), 0) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 INTO bf;
  lead = IIF(pf > bf, 2, IIF(pf = bf, 1, 0));
  IF (lead <> oldlead AND pf > -1000000 AND (attacker = pe OR victim = pe OR oldlead = 2 OR lead = 2)) THEN
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
    IF (pf >= lim) THEN wname = 'You'; ELSE SELECT FIRST 1 e.bot FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 ORDER BY e.frags DESC INTO wname;
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
  ELSE IF (think = 'missile_explode') THEN EXECUTE PROCEDURE missile_explode(eid, 0, 0, 1);
  ELSE IF (think = 'item_respawn') THEN EXECUTE PROCEDURE item_respawn(eid);
  ELSE IF (think = 'remove') THEN DELETE FROM ents e WHERE e.id = :eid;
  ELSE IF (think = 'body_sink') THEN EXECUTE PROCEDURE body_sink(eid);
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
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION; DECLARE ru DOUBLE PRECISION; DECLARE rh DOUBLE PRECISION;
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
      SELECT r.rj_x, r.rj_y, r.rj_z, r.rj_until, r.rj_hold FROM bot_routes r WHERE r.ent_id = :eid INTO rx, ry, rz, ru, rh;
      -- (a pad's throw is steered once it is over the ledge, or coming down)
      IF (ru > t AND (rh IS NULL OR pz > rh OR vz < 0)) THEN EXECUTE PROCEDURE bot_air_steer(eid, rx, ry, rz, dt);
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
    -- G_RunItem: a thrown item that falls into a nodrop brush (CONTENTS_NODROP, the void under the
    -- arena) is removed
    IF (mt = 10) THEN
    BEGIN
      ex = NULL;
      SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid AND e.classname = 'item' INTO ex, ey, ez;
      IF (ex IS NOT NULL) THEN
        IF (BIN_AND(point_contents(ex, ey, ez), -2147483648) <> 0) THEN DELETE FROM ents e WHERE e.id = :eid;
    END
  END
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
  gametype SMALLINT, red_score INTEGER, blue_score INTEGER, team SMALLINT, acc_shots INTEGER, acc_hits INTEGER)
AS
DECLARE i INTEGER = 0;
DECLARE did INTEGER; DECLARE bx DOUBLE PRECISION; DECLARE by_ DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION;
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
    -- Quake III's dead player is its own body until the respawn copies it into the queue: the eye goes where
    -- the body goes, knocked by a blast, carried by a mover, sliding down a slope
    FOR SELECT d.id, c.x, c.y, c.z FROM ents d JOIN ents c ON c.body_of = d.id AND c.classname = 'corpse'
         WHERE d.deadflag = 1 AND d.classname IN ('player', 'bot') AND (d.x <> c.x OR d.y <> c.y OR d.z <> c.z) INTO did, bx, by_, bz DO
    BEGIN
      UPDATE ents e SET e.x = :bx, e.y = :by_, e.z = :bz, e.vx = 0, e.vy = 0, e.vz = 0 WHERE e.id = :did;
      EXECUTE PROCEDURE link_ent(did);
    END
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
         (SELECT COALESCE(MAX(b.frags), 0) FROM ents b WHERE b.classname = 'bot' AND b.queued = 0), p.ducked, g.fraglimit, g.timelimit, g.over_time, g.next_map,
         p.dmg_z, p.dmg_world, p.land_change, e.vx, e.vy, g.warmup_end, e.award, e.award_time, e.n_excellent, e.n_impressive, e.n_gauntlet, p.spectator, IIF(p.follow_id IS NULL, NULL, e.bot),
         p.mover_yaw / :tics, g.gametype, g.red_score, g.blue_score, (SELECT o.pteam FROM ents o WHERE o.id = p.ent_id), e.acc_shots, e.acc_hits
    FROM game g CROSS JOIN player p JOIN ents e ON e.id = COALESCE(p.follow_id, p.ent_id)   -- following: the one followed
   WHERE g.id = 1 AND p.id = 1
    INTO tic, time_, health, max_health, armor, bullets, shells, grenades, rockets, lightning, slugs, cells, bfg,
         weapons, weapon, pending_weapon, weaponstate, weapon_time, attack_start, attack_finished,
         px, py, pz, yaw, pitch, view_z, punch, msg, cprint, dmg_take, dmg_save, dmg_time, dmg_x, dmg_y, bonus_time, dead, exit_kind, frags, deaths, waterlevel, watertype, map_name, level_msg,
         quad, haste, invis, regen, enviro, flight, holdable, leaf, cluster, match_over, winner, land_time, onground, move_speed, weapon_sound, lead, ducked, fraglimit, timelimit, over_time, next_map, dmg_z, dmg_world, land_change, vx, vy, warmup_end, award, award_time, n_excellent, n_impressive, n_gauntlet, spectator, follow_name, mover_yaw, gametype, red_score, blue_score, team, acc_shots, acc_hits;
  -- recording a demo: this snapshot (demo.sql)
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.demo_rec IS NOT NULL)) THEN
  BEGIN
    INSERT INTO demo_frames (demo_id, n, tic, time_, health, max_health, armor, bullets, shells, grenades, rockets, lightning, slugs, cells, bfg, weapons, weapon, pending_weapon, weaponstate, weapon_time, attack_start, attack_finished, px, py, pz, yaw, pitch, view_z, punch, msg, cprint, dmg_take, dmg_save, dmg_time, dmg_x, dmg_y, bonus_time, dead, exit_kind, frags, deaths, waterlevel, watertype, map_name, level_msg, quad, haste, invis, regen, enviro, flight, holdable, leaf, cluster, match_over, winner, land_time, onground, move_speed, weapon_sound, lead, ducked, fraglimit, timelimit, over_time, next_map, dmg_z, dmg_world, land_change, vx, vy, warmup_end, award, award_time, n_excellent, n_impressive, n_gauntlet, spectator, follow_name, mover_yaw, gametype, red_score, blue_score, team, acc_shots, acc_hits, follow_id, view_ofs)
      SELECT g.demo_rec, g.demo_n, :tic, :time_, :health, :max_health, :armor, :bullets, :shells, :grenades, :rockets, :lightning, :slugs, :cells, :bfg, :weapons, :weapon, :pending_weapon, :weaponstate, :weapon_time, :attack_start, :attack_finished, :px, :py, :pz, :yaw, :pitch, :view_z, :punch, :msg, :cprint, :dmg_take, :dmg_save, :dmg_time, :dmg_x, :dmg_y, :bonus_time, :dead, :exit_kind, :frags, :deaths, :waterlevel, :watertype, :map_name, :level_msg, :quad, :haste, :invis, :regen, :enviro, :flight, :holdable, :leaf, :cluster, :match_over, :winner, :land_time, :onground, :move_speed, :weapon_sound, :lead, :ducked, :fraglimit, :timelimit, :over_time, :next_map, :dmg_z, :dmg_world, :land_change, :vx, :vy, :warmup_end, :award, :award_time, :n_excellent, :n_impressive, :n_gauntlet, :spectator, :follow_name, :mover_yaw, :gametype, :red_score, :blue_score, :team, :acc_shots, :acc_hits, p.follow_id, IIF(p.follow_id IS NULL, p.view_ofs - p.stepz, NULL)
        FROM game g CROSS JOIN player p WHERE g.id = 1 AND p.id = 1;
    EXECUTE PROCEDURE demo_snap;
  END
  UPDATE player p SET p.dmg_take = 0, p.dmg_save = 0 WHERE p.id = 1 AND p.dmg_time < :time_ - 0.05e0;
  SUSPEND;
END^

-- the scoreboard: the player and the bots by frags
CREATE OR ALTER PROCEDURE scoreboard
RETURNS (name VARCHAR(32), frags INTEGER, deaths INTEGER, is_player SMALLINT, team SMALLINT, wins SMALLINT, losses SMALLINT)
AS
DECLARE st DOUBLE PRECISION;
BEGIN
  -- (a tournament's spectators, the queue, are team 3 (TEAM_SPECTATOR), in the order they will play)
  FOR SELECT x.name, x.frags, x.deaths, x.is_player, x.team, x.wins, x.losses, x.spec_time FROM (
        SELECT 'You' AS name, p.frags, p.deaths, 1 AS is_player,
               IIF(p.spectator = 1 AND g.gametype = 1, 3, COALESCE(e.pteam, 0)) AS team, e.wins, e.losses, e.spec_time
          FROM player p CROSS JOIN game g LEFT JOIN ents e ON e.id = p.ent_id WHERE p.id = 1 AND g.id = 1
        UNION ALL
        SELECT e.bot, e.frags, e.deaths, 0, IIF(e.queued = 1, 3, e.pteam), e.wins, e.losses, e.spec_time FROM ents e WHERE e.classname = 'bot') x
      ORDER BY x.team, IIF(x.team = 3, x.spec_time, -x.frags), x.deaths INTO name, frags, deaths, is_player, team, wins, losses, st DO SUSPEND;
END^

-- G_InitGame + ClientBegin: the map's entities, the player and the bots
CREATE OR ALTER PROCEDURE init_map (map_name VARCHAR(32), world_model INTEGER, skill SMALLINT, new_game SMALLINT, num_bots INTEGER,
                                    fraglimit INTEGER DEFAULT 20, timelimit INTEGER DEFAULT 0, warmup DOUBLE PRECISION DEFAULT 0,
                                    gametype SMALLINT DEFAULT 0, team SMALLINT DEFAULT 0)
AS
DECLARE pe INTEGER; DECLARE b VARCHAR(16); DECLARE i INTEGER = 0; DECLARE n INTEGER; DECLARE skyname VARCHAR(64);
BEGIN
  -- a new map stops a recording, and ends a demo playing (demo.sql)
  EXECUTE PROCEDURE demo_record_stop;
  UPDATE game g SET g.demo_play = NULL WHERE g.id = 1;
  UPDATE game g SET g.tic = 0, g.time_ = 0, g.map_name = :map_name, g.next_map = NULL, g.exit_kind = 0, g.skill = :skill, g.world_model = :world_model,
         g.level_msg = NULL, g.gravity = 800, g.match_over = 0, g.winner = NULL, g.over_time = 0, g.num_bots = :num_bots,
         g.fraglimit = COALESCE(:fraglimit, 20), g.timelimit = COALESCE(:timelimit, 0), g.time_warnings = 0,
         g.warmup_end = COALESCE(:warmup, 0), g.warmup_said = IIF(COALESCE(:warmup, 0) > 0, 4, 0),
         g.has_water = IIF(EXISTS (SELECT 1 FROM brushes b WHERE BIN_AND(b.contents, 32) <> 0), 1, 0),
         g.gametype = IIF(COALESCE(:gametype, 0) >= 3, 3, IIF(:gametype = 1, 1, 0)), g.red_score = 0, g.blue_score = 0, g.team_lead = 0,
         g.red_leader = NULL, g.blue_leader = NULL WHERE g.id = 1;
  -- the sky: the first sky shader the map's faces use
  SELECT FIRST 1 t.name FROM textures t WHERE BIN_AND(t.flags, 4) <> 0 INTO skyname;
  UPDATE game g SET g.sky = :skyname WHERE g.id = 1;
  UPDATE bot_defs b SET b.skill = :skill;
  DELETE FROM bot_avoid;
  EXECUTE PROCEDURE spawn_map_ents;
  EXECUTE PROCEDURE build_waypoints;
  DELETE FROM bot_routes;
  -- the player
  EXECUTE PROCEDURE spawn_ent('player', 0, 0, 0) RETURNING_VALUES pe;
  UPDATE ents e SET e.pmodel = (SELECT p.model FROM player p WHERE p.id = 1), e.pskin = (SELECT p.skin FROM player p WHERE p.id = 1),
    e.color1 = (SELECT p.color1 FROM player p WHERE p.id = 1), e.viewheight = 26 WHERE e.id = :pe;
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
  -- a tournament: the first two to come play, the others are spectators in the order they came (a
  -- spectating player last); CheckTournament starts the countdown
  IF (COALESCE(gametype, 0) = 1) THEN
  BEGIN
    i = (SELECT IIF(p.spectator = 1, 0, 1) FROM player p WHERE p.id = 1);
    FOR SELECT e.id FROM ents e WHERE e.classname = 'bot' ORDER BY e.id INTO pe DO
    BEGIN
      IF (i >= 2) THEN
      BEGIN
        EXECUTE PROCEDURE bot_to_queue(pe);
        UPDATE ents e SET e.spec_time = now_() + :i * 0.001e0 WHERE e.id = :pe;
      END
      i = i + 1;
    END
    UPDATE ents e SET e.spec_time = now_() + 1 WHERE e.id = player_ent() AND (SELECT p.spectator FROM player p WHERE p.id = 1) = 1;
    UPDATE game g SET g.warmup_end = 1e9, g.warmup_said = 0 WHERE g.id = 1;
  END
  -- the bots' greetings (BotChat_StartLevel)
  FOR SELECT e.id FROM ents e WHERE e.classname = 'bot' ORDER BY e.id INTO pe DO EXECUTE PROCEDURE bot_chat_event(pe, 'level_start', NULL, 0);
  -- the level name, and "fight"
  UPDATE player p SET p.cprint = (SELECT g.level_msg FROM game g WHERE g.id = 1), p.cprint_time = 3 WHERE p.id = 1;
  IF (COALESCE(gametype, 0) <> 1) THEN   -- (a tournament's countdown says it when its two are there)
    EXECUTE PROCEDURE snd_local(IIF(COALESCE(warmup, 0) > 0, 'sound/feedback/prepare.wav', 'sound/feedback/fight.wav'));   -- "prepare to fight", or straight in
END^

SET TERM ; ^
