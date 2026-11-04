-- demo.sql – recording a match and playing it back (CL_Record, CL_ReadDemoMessage): the snapshots of a match kept
-- as rows (schema.sql's demos, demo_frames, demo_ents …), played back into the tables the frame reads, the game not
-- running. q3_tic ends with demo_snap while a recording runs (game.demo_rec); the page calls demo_play instead of
-- q3_tic while one plays (game.demo_play), and paints what comes back as it paints a tic

SET TERM ^ ;

-- "record": a new demo from the next snapshot on; the first carries every entity (the gamestate's baselines)
CREATE OR ALTER PROCEDURE demo_record_start
RETURNS (demo_id INTEGER)
AS
BEGIN
  demo_id = NEXT VALUE FOR demo_seq;
  INSERT INTO demos (id, map_name, gametype, ent_id)
    SELECT :demo_id, g.map_name, g.gametype, p.ent_id FROM game g CROSS JOIN player p WHERE g.id = 1 AND p.id = 1;
  DELETE FROM demo_last;
  UPDATE game g SET g.demo_rec = :demo_id, g.demo_n = 0,
         g.demo_snd = COALESCE((SELECT MAX(s.id) FROM sound_events s), 0), g.demo_fx = COALESCE((SELECT MAX(f.id) FROM fx_events f), 0),
         g.demo_msg = COALESCE((SELECT MAX(m.id) FROM messages m), 0) WHERE g.id = 1;
  SUSPEND;
END^

-- "stop": the recording ends (and with the map: a new map stops it, as it does Quake III's)
CREATE OR ALTER PROCEDURE demo_record_stop
AS
DECLARE d INTEGER;
BEGIN
  SELECT g.demo_rec FROM game g WHERE g.id = 1 INTO d;
  IF (d IS NULL) THEN EXIT;
  UPDATE demos m SET m.frames = (SELECT COUNT(*) FROM demo_frames f WHERE f.demo_id = :d),
         m.seconds = COALESCE((SELECT MAX(f.time_) - MIN(f.time_) FROM demo_frames f WHERE f.demo_id = :d), 0) WHERE m.id = :d;
  UPDATE game g SET g.demo_rec = NULL WHERE g.id = 1;
  DELETE FROM demo_last;
END^

-- the snapshot of this tic, its frame row already written by q3_tic: the entities that changed since the last, those
-- gone, the tic's sounds, effects and console lines
CREATE OR ALTER PROCEDURE demo_snap
AS
DECLARE d INTEGER; DECLARE n INTEGER; DECLARE s0 INTEGER; DECLARE f0 INTEGER; DECLARE m0 INTEGER;
BEGIN
  SELECT g.demo_rec, g.demo_n, g.demo_snd, g.demo_fx, g.demo_msg FROM game g WHERE g.id = 1 INTO d, n, s0, f0, m0;
  IF (d IS NULL) THEN EXIT;
  INSERT INTO demo_ents (demo_id, n, gone, id, classname, model_id, frame, skin, effects, x, y, z, vx, vy, vz, pitch, yaw, roll, minx, miny, minz, maxx, maxy, maxz, solid, movetype, flags, health, deadflag, st, alpha, weapon, pmodel, pskin, color1, legs_anim, legs_time, torso_anim, torso_time, award, award_time, waterlevel, watertype, quad_finished, haste_finished, invis_finished, regen_finished, enviro_finished, leaf, cluster, clusters, area1, area2, loop_sound, count_, bot, pteam, queued, frags, deaths, wins, losses, spec_time, viewheight, body_of, owner_id, item, armor, n_excellent, n_impressive, n_gauntlet, acc_shots, acc_hits)
    SELECT :d, :n, 0, e.id, e.classname, e.model_id, e.frame, e.skin, e.effects, e.x, e.y, e.z, e.vx, e.vy, e.vz, e.pitch, e.yaw, e.roll, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.solid, e.movetype, e.flags, e.health, e.deadflag, e.st, e.alpha, e.weapon, e.pmodel, e.pskin, e.color1, e.legs_anim, e.legs_time, e.torso_anim, e.torso_time, e.award, e.award_time, e.waterlevel, e.watertype, e.quad_finished, e.haste_finished, e.invis_finished, e.regen_finished, e.enviro_finished, e.leaf, e.cluster, e.clusters, e.area1, e.area2, e.loop_sound, e.count_, e.bot, e.pteam, e.queued, e.frags, e.deaths, e.wins, e.losses, e.spec_time, e.viewheight, e.body_of, e.owner_id, e.item, e.armor, e.n_excellent, e.n_impressive, e.n_gauntlet, e.acc_shots, e.acc_hits FROM ents e LEFT JOIN demo_last l ON l.id = e.id
     WHERE l.id IS NULL
           OR e.classname IS DISTINCT FROM l.classname
           OR e.model_id IS DISTINCT FROM l.model_id
           OR e.frame IS DISTINCT FROM l.frame
           OR e.skin IS DISTINCT FROM l.skin
           OR e.effects IS DISTINCT FROM l.effects
           OR e.x IS DISTINCT FROM l.x
           OR e.y IS DISTINCT FROM l.y
           OR e.z IS DISTINCT FROM l.z
           OR e.vx IS DISTINCT FROM l.vx
           OR e.vy IS DISTINCT FROM l.vy
           OR e.vz IS DISTINCT FROM l.vz
           OR e.pitch IS DISTINCT FROM l.pitch
           OR e.yaw IS DISTINCT FROM l.yaw
           OR e.roll IS DISTINCT FROM l.roll
           OR e.minx IS DISTINCT FROM l.minx
           OR e.miny IS DISTINCT FROM l.miny
           OR e.minz IS DISTINCT FROM l.minz
           OR e.maxx IS DISTINCT FROM l.maxx
           OR e.maxy IS DISTINCT FROM l.maxy
           OR e.maxz IS DISTINCT FROM l.maxz
           OR e.solid IS DISTINCT FROM l.solid
           OR e.movetype IS DISTINCT FROM l.movetype
           OR e.flags IS DISTINCT FROM l.flags
           OR e.health IS DISTINCT FROM l.health
           OR e.deadflag IS DISTINCT FROM l.deadflag
           OR e.st IS DISTINCT FROM l.st
           OR e.alpha IS DISTINCT FROM l.alpha
           OR e.weapon IS DISTINCT FROM l.weapon
           OR e.pmodel IS DISTINCT FROM l.pmodel
           OR e.pskin IS DISTINCT FROM l.pskin
           OR e.color1 IS DISTINCT FROM l.color1
           OR e.legs_anim IS DISTINCT FROM l.legs_anim
           OR e.legs_time IS DISTINCT FROM l.legs_time
           OR e.torso_anim IS DISTINCT FROM l.torso_anim
           OR e.torso_time IS DISTINCT FROM l.torso_time
           OR e.award IS DISTINCT FROM l.award
           OR e.award_time IS DISTINCT FROM l.award_time
           OR e.waterlevel IS DISTINCT FROM l.waterlevel
           OR e.watertype IS DISTINCT FROM l.watertype
           OR e.quad_finished IS DISTINCT FROM l.quad_finished
           OR e.haste_finished IS DISTINCT FROM l.haste_finished
           OR e.invis_finished IS DISTINCT FROM l.invis_finished
           OR e.regen_finished IS DISTINCT FROM l.regen_finished
           OR e.enviro_finished IS DISTINCT FROM l.enviro_finished
           OR e.leaf IS DISTINCT FROM l.leaf
           OR e.cluster IS DISTINCT FROM l.cluster
           OR e.clusters IS DISTINCT FROM l.clusters
           OR e.area1 IS DISTINCT FROM l.area1
           OR e.area2 IS DISTINCT FROM l.area2
           OR e.loop_sound IS DISTINCT FROM l.loop_sound
           OR e.count_ IS DISTINCT FROM l.count_
           OR e.bot IS DISTINCT FROM l.bot
           OR e.pteam IS DISTINCT FROM l.pteam
           OR e.queued IS DISTINCT FROM l.queued
           OR e.frags IS DISTINCT FROM l.frags
           OR e.deaths IS DISTINCT FROM l.deaths
           OR e.wins IS DISTINCT FROM l.wins
           OR e.losses IS DISTINCT FROM l.losses
           OR e.spec_time IS DISTINCT FROM l.spec_time
           OR e.viewheight IS DISTINCT FROM l.viewheight
           OR e.body_of IS DISTINCT FROM l.body_of
           OR e.owner_id IS DISTINCT FROM l.owner_id
           OR e.item IS DISTINCT FROM l.item
           OR e.armor IS DISTINCT FROM l.armor
           OR e.n_excellent IS DISTINCT FROM l.n_excellent
           OR e.n_impressive IS DISTINCT FROM l.n_impressive
           OR e.n_gauntlet IS DISTINCT FROM l.n_gauntlet
           OR e.acc_shots IS DISTINCT FROM l.acc_shots
           OR e.acc_hits IS DISTINCT FROM l.acc_hits;
  INSERT INTO demo_ents (demo_id, n, gone, id, classname)
    SELECT :d, :n, 1, l.id, l.classname FROM demo_last l WHERE NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = l.id);
  -- (the base moves on by the rows just written: the changed ones put in, the gone taken out)
  DELETE FROM demo_last l WHERE l.id IN (SELECT x.id FROM demo_ents x WHERE x.demo_id = :d AND x.n = :n);
  INSERT INTO demo_last (id, classname, model_id, frame, skin, effects, x, y, z, vx, vy, vz, pitch, yaw, roll, minx, miny, minz, maxx, maxy, maxz, solid, movetype, flags, health, deadflag, st, alpha, weapon, pmodel, pskin, color1, legs_anim, legs_time, torso_anim, torso_time, award, award_time, waterlevel, watertype, quad_finished, haste_finished, invis_finished, regen_finished, enviro_finished, leaf, cluster, clusters, area1, area2, loop_sound, count_, bot, pteam, queued, frags, deaths, wins, losses, spec_time, viewheight, body_of, owner_id, item, armor, n_excellent, n_impressive, n_gauntlet, acc_shots, acc_hits) SELECT x.id, x.classname, x.model_id, x.frame, x.skin, x.effects, x.x, x.y, x.z, x.vx, x.vy, x.vz, x.pitch, x.yaw, x.roll, x.minx, x.miny, x.minz, x.maxx, x.maxy, x.maxz, x.solid, x.movetype, x.flags, x.health, x.deadflag, x.st, x.alpha, x.weapon, x.pmodel, x.pskin, x.color1, x.legs_anim, x.legs_time, x.torso_anim, x.torso_time, x.award, x.award_time, x.waterlevel, x.watertype, x.quad_finished, x.haste_finished, x.invis_finished, x.regen_finished, x.enviro_finished, x.leaf, x.cluster, x.clusters, x.area1, x.area2, x.loop_sound, x.count_, x.bot, x.pteam, x.queued, x.frags, x.deaths, x.wins, x.losses, x.spec_time, x.viewheight, x.body_of, x.owner_id, x.item, x.armor, x.n_excellent, x.n_impressive, x.n_gauntlet, x.acc_shots, x.acc_hits FROM demo_ents x WHERE x.demo_id = :d AND x.n = :n AND x.gone = 0;
  INSERT INTO demo_sounds (demo_id, n, k, ent_id, chan, snd, vol, attn, x, y, z)
    SELECT :d, :n, s.id, s.ent_id, s.chan, s.snd, s.vol, s.attn, s.x, s.y, s.z FROM sound_events s WHERE s.id > :s0;
  INSERT INTO demo_fx (demo_id, n, k, kind, x, y, z, x2, y2, z2, nn)
    SELECT :d, :n, f.id, f.kind, f.x, f.y, f.z, f.x2, f.y2, f.z2, f.n FROM fx_events f WHERE f.id > :f0;
  INSERT INTO demo_msgs (demo_id, n, k, msg) SELECT :d, :n, m.id, m.msg FROM messages m WHERE m.id > :m0;
  UPDATE game g SET g.demo_n = :n + 1,
         g.demo_snd = COALESCE((SELECT MAX(s.id) FROM sound_events s), :s0), g.demo_fx = COALESCE((SELECT MAX(f.id) FROM fx_events f), :f0),
         g.demo_msg = COALESCE((SELECT MAX(m.id) FROM messages m), :m0) WHERE g.id = 1;
END^

-- "demo": playback of a demo from its start, on its map (loaded by the page first): the arena's entities give way to
-- the demo's, a recording stops
CREATE OR ALTER PROCEDURE demo_play_start (did INTEGER)
AS
BEGIN
  EXECUTE PROCEDURE demo_record_stop;
  DELETE FROM ents;
  DELETE FROM messages;
  DELETE FROM bot_routes;
  UPDATE game g SET g.demo_play = :did, g.demo_n = -1 WHERE g.id = 1;
  UPDATE player p SET p.ent_id = (SELECT m.ent_id FROM demos m WHERE m.id = :did), p.follow_id = NULL WHERE p.id = 1;
END^

-- the next `tics` tics of the demo playing: every snapshot up to there applied (the entities that changed put back,
-- those gone removed, the sounds, effects and lines played again), the clock and the view set as recorded, and the
-- last snapshot's frame row returned as q3_tic returns one. Past the end: the arena again (exit_kind 3), as Quake
-- III goes back to the menu when a demo ends
CREATE OR ALTER PROCEDURE demo_play (tics INTEGER)
RETURNS (
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
  acc_hits INTEGER)
AS
DECLARE d INTEGER; DECLARE n INTEGER; DECLARE upto INTEGER; DECLARE t0 INTEGER; DECLARE k INTEGER; DECLARE gt INTEGER; DECLARE tm DOUBLE PRECISION;
DECLARE fol INTEGER; DECLARE vo DOUBLE PRECISION;
BEGIN
  SELECT g.demo_play, g.demo_n FROM game g WHERE g.id = 1 INTO d, n;
  IF (d IS NULL) THEN EXIT;
  -- up to the last snapshot within `tics` of the one shown (at least the next)
  SELECT f.tic FROM demo_frames f WHERE f.demo_id = :d AND f.n = :n INTO t0;
  IF (t0 IS NULL) THEN SELECT f.tic - 1 FROM demo_frames f WHERE f.demo_id = :d AND f.n = 0 INTO t0;   -- (none shown yet)
  SELECT MAX(f.n) FROM demo_frames f WHERE f.demo_id = :d AND f.n > :n AND (f.n = :n + 1 OR f.tic <= :t0 + :tics) INTO upto;
  IF (upto IS NULL) THEN
  BEGIN
    -- the end
    SELECT f.tic, f.time_, f.health, f.max_health, f.armor, f.bullets, f.shells, f.grenades, f.rockets, f.lightning, f.slugs, f.cells, f.bfg, f.weapons, f.weapon, f.pending_weapon, f.weaponstate, f.weapon_time, f.attack_start, f.attack_finished, f.px, f.py, f.pz, f.yaw, f.pitch, f.view_z, f.punch, f.msg, f.cprint, f.dmg_take, f.dmg_save, f.dmg_time, f.dmg_x, f.dmg_y, f.bonus_time, f.dead, f.exit_kind, f.frags, f.deaths, f.waterlevel, f.watertype, f.map_name, f.level_msg, f.quad, f.haste, f.invis, f.regen, f.enviro, f.flight, f.holdable, f.leaf, f.cluster, f.match_over, f.winner, f.land_time, f.onground, f.move_speed, f.weapon_sound, f.lead, f.ducked, f.fraglimit, f.timelimit, f.over_time, f.next_map, f.dmg_z, f.dmg_world, f.land_change, f.vx, f.vy, f.warmup_end, f.award, f.award_time, f.n_excellent, f.n_impressive, f.n_gauntlet, f.spectator, f.follow_name, f.mover_yaw, f.gametype, f.red_score, f.blue_score, f.team, f.acc_shots, f.acc_hits FROM demo_frames f WHERE f.demo_id = :d AND f.n = :n INTO tic, time_, health, max_health, armor, bullets, shells, grenades, rockets, lightning, slugs, cells, bfg, weapons, weapon, pending_weapon, weaponstate, weapon_time, attack_start, attack_finished, px, py, pz, yaw, pitch, view_z, punch, msg, cprint, dmg_take, dmg_save, dmg_time, dmg_x, dmg_y, bonus_time, dead, exit_kind, frags, deaths, waterlevel, watertype, map_name, level_msg, quad, haste, invis, regen, enviro, flight, holdable, leaf, cluster, match_over, winner, land_time, onground, move_speed, weapon_sound, lead, ducked, fraglimit, timelimit, over_time, next_map, dmg_z, dmg_world, land_change, vx, vy, warmup_end, award, award_time, n_excellent, n_impressive, n_gauntlet, spectator, follow_name, mover_yaw, gametype, red_score, blue_score, team, acc_shots, acc_hits;
    UPDATE game g SET g.demo_play = NULL WHERE g.id = 1;
    exit_kind = 3; next_map = NULL;
    SUSPEND;
    EXIT;
  END
  k = n + 1;
  WHILE (k <= upto) DO
  BEGIN
    MERGE INTO ents e
      USING (SELECT id, classname, model_id, frame, skin, effects, x, y, z, vx, vy, vz, pitch, yaw, roll, minx, miny, minz, maxx, maxy, maxz, solid, movetype, flags, health, deadflag, st, alpha, weapon, pmodel, pskin, color1, legs_anim, legs_time, torso_anim, torso_time, award, award_time, waterlevel, watertype, quad_finished, haste_finished, invis_finished, regen_finished, enviro_finished, leaf, cluster, clusters, area1, area2, loop_sound, count_, bot, pteam, queued, frags, deaths, wins, losses, spec_time, viewheight, body_of, owner_id, item, armor, n_excellent, n_impressive, n_gauntlet, acc_shots, acc_hits FROM demo_ents x WHERE x.demo_id = :d AND x.n = :k AND x.gone = 0) d ON e.id = d.id
      WHEN MATCHED THEN UPDATE SET e.classname = d.classname, e.model_id = d.model_id, e.frame = d.frame, e.skin = d.skin, e.effects = d.effects, e.x = d.x, e.y = d.y, e.z = d.z, e.vx = d.vx, e.vy = d.vy, e.vz = d.vz, e.pitch = d.pitch, e.yaw = d.yaw, e.roll = d.roll, e.minx = d.minx, e.miny = d.miny, e.minz = d.minz, e.maxx = d.maxx, e.maxy = d.maxy, e.maxz = d.maxz, e.solid = d.solid, e.movetype = d.movetype, e.flags = d.flags, e.health = d.health, e.deadflag = d.deadflag, e.st = d.st, e.alpha = d.alpha, e.weapon = d.weapon, e.pmodel = d.pmodel, e.pskin = d.pskin, e.color1 = d.color1, e.legs_anim = d.legs_anim, e.legs_time = d.legs_time, e.torso_anim = d.torso_anim, e.torso_time = d.torso_time, e.award = d.award, e.award_time = d.award_time, e.waterlevel = d.waterlevel, e.watertype = d.watertype, e.quad_finished = d.quad_finished, e.haste_finished = d.haste_finished, e.invis_finished = d.invis_finished, e.regen_finished = d.regen_finished, e.enviro_finished = d.enviro_finished, e.leaf = d.leaf, e.cluster = d.cluster, e.clusters = d.clusters, e.area1 = d.area1, e.area2 = d.area2, e.loop_sound = d.loop_sound, e.count_ = d.count_, e.bot = d.bot, e.pteam = d.pteam, e.queued = d.queued, e.frags = d.frags, e.deaths = d.deaths, e.wins = d.wins, e.losses = d.losses, e.spec_time = d.spec_time, e.viewheight = d.viewheight, e.body_of = d.body_of, e.owner_id = d.owner_id, e.item = d.item, e.armor = d.armor, e.n_excellent = d.n_excellent, e.n_impressive = d.n_impressive, e.n_gauntlet = d.n_gauntlet, e.acc_shots = d.acc_shots, e.acc_hits = d.acc_hits, e.lx = d.x, e.ly = d.y, e.lz = d.z, e.vis_cl = NULL
      WHEN NOT MATCHED THEN INSERT (id, classname, model_id, frame, skin, effects, x, y, z, vx, vy, vz, pitch, yaw, roll, minx, miny, minz, maxx, maxy, maxz, solid, movetype, flags, health, deadflag, st, alpha, weapon, pmodel, pskin, color1, legs_anim, legs_time, torso_anim, torso_time, award, award_time, waterlevel, watertype, quad_finished, haste_finished, invis_finished, regen_finished, enviro_finished, leaf, cluster, clusters, area1, area2, loop_sound, count_, bot, pteam, queued, frags, deaths, wins, losses, spec_time, viewheight, body_of, owner_id, item, armor, n_excellent, n_impressive, n_gauntlet, acc_shots, acc_hits, lx, ly, lz) VALUES (d.id, d.classname, d.model_id, d.frame, d.skin, d.effects, d.x, d.y, d.z, d.vx, d.vy, d.vz, d.pitch, d.yaw, d.roll, d.minx, d.miny, d.minz, d.maxx, d.maxy, d.maxz, d.solid, d.movetype, d.flags, d.health, d.deadflag, d.st, d.alpha, d.weapon, d.pmodel, d.pskin, d.color1, d.legs_anim, d.legs_time, d.torso_anim, d.torso_time, d.award, d.award_time, d.waterlevel, d.watertype, d.quad_finished, d.haste_finished, d.invis_finished, d.regen_finished, d.enviro_finished, d.leaf, d.cluster, d.clusters, d.area1, d.area2, d.loop_sound, d.count_, d.bot, d.pteam, d.queued, d.frags, d.deaths, d.wins, d.losses, d.spec_time, d.viewheight, d.body_of, d.owner_id, d.item, d.armor, d.n_excellent, d.n_impressive, d.n_gauntlet, d.acc_shots, d.acc_hits, d.x, d.y, d.z);
    DELETE FROM ents e WHERE e.id IN (SELECT x.id FROM demo_ents x WHERE x.demo_id = :d AND x.n = :k AND x.gone = 1);
    SELECT f.tic, f.time_ FROM demo_frames f WHERE f.demo_id = :d AND f.n = :k INTO gt, tm;
    INSERT INTO sound_events (id, tic, ent_id, chan, snd, vol, attn, x, y, z)
      SELECT NEXT VALUE FOR sound_seq, :gt, s.ent_id, s.chan, s.snd, s.vol, s.attn, s.x, s.y, s.z FROM demo_sounds s WHERE s.demo_id = :d AND s.n = :k ORDER BY s.k;
    INSERT INTO fx_events (id, tic, kind, x, y, z, x2, y2, z2, n)
      SELECT NEXT VALUE FOR fx_seq, :gt, f.kind, f.x, f.y, f.z, f.x2, f.y2, f.z2, f.nn FROM demo_fx f WHERE f.demo_id = :d AND f.n = :k ORDER BY f.k;
    INSERT INTO messages (id, time_, msg)
      SELECT NEXT VALUE FOR msg_seq, :tm, m.msg FROM demo_msgs m WHERE m.demo_id = :d AND m.n = :k ORDER BY m.k;
    k = k + 1;
  END
  SELECT f.tic, f.time_, f.health, f.max_health, f.armor, f.bullets, f.shells, f.grenades, f.rockets, f.lightning, f.slugs, f.cells, f.bfg, f.weapons, f.weapon, f.pending_weapon, f.weaponstate, f.weapon_time, f.attack_start, f.attack_finished, f.px, f.py, f.pz, f.yaw, f.pitch, f.view_z, f.punch, f.msg, f.cprint, f.dmg_take, f.dmg_save, f.dmg_time, f.dmg_x, f.dmg_y, f.bonus_time, f.dead, f.exit_kind, f.frags, f.deaths, f.waterlevel, f.watertype, f.map_name, f.level_msg, f.quad, f.haste, f.invis, f.regen, f.enviro, f.flight, f.holdable, f.leaf, f.cluster, f.match_over, f.winner, f.land_time, f.onground, f.move_speed, f.weapon_sound, f.lead, f.ducked, f.fraglimit, f.timelimit, f.over_time, f.next_map, f.dmg_z, f.dmg_world, f.land_change, f.vx, f.vy, f.warmup_end, f.award, f.award_time, f.n_excellent, f.n_impressive, f.n_gauntlet, f.spectator, f.follow_name, f.mover_yaw, f.gametype, f.red_score, f.blue_score, f.team, f.acc_shots, f.acc_hits, f.follow_id, f.view_ofs FROM demo_frames f WHERE f.demo_id = :d AND f.n = :upto INTO tic, time_, health, max_health, armor, bullets, shells, grenades, rockets, lightning, slugs, cells, bfg, weapons, weapon, pending_weapon, weaponstate, weapon_time, attack_start, attack_finished, px, py, pz, yaw, pitch, view_z, punch, msg, cprint, dmg_take, dmg_save, dmg_time, dmg_x, dmg_y, bonus_time, dead, exit_kind, frags, deaths, waterlevel, watertype, map_name, level_msg, quad, haste, invis, regen, enviro, flight, holdable, leaf, cluster, match_over, winner, land_time, onground, move_speed, weapon_sound, lead, ducked, fraglimit, timelimit, over_time, next_map, dmg_z, dmg_world, land_change, vx, vy, warmup_end, award, award_time, n_excellent, n_impressive, n_gauntlet, spectator, follow_name, mover_yaw, gametype, red_score, blue_score, team, acc_shots, acc_hits, fol, vo;
  -- the clock, and the view as view_setup reads it (the eye's height, the pitch, the one followed)
  UPDATE game g SET g.tic = :tic, g.time_ = :time_, g.demo_n = :upto WHERE g.id = 1;
  UPDATE player p SET p.follow_id = :fol, p.view_ofs = COALESCE(:vo, p.view_ofs), p.stepz = 0, p.pitch = :pitch, p.punchangle = 0,
         p.frags = :frags, p.deaths = :deaths, p.spectator = :spectator WHERE p.id = 1;
  DELETE FROM sound_events s WHERE s.tic < :tic - 40;
  DELETE FROM fx_events f WHERE f.tic < :tic - 40;
  DELETE FROM messages m WHERE m.id < (SELECT MAX(m2.id) FROM messages m2) - 6;
  SUSPEND;
END^

SET TERM ; ^
