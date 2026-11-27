-- ctf.sql – capture the flag (g_team.c's flags, GT_CTF = 4): each team's flag stands at its base; an enemy who
-- touches it carries it (PW_REDFLAG, PW_BLUEFLAG), and brought to its own flag at its own base it is a capture, a
-- point for the team. A carrier that dies drops it; a dropped flag goes home when one of its team touches it or
-- after 30 seconds. The first team at the capturelimit wins.
--
-- Where a flag is needs no state of its own: it is carried when a player's effects have its bit (131072 the red
-- flag, 262144 the blue: they go with the entity to the painter and into a demo's snapshots), dropped when an
-- item of its class with an owner lies about, and else at its base (the map's item, hidden while it is away).
-- The bots' part is bot_ctf_goals, a small piece of BotCTFSeekGoals and BotCTFOrders.

SET TERM ^ ;

-- TeamName
CREATE OR ALTER FUNCTION ctf_team_name (tm SMALLINT) RETURNS VARCHAR(8)
AS
BEGIN
  IF (tm = 1) THEN RETURN 'RED';
  IF (tm = 2) THEN RETURN 'BLUE';
  RETURN 'FREE';
END^

-- the flag an entity carries: 0 none, 1 the red one, 2 the blue one
CREATE OR ALTER FUNCTION ctf_carried (eid INTEGER) RETURNS SMALLINT
AS
DECLARE ef INTEGER;
BEGIN
  SELECT e.effects FROM ents e WHERE e.id = :eid INTO ef;
  IF (BIN_AND(COALESCE(ef, 0), 131072) <> 0) THEN RETURN 1;
  IF (BIN_AND(COALESCE(ef, 0), 262144) <> 0) THEN RETURN 2;
  RETURN 0;
END^

-- a team's flag at its base (the map's item, there or hidden), and who carries it
CREATE OR ALTER FUNCTION ctf_base (tm SMALLINT) RETURNS INTEGER
AS
BEGIN
  RETURN (SELECT FIRST 1 e.id FROM ents e WHERE e.classname = 'item' AND e.owner_id IS NULL
            AND e.item = IIF(:tm = 1, 'team_CTF_redflag', 'team_CTF_blueflag') ORDER BY e.id);
END^

CREATE OR ALTER FUNCTION ctf_carrier (tm SMALLINT) RETURNS INTEGER
AS
BEGIN
  RETURN (SELECT FIRST 1 e.id FROM ents e WHERE e.classname IN ('player', 'bot') AND BIN_AND(e.effects, IIF(:tm = 1, 131072, 262144)) <> 0 ORDER BY e.id);
END^

CREATE OR ALTER FUNCTION ctf_dropped (tm SMALLINT) RETURNS INTEGER
AS
BEGIN
  RETURN (SELECT FIRST 1 e.id FROM ents e WHERE e.classname = 'item' AND e.owner_id IS NOT NULL
            AND e.item = IIF(:tm = 1, 'team_CTF_redflag', 'team_CTF_blueflag') ORDER BY e.id);
END^

-- Team_SetFlagStatus's answer: 0 at its base, 1 taken, 2 dropped
CREATE OR ALTER FUNCTION ctf_status (tm SMALLINT) RETURNS SMALLINT
AS
BEGIN
  IF (ctf_carrier(tm) IS NOT NULL) THEN RETURN 1;
  IF (ctf_dropped(tm) IS NOT NULL) THEN RETURN 2;
  RETURN 0;
END^

-- The team sounds as the player hears them (CG_EntityEvent's EV_GLOBAL_TEAM_SOUND: which one depends on the
-- listener's team). kind 1: team tm's flag was taken (by `who`); 2: it is back at its base; 3: team tm scored
CREATE OR ALTER PROCEDURE ctf_sound (kind SMALLINT, tm SMALLINT, who INTEGER)
AS
DECLARE pe INTEGER; DECLARE mine SMALLINT;
BEGIN
  pe = player_ent();
  SELECT e.pteam FROM ents e WHERE e.id = :pe INTO mine;
  IF (kind = 1) THEN
  BEGIN
    IF (who = pe) THEN EXECUTE PROCEDURE snd_local('sound/teamplay/voc_you_flag.wav');
    ELSE IF (mine = tm) THEN
    BEGIN
      EXECUTE PROCEDURE snd_local('sound/teamplay/flagtaken_opponent.wav');
      EXECUTE PROCEDURE snd_local('sound/teamplay/voc_enemy_flag.wav');
    END
    ELSE
    BEGIN
      EXECUTE PROCEDURE snd_local('sound/teamplay/flagtaken_yourteam.wav');
      EXECUTE PROCEDURE snd_local('sound/teamplay/voc_team_flag.wav');
    END
  END
  ELSE IF (kind = 2) THEN
  BEGIN
    EXECUTE PROCEDURE snd_local(TRIM(IIF(mine = tm, 'sound/teamplay/flagreturn_yourteam.wav', 'sound/teamplay/flagreturn_opponent.wav')));
    EXECUTE PROCEDURE snd_local(TRIM(IIF(tm = 1, 'sound/teamplay/voc_red_returned.wav', 'sound/teamplay/voc_blue_returned.wav')));
  END
  ELSE
  BEGIN
    EXECUTE PROCEDURE snd_local(TRIM(IIF(mine = tm, 'sound/teamplay/flagcapture_yourteam.wav', 'sound/teamplay/flagcapture_opponent.wav')));
    EXECUTE PROCEDURE snd_local(TRIM(IIF(tm = 1, 'sound/teamplay/voc_red_scores.wav', 'sound/teamplay/voc_blue_scores.wav')));
  END
END^

-- Team_ResetFlag: a team's flag back at its base; what lay dropped of it goes, and nobody carries it
CREATE OR ALTER PROCEDURE ctf_reset_flag (tm SMALLINT)
AS
DECLARE d INTEGER;
BEGIN
  FOR SELECT e.id FROM ents e WHERE e.classname = 'item' AND e.owner_id IS NOT NULL AND e.item = IIF(:tm = 1, 'team_CTF_redflag', 'team_CTF_blueflag') INTO d DO
    EXECUTE PROCEDURE remove_ent(d);
  UPDATE ents e SET e.effects = BIN_AND(e.effects, BIN_NOT(IIF(:tm = 1, 131072, 262144)))
   WHERE e.classname IN ('player', 'bot', 'corpse') AND BIN_AND(e.effects, IIF(:tm = 1, 131072, 262144)) <> 0;
  UPDATE ents e SET e.solid = 1, e.alpha = 0, e.think = NULL, e.nextthink = NULL
   WHERE e.classname = 'item' AND e.owner_id IS NULL AND e.item = IIF(:tm = 1, 'team_CTF_redflag', 'team_CTF_blueflag');
END^

-- Team_ReturnFlag: back at its base, said and heard
CREATE OR ALTER PROCEDURE ctf_return_flag (tm SMALLINT)
AS
BEGIN
  EXECUTE PROCEDURE ctf_reset_flag(tm);
  EXECUTE PROCEDURE say('The ' || ctf_team_name(tm) || ' flag has returned!');
  EXECUTE PROCEDURE ctf_sound(2, tm, NULL);
END^

-- Team_DroppedFlagThink: a dropped flag nobody touched for 30 seconds goes home
CREATE OR ALTER PROCEDURE flag_return (eid INTEGER)
AS
DECLARE cls VARCHAR(40);
BEGIN
  SELECT e.item FROM ents e WHERE e.id = :eid INTO cls;
  IF (cls IS NULL) THEN EXIT;
  EXECUTE PROCEDURE ctf_return_flag(IIF(cls = 'team_CTF_redflag', 1, 2));
END^

-- Pickup_Team: a player or a bot touches a flag. Its own team's: a dropped one goes home (Team_TouchOurFlag: a
-- frag for the recovery), and the one at its base takes the enemy flag it carries for a capture: a point for
-- the team, five frags for the carrier, both flags home. The enemy's: it is carried from here (Team_TouchEnemyFlag)
CREATE OR ALTER PROCEDURE ctf_touch_flag (item INTEGER, other INTEGER)
AS
DECLARE cls VARCHAR(40); DECLARE dropped SMALLINT; DECLARE ftm SMALLINT; DECLARE tm SMALLINT; DECLARE hp INTEGER; DECLARE ef INTEGER;
DECLARE nm VARCHAR(32); DECLARE lim INTEGER; DECLARE rs INTEGER; DECLARE bs INTEGER; DECLARE tl SMALLINT; DECLARE otl SMALLINT;
BEGIN
  SELECT e.item, IIF(e.owner_id IS NULL, 0, 1) FROM ents e WHERE e.id = :item AND e.solid = 1 INTO cls, dropped;
  IF (cls IS NULL) THEN EXIT;
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND (g.gametype <> 4 OR g.match_over = 1))) THEN EXIT;
  ftm = IIF(cls = 'team_CTF_redflag', 1, 2);
  SELECT e.pteam, e.health, e.effects FROM ents e WHERE e.id = :other AND e.classname IN ('player', 'bot') AND e.deadflag = 0 INTO tm, hp, ef;
  IF (tm IS NULL OR tm NOT IN (1, 2) OR hp <= 0) THEN EXIT;
  IF (other = player_ent() AND (SELECT p.spectator FROM player p WHERE p.id = 1) = 1) THEN EXIT;
  nm = chat_name(other);
  IF (tm = ftm) THEN
  BEGIN
    IF (dropped = 1) THEN
    BEGIN
      EXECUTE PROCEDURE say(nm || ' returned the ' || ctf_team_name(ftm) || ' flag!');
      EXECUTE PROCEDURE add_score(other, 1);                     -- CTF_RECOVERY_BONUS
      EXECUTE PROCEDURE ctf_reset_flag(ftm);
      EXECUTE PROCEDURE ctf_sound(2, ftm, NULL);
      EXIT;
    END
    IF (BIN_AND(ef, IIF(tm = 1, 262144, 131072)) = 0) THEN EXIT;   -- we do not have the flag
    EXECUTE PROCEDURE say(nm || ' captured the ' || ctf_team_name(3 - ftm) || ' flag!');
    UPDATE ents e SET e.effects = BIN_AND(e.effects, BIN_NOT(393216)) WHERE e.id = :other;
    UPDATE game g SET g.red_score = g.red_score + IIF(:tm = 1, 1, 0), g.blue_score = g.blue_score + IIF(:tm = 2, 1, 0) WHERE g.id = 1;
    EXECUTE PROCEDURE add_score(other, 5);                       -- CTF_CAPTURE_BONUS
    EXECUTE PROCEDURE ctf_sound(3, tm, other);
    EXECUTE PROCEDURE ctf_reset_flag(1);                         -- Team_ResetFlags
    EXECUTE PROCEDURE ctf_reset_flag(2);
    SELECT g.capturelimit, g.red_score, g.blue_score, g.team_lead FROM game g WHERE g.id = 1 INTO lim, rs, bs, otl;
    tl = IIF(rs > bs, 1, IIF(bs > rs, 2, 0));
    IF (tl <> otl) THEN
    BEGIN
      UPDATE game g SET g.team_lead = :tl WHERE g.id = 1;
      EXECUTE PROCEDURE snd_local(CASE tl WHEN 1 THEN 'sound/feedback/redleads.wav' WHEN 2 THEN 'sound/feedback/blueleads.wav' ELSE 'sound/feedback/teamstied.wav' END);
    END
    IF (lim > 0 AND (rs >= lim OR bs >= lim)) THEN
    BEGIN
      EXECUTE PROCEDURE sprint(TRIM(IIF(rs >= lim, 'Red', 'Blue')) || ' hit the capturelimit.');
      EXECUTE PROCEDURE end_match(TRIM(IIF(rs >= lim, 'Red team', 'Blue team')));
    END
    EXIT;
  END
  -- the enemy's flag: carried from here; a dropped one is gone, the one at its base hidden till it is back
  EXECUTE PROCEDURE say(nm || ' got the ' || ctf_team_name(ftm) || ' flag!');
  UPDATE ents e SET e.effects = BIN_OR(e.effects, IIF(:ftm = 1, 131072, 262144)) WHERE e.id = :other;
  IF (dropped = 1) THEN EXECUTE PROCEDURE remove_ent(item);
  ELSE UPDATE ents e SET e.solid = 0, e.alpha = 1, e.think = NULL, e.nextthink = NULL WHERE e.id = :item;
  EXECUTE PROCEDURE ctf_sound(1, ftm, other);
END^

-- A carrier that dies (TossClientItems) drops the flag where it stood: thrown as any item is, home in 30 seconds
-- (Launch_Item gives the flags Team_DroppedFlagThink) unless someone touches it first. Who dropped it and when is
-- kept for the bonus of the one that fragged it
CREATE OR ALTER PROCEDURE ctf_drop_flag (eid INTEGER)
AS
DECLARE tm SMALLINT; DECLARE cls VARCHAR(40); DECLARE it INTEGER;
BEGIN
  tm = ctf_carried(eid);
  IF (tm = 0) THEN EXIT;
  UPDATE ents e SET e.effects = BIN_AND(e.effects, BIN_NOT(393216)) WHERE e.id = :eid;
  UPDATE game g SET g.ctf_carrier = :eid, g.ctf_drop_time = g.time_ WHERE g.id = 1;
  cls = IIF(tm = 1, 'team_CTF_redflag', 'team_CTF_blueflag');
  EXECUTE PROCEDURE drop_item(eid, cls, 0, 0);
  SELECT FIRST 1 e.id FROM ents e WHERE e.classname = 'item' AND e.item = :cls AND e.owner_id = :eid ORDER BY e.id DESC INTO it;
  IF (it IS NULL) THEN EXECUTE PROCEDURE ctf_return_flag(tm);
  ELSE UPDATE ents e SET e.think = 'flag_return', e.nextthink = now_() + 30 WHERE e.id = :it;
END^

-- Team_FragBonuses, its first part: two frags more for fragging the enemy's flag carrier
CREATE OR ALTER PROCEDURE ctf_frag_bonus (attacker INTEGER, victim INTEGER)
AS
DECLARE carrier INTEGER; DECLARE dt DOUBLE PRECISION; DECLARE atm SMALLINT;
BEGIN
  IF (attacker IS NULL OR attacker <= 0 OR attacker = victim OR on_same_team(attacker, victim) = 1) THEN EXIT;
  SELECT g.ctf_carrier, g.time_ - g.ctf_drop_time FROM game g WHERE g.id = 1 AND g.gametype = 4 INTO carrier, dt;
  IF (NOT ((carrier = victim AND dt < 0.2e0) OR ctf_carried(victim) <> 0)) THEN EXIT;
  UPDATE game g SET g.ctf_carrier = NULL WHERE g.id = 1;
  SELECT e.pteam FROM ents e WHERE e.id = :attacker INTO atm;
  EXECUTE PROCEDURE add_score(attacker, 2);                      -- CTF_FRAG_CARRIER_BONUS
  EXECUTE PROCEDURE say(chat_name(attacker) || ' fragged ' || ctf_team_name(3 - atm) || '''s flag carrier!');
END^

-- The bots' flag play, a small part of BotCTFSeekGoals and of the team leader's BotCTFOrders. A bot with the enemy
-- flag takes it home (and stays about its base while its own flag is away). A flag lying dropped is gone for,
-- its own to send it home and the enemy's to carry it on. Otherwise the team's bots are split as the leader would
-- split them with both flags at their bases: one in two or three defends its base, two in five of a larger team,
-- and the others go for the enemy flag; a defender whose flag was taken is after the carrier. These goals are the
-- bot's own (ctf_goal 1) and give way to an order of the player's (chat.sql), which they take up again after.
CREATE OR ALTER PROCEDURE bot_ctf_goals (eid INTEGER)
AS
DECLARE tm SMALLINT; DECLARE getid INTEGER; DECLARE defid INTEGER; DECLARE own SMALLINT; DECLARE t DOUBLE PRECISION;
DECLARE mine INTEGER; DECLARE theirs INTEGER; DECLARE wget INTEGER; DECLARE wdef INTEGER; DECLARE n INTEGER; DECLARE idx INTEGER; DECLARE ndef INTEGER;
DECLARE st_mine SMALLINT; DECLARE st_theirs SMALLINT; DECLARE carrier INTEGER; DECLARE odef INTEGER;
BEGIN
  SELECT e.pteam, e.get_id, e.def_id, e.ctf_goal FROM ents e WHERE e.id = :eid AND e.classname = 'bot' AND e.health > 0 INTO tm, getid, defid, own;
  IF (tm IS NULL OR tm NOT IN (1, 2)) THEN EXIT;
  IF (own = 0 AND (getid IS NOT NULL OR defid IS NOT NULL)) THEN EXIT;   -- an order of the player's stands
  t = now_();
  mine = ctf_base(tm); theirs = ctf_base(3 - tm);
  IF (mine IS NULL OR theirs IS NULL) THEN EXIT;
  st_mine = ctf_status(tm); st_theirs = ctf_status(3 - tm);
  IF (ctf_carried(eid) <> 0) THEN
  BEGIN
    IF (st_mine = 0) THEN wget = mine; ELSE wdef = mine;
  END
  ELSE IF (st_mine = 2) THEN wget = ctf_dropped(tm);
  ELSE IF (st_theirs = 2) THEN wget = ctf_dropped(3 - tm);
  ELSE
  BEGIN
    SELECT COUNT(*) FROM ents b WHERE b.classname = 'bot' AND b.pteam = :tm INTO n;
    SELECT COUNT(*) FROM ents b WHERE b.classname = 'bot' AND b.pteam = :tm AND b.id < :eid INTO idx;
    ndef = IIF(n <= 1, 0, IIF(n <= 3, 1, CAST(FLOOR(n * 0.4e0) AS INTEGER)));
    IF (idx < ndef) THEN
    BEGIN
      IF (st_mine = 1) THEN
      BEGIN
        carrier = ctf_carrier(tm);
        UPDATE ents e SET e.enemy_id = :carrier, e.search_time = :t + 10, e.st = 'run'
         WHERE e.id = :eid AND :carrier IS NOT NULL AND (e.enemy_id IS NULL OR e.enemy_id <> :carrier)
           AND NOT EXISTS (SELECT 1 FROM ents o WHERE o.id = e.enemy_id AND o.health > 0 AND o.deadflag = 0);
      END
      ELSE wdef = mine;
    END
    ELSE IF (st_theirs = 0) THEN wget = theirs;
  END
  odef = IIF(own = 1, defid, NULL);
  UPDATE ents e SET e.get_id = :wget, e.get_until = :t + 60, e.def_id = :wdef, e.def_until = :t + 600,
         e.def_away = IIF(:wdef IS NOT DISTINCT FROM :odef, e.def_away, 0), e.ctf_goal = IIF(:wget IS NULL AND :wdef IS NULL, 0, 1)
   WHERE e.id = :eid;
END^

SET TERM ; ^
