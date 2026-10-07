-- render.sql – tr_world.c, tr_bsp.c and tr_mesh.c as a query.
--
-- FRAME_ALL gathers everything a frame needs into one result set: for the
-- cluster the eye is in, every face of every leaf whose cluster is in its
-- PVS is marked once (DISTINCT, like R_MarkLeaves) into VIS_FACES with its
-- plane and bounding sphere copied in, so each frame is a single scan of
-- that table with the back-face and frustum tests as expressions, no join;
-- the visible face ids travel as one ',' separated LIST() per model. Brush
-- model entities (doors, plats, bobbing platforms) are a second, smaller
-- cursor: their faces at their own origin and rotation. The same result set
-- carries the MD3 entities in the PVS with their pose and animations, the
-- sounds and effects of the tic, and the looped speakers that are on, so
-- the page makes one round trip to the engine per frame. FRAME_FACES
-- projects every vertex in SQL as well (the other renderer mode).

SET TERM ^ ;

-- the eye: the player's, or, when the page passes one, the view it is painting between two tics (the
-- position predicted a fraction of a tic ahead, the angles live from the mouse: see the loop in
-- src/main.js). A predicted eye is traced from the player's real one with a small box, so a prediction
-- that runs past a wall stops 8 units short of it instead of looking into the void
CREATE OR ALTER PROCEDURE view_setup (vx DOUBLE PRECISION DEFAULT NULL, vy DOUBLE PRECISION DEFAULT NULL, vz DOUBLE PRECISION DEFAULT NULL,
                                      vyaw DOUBLE PRECISION DEFAULT NULL, vpitch DOUBLE PRECISION DEFAULT NULL)
RETURNS (ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION,
         fx DOUBLE PRECISION, fy DOUBLE PRECISION, fz DOUBLE PRECISION,
         rx DOUBLE PRECISION, ry DOUBLE PRECISION, rz DOUBLE PRECISION,
         ux DOUBLE PRECISION, uy DOUBLE PRECISION, uz DOUBLE PRECISION,
         w INTEGER, h INTEGER, scale_ DOUBLE PRECISION, nearz DOUBLE PRECISION,
         kx DOUBLE PRECISION, ky DOUBLE PRECISION, pvs VARCHAR(2048) CHARACTER SET ASCII, cluster INTEGER, leaf INTEGER)
AS
DECLARE yaw DOUBLE PRECISION; DECLARE pitch DOUBLE PRECISION; DECLARE fov DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE sp DOUBLE PRECISION; DECLARE cp DOUBLE PRECISION;
DECLARE stepz DOUBLE PRECISION; DECLARE dead SMALLINT;
DECLARE f DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  SELECT e.x, e.y, e.z + p.view_ofs, e.yaw, p.pitch + p.punchangle, p.stepz, e.deadflag
    FROM player p JOIN ents e ON e.id = p.ent_id WHERE p.id = 1 INTO ex, ey, ez, yaw, pitch, stepz, dead;
  ez = ez - COALESCE(stepz, 0);
  IF (vx IS NOT NULL) THEN
  BEGIN
    yaw = vyaw; pitch = vpitch;
    IF (ex IS NULL OR ABS(vx - ex) + ABS(vy - ey) + ABS(vz - ez) < 0.5e0) THEN BEGIN ex = vx; ey = vy; ez = vz; END
    ELSE
    BEGIN
      EXECUTE PROCEDURE trace_move(NULL, -8, -8, -8, 8, 8, 8, ex, ey, ez, vx, vy, vz, 1)
        RETURNING_VALUES f, tx, ty, tz, nx, ny, nz, sf, ct, als, sts, hit;
      IF (sts = 1) THEN BEGIN ex = vx; ey = vy; ez = vz; END      -- the real eye is in a wall (noclip, a corpse): trust the page
      ELSE BEGIN ex = tx; ey = ty; ez = tz; END
    END
  END
  SELECT c.w, c.h, c.fov, c.near_z FROM viewcfg c WHERE c.id = 1 INTO w, h, fov, nearz;
  sy = SIN(yaw * 0.0174532925e0); cy = COS(yaw * 0.0174532925e0);
  sp = SIN(pitch * 0.0174532925e0); cp = COS(pitch * 0.0174532925e0);
  fx = cp * cy; fy = cp * sy; fz = -sp;
  rx = sy; ry = -cy; rz = 0;
  ux = sp * cy; uy = sp * sy; uz = cp;
  IF (dead = 1) THEN
  BEGIN
    -- the dead lie on their side: roll the view 40 degrees
    sp = rx; cp = ry;
    rx = sp * 0.766e0 + ux * 0.643e0; ry = cp * 0.766e0 + uy * 0.643e0; rz = rz * 0.766e0 + uz * 0.643e0;
    ux = -sp * 0.643e0 + ux * 0.766e0; uy = -cp * 0.643e0 + uy * 0.766e0; uz = uz * 0.766e0;
  END
  scale_ = (w / 2e0) / TAN(fov * 0.5e0 * 0.0174532925e0);
  kx = (w / 2e0) / scale_;
  ky = (h / 2e0) / scale_;
  leaf = point_leaf(ex, ey, ez);
  SELECT l.pvs, l.cluster FROM leaves l WHERE l.id = :leaf INTO pvs, cluster;
  IF (pvs IS NULL) THEN pvs = '';
  IF (cluster IS NULL) THEN cluster = -1;
  SUSPEND;
END^

SET TERM ; ^

-- the marked world faces (PSQL has no arrays; Quake has visframe): every face
-- of every leaf in the PVS of the cluster the eye is in, kept until the eye
-- moves to another cluster, with the plane and bounding sphere copied in so
-- the frame is a scan of this table alone
CREATE TABLE vis_faces (
  face   INTEGER NOT NULL PRIMARY KEY,
  nx DOUBLE PRECISION NOT NULL, ny DOUBLE PRECISION NOT NULL, nz DOUBLE PRECISION NOT NULL, dist DOUBLE PRECISION NOT NULL, twosided SMALLINT NOT NULL,
  cx DOUBLE PRECISION NOT NULL, cy DOUBLE PRECISION NOT NULL, cz DOUBLE PRECISION NOT NULL, radius DOUBLE PRECISION NOT NULL
);

-- the faces that survive this frame's back-face and frustum tests (FRAME_FACES),
-- with the entity's origin and rotation (m00..m22: world = o + M · v)
CREATE GLOBAL TEMPORARY TABLE sel_faces (
  face   INTEGER NOT NULL,
  ent_id INTEGER NOT NULL,
  ox DOUBLE PRECISION NOT NULL, oy DOUBLE PRECISION NOT NULL, oz DOUBLE PRECISION NOT NULL,
  m00 DOUBLE PRECISION DEFAULT 1 NOT NULL, m01 DOUBLE PRECISION DEFAULT 0 NOT NULL, m02 DOUBLE PRECISION DEFAULT 0 NOT NULL,
  m10 DOUBLE PRECISION DEFAULT 0 NOT NULL, m11 DOUBLE PRECISION DEFAULT 1 NOT NULL, m12 DOUBLE PRECISION DEFAULT 0 NOT NULL,
  m20 DOUBLE PRECISION DEFAULT 0 NOT NULL, m21 DOUBLE PRECISION DEFAULT 0 NOT NULL, m22 DOUBLE PRECISION DEFAULT 1 NOT NULL,
  PRIMARY KEY (ent_id, face)
) ON COMMIT DELETE ROWS;

SET TERM ^ ;

-- Is any cluster of a ',' separated list in the PVS?
CREATE OR ALTER FUNCTION clusters_visible (pvs VARCHAR(2048) CHARACTER SET ASCII, clusters VARCHAR(200) CHARACTER SET ASCII, cluster INTEGER)
RETURNS SMALLINT
AS
DECLARE p INTEGER; DECLARE q INTEGER; DECLARE c INTEGER;
BEGIN
  IF (pvs IS NULL OR pvs = '') THEN RETURN 1;
  IF (clusters IS NULL) THEN RETURN IIF(cluster IS NULL OR cluster < 0, 1, pvs_visible(pvs, cluster));
  p = 2;
  WHILE (p <= CHAR_LENGTH(clusters)) DO
  BEGIN
    q = POSITION(',', clusters, p);
    IF (q = 0) THEN LEAVE;
    c = CAST(SUBSTRING(clusters FROM p FOR q - p) AS INTEGER);
    IF (pvs_visible(pvs, c) = 1) THEN RETURN 1;
    p = q + 1;
  END
  RETURN 0;
END^

-- mark_faces: R_MarkLeaves, once per view cluster: every face of every leaf
-- in the PVS goes into VIS_FACES (kept until the eye moves to another cluster)
CREATE OR ALTER PROCEDURE mark_faces (pvs VARCHAR(2048) CHARACTER SET ASCII, vcluster INTEGER)
AS
DECLARE cur INTEGER; DECLARE world INTEGER;
BEGIN
  SELECT c.vis_cluster FROM viewcfg c WHERE c.id = 1 INTO cur;
  IF (cur IS NOT DISTINCT FROM vcluster) THEN EXIT;
  SELECT g.world_model FROM game g WHERE g.id = 1 INTO world;
  DELETE FROM vis_faces;
  INSERT INTO vis_faces (face, nx, ny, nz, dist, twosided, cx, cy, cz, radius)
  SELECT f.id, f.nx, f.ny, f.nz, f.dist, f.twosided, f.cx, f.cy, f.cz, f.radius
    FROM faces f
   WHERE f.model_id = :world AND BIN_AND(f.flags, 128) = 0
     AND f.id IN (SELECT lf.face
                    FROM leaves l
                    JOIN leaffaces lf ON lf.id >= l.first_lf AND lf.id < l.first_lf + l.num_lf
                   WHERE l.cluster >= 0 AND l.num_lf > 0
                     AND (:pvs = '' OR BIN_AND(POSITION(SUBSTRING(:pvs FROM BIN_SHR(l.cluster, 2) + 1 FOR 1), '0123456789abcdef') - 1, BIN_SHL(1, BIN_AND(l.cluster, 3))) <> 0));
  UPDATE viewcfg c SET c.vis_cluster = :vcluster WHERE c.id = 1;
END^

-- FRAME_FACES: the visible faces, projected vertex by vertex in SQL.
CREATE OR ALTER PROCEDURE frame_faces (vx DOUBLE PRECISION DEFAULT NULL, vy DOUBLE PRECISION DEFAULT NULL, vz DOUBLE PRECISION DEFAULT NULL,
                                       vyaw DOUBLE PRECISION DEFAULT NULL, vpitch DOUBLE PRECISION DEFAULT NULL)
RETURNS (face INTEGER, seq INTEGER, vf DOUBLE PRECISION, vr DOUBLE PRECISION, vu DOUBLE PRECISION,
         sx DOUBLE PRECISION, sy DOUBLE PRECISION, s DOUBLE PRECISION, t DOUBLE PRECISION, u DOUBLE PRECISION, v DOUBLE PRECISION, ent_id INTEGER)
AS
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE fx DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION;
DECLARE ux DOUBLE PRECISION; DECLARE uy DOUBLE PRECISION; DECLARE uz DOUBLE PRECISION;
DECLARE w INTEGER; DECLARE h INTEGER; DECLARE sc DOUBLE PRECISION; DECLARE nearz DOUBLE PRECISION;
DECLARE kx DOUBLE PRECISION; DECLARE ky DOUBLE PRECISION; DECLARE pvs VARCHAR(2048) CHARACTER SET ASCII; DECLARE vcl INTEGER; DECLARE vleaf INTEGER;
DECLARE hw DOUBLE PRECISION; DECLARE hh DOUBLE PRECISION; DECLARE qx DOUBLE PRECISION; DECLARE qy DOUBLE PRECISION; DECLARE world INTEGER;
DECLARE vseq INTEGER; DECLARE eid INTEGER; DECLARE fid INTEGER; DECLARE cur INTEGER; DECLARE curent INTEGER;
DECLARE emid INTEGER; DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE oz DOUBLE PRECISION;
DECLARE cls VARCHAR(200) CHARACTER SET ASCII; DECLARE cl INTEGER; DECLARE ep DOUBLE PRECISION; DECLARE eyaw DOUBLE PRECISION; DECLARE er DOUBLE PRECISION;
DECLARE m00 DOUBLE PRECISION; DECLARE m01 DOUBLE PRECISION; DECLARE m02 DOUBLE PRECISION;
DECLARE m10 DOUBLE PRECISION; DECLARE m11 DOUBLE PRECISION; DECLARE m12 DOUBLE PRECISION;
DECLARE m20 DOUBLE PRECISION; DECLARE m21 DOUBLE PRECISION; DECLARE m22 DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE view_setup(vx, vy, vz, vyaw, vpitch) RETURNING_VALUES ex, ey, ez, fx, fy, fz, rx, ry, rz, ux, uy, uz, w, h, sc, nearz, kx, ky, pvs, vcl, vleaf;
  hw = w / 2e0; hh = h / 2e0;
  qx = SQRT(1 + kx * kx); qy = SQRT(1 + ky * ky);
  EXECUTE PROCEDURE mark_faces(pvs, vcl);

  -- the faces that face the eye (or are two-sided) and whose sphere is in the frustum
  DELETE FROM sel_faces;
  INSERT INTO sel_faces (face, ent_id, ox, oy, oz)
  SELECT v.face, 0, 0, 0, 0
    FROM vis_faces v
   WHERE (v.twosided = 1 OR v.nx * :ex + v.ny * :ey + v.nz * :ez - v.dist > 0)
     AND (v.cx - :ex) * :fx + (v.cy - :ey) * :fy + (v.cz - :ez) * :fz + v.radius >= :nearz
     AND ABS((v.cx - :ex) * :rx + (v.cy - :ey) * :ry + (v.cz - :ez) * :rz)
         <= ((v.cx - :ex) * :fx + (v.cy - :ey) * :fy + (v.cz - :ez) * :fz) * :kx + v.radius * :qx
     AND ABS((v.cx - :ex) * :ux + (v.cy - :ey) * :uy + (v.cz - :ez) * :uz)
         <= ((v.cx - :ex) * :fx + (v.cy - :ey) * :fy + (v.cz - :ez) * :fz) * :ky + v.radius * :qy;
  SELECT g.world_model FROM game g WHERE g.id = 1 INTO world;
  FOR SELECT e.id, e.model_id, e.x, e.y, e.z, e.clusters, e.cluster, e.pitch, e.yaw, e.roll
        FROM ents e JOIN models m ON m.id = e.model_id
       WHERE m.kind = 'B' AND e.model_id <> :world AND e.solid <> 1 AND e.alpha = 0
        INTO eid, emid, ox, oy, oz, cls, cl, ep, eyaw, er
  DO
  BEGIN
    IF (clusters_visible(pvs, cls, cl) = 0) THEN CONTINUE;
    IF (ep = 0 AND eyaw = 0 AND er = 0) THEN
      INSERT INTO sel_faces (face, ent_id, ox, oy, oz)
      SELECT f.id, :eid, :ox, :oy, :oz FROM faces f
       WHERE f.model_id = :emid AND BIN_AND(f.flags, 128) = 0
         AND (f.twosided = 1 OR f.nx * (:ex - :ox) + f.ny * (:ey - :oy) + f.nz * (:ez - :oz) - f.dist > 0)
         AND (f.cx + :ox - :ex) * :fx + (f.cy + :oy - :ey) * :fy + (f.cz + :oz - :ez) * :fz + f.radius >= :nearz
         AND ABS((f.cx + :ox - :ex) * :rx + (f.cy + :oy - :ey) * :ry + (f.cz + :oz - :ez) * :rz)
             <= ((f.cx + :ox - :ex) * :fx + (f.cy + :oy - :ey) * :fy + (f.cz + :oz - :ez) * :fz) * :kx + f.radius * :qx
         AND ABS((f.cx + :ox - :ex) * :ux + (f.cy + :oy - :ey) * :uy + (f.cz + :oz - :ez) * :uz)
             <= ((f.cx + :ox - :ex) * :fx + (f.cy + :oy - :ey) * :fy + (f.cz + :oz - :ez) * :fz) * :ky + f.radius * :qy;
    ELSE
    BEGIN
      EXECUTE PROCEDURE angle_matrix(ep, eyaw, er) RETURNING_VALUES m00, m01, m02, m10, m11, m12, m20, m21, m22;
      INSERT INTO sel_faces (face, ent_id, ox, oy, oz, m00, m01, m02, m10, m11, m12, m20, m21, m22)
      SELECT f.id, :eid, :ox, :oy, :oz, :m00, :m01, :m02, :m10, :m11, :m12, :m20, :m21, :m22 FROM faces f WHERE f.model_id = :emid AND BIN_AND(f.flags, 128) = 0;
    END
  END

  -- one cursor over the selected faces' vertices: the rotation, the view transform and the
  -- projection are in the select list, evaluated by the engine rather than as PSQL statements.
  -- The (face, seq) key walks each face's vertices in order. Vertices behind the near plane
  -- project to NULL; the painter clips those edges in view space.
  cur = -1; curent = -1;
  FOR SELECT v.ent_id, f.id, fv.seq,
             (v.m00 * fv.x + v.m01 * fv.y + v.m02 * fv.z + v.ox - :ex) * :fx + (v.m10 * fv.x + v.m11 * fv.y + v.m12 * fv.z + v.oy - :ey) * :fy + (v.m20 * fv.x + v.m21 * fv.y + v.m22 * fv.z + v.oz - :ez) * :fz,
             (v.m00 * fv.x + v.m01 * fv.y + v.m02 * fv.z + v.ox - :ex) * :rx + (v.m10 * fv.x + v.m11 * fv.y + v.m12 * fv.z + v.oy - :ey) * :ry + (v.m20 * fv.x + v.m21 * fv.y + v.m22 * fv.z + v.oz - :ez) * :rz,
             (v.m00 * fv.x + v.m01 * fv.y + v.m02 * fv.z + v.ox - :ex) * :ux + (v.m10 * fv.x + v.m11 * fv.y + v.m12 * fv.z + v.oy - :ey) * :uy + (v.m20 * fv.x + v.m21 * fv.y + v.m22 * fv.z + v.oz - :ez) * :uz,
             fv.s, fv.t, fv.u, fv.v
        FROM sel_faces v
        JOIN faces f ON f.id = v.face
        JOIN face_verts fv ON fv.face = f.id
        INTO eid, fid, vseq, vf, vr, vu, s, t, u, v
  DO
  BEGIN
    IF (fid <> cur OR eid <> curent OR vseq = 0) THEN
    BEGIN
      cur = fid; curent = eid; face = fid; ent_id = eid;
    END
    seq = vseq;
    IF (vf >= nearz) THEN
    BEGIN
      sx = hw + vr * sc / vf; sy = hh - vu * sc / vf;
    END
    ELSE
    BEGIN
      sx = NULL; sy = NULL;
    END
    SUSPEND;
  END
END^

-- FRAME_ALL: the frame as one result set, so the page makes one round trip to the
-- engine per frame. SQL decides what is visible (PVS, back faces, frustum); the painter transforms
-- the vertices it already holds from the BSP. kind:
--   1 faces (i2 ent, d1..3 origin, lst the face ids)
--   8 projected vertex, mode 1 only (i1 face, i2 seq, i3 ent, d1..9 vf vr vu sx sy s t u v)
--   2 an MD3 entity (i1 id, i2 model, i3 frame, i4 weapon, i5 effects, d1..6 pose, d7 legs_time, d8 torso_time, s "pmodel/skin" or NULL,
--                    lst "legs_anim,torso_anim,health,classname")
--   4 sound after last_sound (i1 id, i2 ent, i3 chan, d1 vol, d2 attn, d3..5 at, s name)
--   5 effect after last_fx (i1 id, i2 kind, i3 n, d1..6 at/to)
--   6 brush-model pose (i1 ent, d1..3 angles)
--   7 the looped speakers that are on (lst their ids), when want_speakers = 1
--   9 a console line (i1 id, d1 time, s text)
CREATE OR ALTER PROCEDURE frame_all (mode SMALLINT, last_sound INTEGER, last_fx INTEGER, want_speakers SMALLINT,
                                     vx DOUBLE PRECISION DEFAULT NULL, vy DOUBLE PRECISION DEFAULT NULL, vz DOUBLE PRECISION DEFAULT NULL,
                                     vyaw DOUBLE PRECISION DEFAULT NULL, vpitch DOUBLE PRECISION DEFAULT NULL)
RETURNS (kind SMALLINT, i1 INTEGER, i2 INTEGER, i3 INTEGER, i4 INTEGER, i5 INTEGER,
         d1 DOUBLE PRECISION, d2 DOUBLE PRECISION, d3 DOUBLE PRECISION, d4 DOUBLE PRECISION, d5 DOUBLE PRECISION,
         d6 DOUBLE PRECISION, d7 DOUBLE PRECISION, d8 DOUBLE PRECISION, d9 DOUBLE PRECISION, s VARCHAR(200),
         lst BLOB SUB_TYPE TEXT CHARACTER SET ASCII)
AS
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE fx DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION;
DECLARE ux DOUBLE PRECISION; DECLARE uy DOUBLE PRECISION; DECLARE uz DOUBLE PRECISION;
DECLARE w INTEGER; DECLARE h INTEGER; DECLARE sc DOUBLE PRECISION; DECLARE nearz DOUBLE PRECISION;
DECLARE kx DOUBLE PRECISION; DECLARE ky DOUBLE PRECISION; DECLARE pvs VARCHAR(2048) CHARACTER SET ASCII; DECLARE vcl INTEGER; DECLARE vleaf INTEGER;
DECLARE qx DOUBLE PRECISION; DECLARE qy DOUBLE PRECISION; DECLARE world INTEGER; DECLARE pe INTEGER;
DECLARE eid INTEGER; DECLARE emid INTEGER; DECLARE cls VARCHAR(200) CHARACTER SET ASCII; DECLARE cl INTEGER; DECLARE rot SMALLINT;
DECLARE vis SMALLINT; DECLARE vis_cl INTEGER;
DECLARE pm VARCHAR(16); DECLARE ps VARCHAR(16); DECLARE la INTEGER; DECLARE ta INTEGER; DECLARE hp INTEGER; DECLARE cn VARCHAR(40); DECLARE alpha SMALLINT;
BEGIN
  SELECT g.world_model FROM game g WHERE g.id = 1 INTO world;
  pe = player_ent();
  EXECUTE PROCEDURE view_setup(vx, vy, vz, vyaw, vpitch) RETURNING_VALUES ex, ey, ez, fx, fy, fz, rx, ry, rz, ux, uy, uz, w, h, sc, nearz, kx, ky, pvs, vcl, vleaf;
  qx = SQRT(1 + kx * kx); qy = SQRT(1 + ky * ky);
  -- the eye this frame was culled for (a predicted one may have been clamped): the page paints from it
  kind = 10; d1 = ex; d2 = ey; d3 = ez;
  SUSPEND;
  d1 = NULL; d2 = NULL; d3 = NULL;
  IF (mode = 1) THEN
  BEGIN
    kind = 8;
    FOR SELECT f.face, f.seq, f.ent_id, f.vf, f.vr, f.vu, f.sx, f.sy, f.s, f.t, f.u, f.v FROM frame_faces(:vx, :vy, :vz, :vyaw, :vpitch) f INTO i1, i2, i3, d1, d2, d3, d4, d5, d6, d7, d8, d9 DO SUSPEND;
    i3 = NULL; d4 = NULL; d5 = NULL; d6 = NULL; d7 = NULL; d8 = NULL; d9 = NULL;
  END
  ELSE
  BEGIN
    EXECUTE PROCEDURE mark_faces(pvs, vcl);
    kind = 1; i2 = 0; d1 = 0; d2 = 0; d3 = 0;
    SELECT LIST(v.face, ',')
      FROM vis_faces v
     WHERE (v.twosided = 1 OR v.nx * :ex + v.ny * :ey + v.nz * :ez - v.dist > 0)
       AND (v.cx - :ex) * :fx + (v.cy - :ey) * :fy + (v.cz - :ez) * :fz + v.radius >= :nearz
       AND ABS((v.cx - :ex) * :rx + (v.cy - :ey) * :ry + (v.cz - :ez) * :rz)
           <= ((v.cx - :ex) * :fx + (v.cy - :ey) * :fy + (v.cz - :ez) * :fz) * :kx + v.radius * :qx
       AND ABS((v.cx - :ex) * :ux + (v.cy - :ey) * :uy + (v.cz - :ez) * :uz)
           <= ((v.cx - :ex) * :fx + (v.cy - :ey) * :fy + (v.cz - :ez) * :fz) * :ky + v.radius * :qy
      INTO lst;
    IF (lst IS NOT NULL) THEN SUSPEND;

    -- the brush-model entities in the PVS. Whether a model's clusters are in the PVS is decided
    -- once per view cluster and kept on the row until the model is relinked.
    FOR SELECT e.id, e.model_id, e.x, e.y, e.z, e.clusters, e.cluster, IIF(e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0, 1, 0), e.vis_cl, e.vis
          FROM ents e JOIN models m ON m.id = e.model_id
         WHERE m.kind = 'B' AND e.model_id <> :world AND e.solid <> 1 AND e.alpha = 0
          INTO eid, emid, d1, d2, d3, cls, cl, rot, vis_cl, vis
    DO
    BEGIN
      IF (vis_cl IS DISTINCT FROM vcl OR vis IS NULL) THEN
      BEGIN
        vis = clusters_visible(pvs, cls, cl);
        UPDATE ents e SET e.vis_cl = :vcl, e.vis = :vis WHERE e.id = :eid;
      END
      IF (vis = 0) THEN CONTINUE;
      i2 = eid;
      SELECT LIST(f.id, ',')
        FROM faces f
       WHERE f.model_id = :emid AND BIN_AND(f.flags, 128) = 0
         AND (:rot = 1 OR (
             (f.twosided = 1 OR f.nx * (:ex - :d1) + f.ny * (:ey - :d2) + f.nz * (:ez - :d3) - f.dist > 0)
         AND (f.cx + :d1 - :ex) * :fx + (f.cy + :d2 - :ey) * :fy + (f.cz + :d3 - :ez) * :fz + f.radius >= :nearz
         AND ABS((f.cx + :d1 - :ex) * :rx + (f.cy + :d2 - :ey) * :ry + (f.cz + :d3 - :ez) * :rz)
             <= ((f.cx + :d1 - :ex) * :fx + (f.cy + :d2 - :ey) * :fy + (f.cz + :d3 - :ez) * :fz) * :kx + f.radius * :qx
         AND ABS((f.cx + :d1 - :ex) * :ux + (f.cy + :d2 - :ey) * :uy + (f.cz + :d3 - :ez) * :uz)
             <= ((f.cx + :d1 - :ex) * :fx + (f.cy + :d2 - :ey) * :fy + (f.cz + :d3 - :ez) * :fz) * :ky + f.radius * :qy))
        INTO lst;
      IF (lst IS NOT NULL) THEN SUSPEND;
    END
    lst = NULL;
  END

  -- the MD3 entities (items, missiles, gibs) and the player models (bots, corpses) in the frustum and
  -- the PVS, with their pose. The frustum test is in the WHERE clause so only the entities in view
  -- reach the PVS test; the sphere is the model's radius plus a margin that covers a player's box.
  kind = 2;
  FOR SELECT e.id, e.model_id, e.frame, e.weapon, e.effects, e.x, e.y, e.z, e.pitch, e.yaw, e.roll, e.legs_time, e.torso_time,
             e.pmodel, e.pskin, e.legs_anim, e.torso_anim, e.health, e.classname, e.cluster, e.clusters
        FROM ents e LEFT JOIN models m ON m.id = e.model_id
       WHERE (m.kind IN ('M', 'S') OR e.pmodel IS NOT NULL) AND e.id <> :pe AND e.alpha = 0
         AND (e.x - :ex) * :fx + (e.y - :ey) * :fy + (e.z - :ez) * :fz + COALESCE(m.radius, 0) + 64 >= :nearz
         AND ABS((e.x - :ex) * :rx + (e.y - :ey) * :ry + (e.z - :ez) * :rz)
             <= ((e.x - :ex) * :fx + (e.y - :ey) * :fy + (e.z - :ez) * :fz + COALESCE(m.radius, 0) + 64) * :kx + COALESCE(m.radius, 0) + 64
        INTO i1, i2, i3, i4, i5, d1, d2, d3, d4, d5, d6, d7, d8, pm, ps, la, ta, hp, cn, cl, cls
  DO
  BEGIN
    IF (clusters_visible(pvs, cls, COALESCE(cl, (SELECT l.cluster FROM leaves l WHERE l.id = point_leaf(:d1, :d2, :d3)))) = 0) THEN CONTINUE;
    s = IIF(pm IS NULL, NULL, pm || '/' || COALESCE(ps, 'default'));
    lst = la || ',' || ta || ',' || hp || ',' || cn;
    SUSPEND;
  END
  i1 = NULL; i2 = NULL; i3 = NULL; i4 = NULL; i5 = NULL; d1 = NULL; d2 = NULL; d3 = NULL; d4 = NULL; d5 = NULL; d6 = NULL; d7 = NULL; d8 = NULL; s = NULL; lst = NULL;
  kind = 4;
  FOR SELECT se.id, se.ent_id, se.chan, se.vol, se.attn, se.x, se.y, se.z, se.snd FROM sound_events se WHERE se.id > :last_sound ORDER BY se.id
        INTO i1, i2, i3, d1, d2, d3, d4, d5, s DO SUSPEND;
  kind = 5; s = NULL;
  FOR SELECT fe.id, fe.kind, fe.n, fe.x, fe.y, fe.z, fe.x2, fe.y2, fe.z2 FROM fx_events fe WHERE fe.id > :last_fx ORDER BY fe.id
        INTO i1, i2, i3, d1, d2, d3, d4, d5, d6 DO SUSPEND;
  kind = 6; i2 = NULL; i3 = NULL; d4 = NULL; d5 = NULL; d6 = NULL;
  FOR SELECT e.id, e.pitch, e.yaw, e.roll FROM ents e JOIN models m ON m.id = e.model_id
       WHERE m.kind = 'B' AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0) INTO i1, d1, d2, d3 DO SUSPEND;
  kind = 9; d2 = NULL; d3 = NULL;
  FOR SELECT m.id, m.time_, m.msg FROM messages m ORDER BY m.id INTO i1, d1, s DO SUSPEND;
  IF (want_speakers = 1) THEN
  BEGIN
    kind = 7; i1 = NULL; d1 = NULL; s = NULL;
    SELECT LIST(e.id, ',') FROM ents e WHERE e.classname = 'target_speaker' AND e.count_ = 1 INTO lst;
    SUSPEND;
  END
END^

-- FRAME_FACES_FAST: the faces to draw, one row each (FRAME_ALL's lists split), for scripts and the console
CREATE OR ALTER PROCEDURE frame_faces_fast
RETURNS (face INTEGER, ent_id INTEGER, ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION)
AS
DECLARE lst BLOB SUB_TYPE TEXT CHARACTER SET ASCII; DECLARE buf VARCHAR(32000) CHARACTER SET ASCII;
DECLARE p INTEGER; DECLARE q INTEGER; DECLARE n INTEGER; DECLARE off INTEGER;
BEGIN
  FOR SELECT r.i2, r.d1, r.d2, r.d3, r.lst FROM frame_all(0, 2147483647, 2147483647, 0) r WHERE r.kind = 1 INTO ent_id, ox, oy, oz, lst
  DO
  BEGIN
    n = CHAR_LENGTH(lst); off = 1;
    WHILE (off <= n) DO
    BEGIN
      -- 32000 characters at a time, cut at a ','
      buf = SUBSTRING(lst FROM off FOR 32000);
      IF (off + 32000 <= n) THEN
      BEGIN
        q = CHAR_LENGTH(buf);
        WHILE (q > 0 AND SUBSTRING(buf FROM q FOR 1) <> ',') DO q = q - 1;
        buf = SUBSTRING(buf FROM 1 FOR q);
      END
      off = off + CHAR_LENGTH(buf);
      p = 1;
      WHILE (p <= CHAR_LENGTH(buf)) DO
      BEGIN
        q = POSITION(',', buf, p);
        IF (q = 0) THEN q = CHAR_LENGTH(buf) + 1;
        face = CAST(SUBSTRING(buf FROM p FOR q - p) AS INTEGER);
        SUSPEND;
        p = q + 1;
      END
    END
  END
END^

-- FRAME_ENTS: the models to draw, with their pose (the entity rows of FRAME_ALL)
CREATE OR ALTER PROCEDURE frame_ents
RETURNS (id INTEGER, model_id INTEGER, frame INTEGER, weapon INTEGER, effects INTEGER,
         x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
         pitch DOUBLE PRECISION, yaw DOUBLE PRECISION, roll DOUBLE PRECISION,
         legs_time DOUBLE PRECISION, torso_time DOUBLE PRECISION, pmodel VARCHAR(200), anims BLOB SUB_TYPE TEXT CHARACTER SET ASCII)
AS
BEGIN
  FOR SELECT r.i1, r.i2, r.i3, r.i4, r.i5, r.d1, r.d2, r.d3, r.d4, r.d5, r.d6, r.d7, r.d8, r.s, r.lst
        FROM frame_all(0, 2147483647, 2147483647, 0) r WHERE r.kind = 2
        INTO id, model_id, frame, weapon, effects, x, y, z, pitch, yaw, roll, legs_time, torso_time, pmodel, anims DO SUSPEND;
END^

SET TERM ; ^
