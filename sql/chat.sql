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
  IF (kind IN ('accompany', 'camp', 'dismiss', 'get', 'kill')) THEN
  BEGIN
    -- a new order ends the old one: the camp spot ordered before goes
    DELETE FROM ents c WHERE c.classname = 'camp_order' AND c.owner_id = :eid;
    UPDATE ents e SET e.acc_id = NULL, e.camp_id = NULL, e.camp_until = NULL, e.get_id = NULL, e.goal_id = NULL, e.nbg_id = NULL WHERE e.id = :eid;
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
    SELECT e.acc_id, e.camp_id, e.get_id, e.enemy_id FROM ents e WHERE e.id = :eid INTO acc, camp, getid, en;
    IF (acc IS NOT NULL) THEN EXECUTE PROCEDURE bot_say(eid, 'accompanying', chat_name(acc), NULL, NULL, NULL, NULL, NULL, pe, 0);
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
  ordered = IIF(kind IN ('accompany', 'camp', 'dismiss', 'get', 'kill'), 1, 0);
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

SET TERM ; ^
