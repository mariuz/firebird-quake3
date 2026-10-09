-- waypoints.sql – the bots' map of the arena, in the spirit of the AAS
-- files (botlib's area awareness system), built when the map loads:
--
--   WAYPOINTS  a node wherever a player can stand: at every spawn point,
--              item, jump pad (and where it lands you), teleporter (and
--              its destination), and on a coarse grid over every floor
--   WP_EDGES   a → b when a player box can walk from a to b: a straight
--              box trace with floor probes, else a stepped walk that
--              climbs stairs and drops off ledges (one way); jump pads
--              and teleporters are edges of their own, and so is a rocket
--              jump up to a ledge (the AAS's TRAVEL_ROCKETJUMP)
--   WP_ROUTE   breadth-first over the edges, the path as a string of nodes
--
-- The bots route to the player when they cannot see him, and roam between
-- the items otherwise (bots.sql).

CREATE TABLE waypoints (
  id   INTEGER NOT NULL PRIMARY KEY,
  x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL, z DOUBLE PRECISION NOT NULL,   -- where a standing player's origin is (floor + 25)
  kind SMALLINT DEFAULT 0 NOT NULL,     -- 0 grid 1 spawn 2 item 3 jump pad 4 pad landing 5 teleporter 6 teleporter destination
  ent_id INTEGER,                       -- the item or trigger it stands for
  linked SMALLINT DEFAULT 0 NOT NULL    -- 1 once its walkable edges were traced (wp_link_chunk)
);

CREATE TABLE wp_edges (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  len DOUBLE PRECISION NOT NULL,
  kind SMALLINT DEFAULT 0 NOT NULL,     -- 0 walk 1 jump pad 2 teleporter 3 drop (one way) 4 rocket jump (one way) 5 jump (one way) 6 jump pad steered in the air (one way)
  PRIMARY KEY (a, b)
);
CREATE INDEX wp_edges_a ON wp_edges (a);

-- each bot's current route: to which entity, through which nodes (',n1,n2,...,' the next first)
CREATE TABLE bot_routes (
  ent_id INTEGER NOT NULL PRIMARY KEY,
  target INTEGER,
  dst_node INTEGER,
  path VARCHAR(400),
  built DOUBLE PRECISION,
  fails SMALLINT DEFAULT 0 NOT NULL,
  prog_d DOUBLE PRECISION,               -- the nearest it has been to its next node, and when:
  prog_t DOUBLE PRECISION,               -- no progress for a while means it is stuck, whatever the steps say
  last_node INTEGER,                     -- the node it last reached: the start of the edge it is on
  rj_x DOUBLE PRECISION, rj_y DOUBLE PRECISION, rj_z DOUBLE PRECISION,   -- a rocket jump's landing, steered for in the air
  rj_until DOUBLE PRECISION DEFAULT 0 NOT NULL,
  rj_hold DOUBLE PRECISION                -- a pad's throw: no steering while rising under this height (the ledge's)
);

-- where the build of the graph has got to: the next grid column to scan, and the phase
CREATE TABLE wp_build (
  id INTEGER NOT NULL PRIMARY KEY,
  gx DOUBLE PRECISION, gy DOUBLE PRECISION,
  minx DOUBLE PRECISION, miny DOUBLE PRECISION, minz DOUBLE PRECISION, maxx DOUBLE PRECISION, maxy DOUBLE PRECISION, maxz DOUBLE PRECISION,
  phase SMALLINT DEFAULT 0 NOT NULL      -- 0 scanning the grid 1 linking 2 done
);
INSERT INTO wp_build (id, phase) VALUES (1, 2);

-- the frontier of a route search (PSQL has no arrays)
CREATE GLOBAL TEMPORARY TABLE wp_visit (
  node INTEGER NOT NULL PRIMARY KEY,
  prev INTEGER,
  depth INTEGER NOT NULL
) ON COMMIT DELETE ROWS;

SET TERM ^ ;

-- the floor under (x, y, z) within `drop_` units: the height a player box comes to rest at there, less its
-- 24 of legs (on a ramp the box rests on its uphill corner, as in the game), or NULL when there is none
CREATE OR ALTER FUNCTION wp_drop (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, drop_ DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE fp DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, x, y, z, x, y, z - drop_, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f >= 1) THEN RETURN NULL;
  IF (sts = 1) THEN RETURN -99999;                   -- (x, y, z) is inside something: a pillar, a crate
  fp = ez;
  IF (nz > 0.99e0 OR nz < 0.7e0) THEN RETURN fp;    -- flat, or too steep to stand on (wp_stand says so)
  -- a slope: settle the box onto it from just above
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, x, y, fp + 64, x, y, fp + 16, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (sts = 1 OR f >= 1) THEN RETURN fp;
  RETURN ez - 24;
END^

-- can a player stand on the floor at (x, y, fl)? 1 yes; 0 no (too steep, outside the world, no room for the
-- box); 2 no, it is deadly (lava, slime, the void), and so is everything beside it
CREATE OR ALTER FUNCTION wp_stand (x DOUBLE PRECISION, y DOUBLE PRECISION, fl DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER; DECLARE cl INTEGER;
BEGIN
  IF (BIN_AND(point_contents(x, y, fl + 1), 24) <> 0) THEN RETURN 2;                -- lava, slime
  IF (EXISTS (SELECT 1 FROM ents h WHERE h.classname = 'trigger_hurt' AND h.solid = 1
                AND :x >= h.x + h.minx AND :x <= h.x + h.maxx AND :y >= h.y + h.miny AND :y <= h.y + h.maxy
                AND :fl + 25 >= h.z + h.minz AND :fl + 25 <= h.z + h.maxz)) THEN RETURN 2;   -- the void
  SELECT l.cluster FROM leaves l WHERE l.id = point_leaf(:x, :y, :fl + 25) INTO cl;
  IF (cl IS NULL OR cl < 0) THEN RETURN 0;                                           -- outside the world
  EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, x, y, fl + 20, x, y, fl - 12, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 AND nz < 0.7e0) THEN RETURN 0;                                           -- too steep
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, x, y, fl + 25, x, y, fl + 25, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (sts = 1 OR als = 1) THEN RETURN 0;
  RETURN 1;
END^

-- a standing spot: the floor under (x, y, z) within `drop_` units that a player can stand on, or NULL
CREATE OR ALTER FUNCTION wp_floor (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, drop_ DOUBLE PRECISION) RETURNS DOUBLE PRECISION
AS
DECLARE fl DOUBLE PRECISION;
BEGIN
  fl = wp_drop(x, y, z, drop_);
  IF (fl IS NULL OR fl <= -99999 OR wp_stand(x, y, fl) = 0) THEN RETURN NULL;
  RETURN fl;
END^

-- add a node unless one stands within 64 units already; returns its id
CREATE OR ALTER PROCEDURE wp_add (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, kind SMALLINT, ent INTEGER)
RETURNS (id INTEGER)
AS
BEGIN
  SELECT FIRST 1 w.id FROM waypoints w WHERE ABS(w.x - :x) < 64 AND ABS(w.y - :y) < 64 AND ABS(w.z - :z) < 40 INTO id;
  IF (id IS NOT NULL) THEN
  BEGIN
    -- an entity's node outranks a grid node
    IF (kind > 0) THEN UPDATE waypoints w SET w.kind = :kind, w.ent_id = COALESCE(:ent, w.ent_id) WHERE w.id = :id AND w.kind = 0;
    SUSPEND; EXIT;
  END
  SELECT COALESCE(MAX(w.id), 0) + 1 FROM waypoints w INTO id;
  INSERT INTO waypoints (id, x, y, z, kind, ent_id) VALUES (:id, :x, :y, :z, :kind, :ent);
  SUSPEND;
END^

-- can a player walk from a to b? 0 no, 1 yes, 3 yes but only this way (a drop of more than a step, up to 400)
CREATE OR ALTER FUNCTION wp_walkable (ax DOUBLE PRECISION, ay DOUBLE PRECISION, az DOUBLE PRECISION, bx DOUBLE PRECISION, by_ DOUBLE PRECISION, bz DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION; DECLARE k DOUBLE PRECISION;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE len DOUBLE PRECISION; DECLARE steps INTEGER; DECLARE i INTEGER; DECLARE ok SMALLINT;
DECLARE dropped SMALLINT = 0; DECLARE fl DOUBLE PRECISION; DECLARE climb INTEGER;
BEGIN
  dx = bx - ax; dy = by_ - ay; len = vlen(dx, dy, 0);
  IF (len < 1) THEN RETURN IIF(ABS(bz - az) < 48, 1, 0);
  -- the straight line, with the box, and the floor probed at a third and two thirds of the way
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ax, ay, az, bx, by_, bz, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f >= 1 AND sts = 0) THEN
  BEGIN
    ok = 1;
    k = 0.33e0;
    WHILE (k < 0.8e0) DO
    BEGIN
      px = ax + dx * k; py = ay + dy * k; pz = az + (bz - az) * k;
      EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, px, py, pz, px, py, pz - 60, 65537)
        RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
      IF (f >= 1 OR BIN_AND(point_contents(ex, ey, ez + 1), 24) <> 0) THEN BEGIN ok = 0; LEAVE; END
      k = k + 0.34e0;
    END
    IF (ok = 1) THEN RETURN 1;
  END
  -- a wall or a pillar at chest height of the higher of the two is a wall: the walk up the stairs ends
  -- there, the walk off the ledge starts there (a tunnel sloping under a low ceiling is the one case
  -- this gets wrong, and the stepped walk below is too dear to run for every pair)
  EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, ax, ay, MAXVALUE(az, bz) + 20, bx, by_, MAXVALUE(az, bz) + 20, 1)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 OR sts = 1) THEN RETURN 0;
  -- the stepped walk: 40 units forward at step height, then settle onto the floor; climbs stairs, drops ledges
  steps = CAST(CEILING(len / 40) AS INTEGER);
  IF (steps > 14) THEN RETURN 0;
  px = ax; py = ay; pz = az;
  dx = dx / len; dy = dy / len;
  i = 0;
  WHILE (i < steps) DO
  BEGIN
    k = MINVALUE(40, len - i * 40);
    EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, px, py, pz + 18, px + dx * k, py + dy * k, pz + 18, 65537)
      RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
    IF (sts = 1) THEN RETURN 0;
    climb = 0;
    WHILE (f < 0.9e0 AND climb < 3) DO
    BEGIN
      -- a stair or a ramp: another step up from where it stopped
      climb = climb + 1;
      k = k * (1 - f);
      EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ex, ey, ez + 18, ex + dx * k, ey + dy * k, ez + 18, 65537)
        RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
      IF (sts = 1) THEN RETURN 0;
    END
    IF (f < 0.9e0) THEN RETURN 0;
    px = ex; py = ey;
    -- the floor below: a step down, or a drop of up to 400 (one way; a fall that hurts a little, as the
    -- AAS's "jump down" reachabilities allow)
    EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, px, py, ez, px, py, ez - 436, 65537)
      RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
    IF (f >= 1 OR sts = 1 OR nz < 0.7e0) THEN RETURN 0;
    IF (BIN_AND(point_contents(ex, ey, ez - 24), 24) <> 0) THEN RETURN 0;
    IF (pz - ez > 40) THEN dropped = 1;
    pz = ez;
    i = i + 1;
  END
  IF (ABS(pz - bz) > 48 OR vlen(px - bx, py - by_, 0) > 48) THEN RETURN 0;
  RETURN IIF(dropped = 1, 3, 1);
END^

-- build the graph for the loaded map
CREATE OR ALTER PROCEDURE build_waypoints
AS
DECLARE minx DOUBLE PRECISION; DECLARE miny DOUBLE PRECISION; DECLARE minz DOUBLE PRECISION; DECLARE maxx DOUBLE PRECISION; DECLARE maxy DOUBLE PRECISION; DECLARE maxz DOUBLE PRECISION;
DECLARE eid INTEGER; DECLARE cls VARCHAR(40); DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE fl DOUBLE PRECISION;
DECLARE a INTEGER; DECLARE b INTEGER; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE tgt VARCHAR(40);
DECLARE ax DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE az DOUBLE PRECISION; DECLARE bx DOUBLE PRECISION; DECLARE by_ DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION;
DECLARE n INTEGER; DECLARE w SMALLINT; DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION; DECLARE gz DOUBLE PRECISION; DECLARE step DOUBLE PRECISION;
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE ft DOUBLE PRECISION; DECLARE j INTEGER; DECLARE cl INTEGER; DECLARE k INTEGER;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  DELETE FROM wp_edges;
  DELETE FROM waypoints;
  SELECT m.minx, m.miny, m.minz, m.maxx, m.maxy, m.maxz FROM models m JOIN game g ON g.world_model = m.id WHERE g.id = 1 INTO minx, miny, minz, maxx, maxy, maxz;
  IF (minx IS NULL) THEN EXIT;

  -- the places that matter: spawn points, items, pads and their landings, teleporters and their destinations
  FOR SELECT e.id, e.classname, e.x + (e.minx + e.maxx) / 2, e.y + (e.miny + e.maxy) / 2, e.z + (e.minz + e.maxz) / 2, e.target
        FROM ents e WHERE e.classname IN ('info_player_deathmatch', 'info_player_start', 'item', 'trigger_push', 'trigger_teleport', 'misc_teleporter_dest')
       INTO eid, cls, x, y, z, tgt
  DO
  BEGIN
    fl = wp_floor(x, y, z + 40, 300);
    IF (fl IS NULL) THEN CONTINUE;
    a = NULL;
    EXECUTE PROCEDURE wp_add(x, y, fl + 25, CASE cls WHEN 'item' THEN 2 WHEN 'trigger_push' THEN 3 WHEN 'trigger_teleport' THEN 5 WHEN 'misc_teleporter_dest' THEN 6 ELSE 1 END, eid) RETURNING_VALUES a;
    IF (cls IN ('trigger_push', 'trigger_teleport') AND tgt IS NOT NULL) THEN
    BEGIN
      -- where it sends you: the teleporter's destination, or the pad's arc flown past its target_position (the
      -- apex of the throw, AimAtTarget) and down to the floor
      SELECT FIRST 1 m.ox, m.oy, m.oz FROM map_ents m WHERE m.targetname = :tgt INTO tx, ty, tz;
      IF (tx IS NULL) THEN CONTINUE;
      IF (cls = 'trigger_push') THEN
      BEGIN
        SELECT e.p1x, e.p1y FROM ents e WHERE e.id = :eid INTO vx, vy;
        ft = 0; fl = NULL;
        WHILE (ft < 3 AND fl IS NULL) DO
        BEGIN
          ax = tx + vx * ft; ay = ty + vy * ft; az = tz - 400 * ft * ft;
          ft = ft + 0.05e0;
          bx = tx + vx * ft; by_ = ty + vy * ft; bz = tz - 400 * ft * ft;
          EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ax, ay, az, bx, by_, bz, 65537)
            RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
          IF (f < 1) THEN
          BEGIN
            fl = wp_floor(ex, ey, ez + 8, 120);
            IF (fl IS NULL) THEN LEAVE;
            tx = ex; ty = ey;
          END
        END
      END
      ELSE fl = wp_floor(tx, ty, tz + 40, 300);
      IF (fl IS NULL) THEN CONTINUE;
      EXECUTE PROCEDURE wp_add(tx, ty, fl + 25, IIF(cls = 'trigger_push', 4, 6), eid) RETURNING_VALUES b;
      IF (a IS NOT NULL AND b IS NOT NULL AND a <> b) THEN
        UPDATE OR INSERT INTO wp_edges (a, b, len, kind) VALUES (:a, :b, 64, IIF(:cls = 'trigger_push', 1, 2)) MATCHING (a, b);
    END
  END

  -- the grid over the floors is scanned by wp_build_chunk, a few columns at a time
  UPDATE OR INSERT INTO wp_build (id, gx, gy, minx, miny, minz, maxx, maxy, maxz, phase)
    VALUES (1, :minx + 64, :miny + 64, :minx, :miny, :minz, :maxx, :maxy, :maxz, 0) MATCHING (id);
END^

-- can a rocket jump take a player from a to b (the AAS's weapon-jump reachability)? Up at about 680 a
-- second once the rocket's knock is in (the jump's 270 and the splash's 400 or so, measured: the apex is
-- 300 over the floor), down at gravity; across with the air control a bot steers with (Quake III's air
-- acceleration, 16 a tic up to 320), with a margin. The flight's room: up from a, across, down onto b
CREATE OR ALTER FUNCTION wp_rocket_jump (ax DOUBLE PRECISION, ay DOUBLE PRECISION, az DOUBLE PRECISION, bx DOUBLE PRECISION, by_ DOUBLE PRECISION, bz DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE h DOUBLE PRECISION; DECLARE d DOUBLE PRECISION; DECLARE tf DOUBLE PRECISION; DECLARE n DOUBLE PRECISION; DECLARE reach DOUBLE PRECISION; DECLARE top DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  h = bz - az; d = vlen(bx - ax, by_ - ay, 0);
  IF (h <= 0 OR h > 250 OR d < 48) THEN RETURN 0;      -- a ledge, not a floor overhead
  -- a floor a rocket hits under the start (not the player clip a shot goes through)
  EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, ax, ay, az, ax, ay, az - 40, 1)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f >= 1 OR ez < az - 30) THEN RETURN 0;
  tf = (680 + SQRT(680e0 * 680 - 1600 * h)) / 800;
  n = tf / 0.05e0;
  reach = IIF(n <= 20, 0.4e0 * n * (n + 1), 168 + (n - 20) * 16);
  IF (d > reach * 0.8e0) THEN RETURN 0;
  top = az + MINVALUE(280, h + 90);
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ax, ay, az, ax, ay, top, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 OR sts = 1) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ax, ay, top, bx, by_, top, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 OR sts = 1) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, bx, by_, top, bx, by_, bz - 30, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f >= 1 OR sts = 1 OR nz < 0.7e0 OR ez < bz - 4 OR ez > bz + 3) THEN RETURN 0;
  RETURN 1;
END^

-- A jump across a gap (the AAS's TRAVEL_JUMP): a run and a jump, 320 across and 270 up under gravity 800,
-- lands b's floor (no higher than 40 above a: the jump's apex is 45) within 85 percent of the reach,
-- t = (270 + sqrt(270² - 1600 dz)) / 800 seconds at 320. The flight's room: up 50 from a, across, down onto b
CREATE OR ALTER FUNCTION wp_jump (ax DOUBLE PRECISION, ay DOUBLE PRECISION, az DOUBLE PRECISION, bx DOUBLE PRECISION, by_ DOUBLE PRECISION, bz DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE h DOUBLE PRECISION; DECLARE d DOUBLE PRECISION; DECLARE top DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  h = bz - az; d = vlen(bx - ax, by_ - ay, 0);
  IF (h > 40 OR h < -400 OR d < 64) THEN RETURN 0;
  IF (d > 0.85e0 * 320 * (270 + SQRT(270e0 * 270 - 1600 * h)) / 800) THEN RETURN 0;
  top = MAXVALUE(az, bz) + 50;
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ax, ay, az, ax, ay, top, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 OR sts = 1) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, ax, ay, top, bx, by_, top, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 OR sts = 1) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, bx, by_, top, bx, by_, bz - 30, 65537)
    RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f >= 1 OR sts = 1 OR nz < 0.7e0 OR ez < bz - 4 OR ez > bz + 3) THEN RETURN 0;
  -- not into lava or slime
  IF (BIN_AND(point_contents(bx, by_, bz - 24), 24) <> 0) THEN RETURN 0;
  RETURN 1;
END^

-- A jump pad that throws nearly straight up (q3dm17's centre one lands where it took off) is worth
-- something only with air control: the AAS's jump-pad reachabilities include the places a player reaches
-- by steering during the throw (AAS_Reachability_JumpPad). First a bound: b's floor under the apex by 30
-- or more, and within the reach of the air acceleration (16 a tic up to 320) in the time the throw is over
-- b's height. Then the throw is flown in tenths of a second as a bot flies it: up at the pad's speed, down
-- under gravity 800, steered as bot_air_steer steers once over b's height (rj_hold) or coming down, the box
-- traced each step; it must come down on b's floor, within 48 of it, not into lava or slime.
CREATE OR ALTER FUNCTION wp_pad_steer (ax DOUBLE PRECISION, ay DOUBLE PRECISION, az DOUBLE PRECISION, vx DOUBLE PRECISION, vy DOUBLE PRECISION, vz DOUBLE PRECISION,
  bx DOUBLE PRECISION, by_ DOUBLE PRECISION, bz DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE top DOUBLE PRECISION; DECLARE t DOUBLE PRECISION; DECLARE reach DOUBLE PRECISION; DECLARE d DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE nvz DOUBLE PRECISION;
DECLARE wx DOUBLE PRECISION; DECLARE wy DOUBLE PRECISION; DECLARE l DOUBLE PRECISION; DECLARE tl DOUBLE PRECISION; DECLARE dt DOUBLE PRECISION = 0.1e0;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  top = az + vz * vz / 1600;
  IF (bz > top - 30) THEN RETURN 0;
  t = (vz + SQRT(vz * vz - 1600 * (bz + 30 - az))) / 800 - IIF(bz + 8 > az, (vz - SQRT(MAXVALUE(0, vz * vz - 1600 * (bz + 8 - az)))) / 800, 0);
  reach = IIF(t <= 1, 160 * t * t, 160 + 320 * (t - 1));
  t = (vz + SQRT(vz * vz - 1600 * (bz + 30 - az))) / 800;
  d = vlen(bx - (ax + vx * t), by_ - (ay + vy * t), 0);
  IF (d > reach OR d < 48) THEN RETURN 0;
  IF (BIN_AND(point_contents(bx, by_, bz - 24), 24) <> 0) THEN RETURN 0;
  -- the flight
  x = ax; y = ay; z = az - 1; t = 0;
  WHILE (t < 4) DO
  BEGIN
    IF (z > bz + 8 OR vz < 0) THEN
    BEGIN
      d = vz * vz + 1600 * (z - bz);
      tl = MAXVALUE(dt, IIF(d > 0, (vz + SQRT(d)) / 800, dt));
      wx = (bx - x) / tl; wy = (by_ - y) / tl;
      l = vlen(wx, wy, 0);
      IF (l > 320) THEN BEGIN wx = wx * 320 / l; wy = wy * 320 / l; END
      wx = wx - vx; wy = wy - vy;
      l = vlen(wx, wy, 0);
      IF (l > 320 * dt) THEN BEGIN wx = wx * 320 * dt / l; wy = wy * 320 * dt / l; END
      vx = vx + wx; vy = vy + wy;
    END
    nvz = vz - 800 * dt;
    EXECUTE PROCEDURE trace_move(NULL, -15, -15, -24, 15, 15, 32, x, y, z, x + vx * dt, y + vy * dt, z + (vz + nvz) / 2 * dt, 65537)
      RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
    IF (sts = 1) THEN RETURN 0;
    IF (f < 1) THEN
    BEGIN
      -- a ceiling or a wall ends it (a player would slide; the check stays on the safe side); a floor is the landing
      IF (nz < 0.7e0) THEN RETURN 0;
      RETURN IIF(vlen(ex - bx, ey - by_, 0) <= 48 AND ABS(ez - (bz - 1)) < 30, 1, 0);
    END
    x = ex; y = ey; z = ez; vz = nvz;
    t = t + dt;
  END
  RETURN 0;
END^

-- the walkable edges of up to `cnt` nodes not yet linked, each to its nearest neighbours; returns how many
-- nodes remain. The game calls it a few nodes per frame, so the arena opens while the bots learn their way
CREATE OR ALTER PROCEDURE wp_link_chunk (cnt INTEGER)
RETURNS (remaining INTEGER)
AS
DECLARE a INTEGER; DECLARE b INTEGER; DECLARE n INTEGER; DECLARE w SMALLINT; DECLARE done INTEGER = 0; DECLARE pass INTEGER;
DECLARE ax DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE az DOUBLE PRECISION; DECLARE bx DOUBLE PRECISION; DECLARE by_ DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION;
BEGIN
  FOR SELECT w1.id, w1.x, w1.y, w1.z FROM waypoints w1 WHERE w1.linked = 0 ORDER BY w1.id INTO a, ax, ay, az DO
  BEGIN
    IF (done >= cnt) THEN LEAVE;
    done = done + 1;
    UPDATE waypoints w SET w.linked = 1 WHERE w.id = :a;
    -- two passes: the ten nearest neighbours, then the four nearest on a lower level (the ten are
    -- all on this one when the grid is dense), so a ledge gets its way down
    pass = 0;
    WHILE (pass < 2) DO
    BEGIN
      n = 0;
      FOR SELECT w2.id, w2.x, w2.y, w2.z FROM waypoints w2
           WHERE w2.id <> :a AND ABS(w2.x - :ax) < IIF(:pass = 0, 420, 300) AND ABS(w2.y - :ay) < IIF(:pass = 0, 420, 300) AND ABS(w2.z - :az) < 450
             AND (:pass = 0 OR w2.z < :az - 48)
           ORDER BY (w2.x - :ax) * (w2.x - :ax) + (w2.y - :ay) * (w2.y - :ay) + (w2.z - :az) * (w2.z - :az) * 2
           INTO b, bx, by_, bz
      DO
      BEGIN
        IF (n >= IIF(:pass = 0, 10, 3)) THEN LEAVE;
        n = n + 1;
        IF (EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :a AND e.b = :b)) THEN CONTINUE;
        w = wp_walkable(ax, ay, az, bx, by_, bz);
        IF (w = 0) THEN
        BEGIN
          -- no walk: a jump across the gap, maybe (from a pad or a teleporter's trigger, no)
          IF (wp_jump(ax, ay, az, bx, by_, bz) = 1 AND NOT EXISTS (SELECT 1 FROM waypoints w WHERE w.id = :a AND w.kind IN (3, 5))) THEN
            INSERT INTO wp_edges (a, b, len, kind) VALUES (:a, :b, vlen(:bx - :ax, :by_ - :ay, :bz - :az), 5);
          CONTINUE;
        END
        INSERT INTO wp_edges (a, b, len, kind) VALUES (:a, :b, vlen(:bx - :ax, :by_ - :ay, :bz - :az), IIF(:w = 3, 3, 0));
        -- a flat walk goes both ways
        IF (w = 1 AND ABS(bz - az) < 40 AND NOT EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :b AND e.b = :a)) THEN
          INSERT INTO wp_edges (a, b, len, kind) VALUES (:b, :a, vlen(:bx - :ax, :by_ - :ay, :bz - :az), 0);
      END
      pass = pass + 1;
    END
    -- a pad that throws nearly straight up: up to six places it reaches steered (items first, then the
    -- highest), each a walk from nowhere near the pad
    IF (EXISTS (SELECT 1 FROM waypoints w JOIN ents p ON p.id = w.ent_id WHERE w.id = :a AND w.kind = 3 AND vlen(p.p1x, p.p1y, 0) < 100)) THEN
    BEGIN
      n = 0;
      FOR SELECT w2.id, w2.x, w2.y, w2.z FROM waypoints w2 CROSS JOIN waypoints w JOIN ents p ON p.id = w.ent_id
           WHERE w.id = :a AND w2.id <> :a AND w2.kind NOT IN (3, 5)
             AND w2.z < :az + p.p1z * p.p1z / 1600 - 30 AND w2.z > :az - 400 AND ABS(w2.x - :ax) < 1200 AND ABS(w2.y - :ay) < 1200
             AND vlen(w2.x - :ax, w2.y - :ay, 0) > 96
           ORDER BY IIF(w2.kind = 2, 0, 1), w2.z DESC, (w2.x - :ax) * (w2.x - :ax) + (w2.y - :ay) * (w2.y - :ay)
           INTO b, bx, by_, bz
      DO
      BEGIN
        IF (n >= 6) THEN LEAVE;
        IF (EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :a AND e.b = :b)) THEN CONTINUE;
        IF (wp_pad_steer(ax, ay, az, (SELECT p.p1x FROM waypoints w JOIN ents p ON p.id = w.ent_id WHERE w.id = :a), (SELECT p.p1y FROM waypoints w JOIN ents p ON p.id = w.ent_id WHERE w.id = :a),
                         (SELECT p.p1z FROM waypoints w JOIN ents p ON p.id = w.ent_id WHERE w.id = :a), bx, by_, bz) = 1) THEN
        BEGIN
          INSERT INTO wp_edges (a, b, len, kind) VALUES (:a, :b, vlen(:bx - :ax, :by_ - :ay, :bz - :az), 6);
          n = n + 1;
        END
      END
    END
    -- and up to two rocket jumps to a ledge above, beyond a jump and within the reach (six tried at most;
    -- not from or onto a pad or a teleporter)
    IF (NOT EXISTS (SELECT 1 FROM waypoints w WHERE w.id = :a AND w.kind IN (3, 5))) THEN
    BEGIN
      n = 0; pass = 0;
      FOR SELECT w2.id, w2.x, w2.y, w2.z FROM waypoints w2
           WHERE w2.z > :az + 60 AND w2.z <= :az + 220 AND ABS(w2.x - :ax) < 260 AND ABS(w2.y - :ay) < 260 AND w2.kind NOT IN (3, 5)
           ORDER BY (w2.x - :ax) * (w2.x - :ax) + (w2.y - :ay) * (w2.y - :ay)
           INTO b, bx, by_, bz
      DO
      BEGIN
        IF (n >= 2 OR pass >= 6) THEN LEAVE;
        IF (EXISTS (SELECT 1 FROM wp_edges e WHERE e.a = :a AND e.b = :b)) THEN CONTINUE;
        pass = pass + 1;
        IF (wp_rocket_jump(ax, ay, az, bx, by_, bz) = 1) THEN
        BEGIN
          INSERT INTO wp_edges (a, b, len, kind) VALUES (:a, :b, vlen(:bx - :ax, :by_ - :ay, :bz - :az), 4);
          n = n + 1;
        END
      END
    END
  END
  SELECT COUNT(*) FROM waypoints w WHERE w.linked = 0 INTO remaining;
  SUSPEND;
END^

-- one column of the grid: down from the first open air to the floor below it, then on from under that
-- floor; a floor the box does not fit on (a wall beside the column) is tried a little to each side,
-- and a column that finds nothing at all tries beside itself (corridors)
CREATE OR ALTER PROCEDURE wp_scan_column (gx DOUBLE PRECISION, gy DOUBLE PRECISION, minz DOUBLE PRECISION, maxz DOUBLE PRECISION)
AS
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE gz DOUBLE PRECISION; DECLARE fl DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION;
DECLARE ax DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE a INTEGER; DECLARE n INTEGER; DECLARE j INTEGER; DECLARE k INTEGER; DECLARE cl INTEGER; DECLARE w SMALLINT;
BEGIN
  n = 0; j = 0;
  WHILE (j < 5 AND (j = 0 OR n = 0)) DO
  BEGIN
    x = gx + CASE j WHEN 1 THEN 56 WHEN 2 THEN -56 ELSE 0 END;
    y = gy + CASE j WHEN 3 THEN 56 WHEN 4 THEN -56 ELSE 0 END;
    gz = maxz - 8;
    WHILE (gz > minz) DO
    BEGIN
      SELECT l.cluster FROM leaves l WHERE l.id = point_leaf(:x, :y, :gz) INTO cl;
      IF (cl IS NULL OR cl < 0) THEN BEGIN gz = gz - 48; CONTINUE; END
      fl = wp_drop(x, y, gz, gz - minz + 1);
      IF (fl IS NULL) THEN LEAVE;
      IF (fl <= -99999) THEN BEGIN gz = gz - 48; CONTINUE; END
      w = wp_stand(x, y, fl);
      IF (w = 1) THEN
      BEGIN
        EXECUTE PROCEDURE wp_add(x, y, fl + 25, 0, NULL) RETURNING_VALUES a;
        n = n + 1;
      END
      ELSE IF (w = 0 AND j = 0) THEN
      BEGIN
        k = 1;
        WHILE (k <= 4) DO
        BEGIN
          ax = x + CASE k WHEN 1 THEN 40 WHEN 2 THEN -40 ELSE 0 END;
          ay = y + CASE k WHEN 3 THEN 40 WHEN 4 THEN -40 ELSE 0 END;
          bz = wp_floor(ax, ay, fl + 40, 80);
          IF (bz IS NOT NULL) THEN
          BEGIN
            EXECUTE PROCEDURE wp_add(ax, ay, bz + 25, 0, NULL) RETURNING_VALUES a;
            n = n + 1;
            LEAVE;
          END
          k = k + 1;
        END
      END
      gz = MINVALUE(fl - 8, gz - 32);     -- on under this floor (a settled box can sit above gz)
    END
    j = j + 1;
  END
END^

-- the build goes on: up to `cols` grid columns scanned (128 units apart), or, once the grid is done, the
-- walkable edges of up to `links` nodes traced. Returns how much is left (columns, then nodes), 0 when
-- the graph is complete. The game calls it every frame, so the arena opens while the bots learn their way
CREATE OR ALTER PROCEDURE wp_build_chunk (cols INTEGER, links INTEGER)
RETURNS (remaining INTEGER)
AS
DECLARE gx DOUBLE PRECISION; DECLARE gy DOUBLE PRECISION; DECLARE phase SMALLINT; DECLARE done INTEGER = 0;
DECLARE minx DOUBLE PRECISION; DECLARE miny DOUBLE PRECISION; DECLARE minz DOUBLE PRECISION; DECLARE maxx DOUBLE PRECISION; DECLARE maxy DOUBLE PRECISION; DECLARE maxz DOUBLE PRECISION;
BEGIN
  remaining = 0;
  SELECT b.gx, b.gy, b.minx, b.miny, b.minz, b.maxx, b.maxy, b.maxz, b.phase FROM wp_build b WHERE b.id = 1 INTO gx, gy, minx, miny, minz, maxx, maxy, maxz, phase;
  IF (phase = 0) THEN
  BEGIN
    WHILE (done < cols AND gx < maxx) DO
    BEGIN
      EXECUTE PROCEDURE wp_scan_column(gx, gy, minz, maxz);
      done = done + 1;
      gy = gy + 128;
      IF (gy >= maxy) THEN BEGIN gy = miny + 64; gx = gx + 128; END
    END
    IF (gx >= maxx) THEN phase = 1;
    UPDATE wp_build b SET b.gx = :gx, b.gy = :gy, b.phase = :phase WHERE b.id = 1;
    remaining = CAST(CEILING((maxx - gx) / 128) * CEILING((maxy - miny) / 128) AS INTEGER) + (SELECT COUNT(*) FROM waypoints w WHERE w.linked = 0);
    IF (phase = 0) THEN BEGIN SUSPEND; EXIT; END
  END
  IF (phase = 1) THEN
  BEGIN
    EXECUTE PROCEDURE wp_link_chunk(links) RETURNING_VALUES remaining;
    IF (remaining = 0) THEN UPDATE wp_build b SET b.phase = 2 WHERE b.id = 1;
  END
  SUSPEND;
END^

-- the node nearest a spot (weighting height), or nearest in sight of it when `see` = 1
CREATE OR ALTER FUNCTION wp_nearest (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, see SMALLINT) RETURNS INTEGER
AS
DECLARE id INTEGER; DECLARE wx DOUBLE PRECISION; DECLARE wy DOUBLE PRECISION; DECLARE wz DOUBLE PRECISION; DECLARE n INTEGER = 0; DECLARE best INTEGER;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  FOR SELECT w.id, w.x, w.y, w.z FROM waypoints w WHERE ABS(w.x - :x) < 600 AND ABS(w.y - :y) < 600 AND ABS(w.z - :z) < 300
       ORDER BY (w.x - :x) * (w.x - :x) + (w.y - :y) * (w.y - :y) + (w.z - :z) * (w.z - :z) * 4 INTO id, wx, wy, wz
  DO
  BEGIN
    IF (best IS NULL) THEN best = id;
    IF (see = 0) THEN RETURN id;
    EXECUTE PROCEDURE trace_move(NULL, 0, 0, 0, 0, 0, 0, x, y, z, wx, wy, wz, 1) RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sf, ct, als, sts, hit;
    IF (f >= 1) THEN RETURN id;
    n = n + 1;
    IF (n >= 4) THEN LEAVE;
  END
  RETURN best;
END^

-- the route from node `src` to node `dst` as ',n1,n2,…,dst,' (without src), NULL when there is none; over
-- the rocket jumps too when `rj` is 1 (the travel flags with TFL_ROCKETJUMP)
CREATE OR ALTER FUNCTION wp_route (src INTEGER, dst INTEGER, rj SMALLINT) RETURNS VARCHAR(400)
AS
DECLARE level INTEGER = 0; DECLARE added INTEGER; DECLARE path VARCHAR(400); DECLARE n INTEGER; DECLARE p INTEGER;
BEGIN
  IF (src IS NULL OR dst IS NULL) THEN RETURN NULL;
  IF (src = dst) THEN RETURN ',' || dst || ',';
  DELETE FROM wp_visit;
  INSERT INTO wp_visit (node, prev, depth) VALUES (:src, NULL, 0);
  WHILE (level < 40) DO
  BEGIN
    INSERT INTO wp_visit (node, prev, depth)
    SELECT x.b, MIN(x.node), :level + 1
      FROM (SELECT e.b, v.node FROM wp_visit v JOIN wp_edges e ON e.a = v.node WHERE v.depth = :level AND (e.kind <> 4 OR :rj = 1)
              AND NOT EXISTS (SELECT 1 FROM wp_visit w WHERE w.node = e.b)) x
     GROUP BY x.b;
    added = ROW_COUNT;
    IF (added = 0) THEN RETURN NULL;
    IF (EXISTS (SELECT 1 FROM wp_visit v WHERE v.node = :dst)) THEN LEAVE;
    level = level + 1;
  END
  IF (NOT EXISTS (SELECT 1 FROM wp_visit v WHERE v.node = :dst)) THEN RETURN NULL;
  -- walk back from the destination
  path = ',';
  n = dst;
  WHILE (n IS NOT NULL AND n <> src) DO
  BEGIN
    path = ',' || n || path;
    SELECT v.prev FROM wp_visit v WHERE v.node = :n INTO p;
    n = p;
    IF (CHAR_LENGTH(path) > 380) THEN LEAVE;
  END
  RETURN path;
END^

SET TERM ; ^
