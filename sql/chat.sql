-- chat.sql – what the player says to the bots (botlib's BotMatchMessage and the BotMatch_* of ai_cmd.c): a typed
-- line is matched to an intent (follow me, camp here, get the …, kill …, dismissed, where are you, what are you
-- doing, a greeting, a taunt, praise) and the bots it is for act on it and answer from their chat files.
--
-- botlib matches the words against match.c's templates. Here the matching is by meaning: the intents' phrases
-- (src/intents.js) were embedded once with EmbeddingGemma 2 (bot_phrase_dims: the leading 128 dimensions,
-- normalized), the page embeds what was typed with the same model and passes the vector, and the nearest phrase by
-- cosine similarity, a sum of products over the dimensions, says what was meant. Without a vector (the model
-- not loaded) a phrase has to be in the line word for word.

SET TERM ^ ;

-- the best match of the vector in say_dims: the phrase with the highest cosine similarity
CREATE OR ALTER PROCEDURE say_match
RETURNS (intent INTEGER, score DOUBLE PRECISION)
AS
BEGIN
  SELECT FIRST 1 p.intent, SUM(d.v * s.v) FROM bot_phrase_dims d JOIN say_dims s ON s.i = d.i JOIN bot_phrases p ON p.id = d.phrase
   GROUP BY p.id, p.intent ORDER BY 2 DESC INTO intent, score;
END^

-- one bot takes an order or answers (BotMatch_HelpAccompany, _Camp, _GetItem, _Kill, _Dismiss, _WhereAreYou,
-- _WhatAreYouDoing): `target` is whom to kill
CREATE OR ALTER PROCEDURE bot_take_order (eid INTEGER, kind VARCHAR(20), arg VARCHAR(40), target INTEGER)
AS
DECLARE pe INTEGER; DECLARE t DOUBLE PRECISION; DECLARE c INTEGER; DECLARE g INTEGER; DECLARE nm VARCHAR(40);
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE acc INTEGER; DECLARE camp INTEGER; DECLARE getid INTEGER; DECLARE en INTEGER;
BEGIN
  pe = player_ent();
  t = now_();
  IF (kind IN ('accompany', 'camp', 'dismiss', 'get', 'kill', 'defend')) THEN
  BEGIN
    -- a new order ends the old one: the camp spot ordered before goes
    DELETE FROM ents c WHERE c.classname = 'camp_order' AND c.owner_id = :eid;
    UPDATE ents e SET e.acc_id = NULL, e.camp_id = NULL, e.camp_until = NULL, e.get_id = NULL, e.def_id = NULL, e.goal_id = NULL, e.nbg_id = NULL WHERE e.id = :eid;
  END
  IF (kind = 'accompany') THEN EXECUTE PROCEDURE bot_order_accompany(eid, pe, pe);   -- (it answers within two seconds: accompany_start)
  ELSE IF (kind = 'camp') THEN
  BEGIN
    -- where the one who said it stands, for TEAM_CAMP_TIME, 600 s
    SELECT o.x, o.y, o.z FROM ents o WHERE o.id = :pe INTO x, y, z;
    EXECUTE PROCEDURE spawn_ent('camp_order', x, y, z) RETURNING_VALUES c;
    UPDATE ents o SET o.owner_id = :eid WHERE o.id = :c;
    UPDATE ents e SET e.camp_id = :c, e.camp_until = :t + 600, e.camp_time = :t WHERE e.id = :eid;
    EXECUTE PROCEDURE bot_say(eid, 'camp_start', chat_name(pe), NULL, NULL, NULL, NULL, NULL, pe, 0);
  END
  ELSE IF (kind = 'dismiss') THEN EXECUTE PROCEDURE bot_say(eid, 'dismissed', NULL, NULL, NULL, NULL, NULL, NULL, pe, 0);
  ELSE IF (kind = 'get') THEN
  BEGIN
    -- the nearest one of the arena, for TEAM_GETITEM_TIME, 60 s
    SELECT i.name FROM item_defs i WHERE i.cls = :arg INTO nm;
    SELECT FIRST 1 o.id FROM ents o CROSS JOIN ents e WHERE e.id = :eid AND o.classname = 'item' AND TRIM(o.item) = :arg AND o.think IS DISTINCT FROM 'remove'
     ORDER BY (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) + (o.z - e.z) * (o.z - e.z) INTO g;
    IF (g IS NULL) THEN EXECUTE PROCEDURE bot_say(eid, 'cannotfind', COALESCE(nm, arg), NULL, NULL, NULL, NULL, NULL, pe, 0);
    ELSE
    BEGIN
      UPDATE ents e SET e.get_id = :g, e.get_until = :t + 60, e.goal_id = :g WHERE e.id = :eid;
      DELETE FROM bot_avoid a WHERE a.ent_id = :eid AND a.item_id = :g;
      EXECUTE PROCEDURE bot_say(eid, 'getitem_start', nm, NULL, NULL, NULL, NULL, NULL, pe, 0);
    END
  END
  ELSE IF (kind = 'defend') THEN
  BEGIN
    -- BotMatch_DefendKeyArea: the item's place is the team goal for TEAM_DEFENDKEYAREA_TIME, 600 s; the nearest
    -- one of the arena, there or taken (BotGetLevelItemGoal: an item of the level, not a dropped one). No such
    -- item, no answer, as the original has it (its "cannotfind" is commented out)
    SELECT i.name FROM item_defs i WHERE i.cls = :arg INTO nm;
    SELECT FIRST 1 o.id FROM ents o CROSS JOIN ents e WHERE e.id = :eid AND o.classname = 'item' AND TRIM(o.item) = :arg AND o.think IS DISTINCT FROM 'remove'
     ORDER BY (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) + (o.z - e.z) * (o.z - e.z) INTO g;
    IF (g IS NOT NULL) THEN
    BEGIN
      UPDATE ents e SET e.def_id = :g, e.def_until = :t + 600, e.def_away = 0 WHERE e.id = :eid;
      EXECUTE PROCEDURE bot_say(eid, 'defend_start', nm, NULL, NULL, NULL, NULL, NULL, -1, 0);
    END
  END
  ELSE IF (kind = 'kill') THEN
  BEGIN
    -- after it for TEAM_KILL_SOMEONE, 180 s
    IF (target IS NULL) THEN EXIT;
    UPDATE ents e SET e.enemy_id = :target, e.search_time = :t + 180, e.st = 'run' WHERE e.id = :eid;
    EXECUTE PROCEDURE bot_say(eid, 'killing', chat_name(target), NULL, NULL, NULL, NULL, NULL, pe, 0);
  END
  ELSE IF (kind = 'whereareyou') THEN
  BEGIN
    -- "I'm near the …": the nearest item's name (BotMatch_WhereAreYou's nearby item)
    SELECT FIRST 1 i.name FROM ents o JOIN item_defs i ON i.cls = o.item CROSS JOIN ents e
     WHERE e.id = :eid AND o.classname = 'item' AND i.kind IN ('W', 'A', 'P', 'H')
     ORDER BY (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) + (o.z - e.z) * (o.z - e.z) * 4 INTO nm;
    IF (nm IS NOT NULL) THEN EXECUTE PROCEDURE bot_say(eid, 'location', nm, NULL, NULL, NULL, NULL, NULL, pe, 0);
  END
  ELSE IF (kind = 'whatareyoudoing') THEN
  BEGIN
    SELECT e.acc_id, e.camp_id, e.get_id, e.enemy_id, e.def_id FROM ents e WHERE e.id = :eid INTO acc, camp, getid, en, g;
    IF (acc IS NOT NULL) THEN EXECUTE PROCEDURE bot_say(eid, 'accompanying', chat_name(acc), NULL, NULL, NULL, NULL, NULL, pe, 0);
    ELSE IF (g IS NOT NULL) THEN
      EXECUTE PROCEDURE bot_say(eid, 'defending', (SELECT i.name FROM ents o JOIN item_defs i ON i.cls = o.item WHERE o.id = :g), NULL, NULL, NULL, NULL, NULL, pe, 0);
    ELSE IF (camp IS NOT NULL) THEN EXECUTE PROCEDURE bot_say(eid, 'camping', NULL, NULL, NULL, NULL, NULL, NULL, pe, 0);
    ELSE IF (getid IS NOT NULL) THEN
      EXECUTE PROCEDURE bot_say(eid, 'gettingitem', (SELECT i.name FROM ents o JOIN item_defs i ON i.cls = o.item WHERE o.id = :getid), NULL, NULL, NULL, NULL, NULL, pe, 0);
    ELSE IF (en IS NOT NULL AND EXISTS (SELECT 1 FROM ents o WHERE o.id = :en AND o.health > 0)) THEN
      EXECUTE PROCEDURE bot_say(eid, 'killing', chat_name(en), NULL, NULL, NULL, NULL, NULL, pe, 0);
    ELSE EXECUTE PROCEDURE bot_say(eid, 'roaming', NULL, NULL, NULL, NULL, NULL, NULL, pe, 0);
  END
  ELSE IF (kind = 'hello') THEN EXECUTE PROCEDURE bot_say(eid, 'game_enter', chat_name(eid), chat_name(pe), NULL, NULL, NULL, NULL, 0, 0);
  ELSE IF (kind = 'taunt') THEN EXECUTE PROCEDURE bot_say(eid, 'random_insult', chat_name(pe), chat_name(eid), NULL, NULL, NULL, 'Gauntlet', 0, 0);
  ELSE IF (kind = 'praise') THEN EXECUTE PROCEDURE bot_say(eid, 'random_misc', chat_name(pe), chat_name(eid), NULL, NULL, NULL, 'Gauntlet', 0, 0);
END^

-- "say": the player's line goes to the console, is matched to an intent and given to the bots it is for.
--   `vec`  its embedding, the numbers separated by commas, or NULL
-- An order (accompany, camp, get, kill, dismiss) is for the bots of the player's team, those named in the line
-- or all of them (BotMatchMessage: only a teammate is obeyed); in a free-for-all nobody obeys. A question is
-- answered by the bots named, or by the team, or by the nearest bot; a greeting, a taunt or praise by the bot
-- named or the nearest. Returns what was understood, how sure (the similarity; 1 for a word-for-word match) and
-- how many bots took it
CREATE OR ALTER PROCEDURE player_say (msg VARCHAR(200), vec VARCHAR(4000) DEFAULT NULL)
RETURNS (kind VARCHAR(20), arg VARCHAR(40), score DOUBLE PRECISION, heard INTEGER)
AS
DECLARE pe INTEGER; DECLARE intent INTEGER; DECLARE p INTEGER; DECLARE q INTEGER; DECLARE i INTEGER; DECLARE low VARCHAR(200);
DECLARE gt SMALLINT; DECLARE pteam SMALLINT; DECLARE spec SMALLINT; DECLARE named INTEGER; DECLARE b INTEGER; DECLARE target INTEGER;
DECLARE ordered SMALLINT;
BEGIN
  heard = 0;
  msg = TRIM(msg);
  IF (msg = '') THEN EXIT;
  pe = player_ent();
  low = LOWER(msg);
  EXECUTE PROCEDURE say(SUBSTRING(chat_name(pe) || ': ' || msg FROM 1 FOR 200));
  EXECUTE PROCEDURE snd_local('sound/player/talk.wav');
  IF (vec IS NOT NULL AND TRIM(vec) <> '') THEN
  BEGIN
    DELETE FROM say_dims;
    p = 1; i = 0;
    WHILE (p <= CHAR_LENGTH(vec) AND i < 1024) DO
    BEGIN
      q = POSITION(',', vec, p);
      IF (q = 0) THEN q = CHAR_LENGTH(vec) + 1;
      INSERT INTO say_dims (i, v) VALUES (:i, CAST(SUBSTRING(:vec FROM :p FOR :q - :p) AS DOUBLE PRECISION));
      p = q + 1; i = i + 1;
    END
    EXECUTE PROCEDURE say_match RETURNING_VALUES intent, score;
    -- (under 0.905 nothing was meant: the model rates any two short lines about 0.9 alike; of the test lines the
    -- unrelated ones reach 0.898 at most and the meant ones 0.912 at least)
    IF (score < 0.905e0) THEN intent = NULL;
  END
  ELSE
  BEGIN
    -- no model: the longest phrase that is in the line as it stands
    SELECT FIRST 1 ph.intent FROM bot_phrases ph WHERE POSITION(LOWER(ph.phrase) IN :low) > 0 ORDER BY CHAR_LENGTH(ph.phrase) DESC INTO intent;
    score = IIF(intent IS NULL, 0, 1);
  END
  SELECT n.kind, n.arg FROM bot_intents n WHERE n.id = :intent INTO kind, arg;
  IF (kind IS NULL OR kind = 'chat') THEN BEGIN kind = NULL; SUSPEND; EXIT; END
  SELECT g.gametype FROM game g WHERE g.id = 1 INTO gt;
  SELECT o.pteam, (SELECT pl.spectator FROM player pl WHERE pl.id = 1) FROM ents o WHERE o.id = :pe INTO pteam, spec;
  -- the team's leader (BotMatch_WhoIsTeamLeader, _StartTeamLeaderShip, _StopTeamLeaderShip): asked for, the bot
  -- that leads says so; "I am the leader" makes us it for every bot of the team; "I quit" leaves the team without
  -- one and us out of it (notleader), and the bots find one among themselves (bot_team_ai)
  IF (kind IN ('whoisleader', 'iamleader', 'notleader')) THEN
  BEGIN
    IF (gt >= 3 AND spec = 0) THEN
    BEGIN
      SELECT IIF(:pteam = 1, g.red_leader, g.blue_leader) FROM game g WHERE g.id = 1 INTO b;
      IF (kind = 'whoisleader') THEN
      BEGIN
        IF (b IS NOT NULL AND b <> pe AND EXISTS (SELECT 1 FROM ents e WHERE e.id = :b AND e.classname = 'bot' AND e.pteam = :pteam AND e.queued = 0)) THEN
        BEGIN
          EXECUTE PROCEDURE say('(' || chat_name(b) || '): I''m the team leader');
          heard = 1;
        END
      END
      ELSE
      BEGIN
        IF (kind = 'iamleader') THEN
          UPDATE game g SET g.not_leader = 0, g.red_leader = IIF(:pteam = 1, :pe, g.red_leader), g.blue_leader = IIF(:pteam = 2, :pe, g.blue_leader) WHERE g.id = 1;
        ELSE
          UPDATE game g SET g.not_leader = 1, g.red_leader = IIF(:pteam = 1 AND g.red_leader IS NOT DISTINCT FROM :pe, NULL, g.red_leader),
                 g.blue_leader = IIF(:pteam = 2 AND g.blue_leader IS NOT DISTINCT FROM :pe, NULL, g.blue_leader) WHERE g.id = 1;
        SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 AND e.pteam = :pteam INTO heard;
      END
    END
    SUSPEND;
    EXIT;
  END
  ordered = IIF(kind IN ('accompany', 'camp', 'dismiss', 'get', 'kill', 'defend'), 1, 0);
  -- the bots named in the line
  SELECT COUNT(*) FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 AND POSITION(LOWER(TRIM(e.bot)) IN :low) > 0
     AND (:ordered = 0 OR (:gt >= 3 AND e.pteam = :pteam)) INTO named;
  IF (ordered = 1 AND (gt < 3 OR spec = 1)) THEN
  BEGIN
    EXECUTE PROCEDURE say('(the bots take orders from a teammate: play a team game)');
    SUSPEND;
    EXIT;
  END
  IF (kind = 'kill') THEN
  BEGIN
    -- whom: an enemy named in the line, else the one nearest us
    SELECT FIRST 1 o.id FROM ents o CROSS JOIN ents me WHERE me.id = :pe AND o.classname = 'bot' AND o.queued = 0 AND o.health > 0 AND o.pteam <> :pteam
     ORDER BY IIF(POSITION(LOWER(TRIM(o.bot)) IN :low) > 0, 0, 1), (o.x - me.x) * (o.x - me.x) + (o.y - me.y) * (o.y - me.y) INTO target;
  END
  FOR SELECT e.id FROM ents e CROSS JOIN ents me
       WHERE me.id = :pe AND e.classname = 'bot' AND e.queued = 0
         AND (:named = 0 OR POSITION(LOWER(TRIM(e.bot)) IN :low) > 0)
         AND (:ordered = 0 OR e.pteam = :pteam)
         -- (unnamed, a question goes to the team, or in a free-for-all to the nearest bot; the rest to the nearest)
         AND (:named > 0 OR :ordered = 1 OR (:kind IN ('whereareyou', 'whatareyoudoing') AND :gt >= 3 AND e.pteam = :pteam)
              OR e.id = (SELECT FIRST 1 o.id FROM ents o WHERE o.classname = 'bot' AND o.queued = 0 AND o.health > 0
                           AND (:gt < 3 OR :kind NOT IN ('whereareyou', 'whatareyoudoing') OR o.pteam = :pteam)
                          ORDER BY (o.x - me.x) * (o.x - me.x) + (o.y - me.y) * (o.y - me.y) + (o.z - me.z) * (o.z - me.z)))
       ORDER BY e.id INTO b
  DO
  BEGIN
    EXECUTE PROCEDURE bot_take_order(b, kind, arg, target);
    heard = heard + 1;
  END
  SUSPEND;
END^

-- ── A bot whose strategy a language model decides ─────────────────────────────────────────────────────────────
-- Every few seconds the page asks a model (src/llm.js: Claude, with the player's own API key) what a bot should
-- do next, and that is all it asks: which item to go for, whom to hunt, where to wait. The bot's hands stay
-- bot_think's: it aims, dodges, fires and finds its way as every bot does. bot_llm_state writes what the bot
-- knows as a few lines of text, bot_llm_apply carries out the answer with the orders a teammate could give
-- (bot_take_order's get, kill, camp and dismiss, without the chatter), and JavaScript only passes the two along.

-- The bots the model leads: none (0), the first (1) or all of them (2)
CREATE OR ALTER PROCEDURE bot_llm_lead (n SMALLINT)
AS
DECLARE b INTEGER;
BEGIN
  UPDATE ents e SET e.llm = 0, e.llm_plan = NULL, e.llm_time = NULL WHERE e.classname = 'bot';
  -- (decisions left open by a match that ended: nothing is known of what followed; and the clock of a new match
  -- starts again, so those of earlier matches count for the arena's totals alone)
  DELETE FROM bot_llm_log l WHERE l.hp1 IS NULL AND l.ok = 1;
  UPDATE bot_llm_log l SET l.past = 1 WHERE l.past = 0;
  IF (n = 0) THEN EXIT;
  FOR SELECT e.id FROM ents e WHERE e.classname = 'bot' AND e.queued = 0 ORDER BY e.id ROWS (IIF(:n = 1, 1, 64)) INTO b DO
  BEGIN
    UPDATE ents e SET e.llm = 1 WHERE e.id = :b;
    EXECUTE PROCEDURE say(chat_name(b) || ' is led by a language model');
  END
END^

-- The guns of a WP bitmask by name, with their ammunition: "Machinegun (40), Rocket Launcher (10)"
CREATE OR ALTER FUNCTION llm_guns (eid INTEGER) RETURNS VARCHAR(300)
AS
DECLARE ws INTEGER; DECLARE bit INTEGER = 1; DECLARE k SMALLINT = 1; DECLARE nm VARCHAR(40); DECLARE am INTEGER; DECLARE r VARCHAR(300) = '';
BEGIN
  SELECT e.weapons FROM ents e WHERE e.id = :eid INTO ws;
  WHILE (bit <= 256) DO
  BEGIN
    IF (BIN_AND(ws, bit) <> 0) THEN
    BEGIN
      SELECT i.name FROM item_defs i WHERE i.kind = 'W' AND i.bit = :bit INTO nm;
      SELECT CASE :k WHEN 2 THEN e.ammo2 WHEN 3 THEN e.ammo3 WHEN 4 THEN e.ammo4 WHEN 5 THEN e.ammo5 WHEN 6 THEN e.ammo6
                     WHEN 7 THEN e.ammo7 WHEN 8 THEN e.ammo8 WHEN 9 THEN e.ammo9 END FROM ents e WHERE e.id = :eid INTO am;
      IF (r <> '') THEN r = r || ', ';
      r = r || TRIM(nm);
      IF (k > 1) THEN r = r || ' (' || COALESCE(am, 0) || ')';
    END
    bit = bit * 2; k = k + 1;
  END
  RETURN r;
END^

-- What a led bot knows, as text for the model: itself, what it is doing, the match, the others (how far, in
-- sight or not, the gun in hand), the items of the arena by class (the nearest of each: how far, or in how many
-- seconds it is back) and the console's last lines. One row for each led bot that is alive.
CREATE OR ALTER PROCEDURE bot_llm_state
RETURNS (eid INTEGER, bot VARCHAR(16), txt VARCHAR(4000))
AS
DECLARE t DOUBLE PRECISION; DECLARE pe INTEGER; DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE hp INTEGER; DECLARE ar INTEGER; DECLARE fr INTEGER; DECLARE de INTEGER; DECLARE w INTEGER; DECLARE ws INTEGER;
DECLARE getid INTEGER; DECLARE camp INTEGER; DECLARE en INTEGER; DECLARE quad DOUBLE PRECISION; DECLARE lastd VARCHAR(60);
DECLARE o INTEGER; DECLARE onm VARCHAR(32); DECLARE ohp INTEGER; DECLARE ofr INTEGER; DECLARE ow INTEGER; DECLARE d DOUBLE PRECISION;
DECLARE cls VARCHAR(40); DECLARE nm VARCHAR(40); DECLARE kind CHAR(1); DECLARE bit INTEGER; DECLARE back DOUBLE PRECISION;
DECLARE line VARCHAR(400); DECLARE gt SMALLINT; DECLARE lim INTEGER; DECLARE tl INTEGER; DECLARE mapn VARCHAR(32); DECLARE m VARCHAR(200);
DECLARE team SMALLINT; DECLARE oteam SMALLINT;
BEGIN
  t = now_();
  pe = player_ent();
  SELECT g.gametype, g.fraglimit, g.timelimit, g.map_name FROM game g WHERE g.id = 1 INTO gt, lim, tl, mapn;
  FOR SELECT e.id, e.bot, e.x, e.y, e.z, e.health, e.armor, e.frags, e.deaths, e.weapon, e.weapons, e.get_id, e.camp_id, e.enemy_id,
             e.quad_finished, e.llm_plan, e.pteam
        FROM ents e WHERE e.classname = 'bot' AND e.llm = 1 AND e.health > 0 AND e.queued = 0 ORDER BY e.id
      INTO eid, bot, x, y, z, hp, ar, fr, de, w, ws, getid, camp, en, quad, lastd, team DO
  BEGIN
    txt = 'you: ' || TRIM(bot) || ', health ' || hp || ', armor ' || ar || ', frags ' || fr || ', deaths ' || de
          || ', in hand ' || COALESCE((SELECT TRIM(i.name) FROM item_defs i WHERE i.kind = 'W' AND i.bit = :w), 'nothing')
          || TRIM(TRAILING FROM IIF(quad > t, ', quad damage for ' || CAST(quad - t AS INTEGER) || ' s', ''))
          || TRIM(TRAILING FROM IIF(gt >= 3, ', team ' || TRIM(IIF(team = 1, 'red', 'blue')), '')) || ASCII_CHAR(10)
          || 'guns (ammo): ' || llm_guns(eid) || ASCII_CHAR(10)
          || 'doing: ' || TRIM(CASE
               WHEN getid IS NOT NULL THEN 'going for the ' || COALESCE((SELECT TRIM(i.name) FROM ents g JOIN item_defs i ON i.cls = TRIM(g.item) WHERE g.id = :getid), 'item')
               WHEN camp IS NOT NULL THEN 'waiting in ambush'
               WHEN en IS NOT NULL AND EXISTS (SELECT 1 FROM ents q WHERE q.id = :en AND q.health > 0) THEN 'after ' || chat_name(en)
               ELSE 'roaming for items' END)
          || TRIM(TRAILING FROM IIF(lastd IS NULL, '', ' (your last decision: ' || TRIM(lastd) || ')')) || ASCII_CHAR(10)
          || 'match: ' || TRIM(CASE gt WHEN 1 THEN 'tournament' WHEN 3 THEN 'team deathmatch' ELSE 'free for all' END) || ' on ' || COALESCE(TRIM(mapn), '?')
          || ', first to ' || lim || ' frags' || TRIM(TRAILING FROM IIF(tl > 0, ', ' || CAST(t / 60 AS INTEGER) || ' of ' || tl || ' minutes played', '')) || ASCII_CHAR(10)
          || 'others:';
    FOR SELECT q.id, chat_name(q.id), q.health, IIF(q.classname = 'player', p.frags, q.frags), IIF(q.classname = 'player', p.weapon, q.weapon),
               SQRT((q.x - :x) * (q.x - :x) + (q.y - :y) * (q.y - :y) + (q.z - :z) * (q.z - :z)), q.pteam
          FROM ents q LEFT JOIN player p ON p.id = 1
         WHERE q.classname IN ('player', 'bot') AND q.id <> :eid AND q.queued = 0 AND NOT (q.classname = 'player' AND p.spectator = 1)
         ORDER BY 6 INTO o, onm, ohp, ofr, ow, d, oteam DO
    BEGIN
      line = ASCII_CHAR(10) || '  ' || TRIM(onm) || TRIM(TRAILING FROM IIF(gt >= 3, IIF(oteam = team, ' (teammate)', ' (enemy)'), '')) || ': frags ' || ofr;
      IF (ohp <= 0) THEN line = line || ', dead';
      ELSE line = line || ', ' || CAST(d AS INTEGER) || ' units away, ' || TRIM(IIF(visible(eid, o) = 1, 'in sight', 'out of sight'))
                  || ', in hand ' || COALESCE((SELECT TRIM(i.name) FROM item_defs i WHERE i.kind = 'W' AND i.bit = :ow), '?');
      txt = txt || line;
    END
    txt = txt || ASCII_CHAR(10) || 'items (class: name, the nearest one):';
    FOR SELECT TRIM(i.cls), TRIM(i.name), i.kind, i.bit,
               MIN(IIF(g.solid = 1, SQRT((g.x - :x) * (g.x - :x) + (g.y - :y) * (g.y - :y) + (g.z - :z) * (g.z - :z)), NULL)),
               MIN(IIF(g.solid = 1, NULL, g.nextthink - :t))
          FROM ents g JOIN item_defs i ON i.cls = TRIM(g.item)
         WHERE g.classname = 'item' AND i.kind IN ('W', 'A', 'H', 'P') AND g.think IS DISTINCT FROM 'remove'
         GROUP BY 1, 2, 3, 4 ORDER BY 3 DESC, 5 INTO cls, nm, kind, bit, d, back DO
    BEGIN
      line = ASCII_CHAR(10) || '  ' || cls || ': ' || nm
             || TRIM(TRAILING FROM IIF(d IS NOT NULL, ', ' || CAST(d AS INTEGER) || ' units away', ', taken, back in ' || CAST(MAXVALUE(back, 0) AS INTEGER) || ' s'))
             || TRIM(TRAILING FROM IIF(kind = 'W' AND BIN_AND(ws, bit) <> 0, ' (you have it)', ''));
      IF (CHAR_LENGTH(txt) + CHAR_LENGTH(line) < 3400) THEN txt = txt || line;
    END
    txt = txt || ASCII_CHAR(10) || 'console, latest last:';
    FOR SELECT s.msg FROM (SELECT FIRST 6 c.id, c.msg FROM messages c ORDER BY c.id DESC) s ORDER BY s.id INTO m DO
      IF (CHAR_LENGTH(txt) + CHAR_LENGTH(m) < 3900) THEN txt = txt || ASCII_CHAR(10) || '  ' || TRIM(m);
    SUSPEND;
  END
END^

-- What followed a decision, in words: "frags +1, died, health 35 to 80, armor +50, picked up the Rocket Launcher"
CREATE OR ALTER FUNCTION llm_outcome (id INTEGER) RETURNS VARCHAR(200)
AS
DECLARE ok SMALLINT; DECLARE hp0 INTEGER; DECLARE ar0 INTEGER; DECLARE fr0 INTEGER; DECLARE de0 INTEGER; DECLARE ws0 INTEGER;
DECLARE hp1 INTEGER; DECLARE ar1 INTEGER; DECLARE fr1 INTEGER; DECLARE de1 INTEGER; DECLARE ws1 INTEGER;
DECLARE r VARCHAR(200) = ''; DECLARE nm VARCHAR(40);
BEGIN
  SELECT l.ok, l.hp0, l.armor0, l.frags0, l.deaths0, l.weapons0, l.hp1, l.armor1, l.frags1, l.deaths1, l.weapons1 FROM bot_llm_log l WHERE l.id = :id
    INTO ok, hp0, ar0, fr0, de0, ws0, hp1, ar1, fr1, de1, ws1;
  IF (ok = 0) THEN RETURN 'could not be done';
  IF (hp1 IS NULL) THEN RETURN 'under way';
  IF (fr1 > fr0) THEN r = r || ', frags +' || (fr1 - fr0);
  IF (fr1 < fr0) THEN r = r || ', frags ' || (fr1 - fr0);
  IF (de1 > de0) THEN r = r || ', died';
  ELSE
  BEGIN
    IF (hp1 <> hp0) THEN r = r || ', health ' || hp0 || ' to ' || hp1;
    IF (ar1 <> ar0) THEN r = r || ', armor ' || ar0 || ' to ' || ar1;
    FOR SELECT TRIM(i.name) FROM item_defs i WHERE i.kind = 'W' AND BIN_AND(:ws1, i.bit) <> 0 AND BIN_AND(:ws0, i.bit) = 0 ORDER BY i.bit INTO nm DO
      r = r || ', picked up the ' || nm;
  END
  IF (r = '') THEN RETURN 'nothing changed';
  RETURN SUBSTRING(r FROM 3);
END^

-- The memory of a led bot, as text after its situation: its last six decisions of this match with what followed
-- each, what every kind of decision has brought on this arena so far (a GROUP BY over all of them: how often, how
-- often it could not be done, the frags and the deaths that followed), and the notes the model asked to have kept.
-- The totals and the notes are the arena's, whichever bot was led: the model is the same one, the bots of the
-- next match may not be
CREATE OR ALTER FUNCTION bot_llm_memory (eid INTEGER) RETURNS VARCHAR(3000)
AS
DECLARE bot VARCHAR(16); DECLARE mapn VARCHAR(32); DECLARE t DOUBLE PRECISION; DECLARE r VARCHAR(3000) = '';
DECLARE id INTEGER; DECLARE at_ DOUBLE PRECISION; DECLARE act VARCHAR(20); DECLARE arg VARCHAR(40); DECLARE n INTEGER; DECLARE bad INTEGER;
DECLARE fr INTEGER; DECLARE de INTEGER; DECLARE note VARCHAR(160); DECLARE line VARCHAR(300); DECLARE k INTEGER = 0;
BEGIN
  t = now_();
  SELECT e.bot, g.map_name FROM ents e CROSS JOIN game g WHERE e.id = :eid AND g.id = 1 INTO bot, mapn;
  FOR SELECT s.id, s.time_, TRIM(s.action), TRIM(s.arg)
        FROM (SELECT FIRST 6 l.id, l.time_, l.action, l.arg FROM bot_llm_log l WHERE l.bot = :bot AND l.map_name = :mapn AND l.past = 0 ORDER BY l.id DESC) s
       ORDER BY s.id INTO id, at_, act, arg DO
  BEGIN
    IF (k = 0) THEN r = r || ASCII_CHAR(10) || 'your last decisions, the latest last, and what followed each:';
    k = k + 1;
    line = '  ' || CAST(t - at_ AS INTEGER) || ' s ago, ' || act;
    IF (arg <> '') THEN line = line || ' ' || arg;
    r = r || ASCII_CHAR(10) || line || ': ' || llm_outcome(id);
  END
  k = 0;
  FOR SELECT TRIM(l.action), TRIM(l.arg), COUNT(*), SUM(1 - l.ok), SUM(IIF(l.ok = 1, l.frags1 - l.frags0, 0)), SUM(IIF(l.ok = 1, l.deaths1 - l.deaths0, 0))
        FROM bot_llm_log l WHERE l.map_name = :mapn AND (l.hp1 IS NOT NULL OR l.ok = 0)
       GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 ROWS 8 INTO act, arg, n, bad, fr, de DO
  BEGIN
    IF (k = 0) THEN r = r || ASCII_CHAR(10) || 'what your decisions have brought on this arena, in all your matches here:';
    k = k + 1;
    line = '  ' || act;
    IF (arg <> '') THEN line = line || ' ' || arg;
    line = line || ': ' || n || ' time';
    IF (n <> 1) THEN line = line || 's';
    IF (bad > 0) THEN line = line || ' (' || bad || ' could not be done)';
    r = r || ASCII_CHAR(10) || line || ', frags ' || IIF(fr >= 0, '+', '') || fr || ', deaths ' || de;
  END
  k = 0;
  FOR SELECT TRIM(c.note) FROM bot_llm_notes c WHERE c.map_name = :mapn ORDER BY c.id INTO note DO
  BEGIN
    IF (k = 0) THEN r = r || ASCII_CHAR(10) || 'your notes about this arena, which you wrote to remember:';
    k = k + 1;
    IF (CHAR_LENGTH(r) < 2700) THEN r = r || ASCII_CHAR(10) || '  ' || note;
  END
  RETURN r;
END^

-- The situation with the memory after it: what the model is sent
CREATE OR ALTER PROCEDURE bot_llm_ask
RETURNS (eid INTEGER, bot VARCHAR(16), txt VARCHAR(7000))
AS
DECLARE s VARCHAR(4000);
BEGIN
  FOR SELECT a.eid, a.bot, a.txt FROM bot_llm_state a INTO eid, bot, s DO
  BEGIN
    txt = s || bot_llm_memory(eid);
    SUSPEND;
  END
END^

-- The model's answer carried out. `action` is get (an item's class in `arg`: the nearest one, for 40 s), hunt (a
-- player's name: after it for 40 s), ambush (wait where it stands, 25 s) or roam (as the bot's own goals say);
-- `line`, if any, is said in the console. Anything else, an item the arena does not have, a name nobody bears:
-- nothing is done and `done` says why, which the next question to the model carries as its last decision.
CREATE OR ALTER PROCEDURE bot_llm_apply (eid INTEGER, action VARCHAR(20), arg VARCHAR(40), line VARCHAR(160), note VARCHAR(160) DEFAULT '')
RETURNS (done VARCHAR(60))
AS
DECLARE t DOUBLE PRECISION; DECLARE g INTEGER; DECLARE c INTEGER; DECLARE o INTEGER;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE bot VARCHAR(16); DECLARE mapn VARCHAR(32); DECLARE ok SMALLINT = 0;
DECLARE hp INTEGER; DECLARE ar INTEGER; DECLARE fr INTEGER; DECLARE de INTEGER; DECLARE ws INTEGER;
BEGIN
  t = now_();
  action = LOWER(TRIM(COALESCE(action, '')));
  arg = TRIM(COALESCE(arg, ''));
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid AND e.classname = 'bot' AND e.llm = 1 AND e.health > 0)) THEN
  BEGIN done = 'no such bot alive'; SUSPEND; EXIT; END
  done = action || IIF(arg = '', '', ' ' || arg);
  IF (action = 'get') THEN
  BEGIN
    SELECT FIRST 1 q.id FROM ents q CROSS JOIN ents e WHERE e.id = :eid AND q.classname = 'item' AND TRIM(q.item) = LOWER(:arg) AND q.solid = 1
     ORDER BY (q.x - e.x) * (q.x - e.x) + (q.y - e.y) * (q.y - e.y) + (q.z - e.z) * (q.z - e.z) INTO g;
    IF (g IS NULL) THEN done = 'get ' || arg || ': none there now';
  END
  ELSE IF (action = 'hunt') THEN
  BEGIN
    SELECT FIRST 1 q.id FROM ents q WHERE q.classname IN ('player', 'bot') AND q.id <> :eid AND q.health > 0 AND LOWER(chat_name(q.id)) = LOWER(:arg) INTO o;
    IF (o IS NULL) THEN done = 'hunt ' || arg || ': nobody alive by that name';
  END
  ELSE IF (action NOT IN ('ambush', 'roam')) THEN done = 'not understood: ' || SUBSTRING(action FROM 1 FOR 20);
  IF (action IN ('get', 'hunt', 'ambush', 'roam') AND NOT (action = 'get' AND g IS NULL) AND NOT (action = 'hunt' AND o IS NULL)) THEN
  BEGIN
    -- a new decision ends the last one, as a new order does
    DELETE FROM ents q WHERE q.classname = 'camp_order' AND q.owner_id = :eid;
    UPDATE ents e SET e.camp_id = NULL, e.camp_until = NULL, e.get_id = NULL, e.goal_id = NULL, e.nbg_id = NULL WHERE e.id = :eid;
    IF (action = 'get') THEN
    BEGIN
      UPDATE ents e SET e.get_id = :g, e.get_until = :t + 40, e.goal_id = :g WHERE e.id = :eid;
      DELETE FROM bot_avoid a WHERE a.ent_id = :eid AND a.item_id = :g;
    END
    ELSE IF (action = 'hunt') THEN UPDATE ents e SET e.enemy_id = :o, e.search_time = :t + 40, e.st = 'run' WHERE e.id = :eid;
    ELSE IF (action = 'ambush') THEN
    BEGIN
      SELECT e.x, e.y, e.z FROM ents e WHERE e.id = :eid INTO x, y, z;
      EXECUTE PROCEDURE spawn_ent('camp_order', x, y, z) RETURNING_VALUES c;
      UPDATE ents q SET q.owner_id = :eid WHERE q.id = :c;
      UPDATE ents e SET e.camp_id = :c, e.camp_until = :t + 25, e.camp_time = :t WHERE e.id = :eid;
    END
    ok = 1;
  END
  UPDATE ents e SET e.llm_plan = SUBSTRING(:done FROM 1 FOR 60), e.llm_time = :t WHERE e.id = :eid;
  -- the memory (bot_llm_memory reads it back): the decision before this one is closed with the bot as it is now,
  -- this one is opened, and a note is kept, the newest twelve of this arena
  SELECT e.bot, gm.map_name FROM ents e CROSS JOIN game gm WHERE e.id = :eid AND gm.id = 1 INTO bot, mapn;
  mapn = COALESCE(mapn, '');
  SELECT e.health, e.armor, e.frags, e.deaths, e.weapons FROM ents e WHERE e.id = :eid INTO hp, ar, fr, de, ws;
  UPDATE bot_llm_log l SET l.hp1 = :hp, l.armor1 = :ar, l.frags1 = :fr, l.deaths1 = :de, l.weapons1 = :ws, l.secs = :t - l.time_
   WHERE l.bot = :bot AND l.map_name = :mapn AND l.hp1 IS NULL AND l.ok = 1;
  IF (action IN ('get', 'hunt', 'ambush', 'roam')) THEN
    INSERT INTO bot_llm_log (id, bot, map_name, time_, action, arg, ok, hp0, armor0, frags0, deaths0, weapons0)
    SELECT NEXT VALUE FOR llm_seq, :bot, :mapn, :t, :action, SUBSTRING(LOWER(:arg) FROM 1 FOR 40), :ok, e.health, e.armor, e.frags, e.deaths, e.weapons
      FROM ents e WHERE e.id = :eid;
  note = TRIM(COALESCE(note, ''));
  IF (note <> '' AND NOT EXISTS (SELECT 1 FROM bot_llm_notes c WHERE c.map_name = :mapn AND LOWER(c.note) = LOWER(:note))) THEN
  BEGIN
    INSERT INTO bot_llm_notes (id, bot, map_name, note) VALUES (NEXT VALUE FOR llm_seq, :bot, :mapn, :note);
    DELETE FROM bot_llm_notes c WHERE c.map_name = :mapn
       AND c.id NOT IN (SELECT FIRST 12 k.id FROM bot_llm_notes k WHERE k.map_name = :mapn ORDER BY k.id DESC);
  END
  line = TRIM(COALESCE(line, ''));
  IF (line <> '') THEN EXECUTE PROCEDURE say(SUBSTRING(chat_name(eid) || ': ' || line FROM 1 FOR 200));
  SUSPEND;
END^

-- ── The same for a small model that runs in the browser ───────────────────────────────────────────────────────
-- A model small enough to download into a browser reads a short text and answers a word; it cannot be trusted to
-- write an item's class or a JSON object, and the smallest cannot choose from a list of ten. So SQL does more of
-- the work: bot_llm_offer finds the best move of each kind and writes them as lines that begin with a word,
--   heal: the nearest health (when hurt; the mega always) or armor that is there
--   arm:  the nearest gun the bot does not have, or powerup
--   hunt: the nearest of the others alive (of the enemies, in a team game)
--   wait: an ambush where it stands
-- after one line about the bot; the model answers one of the words, and bot_llm_pick gives the move kept under
-- that word to bot_llm_apply, so the memory (bot_llm_log) is written as for the large model.

-- The brief, one row for each led bot alive; the moves are kept in bot_llm_choices
CREATE OR ALTER PROCEDURE bot_llm_offer
RETURNS (eid INTEGER, bot VARCHAR(16), txt VARCHAR(1000), words VARCHAR(40))
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION;
DECLARE hp INTEGER; DECLARE ar INTEGER; DECLARE ws INTEGER; DECLARE team SMALLINT; DECLARE gt SMALLINT;
DECLARE cls VARCHAR(40); DECLARE nm VARCHAR(40); DECLARE d DOUBLE PRECISION; DECLARE o INTEGER; DECLARE onm VARCHAR(32); DECLARE ow INTEGER;
DECLARE line VARCHAR(300);
BEGIN
  SELECT g.gametype FROM game g WHERE g.id = 1 INTO gt;
  FOR SELECT e.id, e.bot, e.x, e.y, e.z, e.health, e.armor, e.weapons, e.pteam
        FROM ents e WHERE e.classname = 'bot' AND e.llm = 1 AND e.health > 0 AND e.queued = 0 ORDER BY e.id
      INTO eid, bot, x, y, z, hp, ar, ws, team DO
  BEGIN
    DELETE FROM bot_llm_choices c WHERE c.eid = :eid;
    words = '';
    txt = 'Health ' || hp || ', armor ' || ar || '. Guns: ' || llm_guns(eid) || '.';
    -- the nearest of the others
    o = NULL;
    SELECT FIRST 1 q.id, chat_name(q.id), IIF(q.classname = 'player', p.weapon, q.weapon),
           SQRT((q.x - :x) * (q.x - :x) + (q.y - :y) * (q.y - :y) + (q.z - :z) * (q.z - :z))
      FROM ents q LEFT JOIN player p ON p.id = 1
     WHERE q.classname IN ('player', 'bot') AND q.id <> :eid AND q.queued = 0 AND q.health > 0 AND NOT (q.classname = 'player' AND p.spectator = 1)
       AND (:gt < 3 OR q.pteam <> :team)
     ORDER BY 4 INTO o, onm, ow, d;
    IF (o IS NOT NULL) THEN
    BEGIN
      line = ' Nearest enemy: ' || CAST(d AS INTEGER) || ' units away';
      IF (visible(eid, o) = 1) THEN line = line || ', in sight';
      txt = txt || line || ', holding the ' || COALESCE((SELECT TRIM(i.name) FROM item_defs i WHERE i.kind = 'W' AND i.bit = :ow), 'Machinegun') || '.';
    END
    cls = NULL;
    SELECT FIRST 1 TRIM(i.cls), TRIM(i.name), SQRT((g.x - :x) * (g.x - :x) + (g.y - :y) * (g.y - :y) + (g.z - :z) * (g.z - :z))
      FROM ents g JOIN item_defs i ON i.cls = TRIM(g.item)
     WHERE g.classname = 'item' AND g.solid = 1
       AND ((i.kind = 'H' AND (:hp < 100 AND i.qty >= 25 OR i.qty >= 100)) OR (i.kind = 'A' AND :ar < 100 AND i.qty >= 25))
     ORDER BY 3 INTO cls, nm, d;
    IF (cls IS NOT NULL) THEN
    BEGIN
      INSERT INTO bot_llm_choices (eid, word, action, arg) VALUES (:eid, 'heal', 'get', :cls);
      txt = txt || ASCII_CHAR(10) || 'heal: the ' || nm || ', ' || CAST(d AS INTEGER) || ' units away';
      words = words || 'heal ';
    END
    cls = NULL;
    SELECT FIRST 1 TRIM(i.cls), TRIM(i.name), SQRT((g.x - :x) * (g.x - :x) + (g.y - :y) * (g.y - :y) + (g.z - :z) * (g.z - :z))
      FROM ents g JOIN item_defs i ON i.cls = TRIM(g.item)
     WHERE g.classname = 'item' AND g.solid = 1 AND ((i.kind = 'W' AND BIN_AND(:ws, i.bit) = 0) OR i.kind = 'P')
     ORDER BY 3 INTO cls, nm, d;
    IF (cls IS NOT NULL) THEN
    BEGIN
      INSERT INTO bot_llm_choices (eid, word, action, arg) VALUES (:eid, 'arm', 'get', :cls);
      txt = txt || ASCII_CHAR(10) || 'arm: the ' || nm || ', ' || CAST(d AS INTEGER) || ' units away';
      words = words || 'arm ';
    END
    IF (o IS NOT NULL) THEN
    BEGIN
      INSERT INTO bot_llm_choices (eid, word, action, arg) VALUES (:eid, 'hunt', 'hunt', TRIM(:onm));
      txt = txt || ASCII_CHAR(10) || 'hunt: ' || TRIM(onm);
      words = words || 'hunt ';
    END
    INSERT INTO bot_llm_choices (eid, word, action, arg) VALUES (:eid, 'wait', 'ambush', '');
    txt = txt || ASCII_CHAR(10) || 'wait: in ambush here';
    words = words || 'wait';
    SUSPEND;
  END
END^

-- The word a small model answered, carried out: the move kept under that word when the bot was last offered its
-- choices; a word that was not offered lets the bot roam
CREATE OR ALTER PROCEDURE bot_llm_pick (eid INTEGER, word VARCHAR(40))
RETURNS (done VARCHAR(60))
AS
DECLARE act VARCHAR(20); DECLARE arg VARCHAR(40);
BEGIN
  SELECT c.action, c.arg FROM bot_llm_choices c WHERE c.eid = :eid AND c.word = LOWER(TRIM(:word)) INTO act, arg;
  IF (act IS NULL) THEN BEGIN act = 'roam'; arg = ''; END
  SELECT a.done FROM bot_llm_apply(:eid, :act, :arg, '', '') a INTO done;
  SUSPEND;
END^

SET TERM ; ^
