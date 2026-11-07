-- save.sql – save games: the tables play changes (game, player, ents, the console, the bots' routes and avoid
-- times, the waypoint graph, the area portals' state, the bots' skills) are written to a file and read back by
-- src/save.js on a freshly loaded arena; this puts the rest in order once the rows are back. (Quake III has no
-- save games, its single player is a ladder of matches; Quake II's game.dll wrote its edicts and clients to
-- disk, WriteGame and WriteLevel, and this is that.)

SET TERM ^ ;

-- after a save's rows replaced the arena's: the id sequences moved past the ids that came back (a rocket fired
-- next must not take a saved entity's id), the caches of what is in view dropped (they belong to the fresh
-- arena's last view), the sounds and effects of the fresh arena gone, no demo recording or playing
CREATE OR ALTER PROCEDURE save_restored
AS
DECLARE m INTEGER; DECLARE n BIGINT;
BEGIN
  SELECT COALESCE(MAX(e.id), 0) FROM ents e INTO m;
  n = GEN_ID(ent_seq, 0);
  IF (m > n) THEN n = GEN_ID(ent_seq, m - n);
  SELECT COALESCE(MAX(x.id), 0) FROM messages x INTO m;
  n = GEN_ID(msg_seq, 0);
  IF (m > n) THEN n = GEN_ID(msg_seq, m - n);
  UPDATE ents e SET e.vis_cl = NULL, e.vis = NULL;
  UPDATE viewcfg c SET c.vis_cluster = NULL, c.portal_cluster = NULL WHERE c.id = 1;
  DELETE FROM sound_events;
  DELETE FROM fx_events;
  UPDATE game g SET g.demo_rec = NULL, g.demo_play = NULL WHERE g.id = 1;
  DELETE FROM demo_last;
END^

SET TERM ; ^
