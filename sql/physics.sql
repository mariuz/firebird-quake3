-- physics.sql – cm_trace.c, cm_patch.c, g_... inside Firebird.
--
-- Collision is Quake III's: a trace walks the BSP tree with the moving box's
-- extents pushing the split planes out (CM_TraceThroughTree) and, in each
-- leaf it reaches, clips the segment against every brush of the leaf whose
-- contents match the mask (CM_TraceThroughBrush); a patch's facets are
-- one-sided brushes and are clipped the same way (CM_TraceThroughPatch-
-- Collide). PSQL has recursion, so RHC is a recursive procedure threading
-- the trace state through its parameters. Brush models have no tree: their
-- "head node" is a leaf listing their brushes. Box entities (players, bots)
-- are hit with a Minkowski slab test.
--
-- Content masks: MASK_SOLID 1, MASK_PLAYERSOLID 33619969 (solid|playerclip|
-- body), MASK_DEADSOLID 65537, MASK_WATER 56, MASK_OPAQUE 25, MASK_SHOT
-- 100663297 (solid|body|corpse).

SET TERM ^ ;

-- forward declarations (bodies in game.sql); signatures must not change
CREATE OR ALTER PROCEDURE impact (e1 INTEGER, e2 INTEGER, sflags INTEGER) AS BEGIN END^

-- ── point queries ─────────────────────────────────────────────────────────
-- CM_PointLeafnum from a head node (model space). A negative head is a leaf.
CREATE OR ALTER FUNCTION model_point_leaf (head INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION)
RETURNS INTEGER
AS
DECLARE n INTEGER;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION; DECLARE d DOUBLE PRECISION;
DECLARE c0 INTEGER; DECLARE c1 INTEGER;
BEGIN
  n = head;
  WHILE (n >= 0) DO
  BEGIN
    SELECT h.nx, h.ny, h.nz, h.dist, h.c0, h.c1 FROM nodes h WHERE h.id = :n INTO nx, ny, nz, d, c0, c1;
    IF (nx IS NULL) THEN RETURN 0;
    n = IIF(nx * px + ny * py + nz * pz - d >= 0, c0, c1);
    nx = NULL;
  END
  RETURN -n - 1;
END^

-- the world leaf of a point
CREATE OR ALTER FUNCTION point_leaf (px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION)
RETURNS INTEGER
AS
BEGIN
  RETURN model_point_leaf(0, px, py, pz);
END^

-- the contents of the brushes of one leaf that contain a point (CM_PointContents: a point is in a
-- brush when it is behind every side)
CREATE OR ALTER FUNCTION leaf_point_contents (leaf INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION)
RETURNS INTEGER
AS
DECLARE c INTEGER = 0; DECLARE flb INTEGER; DECLARE nlb INTEGER; DECLARE bc INTEGER;
BEGIN
  SELECT l.first_lb, l.num_lb FROM leaves l WHERE l.id = :leaf INTO flb, nlb;
  IF (nlb IS NULL OR nlb = 0) THEN RETURN 0;
  FOR SELECT br.contents FROM leafbrushes lb JOIN brushes br ON br.id = lb.brush
       WHERE lb.id >= :flb AND lb.id < :flb + :nlb AND br.facet = 0
         AND br.minx <= :px AND br.maxx >= :px AND br.miny <= :py AND br.maxy >= :py AND br.minz <= :pz AND br.maxz >= :pz
         AND NOT EXISTS (SELECT 1 FROM brushsides s WHERE s.id >= br.first_side AND s.id < br.first_side + br.num_sides
                           AND s.nx * :px + s.ny * :py + s.nz * :pz - s.dist > 0)
        INTO bc
  DO c = BIN_OR(c, bc);
  RETURN c;
END^

-- SV_PointContents: the world's brushes at the point, plus any brush model standing there.
CREATE OR ALTER FUNCTION point_contents (px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION)
RETURNS INTEGER
AS
DECLARE c INTEGER; DECLARE head INTEGER; DECLARE eox DOUBLE PRECISION; DECLARE eoy DOUBLE PRECISION; DECLARE eoz DOUBLE PRECISION;
DECLARE lf INTEGER;
BEGIN
  -- (a function in a WHERE clause is evaluated three times; call it once)
  lf = point_leaf(px, py, pz);
  c = leaf_point_contents(lf, px, py, pz);
  FOR SELECT m.headnode, e.x, e.y, e.z FROM ents e JOIN models m ON m.id = e.model_id
       WHERE e.solid = 4 AND e.x + e.minx <= :px AND e.x + e.maxx >= :px AND e.y + e.miny <= :py AND e.y + e.maxy >= :py
         AND e.z + e.minz <= :pz AND e.z + e.maxz >= :pz
        INTO head, eox, eoy, eoz
  DO
  BEGIN
    IF (head < 0) THEN c = BIN_OR(c, leaf_point_contents(-head - 1, px - eox, py - eoy, pz - eoz));
  END
  RETURN c;
END^

-- AngleVectors as a matrix: world = origin + M · local, with the columns
-- forward, -right, up (the convention CM_TransformedBoxTrace uses).
CREATE OR ALTER PROCEDURE angle_matrix (pitch DOUBLE PRECISION, yaw DOUBLE PRECISION, roll DOUBLE PRECISION)
RETURNS (m00 DOUBLE PRECISION, m01 DOUBLE PRECISION, m02 DOUBLE PRECISION,
         m10 DOUBLE PRECISION, m11 DOUBLE PRECISION, m12 DOUBLE PRECISION,
         m20 DOUBLE PRECISION, m21 DOUBLE PRECISION, m22 DOUBLE PRECISION)
AS
DECLARE sy DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE sp DOUBLE PRECISION; DECLARE cp DOUBLE PRECISION;
DECLARE sr DOUBLE PRECISION; DECLARE cr DOUBLE PRECISION;
BEGIN
  sy = SIN(yaw * 0.0174532925e0); cy = COS(yaw * 0.0174532925e0);
  sp = SIN(pitch * 0.0174532925e0); cp = COS(pitch * 0.0174532925e0);
  sr = SIN(roll * 0.0174532925e0); cr = COS(roll * 0.0174532925e0);
  m00 = cp * cy;  m01 = sr * sp * cy - cr * sy;   m02 = cr * sp * cy + sr * sy;
  m10 = cp * sy;  m11 = sr * sp * sy + cr * cy;   m12 = cr * sp * sy - sr * cy;
  m20 = -sp;      m21 = sr * cp;                  m22 = cr * cp;
  SUSPEND;
END^

-- Is cluster `cluster` in the PVS string `pvs`? ('' = everything visible)
CREATE OR ALTER FUNCTION pvs_visible (pvs VARCHAR(2048) CHARACTER SET ASCII, cluster INTEGER)
RETURNS SMALLINT
AS
DECLARE c CHAR(1) CHARACTER SET ASCII;
BEGIN
  IF (pvs IS NULL OR pvs = '') THEN RETURN 1;
  IF (cluster IS NULL OR cluster < 0) THEN RETURN 0;
  c = SUBSTRING(pvs FROM BIN_SHR(cluster, 2) + 1 FOR 1);
  IF (c IS NULL OR c = '') THEN RETURN 0;
  RETURN IIF(BIN_AND(POSITION(c, '0123456789abcdef') - 1, BIN_SHL(1, BIN_AND(cluster, 3))) <> 0, 1, 0);
END^

-- ── brushes ──────────────────────────────────────────────────────────────
-- CM_TraceThroughBrush for every brush of one leaf that matches the mask and
-- whose bounds the swept box touches. One cursor over the sides of all those
-- brushes (grouped by brush: the join walks leafbrushes in order and each
-- brush's sides by key), finalising a brush when the next one begins.
-- fraction/plane/flags/contents come in and go out so the nearest hit wins.
-- A facet (a patch's cell) is one-sided: starting behind it is not solid.
CREATE OR ALTER PROCEDURE clip_leaf (
  leaf INTEGER,
  mnx DOUBLE PRECISION, mny DOUBLE PRECISION, mnz DOUBLE PRECISION,
  mxx DOUBLE PRECISION, mxy DOUBLE PRECISION, mxz DOUBLE PRECISION,
  p1x DOUBLE PRECISION, p1y DOUBLE PRECISION, p1z DOUBLE PRECISION,
  p2x DOUBLE PRECISION, p2y DOUBLE PRECISION, p2z DOUBLE PRECISION,
  mask INTEGER, ispoint SMALLINT,
  frac_in DOUBLE PRECISION, nx_in DOUBLE PRECISION, ny_in DOUBLE PRECISION, nz_in DOUBLE PRECISION, pd_in DOUBLE PRECISION,
  sflags_in INTEGER, contents_in INTEGER, allsolid_in SMALLINT, startsolid_in SMALLINT)
RETURNS (
  fraction DOUBLE PRECISION, nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION, pdist DOUBLE PRECISION,
  sflags INTEGER, contents INTEGER, allsolid SMALLINT, startsolid SMALLINT)
AS
DECLARE lc INTEGER; DECLARE flb INTEGER; DECLARE nlb INTEGER;
DECLARE b INTEGER; DECLARE bc INTEGER; DECLARE bf SMALLINT; DECLARE cur INTEGER = -1; DECLARE curc INTEGER; DECLARE curf SMALLINT;
DECLARE snx DOUBLE PRECISION; DECLARE sny DOUBLE PRECISION; DECLARE snz DOUBLE PRECISION; DECLARE sd DOUBLE PRECISION; DECLARE sfl INTEGER;
DECLARE d1 DOUBLE PRECISION; DECLARE d2 DOUBLE PRECISION; DECLARE dist DOUBLE PRECISION; DECLARE f DOUBLE PRECISION;
DECLARE enterfrac DOUBLE PRECISION; DECLARE leavefrac DOUBLE PRECISION;
DECLARE getout SMALLINT; DECLARE startout SMALLINT; DECLARE skip SMALLINT;
DECLARE cnx DOUBLE PRECISION; DECLARE cny DOUBLE PRECISION; DECLARE cnz DOUBLE PRECISION; DECLARE cd DOUBLE PRECISION; DECLARE cfl INTEGER;
DECLARE bminx DOUBLE PRECISION; DECLARE bminy DOUBLE PRECISION; DECLARE bminz DOUBLE PRECISION;
DECLARE bmaxx DOUBLE PRECISION; DECLARE bmaxy DOUBLE PRECISION; DECLARE bmaxz DOUBLE PRECISION;
BEGIN
  fraction = frac_in; nx = nx_in; ny = ny_in; nz = nz_in; pdist = pd_in; sflags = sflags_in; contents = contents_in;
  allsolid = allsolid_in; startsolid = startsolid_in;
  SELECT l.contents, l.first_lb, l.num_lb FROM leaves l WHERE l.id = :leaf INTO lc, flb, nlb;
  IF (lc IS NULL OR BIN_AND(lc, mask) = 0 OR nlb = 0) THEN BEGIN SUSPEND; EXIT; END
  -- the swept box of the trace
  bminx = MINVALUE(p1x, p2x) + mnx - 1; bminy = MINVALUE(p1y, p2y) + mny - 1; bminz = MINVALUE(p1z, p2z) + mnz - 1;
  bmaxx = MAXVALUE(p1x, p2x) + mxx + 1; bmaxy = MAXVALUE(p1y, p2y) + mxy + 1; bmaxz = MAXVALUE(p1z, p2z) + mxz + 1;

  enterfrac = -1; leavefrac = 1; getout = 0; startout = 0; skip = 0; cnx = 0; cny = 0; cnz = 0; cd = 0; cfl = 0; curc = 0; curf = 0;
  -- the side's distance to the box's leading corner and both endpoints' distances, as expressions: the
  -- engine evaluates them far cheaper than PSQL statements would
  FOR SELECT br.id, br.contents, br.facet, s.nx, s.ny, s.nz, s.dist, s.flags,
             :p1x * s.nx + :p1y * s.ny + :p1z * s.nz - (s.dist - IIF(:ispoint = 1, 0, IIF(s.nx < 0, :mxx, :mnx) * s.nx + IIF(s.ny < 0, :mxy, :mny) * s.ny + IIF(s.nz < 0, :mxz, :mnz) * s.nz)),
             :p2x * s.nx + :p2y * s.ny + :p2z * s.nz - (s.dist - IIF(:ispoint = 1, 0, IIF(s.nx < 0, :mxx, :mnx) * s.nx + IIF(s.ny < 0, :mxy, :mny) * s.ny + IIF(s.nz < 0, :mxz, :mnz) * s.nz))
        FROM leafbrushes lb
        JOIN brushes br ON br.id = lb.brush
        JOIN brushsides s ON s.id >= br.first_side AND s.id < br.first_side + br.num_sides
       WHERE lb.id >= :flb AND lb.id < :flb + :nlb AND BIN_AND(br.contents, :mask) <> 0
         AND br.maxx >= :bminx AND br.minx <= :bmaxx AND br.maxy >= :bminy AND br.miny <= :bmaxy AND br.maxz >= :bminz AND br.minz <= :bmaxz
        INTO b, bc, bf, snx, sny, snz, sd, sfl, d1, d2
  DO
  BEGIN
    IF (b <> cur) THEN
    BEGIN
      -- finish the previous brush
      IF (cur >= 0 AND skip = 0) THEN
      BEGIN
        IF (startout = 0) THEN
        BEGIN
          IF (curf = 0) THEN
          BEGIN
            startsolid = 1;
            IF (getout = 0) THEN allsolid = 1;
          END
        END
        ELSE IF (enterfrac < leavefrac AND enterfrac > -1 AND enterfrac < fraction) THEN
        BEGIN
          fraction = MAXVALUE(0, enterfrac);
          nx = cnx; ny = cny; nz = cnz; pdist = cd; sflags = cfl; contents = curc;
        END
      END
      cur = b; curc = bc; curf = bf;
      enterfrac = -1; leavefrac = 1; getout = 0; startout = 0; skip = 0; cnx = 0; cny = 0; cnz = 0; cd = 0; cfl = 0;
    END
    IF (skip = 1) THEN CONTINUE;
    IF (d2 > 0) THEN getout = 1;
    IF (d1 > 0) THEN startout = 1;
    IF (d1 > 0 AND d2 >= d1) THEN BEGIN skip = 1; CONTINUE; END     -- completely in front of this face
    IF (d1 <= 0 AND d2 <= 0) THEN CONTINUE;
    IF (d1 > d2) THEN
    BEGIN
      f = (d1 - 0.03125e0) / (d1 - d2);
      IF (f > enterfrac) THEN BEGIN enterfrac = f; cnx = snx; cny = sny; cnz = snz; cd = sd; cfl = sfl; END
    END
    ELSE
    BEGIN
      f = (d1 + 0.03125e0) / (d1 - d2);
      IF (f < leavefrac) THEN leavefrac = f;
    END
  END
  -- the last brush
  IF (cur >= 0 AND skip = 0) THEN
  BEGIN
    IF (startout = 0) THEN
    BEGIN
      IF (curf = 0) THEN
      BEGIN
        startsolid = 1;
        IF (getout = 0) THEN allsolid = 1;
      END
    END
    ELSE IF (enterfrac < leavefrac AND enterfrac > -1 AND enterfrac < fraction) THEN
    BEGIN
      fraction = MAXVALUE(0, enterfrac);
      nx = cnx; ny = cny; nz = cnz; pdist = cd; sflags = cfl; contents = curc;
    END
  END
  SUSPEND;
END^

-- ── the tree walk ────────────────────────────────────────────────────────
-- CM_TraceThroughTree: the box's extents (ex ey ez = symmetric half sizes)
-- push each split plane out; the segment is split at the plane with a
-- SURFACE_CLIP_EPSILON overlap and both sides are visited, nearest first,
-- skipping anything beyond a hit already found.
CREATE OR ALTER PROCEDURE rhc (
  node INTEGER, p1f DOUBLE PRECISION, p2f DOUBLE PRECISION,
  p1x DOUBLE PRECISION, p1y DOUBLE PRECISION, p1z DOUBLE PRECISION,
  p2x DOUBLE PRECISION, p2y DOUBLE PRECISION, p2z DOUBLE PRECISION,
  s1x DOUBLE PRECISION, s1y DOUBLE PRECISION, s1z DOUBLE PRECISION,
  s2x DOUBLE PRECISION, s2y DOUBLE PRECISION, s2z DOUBLE PRECISION,
  mnx DOUBLE PRECISION, mny DOUBLE PRECISION, mnz DOUBLE PRECISION,
  mxx DOUBLE PRECISION, mxy DOUBLE PRECISION, mxz DOUBLE PRECISION,
  ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION,
  mask INTEGER, ispoint SMALLINT,
  frac_in DOUBLE PRECISION, nx_in DOUBLE PRECISION, ny_in DOUBLE PRECISION, nz_in DOUBLE PRECISION, pd_in DOUBLE PRECISION,
  sflags_in INTEGER, contents_in INTEGER, allsolid_in SMALLINT, startsolid_in SMALLINT)
RETURNS (
  fraction DOUBLE PRECISION, nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION, pdist DOUBLE PRECISION,
  sflags INTEGER, contents INTEGER, allsolid SMALLINT, startsolid SMALLINT)
AS
DECLARE plnx DOUBLE PRECISION; DECLARE plny DOUBLE PRECISION; DECLARE plnz DOUBLE PRECISION; DECLARE pld DOUBLE PRECISION; DECLARE ptype SMALLINT;
DECLARE c0 INTEGER; DECLARE c1 INTEGER; DECLARE cc0 INTEGER; DECLARE cc1 INTEGER; DECLARE ccn INTEGER; DECLARE ccf INTEGER;
DECLARE t1 DOUBLE PRECISION; DECLARE t2 DOUBLE PRECISION; DECLARE offset_ DOUBLE PRECISION;
DECLARE frac DOUBLE PRECISION; DECLARE frac2 DOUBLE PRECISION; DECLARE idist DOUBLE PRECISION; DECLARE midf DOUBLE PRECISION;
DECLARE mx DOUBLE PRECISION; DECLARE my DOUBLE PRECISION; DECLARE mz DOUBLE PRECISION;
DECLARE side_ SMALLINT; DECLARE n INTEGER;
BEGIN
  fraction = frac_in; nx = nx_in; ny = ny_in; nz = nz_in; pdist = pd_in; sflags = sflags_in; contents = contents_in;
  allsolid = allsolid_in; startsolid = startsolid_in;
  IF (fraction <= p1f) THEN BEGIN SUSPEND; EXIT; END      -- already hit something nearer

  n = node;
  WHILE (n >= 0) DO
  BEGIN
    SELECT h.nx, h.ny, h.nz, h.dist, h.ptype, h.c0, h.c1, h.cc0, h.cc1 FROM nodes h WHERE h.id = :n INTO plnx, plny, plnz, pld, ptype, c0, c1, cc0, cc1;
    IF (plnx IS NULL) THEN BEGIN SUSPEND; EXIT; END
    t1 = plnx * p1x + plny * p1y + plnz * p1z - pld;
    t2 = plnx * p2x + plny * p2y + plnz * p2z - pld;
    IF (ispoint = 1) THEN offset_ = 0;
    ELSE IF (ptype = 0) THEN offset_ = ex;
    ELSE IF (ptype = 1) THEN offset_ = ey;
    ELSE IF (ptype = 2) THEN offset_ = ez;
    ELSE offset_ = ABS(ex * plnx) + ABS(ey * plny) + ABS(ez * plnz);
    -- the whole segment on one side: just descend (into an empty leaf: nothing to hit, done)
    IF (t1 >= offset_ AND t2 >= offset_) THEN
    BEGIN
      IF (c0 < 0 AND BIN_AND(cc0, mask) = 0) THEN BEGIN SUSPEND; EXIT; END
      n = c0; CONTINUE;
    END
    IF (t1 < -offset_ AND t2 < -offset_) THEN
    BEGIN
      IF (c1 < 0 AND BIN_AND(cc1, mask) = 0) THEN BEGIN SUSPEND; EXIT; END
      n = c1; CONTINUE;
    END
    LEAVE;
  END
  IF (n < 0) THEN
  BEGIN
    EXECUTE PROCEDURE clip_leaf(-n - 1, mnx, mny, mnz, mxx, mxy, mxz, s1x, s1y, s1z, s2x, s2y, s2z, mask, ispoint,
                                fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid)
      RETURNING_VALUES fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid;
    SUSPEND;
    EXIT;
  END

  -- put the crosspoint SURFACE_CLIP_EPSILON units on the near side
  IF (t1 < t2) THEN
  BEGIN
    idist = 1 / (t1 - t2); side_ = 1;
    frac2 = (t1 + offset_ + 0.125e0) * idist;
    frac = (t1 - offset_ + 0.125e0) * idist;
  END
  ELSE IF (t1 > t2) THEN
  BEGIN
    idist = 1 / (t1 - t2); side_ = 0;
    frac2 = (t1 - offset_ - 0.125e0) * idist;
    frac = (t1 + offset_ + 0.125e0) * idist;
  END
  ELSE
  BEGIN
    side_ = 0; frac = 1; frac2 = 0;
  END

  ccn = IIF(side_ = 0, cc0, cc1); ccf = IIF(side_ = 0, cc1, cc0);
  -- move up to the node (an empty leaf on either side needs no visit)
  IF (frac < 0) THEN frac = 0;
  IF (frac > 1) THEN frac = 1;
  midf = p1f + (p2f - p1f) * frac;
  mx = p1x + frac * (p2x - p1x); my = p1y + frac * (p2y - p1y); mz = p1z + frac * (p2z - p1z);
  IF (NOT (IIF(side_ = 0, c0, c1) < 0 AND BIN_AND(ccn, mask) = 0)) THEN
  EXECUTE PROCEDURE rhc(IIF(side_ = 0, c0, c1), p1f, midf, p1x, p1y, p1z, mx, my, mz, s1x, s1y, s1z, s2x, s2y, s2z, mnx, mny, mnz, mxx, mxy, mxz, ex, ey, ez, mask, ispoint,
                        fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid)
    RETURNING_VALUES fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid;

  -- go past the node
  IF (frac2 < 0) THEN frac2 = 0;
  IF (frac2 > 1) THEN frac2 = 1;
  midf = p1f + (p2f - p1f) * frac2;
  mx = p1x + frac2 * (p2x - p1x); my = p1y + frac2 * (p2y - p1y); mz = p1z + frac2 * (p2z - p1z);
  IF (NOT (IIF(side_ = 0, c1, c0) < 0 AND BIN_AND(ccf, mask) = 0)) THEN
  EXECUTE PROCEDURE rhc(IIF(side_ = 0, c1, c0), midf, p2f, mx, my, mz, p2x, p2y, p2z, s1x, s1y, s1z, s2x, s2y, s2z, mnx, mny, mnz, mxx, mxy, mxz, ex, ey, ez, mask, ispoint,
                        fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid)
    RETURNING_VALUES fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid;
  SUSPEND;
END^

-- CM_BoxTrace against one BSP model whose origin is at (ox, oy, oz).
CREATE OR ALTER PROCEDURE trace_hull (
  head INTEGER,
  ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  mnx DOUBLE PRECISION, mny DOUBLE PRECISION, mnz DOUBLE PRECISION,
  mxx DOUBLE PRECISION, mxy DOUBLE PRECISION, mxz DOUBLE PRECISION,
  x1 DOUBLE PRECISION, y1 DOUBLE PRECISION, z1 DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION, z2 DOUBLE PRECISION,
  mask INTEGER)
RETURNS (
  fraction DOUBLE PRECISION,
  ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION,
  nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION,
  sflags INTEGER, contents INTEGER, allsolid SMALLINT, startsolid SMALLINT)
AS
DECLARE pdist DOUBLE PRECISION; DECLARE ispoint SMALLINT;
DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE hz DOUBLE PRECISION;
BEGIN
  ispoint = IIF(mnx = 0 AND mny = 0 AND mnz = 0 AND mxx = 0 AND mxy = 0 AND mxz = 0, 1, 0);
  hx = MAXVALUE(-mnx, mxx); hy = MAXVALUE(-mny, mxy); hz = MAXVALUE(-mnz, mxz);
  EXECUTE PROCEDURE rhc(head, 0, 1, x1 - ox, y1 - oy, z1 - oz, x2 - ox, y2 - oy, z2 - oz, x1 - ox, y1 - oy, z1 - oz, x2 - ox, y2 - oy, z2 - oz, mnx, mny, mnz, mxx, mxy, mxz, hx, hy, hz, mask, ispoint,
                        1, 0, 0, 0, 0, 0, 0, 0, 0)
    RETURNING_VALUES fraction, nx, ny, nz, pdist, sflags, contents, allsolid, startsolid;
  IF (fraction >= 1) THEN
  BEGIN
    fraction = 1; ex = x2; ey = y2; ez = z2;
  END
  ELSE
  BEGIN
    ex = x1 + fraction * (x2 - x1); ey = y1 + fraction * (y2 - y1); ez = z1 + fraction * (z2 - z1);
  END
  IF (allsolid = 1) THEN
  BEGIN
    startsolid = 1; fraction = 0; ex = x1; ey = y1; ez = z1;
  END
  SUSPEND;
END^

-- A segment against a box (bmins..bmaxs, absolute). Slab test; the hit
-- normal is the axis of the entered face.
CREATE OR ALTER PROCEDURE trace_box (
  bminx DOUBLE PRECISION, bminy DOUBLE PRECISION, bminz DOUBLE PRECISION,
  bmaxx DOUBLE PRECISION, bmaxy DOUBLE PRECISION, bmaxz DOUBLE PRECISION,
  x1 DOUBLE PRECISION, y1 DOUBLE PRECISION, z1 DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION, z2 DOUBLE PRECISION)
RETURNS (
  fraction DOUBLE PRECISION,
  ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION,
  nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION,
  startsolid SMALLINT)
AS
DECLARE tmin DOUBLE PRECISION = 0; DECLARE tmax DOUBLE PRECISION = 1;
DECLARE dx DOUBLE PRECISION; DECLARE dy DOUBLE PRECISION; DECLARE dz DOUBLE PRECISION;
DECLARE ta DOUBLE PRECISION; DECLARE tb DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
DECLARE axis SMALLINT = 0; DECLARE sgn DOUBLE PRECISION = 0;
BEGIN
  fraction = 1; ex = x2; ey = y2; ez = z2; nx = 0; ny = 0; nz = 0; startsolid = 0;
  IF (x1 >= bminx AND x1 <= bmaxx AND y1 >= bminy AND y1 <= bmaxy AND z1 >= bminz AND z1 <= bmaxz) THEN
  BEGIN
    startsolid = 1; fraction = 0; ex = x1; ey = y1; ez = z1;
    SUSPEND;
    EXIT;
  END
  dx = x2 - x1; dy = y2 - y1; dz = z2 - z1;
  IF (ABS(dx) < 1e-9) THEN
  BEGIN
    IF (x1 < bminx OR x1 > bmaxx) THEN BEGIN SUSPEND; EXIT; END
  END
  ELSE
  BEGIN
    ta = (bminx - x1) / dx; tb = (bmaxx - x1) / dx;
    IF (ta > tb) THEN BEGIN t = ta; ta = tb; tb = t; END
    IF (ta > tmin) THEN BEGIN tmin = ta; axis = 1; sgn = IIF(dx > 0, -1, 1); END
    IF (tb < tmax) THEN tmax = tb;
  END
  IF (ABS(dy) < 1e-9) THEN
  BEGIN
    IF (y1 < bminy OR y1 > bmaxy) THEN BEGIN SUSPEND; EXIT; END
  END
  ELSE
  BEGIN
    ta = (bminy - y1) / dy; tb = (bmaxy - y1) / dy;
    IF (ta > tb) THEN BEGIN t = ta; ta = tb; tb = t; END
    IF (ta > tmin) THEN BEGIN tmin = ta; axis = 2; sgn = IIF(dy > 0, -1, 1); END
    IF (tb < tmax) THEN tmax = tb;
  END
  IF (ABS(dz) < 1e-9) THEN
  BEGIN
    IF (z1 < bminz OR z1 > bmaxz) THEN BEGIN SUSPEND; EXIT; END
  END
  ELSE
  BEGIN
    ta = (bminz - z1) / dz; tb = (bmaxz - z1) / dz;
    IF (ta > tb) THEN BEGIN t = ta; ta = tb; tb = t; END
    IF (ta > tmin) THEN BEGIN tmin = ta; axis = 3; sgn = IIF(dz > 0, -1, 1); END
    IF (tb < tmax) THEN tmax = tb;
  END
  IF (tmin > tmax OR axis = 0 OR tmin >= 1) THEN BEGIN SUSPEND; EXIT; END
  fraction = MAXVALUE(0, tmin - 0.03125e0 / MAXVALUE(1e-3, SQRT(dx * dx + dy * dy + dz * dz)));
  ex = x1 + fraction * dx; ey = y1 + fraction * dy; ez = z1 + fraction * dz;
  IF (axis = 1) THEN nx = sgn; ELSE IF (axis = 2) THEN ny = sgn; ELSE nz = sgn;
  SUSPEND;
END^

-- SV_Trace: an entity's box (its mins/maxs) from p1 to p2 through the world,
-- the brush models and the box entities whose contents are in `mask`.
-- `mover` may be NULL for a trace with no owner. hit_ent 0 = the world.
CREATE OR ALTER PROCEDURE trace_move (
  mover INTEGER,
  mnx DOUBLE PRECISION, mny DOUBLE PRECISION, mnz DOUBLE PRECISION,
  mxx DOUBLE PRECISION, mxy DOUBLE PRECISION, mxz DOUBLE PRECISION,
  x1 DOUBLE PRECISION, y1 DOUBLE PRECISION, z1 DOUBLE PRECISION,
  x2 DOUBLE PRECISION, y2 DOUBLE PRECISION, z2 DOUBLE PRECISION,
  mask INTEGER)
RETURNS (
  fraction DOUBLE PRECISION,
  ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION,
  nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION,
  sflags INTEGER, contents INTEGER, allsolid SMALLINT, startsolid SMALLINT,
  hit_ent INTEGER)
AS
DECLARE head INTEGER;
DECLARE f DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION;
DECLARE tsf INTEGER; DECLARE tct INTEGER; DECLARE tas SMALLINT; DECLARE tss SMALLINT;
DECLARE eid INTEGER; DECLARE emid INTEGER; DECLARE esolid SMALLINT; DECLARE eowner INTEGER; DECLARE ehp INTEGER; DECLARE edead SMALLINT;
DECLARE eox DOUBLE PRECISION; DECLARE eoy DOUBLE PRECISION; DECLARE eoz DOUBLE PRECISION;
DECLARE eminx DOUBLE PRECISION; DECLARE eminy DOUBLE PRECISION; DECLARE eminz DOUBLE PRECISION;
DECLARE emaxx DOUBLE PRECISION; DECLARE emaxy DOUBLE PRECISION; DECLARE emaxz DOUBLE PRECISION;
DECLARE bminx DOUBLE PRECISION; DECLARE bminy DOUBLE PRECISION; DECLARE bminz DOUBLE PRECISION;
DECLARE bmaxx DOUBLE PRECISION; DECLARE bmaxy DOUBLE PRECISION; DECLARE bmaxz DOUBLE PRECISION;
DECLARE mower INTEGER; DECLARE econt INTEGER;
DECLARE ep DOUBLE PRECISION; DECLARE eyaw DOUBLE PRECISION; DECLARE er DOUBLE PRECISION;
DECLARE m00 DOUBLE PRECISION; DECLARE m01 DOUBLE PRECISION; DECLARE m02 DOUBLE PRECISION;
DECLARE m10 DOUBLE PRECISION; DECLARE m11 DOUBLE PRECISION; DECLARE m12 DOUBLE PRECISION;
DECLARE m20 DOUBLE PRECISION; DECLARE m21 DOUBLE PRECISION; DECLARE m22 DOUBLE PRECISION;
DECLARE l1x DOUBLE PRECISION; DECLARE l1y DOUBLE PRECISION; DECLARE l1z DOUBLE PRECISION;
DECLARE l2x DOUBLE PRECISION; DECLARE l2y DOUBLE PRECISION; DECLARE l2z DOUBLE PRECISION;
DECLARE wnx DOUBLE PRECISION; DECLARE wny DOUBLE PRECISION; DECLARE wnz DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE trace_hull(0, 0, 0, 0, mnx, mny, mnz, mxx, mxy, mxz, x1, y1, z1, x2, y2, z2, mask)
    RETURNING_VALUES fraction, ex, ey, ez, nx, ny, nz, sflags, contents, allsolid, startsolid;
  hit_ent = 0;
  IF (allsolid = 1) THEN BEGIN SUSPEND; EXIT; END

  IF (mover IS NOT NULL) THEN SELECT e.owner_id FROM ents e WHERE e.id = :mover INTO mower;

  -- SV_ClipMoveToEntities: brush models (doors, plats, …) and box entities in the swept box
  bminx = MINVALUE(x1, ex) + mnx - 1; bminy = MINVALUE(y1, ey) + mny - 1; bminz = MINVALUE(z1, ez) + mnz - 1;
  bmaxx = MAXVALUE(x1, ex) + mxx + 1; bmaxy = MAXVALUE(y1, ey) + mxy + 1; bmaxz = MAXVALUE(z1, ez) + mxz + 1;
  -- (a rotated brush model's box is its model bounds swept by the rotation: grow by its size)
  FOR SELECT e.id, e.model_id, e.solid, e.owner_id, e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.health, e.deadflag, e.pitch, e.yaw, e.roll
        FROM ents e
       WHERE e.solid IN (2, 3, 4)
         AND (:mover IS NULL OR e.id <> :mover)
         AND e.x + e.maxx + IIF(e.solid = 4 AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0), e.maxx - e.minx, 0) >= :bminx
         AND e.x + e.minx - IIF(e.solid = 4 AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0), e.maxx - e.minx, 0) <= :bmaxx
         AND e.y + e.maxy + IIF(e.solid = 4 AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0), e.maxy - e.miny, 0) >= :bminy
         AND e.y + e.miny - IIF(e.solid = 4 AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0), e.maxy - e.miny, 0) <= :bmaxy
         AND e.z + e.maxz + IIF(e.solid = 4 AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0), e.maxz - e.minz, 0) >= :bminz
         AND e.z + e.minz - IIF(e.solid = 4 AND (e.pitch <> 0 OR e.yaw <> 0 OR e.roll <> 0), e.maxz - e.minz, 0) <= :bmaxz
        INTO eid, emid, esolid, eowner, eox, eoy, eoz, eminx, eminy, eminz, emaxx, emaxy, emaxz, ehp, edead, ep, eyaw, er
  DO
  BEGIN
    IF (mover IS NOT NULL AND (eowner = mover OR mower = eid)) THEN CONTINUE;   -- don't clip against own missiles / owner
    IF (esolid = 4) THEN
    BEGIN
      SELECT m.headnode FROM models m WHERE m.id = :emid INTO head;
      IF (head IS NULL) THEN CONTINUE;
      IF (ep = 0 AND eyaw = 0 AND er = 0) THEN
        EXECUTE PROCEDURE trace_hull(head, eox, eoy, eoz, mnx, mny, mnz, mxx, mxy, mxz, x1, y1, z1, x2, y2, z2, mask)
          RETURNING_VALUES f, tx, ty, tz, tnx, tny, tnz, tsf, tct, tas, tss;
      ELSE
      BEGIN
        -- CM_TransformedBoxTrace: rotate the segment into the model's space, the hit normal back out
        EXECUTE PROCEDURE angle_matrix(ep, eyaw, er) RETURNING_VALUES m00, m01, m02, m10, m11, m12, m20, m21, m22;
        l1x = m00 * (x1 - eox) + m10 * (y1 - eoy) + m20 * (z1 - eoz);
        l1y = m01 * (x1 - eox) + m11 * (y1 - eoy) + m21 * (z1 - eoz);
        l1z = m02 * (x1 - eox) + m12 * (y1 - eoy) + m22 * (z1 - eoz);
        l2x = m00 * (x2 - eox) + m10 * (y2 - eoy) + m20 * (z2 - eoz);
        l2y = m01 * (x2 - eox) + m11 * (y2 - eoy) + m21 * (z2 - eoz);
        l2z = m02 * (x2 - eox) + m12 * (y2 - eoy) + m22 * (z2 - eoz);
        EXECUTE PROCEDURE trace_hull(head, 0, 0, 0, mnx, mny, mnz, mxx, mxy, mxz, l1x, l1y, l1z, l2x, l2y, l2z, mask)
          RETURNING_VALUES f, tx, ty, tz, tnx, tny, tnz, tsf, tct, tas, tss;
        wnx = m00 * tnx + m01 * tny + m02 * tnz; wny = m10 * tnx + m11 * tny + m12 * tnz; wnz = m20 * tnx + m21 * tny + m22 * tnz;
        tnx = wnx; tny = wny; tnz = wnz;
        tx = x1 + f * (x2 - x1); ty = y1 + f * (y2 - y1); tz = z1 + f * (z2 - z1);
      END
      head = NULL;
    END
    ELSE
    BEGIN
      -- a box: CONTENTS_BODY while it lives, CONTENTS_CORPSE once it is a corpse
      econt = IIF(edead = 1 OR ehp <= 0, 67108864, 33554432);
      IF (BIN_AND(mask, econt) = 0) THEN CONTINUE;
      EXECUTE PROCEDURE trace_box(eox + eminx - mxx, eoy + eminy - mxy, eoz + eminz - mxz,
                                  eox + emaxx - mnx, eoy + emaxy - mny, eoz + emaxz - mnz,
                                  x1, y1, z1, x2, y2, z2)
        RETURNING_VALUES f, tx, ty, tz, tnx, tny, tnz, tss;
      tas = tss; tsf = 0; tct = econt;
    END
    IF (tas = 1 OR tss = 1 OR f < fraction) THEN
    BEGIN
      hit_ent = eid;
      IF (tas = 1) THEN allsolid = 1;
      IF (tss = 1) THEN startsolid = 1;
      IF (f < fraction) THEN
      BEGIN
        fraction = f; ex = tx; ey = ty; ez = tz; nx = tnx; ny = tny; nz = tnz; sflags = tsf; contents = tct;
      END
      IF (allsolid = 1) THEN
      BEGIN
        fraction = 0; ex = x1; ey = y1; ez = z1;
        SUSPEND;
        EXIT;
      END
    END
  END
  SUSPEND;
END^

-- SV_TestEntityPosition: is the entity's box inside something solid?
CREATE OR ALTER FUNCTION test_position (eid INTEGER, px DOUBLE PRECISION, py DOUBLE PRECISION, pz DOUBLE PRECISION)
RETURNS SMALLINT
AS
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION; DECLARE mask INTEGER;
DECLARE f DOUBLE PRECISION; DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION;
DECLARE tnx DOUBLE PRECISION; DECLARE tny DOUBLE PRECISION; DECLARE tnz DOUBLE PRECISION;
DECLARE tsf INTEGER; DECLARE tct INTEGER; DECLARE tas SMALLINT; DECLARE tss SMALLINT; DECLARE hit INTEGER;
BEGIN
  SELECT e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.clipmask FROM ents e WHERE e.id = :eid INTO mnx, mny, mnz, mxx, mxy, mxz, mask;
  EXECUTE PROCEDURE trace_move(eid, mnx, mny, mnz, mxx, mxy, mxz, px, py, pz, px, py, pz, mask)
    RETURNING_VALUES f, tx, ty, tz, tnx, tny, tnz, tsf, tct, tas, tss, hit;
  RETURN tss;
END^

-- SV_LinkEntity: remember the leaf and cluster of the origin and the clusters
-- the box touches (for the PVS test when drawing).
CREATE OR ALTER PROCEDURE link_ent (eid INTEGER)
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE lf INTEGER; DECLARE cl INTEGER; DECLARE c2 INTEGER; DECLARE lf2 INTEGER; DECLARE oldleaf INTEGER;
DECLARE lst VARCHAR(200) CHARACTER SET ASCII;
DECLARE i INTEGER;
BEGIN
  SELECT e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.leaf FROM ents e WHERE e.id = :eid AND (e.lx IS DISTINCT FROM e.x OR e.ly IS DISTINCT FROM e.y OR e.lz IS DISTINCT FROM e.z)
    INTO px, py, pz, mnx, mny, mnz, mxx, mxy, mxz, oldleaf;
  IF (px IS NULL) THEN EXIT;      -- not moved since the last link (or gone)
  lf = point_leaf(px, py, pz);
  IF (lf = oldleaf AND mnx <= 0 AND mxx >= 0 AND mny <= 0 AND mxy >= 0 AND mnz <= 0 AND mxz >= 0) THEN
  BEGIN
    -- a step that stays in the same leaf: the box's clusters are taken to be unchanged
    UPDATE ents e SET e.lx = :px, e.ly = :py, e.lz = :pz WHERE e.id = :eid;
    EXIT;
  END
  -- a brush model's origin is usually far outside its box: its leaf says nothing about it
  IF (mnx > 0 OR mxx < 0 OR mny > 0 OR mxy < 0 OR mnz > 0 OR mxz < 0) THEN
  BEGIN
    i = point_leaf(px + (mnx + mxx) / 2, py + (mny + mxy) / 2, pz + (mnz + mxz) / 2);
    SELECT l.cluster FROM leaves l WHERE l.id = :i INTO cl;
  END
  ELSE
    SELECT l.cluster FROM leaves l WHERE l.id = :lf INTO cl;
  cl = COALESCE(cl, -1);
  lst = ',' || IIF(cl >= 0, cl || ',', '');
  -- two opposite corners of the box (enough for the PVS test; Quake walks the tree)
  i = 0;
  WHILE (i < 4) DO
  BEGIN
    c2 = NULL;
    lf2 = point_leaf(px + IIF(i = 0, mnx, mxx), py + IIF(i = 0, mny, mxy), pz + IIF(i = 0, mnz, mxz));
    SELECT l.cluster FROM leaves l WHERE l.id = :lf2 INTO c2;
    IF (c2 >= 0 AND POSITION(',' || c2 || ',', lst) = 0 AND CHAR_LENGTH(lst) < 180) THEN lst = lst || c2 || ',';
    i = i + 3;
  END
  IF (lst = ',') THEN lst = NULL;
  UPDATE ents e SET e.leaf = :lf, e.cluster = :cl, e.clusters = :lst, e.lx = :px, e.ly = :py, e.lz = :pz, e.vis_cl = NULL WHERE e.id = :eid;
END^

-- PM_SetWaterLevel: water level 0 none, 1 feet, 2 waist, 3 eyes.
CREATE OR ALTER PROCEDURE check_water (eid INTEGER) RETURNS (waterlevel SMALLINT, watertype INTEGER)
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnz DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION; DECLARE vo DOUBLE PRECISION;
DECLARE c INTEGER;
BEGIN
  SELECT e.x, e.y, e.z, e.minz, e.maxz, IIF(e.viewheight <> 0, e.viewheight, (e.minz + e.maxz) / 2)
    FROM ents e WHERE e.id = :eid INTO px, py, pz, mnz, mxz, vo;
  waterlevel = 0; watertype = 0;
  c = point_contents(px, py, pz + mnz + 1);
  IF (BIN_AND(c, 56) <> 0) THEN
  BEGIN
    watertype = BIN_AND(c, 56); waterlevel = 1;
    c = point_contents(px, py, pz + (mnz + mxz) / 2);
    IF (BIN_AND(c, 56) <> 0) THEN
    BEGIN
      waterlevel = 2;
      c = point_contents(px, py, pz + vo);
      IF (BIN_AND(c, 56) <> 0) THEN waterlevel = 3;
    END
  END
  UPDATE ents e SET e.waterlevel = :waterlevel, e.watertype = :watertype WHERE e.id = :eid;
  SUSPEND;
END^

-- PM_ClipVelocity: slide along the plane. Returns blocked bits (1 floor, 2 step).
CREATE OR ALTER PROCEDURE clip_velocity (
  ix DOUBLE PRECISION, iy DOUBLE PRECISION, iz DOUBLE PRECISION,
  nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION, overbounce DOUBLE PRECISION)
RETURNS (ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION, blocked SMALLINT)
AS
DECLARE backoff DOUBLE PRECISION;
BEGIN
  blocked = 0;
  IF (nz > 0) THEN blocked = BIN_OR(blocked, 1);
  IF (nz = 0) THEN blocked = BIN_OR(blocked, 2);
  backoff = ix * nx + iy * ny + iz * nz;
  IF (backoff < 0) THEN backoff = backoff * overbounce; ELSE backoff = backoff / overbounce;
  ox = ix - nx * backoff; oy = iy - ny * backoff; oz = iz - nz * backoff;
  IF (ox > -0.1e0 AND ox < 0.1e0) THEN ox = 0;
  IF (oy > -0.1e0 AND oy < 0.1e0) THEN oy = 0;
  IF (oz > -0.1e0 AND oz < 0.1e0) THEN oz = 0;
  SUSPEND;
END^

SET TERM ; ^

-- the clip planes PM_SlideMove accumulates (PSQL has no arrays)
CREATE GLOBAL TEMPORARY TABLE clip_planes (
  k INTEGER NOT NULL,
  nx DOUBLE PRECISION NOT NULL, ny DOUBLE PRECISION NOT NULL, nz DOUBLE PRECISION NOT NULL
) ON COMMIT DELETE ROWS;

SET TERM ^ ;

-- PM_SlideMove: slide the entity along the world for `dt` seconds, bumping up
-- to four times. Returns blocked bits (1 floor, 2 wall) and the entity hit.
CREATE OR ALTER PROCEDURE fly_move (eid INTEGER, dt DOUBLE PRECISION)
RETURNS (blocked SMALLINT, hit_ent INTEGER)
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION;
DECLARE ovx DOUBLE PRECISION; DECLARE ovy DOUBLE PRECISION; DECLARE ovz DOUBLE PRECISION;
DECLARE pvx DOUBLE PRECISION; DECLARE pvy DOUBLE PRECISION; DECLARE pvz DOUBLE PRECISION;
DECLARE nvx DOUBLE PRECISION; DECLARE nvy DOUBLE PRECISION; DECLARE nvz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE flags INTEGER; DECLARE mask INTEGER;
DECLARE time_left DOUBLE PRECISION;
DECLARE bump INTEGER = 0;
DECLARE numplanes INTEGER = 0;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sfl INTEGER; DECLARE cts INTEGER; DECLARE allsolid SMALLINT; DECLARE startsolid SMALLINT;
DECLARE hit INTEGER; DECLARE hsolid SMALLINT;
DECLARE i INTEGER; DECLARE j INTEGER; DECLARE ok SMALLINT; DECLARE cb SMALLINT;
DECLARE qx DOUBLE PRECISION; DECLARE qy DOUBLE PRECISION; DECLARE qz DOUBLE PRECISION;
DECLARE ax DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE az DOUBLE PRECISION;
DECLARE bx DOUBLE PRECISION; DECLARE by_ DOUBLE PRECISION; DECLARE bz DOUBLE PRECISION;
DECLARE d DOUBLE PRECISION;
BEGIN
  blocked = 0; hit_ent = 0;
  SELECT e.x, e.y, e.z, e.vx, e.vy, e.vz, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.flags, e.clipmask
    FROM ents e WHERE e.id = :eid INTO px, py, pz, vx, vy, vz, mnx, mny, mnz, mxx, mxy, mxz, flags, mask;
  ovx = vx; ovy = vy; ovz = vz; pvx = vx; pvy = vy; pvz = vz;
  time_left = dt;
  DELETE FROM clip_planes;

  WHILE (bump < 4) DO
  BEGIN
    IF (vx = 0 AND vy = 0 AND vz = 0) THEN LEAVE;
    EXECUTE PROCEDURE trace_move(eid, mnx, mny, mnz, mxx, mxy, mxz, px, py, pz,
                                 px + time_left * vx, py + time_left * vy, pz + time_left * vz, mask)
      RETURNING_VALUES f, ex, ey, ez, nx, ny, nz, sfl, cts, allsolid, startsolid, hit;
    IF (allsolid = 1) THEN
    BEGIN
      vx = 0; vy = 0; vz = 0; blocked = 3;
      LEAVE;
    END
    IF (f > 0) THEN
    BEGIN
      px = ex; py = ey; pz = ez;
      ovx = vx; ovy = vy; ovz = vz;
      numplanes = 0;
      DELETE FROM clip_planes;
    END
    IF (f = 1) THEN LEAVE;

    hit_ent = hit;
    IF (nz > 0.7e0) THEN
    BEGIN
      blocked = BIN_OR(blocked, 1);
      SELECT e.solid FROM ents e WHERE e.id = :hit INTO hsolid;
      IF (hit = 0 OR hsolid = 4) THEN flags = BIN_OR(flags, 512);   -- FL_ONGROUND
    END
    IF (nz = 0) THEN blocked = BIN_OR(blocked, 2);
    -- SV_Impact: touch
    UPDATE ents e SET e.x = :px, e.y = :py, e.z = :pz, e.vx = :vx, e.vy = :vy, e.vz = :vz, e.flags = :flags WHERE e.id = :eid;
    EXECUTE PROCEDURE impact(eid, hit, sfl);
    IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid)) THEN EXIT;   -- removed by its touch
    SELECT e.x, e.y, e.z, e.vx, e.vy, e.vz, e.flags FROM ents e WHERE e.id = :eid INTO px, py, pz, vx, vy, vz, flags;

    time_left = time_left - time_left * f;
    IF (numplanes >= 5) THEN
    BEGIN
      vx = 0; vy = 0; vz = 0; blocked = 3;
      LEAVE;
    END
    INSERT INTO clip_planes (k, nx, ny, nz) VALUES (:numplanes, :nx, :ny, :nz);
    numplanes = numplanes + 1;

    -- modify original_velocity so it parallels all of the clip planes
    i = 0; ok = 0;
    WHILE (i < numplanes) DO
    BEGIN
      SELECT c.nx, c.ny, c.nz FROM clip_planes c WHERE c.k = :i INTO ax, ay, az;
      EXECUTE PROCEDURE clip_velocity(ovx, ovy, ovz, ax, ay, az, 1.001e0) RETURNING_VALUES nvx, nvy, nvz, cb;
      j = 0; ok = 1;
      WHILE (j < numplanes) DO
      BEGIN
        IF (j <> i) THEN
        BEGIN
          SELECT c.nx, c.ny, c.nz FROM clip_planes c WHERE c.k = :j INTO bx, by_, bz;
          IF (nvx * bx + nvy * by_ + nvz * bz < 0) THEN
          BEGIN
            ok = 0;
            LEAVE;
          END
        END
        j = j + 1;
      END
      IF (ok = 1) THEN LEAVE;
      i = i + 1;
    END
    IF (ok = 1) THEN
    BEGIN
      vx = nvx; vy = nvy; vz = nvz;
    END
    ELSE
    BEGIN
      IF (numplanes <> 2) THEN
      BEGIN
        vx = 0; vy = 0; vz = 0;
        LEAVE;
      END
      -- go along the crease
      SELECT c.nx, c.ny, c.nz FROM clip_planes c WHERE c.k = 0 INTO ax, ay, az;
      SELECT c.nx, c.ny, c.nz FROM clip_planes c WHERE c.k = 1 INTO bx, by_, bz;
      qx = ay * bz - az * by_; qy = az * bx - ax * bz; qz = ax * by_ - ay * bx;
      d = qx * vx + qy * vy + qz * vz;
      vx = qx * d; vy = qy * d; vz = qz * d;
    END
    -- if the new velocity is against the original velocity, stop dead
    IF (vx * pvx + vy * pvy + vz * pvz <= 0) THEN
    BEGIN
      vx = 0; vy = 0; vz = 0;
      LEAVE;
    END
    bump = bump + 1;
  END
  UPDATE ents e SET e.x = :px, e.y = :py, e.z = :pz, e.vx = :vx, e.vy = :vy, e.vz = :vz, e.flags = :flags WHERE e.id = :eid;
  SUSPEND;
END^

-- SV_PushEntity: move by a vector, stopping at the first thing hit.
CREATE OR ALTER PROCEDURE push_entity (eid INTEGER, dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION)
RETURNS (fraction DOUBLE PRECISION, nx DOUBLE PRECISION, ny DOUBLE PRECISION, nz DOUBLE PRECISION,
         allsolid SMALLINT, startsolid SMALLINT, hit_ent INTEGER, sflags INTEGER)
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE cts INTEGER; DECLARE mask INTEGER;
BEGIN
  SELECT e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.clipmask
    FROM ents e WHERE e.id = :eid INTO px, py, pz, mnx, mny, mnz, mxx, mxy, mxz, mask;
  EXECUTE PROCEDURE trace_move(eid, mnx, mny, mnz, mxx, mxy, mxz, px, py, pz, px + dx, py + dy, pz + dz, mask)
    RETURNING_VALUES fraction, ex, ey, ez, nx, ny, nz, sflags, cts, allsolid, startsolid, hit_ent;
  UPDATE ents e SET e.x = :ex, e.y = :ey, e.z = :ez WHERE e.id = :eid;
  IF (fraction < 1) THEN EXECUTE PROCEDURE impact(eid, hit_ent, sflags);
  SUSPEND;
END^

-- PM_StepSlideMove for the player: slide, and if a wall stopped us try again
-- from one step (18 units) up, keeping that only if it lands on ground.
CREATE OR ALTER PROCEDURE walk_move (eid INTEGER, dt DOUBLE PRECISION)
AS
DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE oz DOUBLE PRECISION;
DECLARE ovx DOUBLE PRECISION; DECLARE ovy DOUBLE PRECISION; DECLARE ovz DOUBLE PRECISION;
DECLARE nsx DOUBLE PRECISION; DECLARE nsy DOUBLE PRECISION; DECLARE nsz DOUBLE PRECISION;
DECLARE nsvx DOUBLE PRECISION; DECLARE nsvy DOUBLE PRECISION; DECLARE nsvz DOUBLE PRECISION;
DECLARE clip SMALLINT; DECLARE hit INTEGER;
DECLARE oldonground SMALLINT; DECLARE flags INTEGER; DECLARE wl SMALLINT;
DECLARE f DOUBLE PRECISION; DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE sfl INTEGER;
BEGIN
  SELECT e.x, e.y, e.z, e.vx, e.vy, e.vz, e.flags, e.waterlevel FROM ents e WHERE e.id = :eid
    INTO ox, oy, oz, ovx, ovy, ovz, flags, wl;
  oldonground = IIF(BIN_AND(flags, 512) <> 0, 1, 0);
  UPDATE ents e SET e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
  EXECUTE PROCEDURE fly_move(eid, dt) RETURNING_VALUES clip, hit;
  IF (BIN_AND(clip, 2) = 0) THEN EXIT;                   -- move looks good
  IF (oldonground = 0 AND wl = 0) THEN EXIT;             -- don't stair up while jumping
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid)) THEN EXIT;

  SELECT e.x, e.y, e.z, e.vx, e.vy, e.vz FROM ents e WHERE e.id = :eid INTO nsx, nsy, nsz, nsvx, nsvy, nsvz;
  -- try moving up and forward
  UPDATE ents e SET e.x = :ox, e.y = :oy, e.z = :oz, e.vx = :ovx, e.vy = :ovy, e.vz = :ovz WHERE e.id = :eid;
  EXECUTE PROCEDURE push_entity(eid, 0, 0, 18) RETURNING_VALUES f, nx, ny, nz, als, sts, hit, sfl;
  UPDATE ents e SET e.vx = :ovx, e.vy = :ovy, e.vz = 0 WHERE e.id = :eid;
  EXECUTE PROCEDURE fly_move(eid, dt) RETURNING_VALUES clip, hit;
  -- press down the step height
  EXECUTE PROCEDURE push_entity(eid, 0, 0, -18 + ovz * dt) RETURNING_VALUES f, nx, ny, nz, als, sts, hit, sfl;
  IF (nz > 0.7e0 AND f < 1) THEN
  BEGIN
    UPDATE ents e SET e.flags = BIN_OR(e.flags, 512) WHERE e.id = :eid;
  END
  ELSE
  BEGIN
    -- the step didn't land on ground: use the move without it
    UPDATE ents e SET e.x = :nsx, e.y = :nsy, e.z = :nsz, e.vx = :nsvx, e.vy = :nsvy, e.vz = :nsvz WHERE e.id = :eid;
  END
END^

-- SV_movestep for bots: move horizontally, then settle onto the floor
-- within one step up or down. Returns 1 if the move was taken.
CREATE OR ALTER FUNCTION move_step (eid INTEGER, dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION)
RETURNS SMALLINT
AS
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE mnx DOUBLE PRECISION; DECLARE mny DOUBLE PRECISION; DECLARE mnz DOUBLE PRECISION;
DECLARE mxx DOUBLE PRECISION; DECLARE mxy DOUBLE PRECISION; DECLARE mxz DOUBLE PRECISION;
DECLARE flags INTEGER; DECLARE mask INTEGER; DECLARE wl SMALLINT;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE pnx DOUBLE PRECISION; DECLARE pny DOUBLE PRECISION; DECLARE pnz DOUBLE PRECISION;
DECLARE sfl INTEGER; DECLARE cts INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
BEGIN
  SELECT e.x, e.y, e.z, e.minx, e.miny, e.minz, e.maxx, e.maxy, e.maxz, e.flags, e.clipmask, e.waterlevel
    FROM ents e WHERE e.id = :eid INTO px, py, pz, mnx, mny, mnz, mxx, mxy, mxz, flags, mask, wl;
  nx = px + dx; ny = py + dy; nz = pz + dz;

  -- push down from a step height above the wished position
  nz = nz + 18;
  EXECUTE PROCEDURE trace_move(eid, mnx, mny, mnz, mxx, mxy, mxz, nx, ny, nz, nx, ny, nz - 36, mask)
    RETURNING_VALUES f, ex, ey, ez, pnx, pny, pnz, sfl, cts, als, sts, hit;
  IF (als = 1) THEN RETURN 0;
  IF (sts = 1) THEN
  BEGIN
    nz = nz - 18;
    EXECUTE PROCEDURE trace_move(eid, mnx, mny, mnz, mxx, mxy, mxz, nx, ny, nz, nx, ny, nz - 36, mask)
      RETURNING_VALUES f, ex, ey, ez, pnx, pny, pnz, sfl, cts, als, sts, hit;
    IF (als = 1 OR sts = 1) THEN RETURN 0;
  END
  -- don't walk into lava or slime
  IF (BIN_AND(point_contents(ex, ey, ez + mnz + 1), 24) <> 0) THEN RETURN 0;
  IF (f = 1) THEN
  BEGIN
    -- if the ground was pulled out, go ahead and fall
    IF (BIN_AND(flags, 1024) <> 0) THEN
    BEGIN
      UPDATE ents e SET e.x = e.x + :dx, e.y = e.y + :dy, e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :eid;
      EXECUTE PROCEDURE link_ent(eid);
      RETURN 1;
    END
    RETURN 0;                 -- walked off an edge
  END
  -- the move is ok
  UPDATE ents e SET e.x = :ex, e.y = :ey, e.z = :ez, e.flags = BIN_OR(BIN_AND(e.flags, BIN_NOT(1024)), 512) WHERE e.id = :eid;
  EXECUTE PROCEDURE link_ent(eid);
  RETURN 1;
END^

-- G_RunMissile / G_RunItem: gravity, fly, bounce or stop. Missiles fly straight.
CREATE OR ALTER PROCEDURE toss_move (eid INTEGER, dt DOUBLE PRECISION)
AS
DECLARE mt SMALLINT; DECLARE flags INTEGER;
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER; DECLARE sfl INTEGER;
DECLARE ox DOUBLE PRECISION; DECLARE oy DOUBLE PRECISION; DECLARE oz DOUBLE PRECISION; DECLARE cb SMALLINT;
DECLARE grav DOUBLE PRECISION; DECLARE wl SMALLINT; DECLARE wt INTEGER; DECLARE owl SMALLINT; DECLARE d DOUBLE PRECISION;
BEGIN
  SELECT e.movetype, e.flags, e.vx, e.vy, e.vz, e.gravity, e.waterlevel FROM ents e WHERE e.id = :eid INTO mt, flags, vx, vy, vz, grav, owl;
  IF (BIN_AND(flags, 512) <> 0 AND mt <> 9) THEN EXIT;       -- resting on the ground
  IF (mt IN (6, 10)) THEN vz = vz - (SELECT g.gravity FROM game g WHERE g.id = 1) * COALESCE(NULLIF(grav, 0), 1) * dt;
  UPDATE ents e SET e.vz = :vz, e.yaw = MOD(e.yaw + e.avel_yaw * :dt + 360, 360), e.pitch = MOD(e.pitch + e.avel_pitch * :dt + 360, 360) WHERE e.id = :eid;
  EXECUTE PROCEDURE push_entity(eid, vx * dt, vy * dt, vz * dt) RETURNING_VALUES f, nx, ny, nz, als, sts, hit, sfl;
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :eid)) THEN EXIT;
  IF (als = 1 AND mt IN (6, 10)) THEN
  BEGIN
    -- stuck in solid (a gib placed inside a wall): it rests rather than falling forever
    UPDATE ents e SET e.flags = BIN_OR(e.flags, 512), e.vx = 0, e.vy = 0, e.vz = 0, e.avel_yaw = 0, e.avel_pitch = 0 WHERE e.id = :eid;
    EXIT;
  END
  EXECUTE PROCEDURE link_ent(eid);
  IF (f < 1) THEN
  BEGIN
    IF (mt = 10) THEN
    BEGIN
      -- G_BounceMissile: reflect, keep 65 percent; stop when it has all but come to rest on a floor
      d = vx * nx + vy * ny + vz * nz;
      ox = (vx - 2 * d * nx) * 0.65e0; oy = (vy - 2 * d * ny) * 0.65e0; oz = (vz - 2 * d * nz) * 0.65e0;
      IF (nz > 0.2e0 AND SQRT(ox * ox + oy * oy + oz * oz) < 40) THEN
        UPDATE ents e SET e.flags = BIN_OR(e.flags, 512), e.vx = 0, e.vy = 0, e.vz = 0, e.avel_yaw = 0, e.avel_pitch = 0 WHERE e.id = :eid;
      ELSE
        UPDATE ents e SET e.vx = :ox, e.vy = :oy, e.vz = :oz WHERE e.id = :eid;
    END
    ELSE
    BEGIN
      EXECUTE PROCEDURE clip_velocity(vx, vy, vz, nx, ny, nz, 1) RETURNING_VALUES ox, oy, oz, cb;
      -- stop if on ground
      IF (nz > 0.7e0) THEN
        UPDATE ents e SET e.flags = BIN_OR(e.flags, 512), e.vx = 0, e.vy = 0, e.vz = 0, e.avel_yaw = 0, e.avel_pitch = 0 WHERE e.id = :eid;
      ELSE
        UPDATE ents e SET e.vx = :ox, e.vy = :oy, e.vz = :oz WHERE e.id = :eid;
    END
  END
  -- check for water transition
  IF (mt IN (6, 10)) THEN
  BEGIN
    EXECUTE PROCEDURE check_water(eid) RETURNING_VALUES wl, wt;
    IF (owl = 0 AND wl > 0) THEN
      INSERT INTO sound_events (id, tic, ent_id, chan, snd, vol, attn, x, y, z)
        SELECT NEXT VALUE FOR sound_seq, g.tic, :eid, 0, 'sound/player/watr_in.wav', 1, 1, e.x, e.y, e.z FROM ents e CROSS JOIN game g WHERE e.id = :eid AND g.id = 1;
  END
END^

SET TERM ; ^
