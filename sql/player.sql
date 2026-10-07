-- player.sql – bg_pmove.c, g_weapon.c, g_client.c and g_active.c: what the
-- client does each tic: the movement (ground, air and water moves, jumps,
-- the 18-unit step), the nine weapons, dying and respawning.

SET TERM ^ ;

-- the eye and the view vectors
CREATE OR ALTER PROCEDURE view_vectors
RETURNS (ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION,
         fx DOUBLE PRECISION, fy DOUBLE PRECISION, fz DOUBLE PRECISION,
         rx DOUBLE PRECISION, ry DOUBLE PRECISION, rz DOUBLE PRECISION,
         ux DOUBLE PRECISION, uy DOUBLE PRECISION, uz DOUBLE PRECISION)
AS
DECLARE yaw DOUBLE PRECISION; DECLARE pitch DOUBLE PRECISION;
DECLARE sy DOUBLE PRECISION; DECLARE cy DOUBLE PRECISION; DECLARE sp DOUBLE PRECISION; DECLARE cp DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.z + p.view_ofs, e.yaw, p.pitch FROM player p JOIN ents e ON e.id = p.ent_id WHERE p.id = 1 INTO ex, ey, ez, yaw, pitch;
  sy = SIN(yaw * 0.0174532925e0); cy = COS(yaw * 0.0174532925e0);
  sp = SIN(pitch * 0.0174532925e0); cp = COS(pitch * 0.0174532925e0);
  fx = cp * cy; fy = cp * sy; fz = -sp;
  rx = sy; ry = -cy; rz = 0;
  ux = sp * cy; uy = sp * sy; uz = cp;
  SUSPEND;
END^

-- the eye and forward vector of any player or bot (the bots aim from here)
CREATE OR ALTER PROCEDURE eye_of (eid INTEGER)
RETURNS (ex DOUBLE PRECISION, ey DOUBLE PRECISION, ez DOUBLE PRECISION, fx DOUBLE PRECISION, fy DOUBLE PRECISION, fz DOUBLE PRECISION)
AS
DECLARE yaw DOUBLE PRECISION; DECLARE pitch DOUBLE PRECISION;
BEGIN
  SELECT e.x, e.y, e.z + e.viewheight, e.yaw, e.pitch FROM ents e WHERE e.id = :eid INTO ex, ey, ez, yaw, pitch;
  fx = COS(pitch * 0.0174532925e0) * COS(yaw * 0.0174532925e0); fy = COS(pitch * 0.0174532925e0) * SIN(yaw * 0.0174532925e0); fz = -SIN(pitch * 0.0174532925e0);
  SUSPEND;
END^

-- Bullet_Fire / ShotgunPattern: `cnt` traces 8192 units out, spread in Q3's units
CREATE OR ALTER PROCEDURE fire_bullets (shooter INTEGER, cnt INTEGER,
  ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, spread DOUBLE PRECISION, dmg INTEGER, mod_ SMALLINT)
AS
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION;
DECLARE ux DOUBLE PRECISION; DECLARE uy DOUBLE PRECISION; DECLARE uz DOUBLE PRECISION;
DECLARE ax DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION; DECLARE az DOUBLE PRECISION; DECLARE al DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE hz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
DECLARE i INTEGER = 0; DECLARE r DOUBLE PRECISION; DECLARE u DOUBLE PRECISION; DECLARE a DOUBLE PRECISION;
DECLARE td SMALLINT; DECLARE hp INTEGER; DECLARE hits INTEGER = 0;
DECLARE water SMALLINT; DECLARE sw INTEGER; DECLARE dw INTEGER;
DECLARE wx DOUBLE PRECISION; DECLARE wy DOUBLE PRECISION; DECLARE wz DOUBLE PRECISION; DECLARE wf DOUBLE PRECISION;
BEGIN
  SELECT g.has_water FROM game g WHERE g.id = 1 INTO water;
  IF (water = 1) THEN sw = BIN_AND(point_contents(ox, oy, oz), 32);
  al = vlen(dx, dy, dz);
  IF (al = 0) THEN EXIT;
  dx = dx / al; dy = dy / al; dz = dz / al;
  rx = dy; ry = -dx; rz = 0;
  al = vlen(rx, ry, rz);
  IF (al < 1e-6) THEN BEGIN rx = 1; ry = 0; rz = 0; al = 1; END
  rx = rx / al; ry = ry / al; rz = rz / al;
  ux = ry * dz - rz * dy; uy = rz * dx - rx * dz; uz = rx * dy - ry * dx;
  WHILE (i < cnt) DO
  BEGIN
    a = RAND() * 6.2831853e0;
    r = COS(a) * crand() * spread * 16; u = SIN(a) * crand() * spread * 16;
    ax = dx * 131072 + r * rx + u * ux; ay = dy * 131072 + r * ry + u * uy; az = dz * 131072 + r * rz + u * uz;
    EXECUTE PROCEDURE trace_move(shooter, 0, 0, 0, 0, 0, 0, ox, oy, oz, ox + ax, oy + ay, oz + az, 100663297)
      RETURNING_VALUES f, hx, hy, hz, nx, ny, nz, sf, ct, als, sts, hit;
    IF (f < 1) THEN
    BEGIN
      td = 0;
      IF (hit > 0) THEN SELECT e.takedamage, e.health FROM ents e WHERE e.id = :hit INTO td, hp;
      IF (td > 0) THEN
      BEGIN
        IF (hits = 0) THEN EXECUTE PROCEDURE fx(3, hx, hy, hz, 0, 0, 0, dmg);
        hits = hits + 1;
        EXECUTE PROCEDURE t_damage(hit, shooter, shooter, dmg, dmg, 0, mod_);
      END
      ELSE IF (BIN_AND(sf, 4) = 0 AND (cnt = 1 OR MOD(i, 3) = 0)) THEN
        EXECUTE PROCEDURE fx(IIF(cnt > 1, 11, 1), hx, hy, hz, nx, ny, nz, 0);
    END
    -- bubbles where the shot went through water: all the way, from the muzzle up to the surface, or from
    -- the surface down to where it hit (the surface a trace against water alone)
    IF (water = 1) THEN
    BEGIN
      dw = BIN_AND(point_contents(hx, hy, hz), 32);
      IF (sw <> 0 AND dw <> 0) THEN EXECUTE PROCEDURE fx(15, ox, oy, oz, hx, hy, hz, 0);
      ELSE IF (sw <> 0 OR dw <> 0) THEN
      BEGIN
        IF (sw <> 0) THEN EXECUTE PROCEDURE trace_move(shooter, 0, 0, 0, 0, 0, 0, hx, hy, hz, ox, oy, oz, 32) RETURNING_VALUES wf, wx, wy, wz, nx, ny, nz, sf, ct, als, sts, hit;
        ELSE EXECUTE PROCEDURE trace_move(shooter, 0, 0, 0, 0, 0, 0, ox, oy, oz, hx, hy, hz, 32) RETURNING_VALUES wf, wx, wy, wz, nx, ny, nz, sf, ct, als, sts, hit;
        IF (sw <> 0) THEN EXECUTE PROCEDURE fx(15, ox, oy, oz, wx, wy, wz, 0);
        ELSE EXECUTE PROCEDURE fx(15, wx, wy, wz, hx, hy, hz, 0);
      END
    END
    i = i + 1;
  END
END^

-- Weapon_RailgunFire: a slug through everything in its path
CREATE OR ALTER PROCEDURE fire_rail (shooter INTEGER, ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, dmg INTEGER)
AS
DECLARE f DOUBLE PRECISION; DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE hz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER;
DECLARE sx DOUBLE PRECISION; DECLARE sy DOUBLE PRECISION; DECLARE sz DOUBLE PRECISION; DECLARE ignore INTEGER; DECLARE i INTEGER = 0;
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION; DECLARE dl DOUBLE PRECISION;
DECLARE hits INTEGER = 0; DECLARE acc INTEGER;
BEGIN
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN EXIT;
  dx = dx / dl; dy = dy / dl; dz = dz / dl;
  ex = ox + dx * 8192; ey = oy + dy * 8192; ez = oz + dz * 8192;
  sx = ox; sy = oy; sz = oz; ignore = shooter;
  WHILE (i < 10) DO
  BEGIN
    EXECUTE PROCEDURE trace_move(ignore, 0, 0, 0, 0, 0, 0, sx, sy, sz, ex, ey, ez, 100663297)
      RETURNING_VALUES f, hx, hy, hz, nx, ny, nz, sf, ct, als, sts, hit;
    IF (hit > 0 AND EXISTS (SELECT 1 FROM ents e WHERE e.id = :hit AND e.takedamage > 0)) THEN
    BEGIN
      -- LogAccuracyHit: a player or a bot, alive
      IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :hit AND e.classname IN ('player', 'bot') AND e.health > 0 AND e.id <> :shooter)) THEN hits = hits + 1;
      EXECUTE PROCEDURE t_damage(hit, shooter, shooter, dmg, dmg, 0, 17);
      -- continue from just past the hit, ignoring what we just shot
      ignore = hit;
      sx = hx + dx * 8; sy = hy + dy * 8; sz = hz + dz * 8;
      i = i + 1;
      CONTINUE;
    END
    LEAVE;
  END
  EXECUTE PROCEDURE fx(4, ox, oy, oz, hx, hy, hz, 0);
  -- two hits in a row, impressive (a miss starts the count again)
  IF (hits = 0) THEN UPDATE ents e SET e.rail_hits = 0 WHERE e.id = :shooter;
  ELSE
  BEGIN
    UPDATE ents e SET e.rail_hits = e.rail_hits + :hits WHERE e.id = :shooter RETURNING e.rail_hits INTO acc;
    IF (acc >= 2) THEN
    BEGIN
      UPDATE ents e SET e.rail_hits = e.rail_hits - 2 WHERE e.id = :shooter;
      EXECUTE PROCEDURE give_award(shooter, 2);
    END
  END
END^

-- Weapon_LightningFire: 768 units, 8 damage, the beam drawn by the browser
CREATE OR ALTER PROCEDURE fire_lightning (shooter INTEGER, ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, dmg INTEGER)
AS
DECLARE f DOUBLE PRECISION; DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE hz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER; DECLARE dl DOUBLE PRECISION;
BEGIN
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN EXIT;
  EXECUTE PROCEDURE trace_move(shooter, 0, 0, 0, 0, 0, 0, ox, oy, oz, ox + dx / dl * 768, oy + dy / dl * 768, oz + dz / dl * 768, 100663297)
    RETURNING_VALUES f, hx, hy, hz, nx, ny, nz, sf, ct, als, sts, hit;
  EXECUTE PROCEDURE fx(12, ox, oy, oz, hx, hy, hz, shooter);
  IF (f < 1 AND hit > 0 AND EXISTS (SELECT 1 FROM ents e WHERE e.id = :hit AND e.takedamage > 0)) THEN
  BEGIN
    EXECUTE PROCEDURE t_damage(hit, shooter, shooter, dmg, dmg, 0, 16);
    EXECUTE PROCEDURE snd_at(hx, hy, hz, 'sound/weapons/lightning/lg_hit' || TRIM(CASE CAST(FLOOR(RAND() * 3) AS INTEGER) WHEN 0 THEN '' WHEN 1 THEN '2' ELSE '3' END) || '.wav', 1, 1);
  END
  ELSE IF (f < 1 AND BIN_AND(sf, 4) = 0) THEN EXECUTE PROCEDURE fx(7, hx, hy, hz, nx, ny, nz, 4);
END^

-- Weapon_Gauntlet: 32 units, 50 damage
CREATE OR ALTER FUNCTION fire_gauntlet (shooter INTEGER, ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION) RETURNS SMALLINT
AS
DECLARE f DOUBLE PRECISION; DECLARE hx DOUBLE PRECISION; DECLARE hy DOUBLE PRECISION; DECLARE hz DOUBLE PRECISION;
DECLARE nx DOUBLE PRECISION; DECLARE ny DOUBLE PRECISION; DECLARE nz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER; DECLARE dl DOUBLE PRECISION;
BEGIN
  dl = vlen(dx, dy, dz);
  IF (dl = 0) THEN RETURN 0;
  EXECUTE PROCEDURE trace_move(shooter, -15, -15, -15, 15, 15, 15, ox, oy, oz, ox + dx / dl * 32, oy + dy / dl * 32, oz + dz / dl * 32, 100663297)
    RETURNING_VALUES f, hx, hy, hz, nx, ny, nz, sf, ct, als, sts, hit;
  IF (f < 1 AND hit > 0 AND EXISTS (SELECT 1 FROM ents e WHERE e.id = :hit AND e.takedamage > 0 AND e.health > 0)) THEN
  BEGIN
    EXECUTE PROCEDURE fx(3, hx, hy, hz, 0, 0, 0, 50);
    EXECUTE PROCEDURE t_damage(hit, shooter, shooter, 50, 50, 0, 1);
    RETURN 1;
  END
  RETURN 0;
END^

-- the weapon's muzzle: 14 forward of the eye (CalcMuzzlePoint)
CREATE OR ALTER PROCEDURE muzzle
RETURNS (mx DOUBLE PRECISION, my DOUBLE PRECISION, mz DOUBLE PRECISION, fx DOUBLE PRECISION, fy DOUBLE PRECISION, fz DOUBLE PRECISION,
         rx DOUBLE PRECISION, ry DOUBLE PRECISION, rz DOUBLE PRECISION)
AS
DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE ux DOUBLE PRECISION; DECLARE uy DOUBLE PRECISION; DECLARE uz DOUBLE PRECISION;
BEGIN
  EXECUTE PROCEDURE view_vectors RETURNING_VALUES ex, ey, ez, fx, fy, fz, rx, ry, rz, ux, uy, uz;
  mx = ex + fx * 14; my = ey + fy * 14; mz = ez + fz * 14;
  SUSPEND;
END^

-- fire the weapon `w` of any shooter from (ox..) toward (dx..) – the player and the bots share this
CREATE OR ALTER PROCEDURE fire_weapon (shooter INTEGER, w INTEGER, ox DOUBLE PRECISION, oy DOUBLE PRECISION, oz DOUBLE PRECISION,
  dx DOUBLE PRECISION, dy DOUBLE PRECISION, dz DOUBLE PRECISION, vol DOUBLE PRECISION)
AS
DECLARE h SMALLINT;
BEGIN
  IF (w = 1) THEN
  BEGIN
    h = fire_gauntlet(shooter, ox, oy, oz, dx, dy, dz);
    EXECUTE PROCEDURE snd(shooter, 1, IIF(h = 1, 'sound/weapons/melee/fstatck.wav', 'sound/weapons/melee/fstrun.wav'), vol, 1);
  END
  ELSE IF (w = 2) THEN
  BEGIN
    EXECUTE PROCEDURE fire_bullets(shooter, 1, ox, oy, oz, dx, dy, dz, 200, 7, 2);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/machinegun/machgf' || CAST(1 + FLOOR(RAND() * 4) AS INTEGER) || 'b.wav', vol, 1);
  END
  ELSE IF (w = 4) THEN
  BEGIN
    EXECUTE PROCEDURE fire_bullets(shooter, 11, ox, oy, oz, dx, dy, dz, 700, 10, 3);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/shotgun/sshotf1b.wav', vol, 1);
  END
  ELSE IF (w = 8) THEN
  BEGIN
    EXECUTE PROCEDURE launch_grenade(shooter, ox, oy, oz, dx, dy, dz);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/grenade/grenlf1a.wav', vol, 1);
  END
  ELSE IF (w = 16) THEN
  BEGIN
    EXECUTE PROCEDURE launch_missile(shooter, 'rocket', 'models/ammo/rocket/rocket.md3', ox, oy, oz, dx, dy, dz, 900, 100, 100, 120, 16, 10);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/rocket/rocklf1a.wav', vol, 1);
  END
  ELSE IF (w = 32) THEN
  BEGIN
    EXECUTE PROCEDURE fire_lightning(shooter, ox, oy, oz, dx, dy, dz, 8);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/lightning/lg_fire.wav', vol, 1);
  END
  ELSE IF (w = 64) THEN
  BEGIN
    EXECUTE PROCEDURE fire_rail(shooter, ox, oy, oz, dx, dy, dz, 100);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/railgun/railgf1a.wav', vol, 1);
  END
  ELSE IF (w = 128) THEN
  BEGIN
    EXECUTE PROCEDURE launch_missile(shooter, 'plasma', 'sprites/plasmaa', ox, oy, oz, dx, dy, dz, 2000, 20, 15, 20, 8, 10);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/plasma/hyprbf1a.wav', vol, 1);
  END
  ELSE IF (w = 256) THEN
  BEGIN
    EXECUTE PROCEDURE launch_missile(shooter, 'bfg', 'models/weaphits/bfg.md3', ox, oy, oz, dx, dy, dz, 2000, 100, 100, 120, 64, 10);
    EXECUTE PROCEDURE snd(shooter, 1, 'sound/weapons/rocket/rocklf1a.wav', vol, 1);
  END
END^

-- the firing time of a weapon in seconds (bg_pmove's addTime)
CREATE OR ALTER FUNCTION fire_time (w INTEGER) RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN CASE w WHEN 1 THEN 0.4e0 WHEN 2 THEN 0.1e0 WHEN 4 THEN 1 WHEN 8 THEN 0.8e0 WHEN 16 THEN 0.8e0 WHEN 32 THEN 0.05e0 WHEN 64 THEN 1.5e0 WHEN 128 THEN 0.1e0 WHEN 256 THEN 0.2e0 ELSE 0.5e0 END;
END^

-- PM_Weapon: switching, firing when the button is held, the weapon is ready and there is ammo
CREATE OR ALTER PROCEDURE player_fire (btn SMALLINT)
AS
DECLARE pe INTEGER; DECLARE w INTEGER; DECLARE af DOUBLE PRECISION; DECLARE t DOUBLE PRECISION; DECLARE pw INTEGER; DECLARE wt DOUBLE PRECISION; DECLARE ws SMALLINT;
DECLARE mx DOUBLE PRECISION; DECLARE my DOUBLE PRECISION; DECLARE mz DOUBLE PRECISION;
DECLARE fx_ DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION;
DECLARE ak SMALLINT; DECLARE quad DOUBLE PRECISION; DECLARE haste DOUBLE PRECISION; DECLARE ft DOUBLE PRECISION;
BEGIN
  SELECT p.ent_id, p.weapon, p.attack_finished, p.quad_finished, p.haste_finished, p.pending_weapon, p.weapon_time, p.weaponstate
    FROM player p WHERE p.id = 1 INTO pe, w, af, quad, haste, pw, wt, ws;
  t = now_();
  -- a switch in progress: drop the old weapon, raise the new
  IF (pw <> 0) THEN
  BEGIN
    IF (ws = 2 AND t >= wt) THEN
    BEGIN
      UPDATE player p SET p.weapon = :pw, p.weaponstate = 3, p.weapon_time = :t + 0.25e0 WHERE p.id = 1;
      EXECUTE PROCEDURE snd(pe, 1, 'sound/weapons/change.wav', 1, 1);
    END
    ELSE IF (ws = 3 AND t >= wt) THEN
      UPDATE player p SET p.weaponstate = 0, p.pending_weapon = 0 WHERE p.id = 1;
    EXIT;
  END
  IF (btn = 0) THEN
  BEGIN
    UPDATE player p SET p.weapon_sound = 0 WHERE p.id = 1 AND p.weapon_sound <> 0;
    EXIT;
  END
  IF (af > t OR w = 0) THEN EXIT;

  -- ammo
  ak = weapon_ammo(w);
  IF (ak > 0 AND ammo_count(ak) <= 0) THEN
  BEGIN
    IF (EXISTS (SELECT 1 FROM player p WHERE p.id = 1 AND p.pain_finished < :t)) THEN
    BEGIN
      EXECUTE PROCEDURE snd(pe, 1, 'sound/weapons/noammo.wav', 1, 1);
      UPDATE player p SET p.pain_finished = :t + 0.5e0 WHERE p.id = 1;
    END
    UPDATE player p SET p.pending_weapon = best_weapon(), p.weaponstate = 2, p.weapon_time = :t + 0.2e0, p.attack_finished = :t + 0.3e0 WHERE p.id = 1 AND best_weapon() <> p.weapon;
    EXIT;
  END
  EXECUTE PROCEDURE muzzle RETURNING_VALUES mx, my, mz, fx_, fy, fz, rx, ry, rz;
  EXECUTE PROCEDURE fire_weapon(pe, w, mx, my, mz, fx_, fy, fz, 1);
  ft = fire_time(w);
  IF (haste > t) THEN ft = ft / 1.3e0;
  UPDATE player p SET p.attack_finished = :t + :ft, p.attack_start = :t, p.punchangle = -IIF(:w IN (16, 64, 4), 2, 0.5e0), p.weapon_sound = IIF(:w = 32, 1, 0),
         p.bullets = IIF(:ak = 2, p.bullets - 1, p.bullets), p.shells = IIF(:ak = 3, p.shells - 1, p.shells), p.grenades = IIF(:ak = 4, p.grenades - 1, p.grenades),
         p.rockets = IIF(:ak = 5, p.rockets - 1, p.rockets), p.lightning = IIF(:ak = 6, p.lightning - 1, p.lightning), p.slugs = IIF(:ak = 7, p.slugs - 1, p.slugs),
         p.cells = IIF(:ak = 8, p.cells - 1, p.cells), p.bfg = IIF(:ak = 9, p.bfg - 1, p.bfg) WHERE p.id = 1;
  EXECUTE PROCEDURE set_anims(pe, NULL, IIF(w = 1, 8, 7));
  IF (quad > t) THEN EXECUTE PROCEDURE snd(pe, 3, 'sound/items/damage3.wav', 1, 1);
END^

-- "weapon N" for a key 1..9, cycling (12 next, 14 previous), the holdable (13), and the cheats
CREATE OR ALTER PROCEDURE player_impulse (imp SMALLINT)
AS
DECLARE have INTEGER; DECLARE w INTEGER; DECLARE i INTEGER; DECLARE pe INTEGER; DECLARE hold SMALLINT; DECLARE t DOUBLE PRECISION;
DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION;
BEGIN
  SELECT p.weapons, COALESCE(NULLIF(p.pending_weapon, 0), p.weapon), p.ent_id, p.holdable FROM player p WHERE p.id = 1 INTO have, w, pe, hold;
  t = now_();
  IF (imp = 99) THEN                                                     -- give all
  BEGIN
    UPDATE player p SET p.weapons = 511, p.bullets = 200, p.shells = 200, p.rockets = 200, p.grenades = 200, p.lightning = 200, p.slugs = 200, p.cells = 200, p.bfg = 200, p.armor = 200 WHERE p.id = 1;
    UPDATE ents e SET e.health = 200 WHERE e.id = :pe;
    EXECUTE PROCEDURE sprint('Very impressive');
    EXIT;
  END
  IF (imp = 13) THEN                                                     -- use the holdable item
  BEGIN
    IF (hold = 1) THEN
    BEGIN
      EXECUTE PROCEDURE select_spawn(pe) RETURNING_VALUES x, y, z, yaw;
      EXECUTE PROCEDURE teleport_ent(pe, x, y, z, yaw);
    END
    ELSE IF (hold = 2) THEN
    BEGIN
      UPDATE ents e SET e.health = e.max_health + 25 WHERE e.id = :pe;
      EXECUTE PROCEDURE snd(pe, 3, 'sound/items/use_medkit.wav', 1, 1);
    END
    ELSE EXECUTE PROCEDURE snd(pe, 3, 'sound/items/use_nothing.wav', 1, 1);
    UPDATE player p SET p.holdable = 0 WHERE p.id = 1;
    EXIT;
  END
  IF (imp = 12 OR imp = 14) THEN                                         -- cycle to the next / previous weapon held with ammo
  BEGIN
    i = 0;
    WHILE (i < 9) DO
    BEGIN
      IF (imp = 12) THEN w = IIF(w >= 256, 1, w * 2); ELSE w = IIF(w <= 1, 256, w / 2);
      IF (BIN_AND(have, w) <> 0 AND (weapon_ammo(w) = 0 OR ammo_count(weapon_ammo(w)) > 0)) THEN LEAVE;
      i = i + 1;
    END
  END
  ELSE
  BEGIN
    w = CASE imp WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 4 WHEN 4 THEN 8 WHEN 5 THEN 16 WHEN 6 THEN 32 WHEN 7 THEN 64 WHEN 8 THEN 128 WHEN 9 THEN 256 ELSE 0 END;
    IF (w = 0 OR BIN_AND(have, w) = 0) THEN EXIT;
    IF (weapon_ammo(w) > 0 AND ammo_count(weapon_ammo(w)) <= 0) THEN EXIT;
  END
  IF (w <> (SELECT p.weapon FROM player p WHERE p.id = 1)) THEN
    UPDATE player p SET p.pending_weapon = :w, p.weaponstate = 2, p.weapon_time = :t + 0.2e0, p.weapon_sound = 0 WHERE p.id = 1;
END^

-- ClientSpawn: put the player at a spawn point with the starting inventory
CREATE OR ALTER PROCEDURE player_respawn
AS
DECLARE pe INTEGER; DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE t DOUBLE PRECISION;
BEGIN
  pe = player_ent();
  t = now_();
  EXECUTE PROCEDURE select_spawn(pe) RETURNING_VALUES x, y, z, yaw;
  UPDATE ents e SET e.x = :x, e.y = :y, e.z = :z + 9, e.yaw = COALESCE(:yaw, 0), e.pitch = 0, e.vx = 0, e.vy = 0, e.vz = 0,
         e.minx = -15, e.miny = -15, e.minz = -24, e.maxx = 15, e.maxy = 15, e.maxz = 32, e.viewheight = 26,
         e.solid = 3, e.movetype = 3, e.clipmask = 33619969, e.health = 125, e.max_health = 100, e.takedamage = 2, e.mass = 200,
         e.flags = BIN_AND(e.flags, 16), e.deadflag = 0, e.model_id = NULL, e.alpha = 1, e.legs_anim = 22, e.legs_time = :t, e.torso_anim = 11, e.torso_time = :t,
         e.weapon = 2, e.teleport_time = :t + 0.3e0, e.lx = NULL WHERE e.id = :pe;
  UPDATE player p SET p.armor = 0, p.bullets = 100, p.shells = 0, p.grenades = 0, p.rockets = 0, p.lightning = 0, p.slugs = 0, p.cells = 0, p.bfg = 0,
         p.weapons = 3, p.weapon = 2, p.pending_weapon = 0, p.weaponstate = 0, p.attack_finished = :t + 0.3e0, p.attack_start = 0, p.pain_finished = 0, p.punchangle = 0, p.view_ofs = 26, p.ducked = 0,
         p.dmg_take = 0, p.dmg_save = 0, p.dmg_time = -10, p.bonus_time = -10, p.quad_finished = 0, p.haste_finished = 0, p.invis_finished = 0, p.regen_finished = 0, p.enviro_finished = 0, p.flight_finished = 0,
         p.holdable = 0, p.jump_released = 1, p.air_finished = :t + 12, p.drown_dmg = 2, p.pitch = 0, p.stepz = 0, p.dead_time = 0, p.weapon_sound = 0, p.health_decay = :t + 1, p.spawn_protect = :t + 0.5e0 WHERE p.id = 1;
  EXECUTE PROCEDURE link_ent(pe);
  EXECUTE PROCEDURE snd_at(x, y, z, 'sound/world/telein.wav', 1, 1);
  EXECUTE PROCEDURE fx(5, x, y, z + 9, 0, 0, 0, 1);
END^

-- player_die: the obituary, the score, the corpse; the view falls with the body
CREATE OR ALTER PROCEDURE player_die (attacker INTEGER, mod_ SMALLINT)
AS
DECLARE pe INTEGER; DECLARE hp INTEGER; DECLARE t DOUBLE PRECISION; DECLARE c INTEGER; DECLARE pm VARCHAR(16); DECLARE ps VARCHAR(16);
BEGIN
  pe = player_ent();
  t = now_();
  SELECT e.health, e.pmodel, e.pskin FROM ents e WHERE e.id = :pe INTO hp, pm, ps;
  EXECUTE PROCEDURE say(obituary(pe, attacker, mod_));
  EXECUTE PROCEDURE score_frag(attacker, pe, mod_);
  UPDATE ents e SET e.deadflag = 1, e.solid = 0, e.movetype = 6, e.takedamage = 0, e.viewheight = -8, e.minz = -24, e.maxz = -8, e.weapon = 0 WHERE e.id = :pe;
  UPDATE player p SET p.dead_time = :t, p.deaths = p.deaths + 1, p.view_ofs = -8, p.ducked = 0, p.weapon = 0, p.pending_weapon = 0, p.weaponstate = 0, p.quad_finished = 0, p.haste_finished = 0, p.invis_finished = 0, p.regen_finished = 0, p.enviro_finished = 0, p.flight_finished = 0 WHERE p.id = 1;
  IF (hp < -40) THEN
  BEGIN
    EXECUTE PROCEDURE gib_ent(pe, -hp);
    EXIT;
  END
  EXECUTE PROCEDURE snd(pe, 2, 'sound/player/' || COALESCE(pm, 'sarge') || '/death' || CAST(1 + FLOOR(RAND() * 3) AS INTEGER) || '.wav', 1, 1);
  -- the body: a corpse entity with the player's model in a death animation
  EXECUTE PROCEDURE spawn_ent('corpse', (SELECT e.x FROM ents e WHERE e.id = :pe), (SELECT e.y FROM ents e WHERE e.id = :pe), (SELECT e.z FROM ents e WHERE e.id = :pe)) RETURNING_VALUES c;
  UPDATE ents e SET e.pmodel = :pm, e.pskin = :ps, e.yaw = (SELECT o.yaw FROM ents o WHERE o.id = :pe), e.solid = 2, e.movetype = 6, e.clipmask = 65537, e.takedamage = 1, e.health = 0, e.deadflag = 1,
         e.minx = -15, e.miny = -15, e.minz = -24, e.maxx = 15, e.maxy = 15, e.maxz = -8, e.legs_anim = CAST(FLOOR(RAND() * 3) AS INTEGER) * 2, e.legs_time = :t, e.torso_anim = -1,
         e.vx = (SELECT o.vx FROM ents o WHERE o.id = :pe), e.vy = (SELECT o.vy FROM ents o WHERE o.id = :pe), e.weapon = 0,
         e.think = 'remove', e.nextthink = :t + 8 WHERE e.id = :c;
  EXECUTE PROCEDURE link_ent(c);
END^

-- ── the spectator (TEAM_SPECTATOR) ─────────────────────────────────────────
-- FindIntermissionPoint: the map's first info_player_intermission looking at its target (or along its
-- angle), else a spawn point: where the intermission's camera and a new spectator are (the eye)
CREATE OR ALTER PROCEDURE intermission_point
RETURNS (x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION, yaw DOUBLE PRECISION, pitch DOUBLE PRECISION)
AS
DECLARE tx DOUBLE PRECISION; DECLARE ty DOUBLE PRECISION; DECLARE tz DOUBLE PRECISION; DECLARE tgt VARCHAR(40);
DECLARE ang DOUBLE PRECISION; DECLARE ap DOUBLE PRECISION; DECLARE ay DOUBLE PRECISION;
BEGIN
  SELECT FIRST 1 m.ox, m.oy, m.oz, m.target, m.angle, m.apitch, m.ayaw FROM map_ents m WHERE m.classname = 'info_player_intermission' ORDER BY m.id
    INTO x, y, z, tgt, ang, ap, ay;
  IF (x IS NULL) THEN
  BEGIN
    EXECUTE PROCEDURE select_spawn(player_ent()) RETURNING_VALUES x, y, z, yaw;
    z = z + 9 + 26; pitch = 0;
  END
  ELSE
  BEGIN
    yaw = IIF(COALESCE(ay, 0) <> 0, ay, COALESCE(ang, 0)); pitch = COALESCE(ap, 0);
    IF (tgt IS NOT NULL) THEN
    BEGIN
      SELECT FIRST 1 t.ox, t.oy, t.oz FROM map_ents t WHERE t.targetname = :tgt INTO tx, ty, tz;
      IF (tx IS NOT NULL) THEN
      BEGIN
        yaw = vectoyaw(tx - x, ty - y);
        pitch = -ATAN2(tz - z, vlen(tx - x, ty - y, 0)) * 57.29578e0;
      END
    END
  END
  SUSPEND;
END^

-- ClientSpawn for a spectator (SelectSpectatorSpawnPoint): at the intermission point, no body, no weapon,
-- nothing to shoot at (FL_NOTARGET: the bots look past it), clipped by the world only
CREATE OR ALTER PROCEDURE make_spectator
AS
DECLARE pe INTEGER; DECLARE x DOUBLE PRECISION; DECLARE y DOUBLE PRECISION; DECLARE z DOUBLE PRECISION; DECLARE yaw DOUBLE PRECISION; DECLARE pitch DOUBLE PRECISION;
BEGIN
  pe = player_ent();
  EXECUTE PROCEDURE intermission_point RETURNING_VALUES x, y, z, yaw, pitch;
  UPDATE ents e SET e.x = :x, e.y = :y, e.z = :z - 26, e.vx = 0, e.vy = 0, e.vz = 0, e.yaw = :yaw, e.pitch = :pitch,
         e.deadflag = 0, e.health = 100, e.solid = 0, e.takedamage = 0, e.movetype = 0, e.alpha = 1, e.weapon = 0,
         e.minx = -15, e.miny = -15, e.minz = -24, e.maxx = 15, e.maxy = 15, e.maxz = 32, e.viewheight = 26,
         e.clipmask = 65537, e.flags = BIN_OR(BIN_AND(e.flags, 16), 64) WHERE e.id = :pe;
  UPDATE player p SET p.spectator = 1, p.follow_id = NULL, p.spec_fire = 1, p.pitch = :pitch, p.punchangle = 0, p.stepz = 0, p.view_ofs = 26,
         p.ducked = 0, p.onground = 0, p.weapon_sound = 0, p.weapon = 0, p.pending_weapon = 0, p.weaponstate = 0, p.weapons = 0,
         p.quad_finished = 0, p.haste_finished = 0, p.invis_finished = 0, p.regen_finished = 0, p.enviro_finished = 0, p.flight_finished = 0 WHERE p.id = 1;
  EXECUTE PROCEDURE link_ent(pe);
END^

-- SetTeam: to the spectators (one who leaves the match alive dies first, a suicide: a frag less), or
-- back into the match at a spawn point
CREATE OR ALTER PROCEDURE set_spectator (on_ SMALLINT)
AS
DECLARE pe INTEGER; DECLARE spec SMALLINT; DECLARE nm VARCHAR(32);
BEGIN
  pe = player_ent();
  SELECT p.spectator, p.name FROM player p WHERE p.id = 1 INTO spec, nm;
  IF (EXISTS (SELECT 1 FROM game g WHERE g.id = 1 AND g.match_over = 1)) THEN EXIT;
  IF (on_ = 1 AND spec = 0) THEN
  BEGIN
    IF (EXISTS (SELECT 1 FROM ents e WHERE e.id = :pe AND e.deadflag = 0 AND e.health > 0)) THEN EXECUTE PROCEDURE player_die(pe, 20);
    EXECUTE PROCEDURE make_spectator;
    EXECUTE PROCEDURE say(nm || ' joined the spectators.');
  END
  ELSE IF (on_ = 0 AND spec = 1) THEN
  BEGIN
    UPDATE player p SET p.spectator = 0, p.follow_id = NULL WHERE p.id = 1;
    EXECUTE PROCEDURE player_respawn;
    EXECUTE PROCEDURE say(nm || ' entered the game');
  END
END^

-- Cmd_FollowCycle_f: the next bot to follow (dead ones too: the view goes down with them)
CREATE OR ALTER PROCEDURE follow_cycle
AS
DECLARE cur INTEGER; DECLARE nxt INTEGER; DECLARE nm VARCHAR(16);
BEGIN
  SELECT p.follow_id FROM player p WHERE p.id = 1 INTO cur;
  SELECT FIRST 1 e.id, e.bot FROM ents e WHERE e.classname = 'bot' AND e.id > COALESCE(:cur, 0) ORDER BY e.id INTO nxt, nm;
  IF (nxt IS NULL) THEN SELECT FIRST 1 e.id, e.bot FROM ents e WHERE e.classname = 'bot' ORDER BY e.id INTO nxt, nm;
  IF (nxt IS NULL) THEN EXIT;
  UPDATE player p SET p.follow_id = :nxt WHERE p.id = 1;
END^

-- StopFollowing: free again, from where the one followed was, looking where it looked
CREATE OR ALTER PROCEDURE stop_following
AS
DECLARE pe INTEGER; DECLARE f INTEGER;
BEGIN
  pe = player_ent();
  SELECT p.follow_id FROM player p WHERE p.id = 1 INTO f;
  IF (f IS NULL) THEN EXIT;
  UPDATE player p SET p.follow_id = NULL, p.pitch = COALESCE((SELECT o.pitch FROM ents o WHERE o.id = :f), p.pitch) WHERE p.id = 1;
  UPDATE ents e SET e.x = COALESCE((SELECT o.x FROM ents o WHERE o.id = :f), e.x), e.y = COALESCE((SELECT o.y FROM ents o WHERE o.id = :f), e.y),
         e.z = COALESCE((SELECT o.z + o.viewheight - 26 FROM ents o WHERE o.id = :f), e.z), e.yaw = COALESCE((SELECT o.yaw FROM ents o WHERE o.id = :f), e.yaw),
         e.vx = 0, e.vy = 0, e.vz = 0 WHERE e.id = :pe;
  EXECUTE PROCEDURE link_ent(pe);
END^

-- ClientThink + Pmove + ClientEndServerFrame for one tic
-- `jump` is Quake III's upmove: 1 jumps (or swims up), -1 crouches (or swims down), 0 neither
CREATE OR ALTER PROCEDURE player_think (dt DOUBLE PRECISION, fwd DOUBLE PRECISION, side DOUBLE PRECISION,
  yaw_d DOUBLE PRECISION, pitch_d DOUBLE PRECISION, fire SMALLINT, jump SMALLINT, run SMALLINT, imp SMALLINT)
AS
DECLARE pe INTEGER; DECLARE t DOUBLE PRECISION; DECLARE dead SMALLINT; DECLARE flags INTEGER; DECLARE wl SMALLINT; DECLARE wt INTEGER; DECLARE owl SMALLINT;
DECLARE yaw DOUBLE PRECISION; DECLARE pitch DOUBLE PRECISION;
DECLARE vx DOUBLE PRECISION; DECLARE vy DOUBLE PRECISION; DECLARE vz DOUBLE PRECISION;
DECLARE spd DOUBLE PRECISION; DECLARE ns DOUBLE PRECISION; DECLARE control DOUBLE PRECISION; DECLARE drop_ DOUBLE PRECISION;
DECLARE fx_ DOUBLE PRECISION; DECLARE fy DOUBLE PRECISION; DECLARE fz DOUBLE PRECISION;
DECLARE rx DOUBLE PRECISION; DECLARE ry DOUBLE PRECISION;
DECLARE wx DOUBLE PRECISION; DECLARE wy DOUBLE PRECISION; DECLARE wz DOUBLE PRECISION; DECLARE wspd DOUBLE PRECISION; DECLARE maxspd DOUBLE PRECISION;
DECLARE cur DOUBLE PRECISION; DECLARE add_ DOUBLE PRECISION; DECLARE acc DOUBLE PRECISION;
DECLARE jr SMALLINT; DECLARE onground SMALLINT;
DECLARE px DOUBLE PRECISION; DECLARE py DOUBLE PRECISION; DECLARE pz DOUBLE PRECISION;
DECLARE f DOUBLE PRECISION; DECLARE ex DOUBLE PRECISION; DECLARE ey DOUBLE PRECISION; DECLARE ez DOUBLE PRECISION;
DECLARE gnx DOUBLE PRECISION; DECLARE gny DOUBLE PRECISION; DECLARE gnz DOUBLE PRECISION;
DECLARE sf INTEGER; DECLARE ct INTEGER; DECLARE als SMALLINT; DECLARE sts SMALLINT; DECLARE hit INTEGER; DECLARE cb SMALLINT;
DECLARE tst SMALLINT; DECLARE tid INTEGER;
DECLARE afin DOUBLE PRECISION; DECLARE hp INTEGER; DECLARE deadt DOUBLE PRECISION; DECLARE oldz DOUBLE PRECISION;
DECLARE enviro DOUBLE PRECISION; DECLARE haste DOUBLE PRECISION; DECLARE regen DOUBLE PRECISION; DECLARE ndt DOUBLE PRECISION; DECLARE ddmg INTEGER; DECLARE mhp INTEGER;
DECLARE grav DOUBLE PRECISION; DECLARE tt DOUBLE PRECISION; DECLARE legs INTEGER; DECLARE hdecay DOUBLE PRECISION; DECLARE rt DOUBLE PRECISION; DECLARE stept DOUBLE PRECISION;
DECLARE mover SMALLINT; DECLARE pm VARCHAR(16); DECLARE match_done SMALLINT; DECLARE ducked SMALLINT; DECLARE maxz DOUBLE PRECISION; DECLARE wend DOUBLE PRECISION;
DECLARE spec SMALLINT; DECLARE sfire SMALLINT; DECLARE fid INTEGER;
DECLARE kb DOUBLE PRECISION; DECLARE upk DOUBLE PRECISION; DECLARE yaw0 DOUBLE PRECISION; DECLARE yk DOUBLE PRECISION; DECLARE ds DOUBLE PRECISION;
DECLARE sxv DOUBLE PRECISION; DECLARE syv DOUBLE PRECISION; DECLARE szv DOUBLE PRECISION; DECLARE vz0 DOUBLE PRECISION; DECLARE wl2 DOUBLE PRECISION; DECLARE k INTEGER;
DECLARE vz_start DOUBLE PRECISION; DECLARE pz_start DOUBLE PRECISION; DECLARE lvz DOUBLE PRECISION;
DECLARE slick SMALLINT; DECLARE d DOUBLE PRECISION; DECLARE rz DOUBLE PRECISION;
BEGIN
  SELECT p.ent_id, p.jump_released, p.air_finished, p.dead_time, p.enviro_finished, p.haste_finished, p.regen_finished, p.next_drown_time, p.drown_dmg, p.health_decay, p.regen_time, p.step_time, p.ducked,
         p.spectator, p.spec_fire, p.follow_id
    FROM player p WHERE p.id = 1 INTO pe, jr, afin, deadt, enviro, haste, regen, ndt, ddmg, hdecay, rt, stept, ducked, spec, sfire, fid;
  IF (pe IS NULL) THEN EXIT;
  SELECT e.deadflag, e.flags, e.waterlevel, e.watertype, e.yaw, e.health, e.z, e.max_health, e.teleport_time, e.legs_anim, e.pmodel
    FROM ents e WHERE e.id = :pe INTO dead, flags, owl, wt, yaw, hp, oldz, mhp, tt, legs, pm;
  t = now_();
  SELECT g.gravity, g.match_over, g.warmup_end FROM game g WHERE g.id = 1 INTO grav, match_done, wend;

  IF (dead = 1) THEN
  BEGIN
    -- the view falls with the body; respawn on fire or jump after a moment
    EXECUTE PROCEDURE toss_move(pe, dt);
    IF (t > deadt + 1.7e0 AND (fire = 1 OR jump = 1)) THEN
    BEGIN
      IF (match_done = 1) THEN UPDATE game g SET g.exit_kind = 1 WHERE g.id = 1;
      ELSE EXECUTE PROCEDURE player_respawn;
    END
    EXIT;
  END
  IF (match_done = 1) THEN
  BEGIN
    -- CheckIntermissionExit: never in less than five seconds, then as soon as the player is ready
    IF (fire = 1 AND t > (SELECT g.over_time FROM game g WHERE g.id = 1) + 5) THEN UPDATE game g SET g.exit_kind = 1 WHERE g.id = 1;
    EXIT;
  END

  -- view angles
  yaw = anglemod(yaw + yaw_d);
  UPDATE player p SET p.pitch = MAXVALUE(-89, MINVALUE(89, p.pitch + :pitch_d)), p.punchangle = MINVALUE(0, p.punchangle + 10 * :dt) WHERE p.id = 1 RETURNING p.pitch INTO pitch;
  UPDATE ents e SET e.yaw = :yaw, e.pitch = :pitch WHERE e.id = :pe;

  -- a spectator (SpectatorThink): the attack button cycles through the bots to follow, jump lets go of
  -- the one followed; free, it flies (PM_FlyMove: friction 5, acceleration 8, no gravity, up and down
  -- with jump and crouch) through everything but the world, and touches only teleporters and doors
  IF (spec = 1) THEN
  BEGIN
    IF (fire = 1 AND sfire = 0) THEN EXECUTE PROCEDURE follow_cycle;
    UPDATE player p SET p.spec_fire = :fire WHERE p.id = 1 AND p.spec_fire <> :fire;
    IF (fid IS NOT NULL) THEN
    BEGIN
      IF (jump = 1) THEN EXECUTE PROCEDURE stop_following;
      EXIT;
    END
    SELECT e.vx, e.vy, e.vz FROM ents e WHERE e.id = :pe INTO vx, vy, vz;
    spd = vlen(vx, vy, vz);
    IF (spd < 1) THEN BEGIN vx = 0; vy = 0; vz = 0; END
    ELSE
    BEGIN
      ns = MAXVALUE(0, spd - spd * 5 * dt) / spd;
      vx = vx * ns; vy = vy * ns; vz = vz * ns;
    END
    maxspd = IIF(run = 1, 320, 160);
    wx = COS(yaw * 0.0174532925e0) * COS(pitch * 0.0174532925e0) * fwd + SIN(yaw * 0.0174532925e0) * side;
    wy = SIN(yaw * 0.0174532925e0) * COS(pitch * 0.0174532925e0) * fwd - COS(yaw * 0.0174532925e0) * side;
    wz = -SIN(pitch * 0.0174532925e0) * fwd + jump;
    wspd = vlen(wx, wy, wz);
    IF (wspd > 0) THEN
    BEGIN
      wx = wx / wspd; wy = wy / wspd; wz = wz / wspd;
      add_ = maxspd - (vx * wx + vy * wy + vz * wz);
      IF (add_ > 0) THEN
      BEGIN
        acc = MINVALUE(add_, 8 * dt * maxspd);
        vx = vx + acc * wx; vy = vy + acc * wy; vz = vz + acc * wz;
      END
    END
    UPDATE ents e SET e.vx = :vx, e.vy = :vy, e.vz = :vz, e.flags = BIN_AND(e.flags, BIN_NOT(512)) WHERE e.id = :pe;
    EXECUTE PROCEDURE fly_move(pe, dt) RETURNING_VALUES tst, tid;
    EXECUTE PROCEDURE link_ent(pe);
    EXECUTE PROCEDURE touch_triggers(pe);
    UPDATE player p SET p.move_speed = vlen(:vx, :vy, 0), p.onground = 0 WHERE p.id = 1;
    EXIT;
  END
  IF (imp > 0) THEN EXECUTE PROCEDURE player_impulse(imp);

  -- P_WorldEffects: water, slime, lava, drowning
  EXECUTE PROCEDURE check_water(pe) RETURNING_VALUES wl, wt;
  IF (owl = 0 AND wl > 0) THEN EXECUTE PROCEDURE snd(pe, 0, 'sound/player/watr_in.wav', 1, 1);
  ELSE IF (owl > 0 AND wl = 0) THEN EXECUTE PROCEDURE snd(pe, 0, 'sound/player/watr_out.wav', 1, 1);
  IF (owl <> 3 AND wl = 3) THEN EXECUTE PROCEDURE snd(pe, 0, 'sound/player/watr_un.wav', 1, 1);
  IF (owl = 3 AND wl <> 3 AND afin < t + 11) THEN EXECUTE PROCEDURE snd(pe, 2, 'sound/player/' || pm || '/gasp.wav', 1, 1);
  IF (wl = 3) THEN
  BEGIN
    IF (afin < t AND ndt < t) THEN
    BEGIN
      ddmg = MINVALUE(15, ddmg + 2);
      UPDATE player p SET p.next_drown_time = :t + 1, p.drown_dmg = :ddmg WHERE p.id = 1;
      EXECUTE PROCEDURE snd(pe, 2, IIF(hp <= ddmg, 'sound/player/' || pm || '/drown.wav', 'sound/player/gurp' || CAST(1 + FLOOR(RAND() * 2) AS INTEGER) || '.wav'), 1, 1);
      EXECUTE PROCEDURE t_damage(pe, 0, 0, ddmg, 0, 2 + 8, 21);
    END
  END
  ELSE UPDATE player p SET p.air_finished = :t + 12, p.drown_dmg = 2 WHERE p.id = 1;
  IF (wl > 0 AND BIN_AND(wt, 24) <> 0) THEN
  BEGIN
    IF ((SELECT p.dmg_lava_time FROM player p WHERE p.id = 1) < t) THEN
    BEGIN
      UPDATE player p SET p.dmg_lava_time = :t + 0.1e0 WHERE p.id = 1;
      IF (BIN_AND(wt, 8) <> 0) THEN EXECUTE PROCEDURE t_damage(pe, 0, 0, 3 * wl, 0, 2, 14);   -- lava: 30 a second
      ELSE EXECUTE PROCEDURE t_damage(pe, 0, 0, 1 * wl, 0, 2, 15);                           -- slime: 10 a second
      IF (BIN_AND(wt, 8) <> 0 AND RAND() < 0.1e0) THEN EXECUTE PROCEDURE snd(pe, 2, 'sound/player/fry.wav', 1, 1);
    END
  END
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :pe AND e.deadflag = 0)) THEN EXIT;

  SELECT e.vx, e.vy, e.vz, e.flags, e.x, e.y, e.z FROM ents e WHERE e.id = :pe INTO vx, vy, vz, flags, px, py, pz;

  -- PM_CheckDuck: down while the crouch key is held; up again only where the standing box fits
  IF (jump = -1) THEN ducked = 1;
  ELSE IF (ducked = 1) THEN
  BEGIN
    EXECUTE PROCEDURE trace_move(pe, -15, -15, -24, 15, 15, 32, px, py, pz, px, py, pz, 33619969)
      RETURNING_VALUES f, ex, ey, ez, gnx, gny, gnz, sf, ct, als, sts, hit;
    IF (als = 0 AND sts = 0) THEN ducked = 0;
  END
  maxz = IIF(ducked = 1, 16, 32);
  UPDATE ents e SET e.maxz = :maxz, e.viewheight = IIF(:ducked = 1, 12, 26) WHERE e.id = :pe AND e.maxz <> :maxz;
  UPDATE player p SET p.ducked = :ducked, p.view_ofs = IIF(:ducked = 1, 12, 26) WHERE p.id = 1 AND p.ducked <> :ducked;

  -- PM_GroundTrace: a quarter unit down
  EXECUTE PROCEDURE trace_move(pe, -15, -15, -24, 15, 15, maxz, px, py, pz, px, py, pz - 0.25e0, 33619969)
    RETURNING_VALUES f, ex, ey, ez, gnx, gny, gnz, sf, ct, als, sts, hit;
  onground = IIF(f < 1 AND gnz >= 0.7e0 AND NOT (vz > 0 AND vx * gnx + vy * gny + vz * gnz > 10), 1, 0);
  IF (als = 1 OR sts = 1) THEN onground = 1;
  mover = IIF(hit > 0 AND onground = 1, 1, 0);
  -- where the tic starts, for PM_CrashLand's solve if it ends on the ground
  vz_start = vz; pz_start = pz;
  slick = IIF(onground = 1 AND BIN_AND(sf, 2) <> 0, 1, 0);   -- SURF_SLICK: ice, no friction, air acceleration
  flags = IIF(onground = 1, BIN_OR(flags, 512), BIN_AND(flags, BIN_NOT(512)));
  maxspd = IIF(run = 1, 320, 160);
  IF (haste > t) THEN maxspd = maxspd * 1.3e0;
  SELECT p.knockback_until FROM player p WHERE p.id = 1 INTO kb;
  -- PM_CmdScale: the wish speed of the keys, the jump (or crouch) key among them: holding it in the air
  -- takes some air control away; a jump held on the ground does not count (PMF_JUMP_HELD clears it)
  upk = IIF(onground = 1 AND jump = 1 AND jr = 0, 0, ABS(jump));
  wspd = IIF(ABS(fwd) + ABS(side) + upk = 0, 0,
             maxspd * MAXVALUE(ABS(fwd), ABS(side), upk) * SQRT(fwd * fwd + side * side) / SQRT(fwd * fwd + side * side + upk * upk));
  -- PM_WalkMove: a crouching player walks at a quarter of the speed at most (pm_duckScale)
  IF (ducked = 1 AND onground = 1 AND wl < 2) THEN wspd = MINVALUE(wspd, maxspd * 0.25e0);

  -- PM_CheckJump
  IF (jump = 1) THEN
  BEGIN
    IF (wl >= 2) THEN
    BEGIN
      vz = MAXVALUE(vz, 50);
      onground = 0; flags = BIN_AND(flags, BIN_NOT(512));
    END
    ELSE IF (onground = 1 AND jr = 1 AND tt < t) THEN
    BEGIN
      vz = 270;
      flags = BIN_AND(flags, BIN_NOT(512));
      onground = 0;
      UPDATE player p SET p.jump_released = 0 WHERE p.id = 1;
      EXECUTE PROCEDURE snd(pe, 2, 'sound/player/' || pm || '/jump1.wav', 1, 1);
      EXECUTE PROCEDURE set_anims(pe, IIF(fwd >= 0, 18, 20), NULL);
      legs = 18;
    END
  END
  ELSE UPDATE player p SET p.jump_released = 1 WHERE p.id = 1;

  IF (wl >= 2) THEN
  BEGIN
    -- PM_WaterMove: water friction, the forward vector follows the pitch, sink slowly when idle, half speed
    spd = vlen(vx, vy, vz);
    IF (spd > 1) THEN
    BEGIN
      ns = MAXVALUE(0, spd - spd * wl * dt) / spd;
      vx = vx * ns; vy = vy * ns; vz = vz * ns;
    END
    fx_ = COS(yaw * 0.0174532925e0); fy = SIN(yaw * 0.0174532925e0);
    rx = fy; ry = -fx_;
    fz = -SIN(pitch * 0.0174532925e0);
    fx_ = fx_ * COS(pitch * 0.0174532925e0); fy = fy * COS(pitch * 0.0174532925e0);
    wx = fx_ * fwd * maxspd + rx * side * maxspd; wy = fy * fwd * maxspd + ry * side * maxspd; wz = fz * fwd * maxspd;
    IF (fwd = 0 AND side = 0 AND jump = 0) THEN wz = wz - 60;
    ELSE IF (jump = 1) THEN wz = wz + 200;
    ELSE IF (jump = -1) THEN wz = wz - 200;
    wl2 = vlen(wx, wy, wz);
    IF (wl2 > maxspd) THEN BEGIN wx = wx * maxspd / wl2; wy = wy * maxspd / wl2; wz = wz * maxspd / wl2; wl2 = maxspd; END
    IF (wl2 > 0) THEN
    BEGIN
      add_ = wl2 * 0.5e0 - (vx * wx + vy * wy + vz * wz) / wl2;
      IF (add_ > 0) THEN
      BEGIN
        acc = MINVALUE(add_, 4 * wl2 * 0.5e0 * dt);
        vx = vx + acc * wx / wl2; vy = vy + acc * wy / wl2; vz = vz + acc * wz / wl2;
      END
    END
    UPDATE ents e SET e.vx = :vx, e.vy = :vy, e.vz = :vz, e.flags = BIN_AND(:flags, BIN_NOT(512)) WHERE e.id = :pe;
    EXECUTE PROCEDURE fly_move(pe, dt) RETURNING_VALUES tst, tid;
  END
  ELSE
  BEGIN
    -- the substeps: Quake III's client runs Pmove 125 times a second (pmove_fixed, 8 ms), so friction,
    -- acceleration and gravity run six times a tic here, the yaw turning through it as the mouse did; the
    -- collision move then runs once, with the average velocity of the six, and the velocity is the sixth's
    -- with whatever the walls took off the average taken off it too
    yaw0 = yaw - yaw_d;
    ds = dt / 6;
    sxv = 0; syv = 0; szv = 0;
    k = 1;
    WHILE (k <= 6) DO
    BEGIN
      -- PM_Friction: walking, unless a jump pad, a teleporter, a knock or a slick floor has us; on the
      -- horizontal speed ("ignore slope movement"), all three scaled
      IF (onground = 1 AND tt < t AND kb < t AND slick = 0) THEN
      BEGIN
        spd = vlen(vx, vy, 0);
        IF (spd < 1) THEN BEGIN vx = 0; vy = 0; END
        ELSE
        BEGIN
          ns = MAXVALUE(0, spd - MAXVALUE(spd, 100) * 6 * ds) / spd;
          vx = vx * ns; vy = vy * ns; vz = vz * ns;
        END
      END
      -- PM_Accelerate toward the wish direction of this moment: 10 walking, 1 in the air, knocked or on ice.
      -- Walking, forward and right are laid on the ground plane first (PM_WalkMove's PM_ClipVelocity of
      -- them), so a ramp is run up and down along it
      vz0 = vz;
      IF (wspd > 0 AND tt < t) THEN
      BEGIN
        yk = (yaw0 + yaw_d * k / 6) * 0.0174532925e0;
        IF (onground = 1) THEN
        BEGIN
          d = COS(yk) * gnx + SIN(yk) * gny; d = IIF(d < 0, d * 1.001e0, d / 1.001e0);
          fx_ = COS(yk) - gnx * d; fy = SIN(yk) - gny * d; fz = -gnz * d;
          d = vlen(fx_, fy, fz); IF (d > 0) THEN BEGIN fx_ = fx_ / d; fy = fy / d; fz = fz / d; END
          d = SIN(yk) * gnx - COS(yk) * gny; d = IIF(d < 0, d * 1.001e0, d / 1.001e0);
          rx = SIN(yk) - gnx * d; ry = -COS(yk) - gny * d; rz = -gnz * d;
          d = vlen(rx, ry, rz); IF (d > 0) THEN BEGIN rx = rx / d; ry = ry / d; rz = rz / d; END
        END
        ELSE BEGIN fx_ = COS(yk); fy = SIN(yk); fz = 0; rx = SIN(yk); ry = -COS(yk); rz = 0; END
        wx = fx_ * fwd + rx * side; wy = fy * fwd + ry * side; wz = fz * fwd + rz * side;
        wl2 = vlen(wx, wy, wz);
        IF (wl2 > 0) THEN
        BEGIN
          wx = wx / wl2; wy = wy / wl2; wz = wz / wl2;
          add_ = wspd - (vx * wx + vy * wy + vz * wz);
          IF (add_ > 0) THEN
          BEGIN
            acc = MINVALUE(add_, IIF(onground = 1 AND kb < t AND slick = 0, 10, 1) * wspd * ds);
            vx = vx + acc * wx; vy = vy + acc * wy; vz = vz + acc * wz;
          END
        END
      END
      IF (onground = 1) THEN
      BEGIN
        -- knocked or on ice, gravity still pulls; then slide along the ground plane, and "don't decrease
        -- velocity when going up or down a slope": the speed it had, along the plane
        IF (kb >= t OR slick = 1) THEN vz = vz - grav * ds;
        spd = vlen(vx, vy, vz);
        d = vx * gnx + vy * gny + vz * gnz; d = IIF(d < 0, d * 1.001e0, d / 1.001e0);
        vx = vx - gnx * d; vy = vy - gny * d; vz = vz - gnz * d;
        d = vlen(vx, vy, vz);
        IF (d > 0) THEN BEGIN vx = vx * spd / d; vy = vy * spd / d; vz = vz * spd / d; END
        vz0 = vz;   -- (no trapezoid: walking, the move is along the plane, PM_StepSlideMove without gravity)
      END
      -- gravity in the air, over the substep by its average (PM_SlideMove's endVelocity)
      ELSE vz = vz - grav * ds;
      sxv = sxv + vx; syv = syv + vy; szv = szv + (vz0 + vz) / 2;
      k = k + 1;
    END
    UPDATE ents e SET e.vx = :sxv / 6, e.vy = :syv / 6, e.vz = :szv / 6, e.flags = :flags WHERE e.id = :pe;
    EXECUTE PROCEDURE walk_move(pe, dt);
    UPDATE ents e SET e.vx = :vx + (e.vx - :sxv / 6), e.vy = :vy + (e.vy - :syv / 6), e.vz = :vz + (e.vz - :szv / 6) WHERE e.id = :pe;
    -- walking, the end velocity clipped by the ground plane too (PM_SlideMove clips its endVelocity by
    -- the planes it touches): what the step move took off the average must not tip it off a ramp
    IF (onground = 1) THEN
    BEGIN
      SELECT e.vx, e.vy, e.vz FROM ents e WHERE e.id = :pe INTO vx, vy, vz;
      EXECUTE PROCEDURE clip_velocity(vx, vy, vz, gnx, gny, gnz, 1.001e0) RETURNING_VALUES vx, vy, vz, cb;
      UPDATE ents e SET e.vx = :vx, e.vy = :vy, e.vz = :vz WHERE e.id = :pe;
    END
  END
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :pe)) THEN EXIT;
  EXECUTE PROCEDURE link_ent(pe);
  -- in the air, and now on the ground: landed (PmoveSingle's second PM_GroundTrace, then PM_CrashLand)
  IF (onground = 0) THEN
  BEGIN
    SELECT e.x, e.y, e.z, e.vx, e.vy, e.vz FROM ents e WHERE e.id = :pe INTO ex, ey, ez, gnx, gny, gnz;
    lvz = gnz;
    EXECUTE PROCEDURE trace_move(pe, -15, -15, -24, 15, 15, maxz, ex, ey, ez, ex, ey, ez - 0.25e0, 33619969)
      RETURNING_VALUES f, ex, ey, ez, gnx, gny, gnz, sf, ct, als, sts, hit;
    IF (f < 1 AND gnz >= 0.7e0 AND lvz <= 10 AND sts = 0) THEN
    BEGIN
      -- the velocity the tic ends with, clipped by the floor it came down on (PM_SlideMove's endVelocity
      -- clip), or what is left of the fall would be turned along the ground by the next PM_WalkMove
      SELECT e.vx, e.vy, e.vz FROM ents e WHERE e.id = :pe INTO vx, vy, vz;
      IF (vx * gnx + vy * gny + vz * gnz < 0) THEN
      BEGIN
        EXECUTE PROCEDURE clip_velocity(vx, vy, vz, gnx, gny, gnz, 1.001e0) RETURNING_VALUES vx, vy, vz, cb;
        UPDATE ents e SET e.vx = :vx, e.vy = :vy, e.vz = :vz WHERE e.id = :pe;
      END
      EXECUTE PROCEDURE crash_land(pe, vz_start, (SELECT e.z FROM ents e WHERE e.id = :pe) - pz_start, grav, ducked, wl, sf);
    END
  END
  -- smooth the view over steps
  SELECT e.z, e.vx, e.vy FROM ents e WHERE e.id = :pe INTO pz, vx, vy;
  UPDATE player p SET p.stepz = IIF(:onground = 1 AND :pz - :oldz > 0 AND :pz - :oldz <= 18, MINVALUE(p.stepz + (:pz - :oldz), 18), MAXVALUE(0, p.stepz - 160 * :dt)),
         p.move_speed = vlen(:vx, :vy, 0), p.onground = :onground WHERE p.id = 1;

  -- the legs: run, back-pedal, idle, crouch-walk, crouch-idle, or still in the air
  IF (onground = 1 AND legs IN (18, 20) AND tt < t) THEN BEGIN EXECUTE PROCEDURE set_anims(pe, 19, NULL); legs = 19; END
  ELSE IF (onground = 1 AND ducked = 1) THEN
  BEGIN
    IF (vlen(vx, vy, 0) > 10 AND legs <> 13) THEN EXECUTE PROCEDURE set_anims(pe, 13, NULL);         -- LEGS_WALKCR
    ELSE IF (vlen(vx, vy, 0) <= 10 AND legs <> 23) THEN EXECUTE PROCEDURE set_anims(pe, 23, NULL);   -- LEGS_IDLECR
  END
  ELSE IF (onground = 1 AND legs <> 19) THEN
  BEGIN
    IF (vlen(vx, vy, 0) > 40 AND legs NOT IN (IIF(fwd < 0, 16, 15))) THEN EXECUTE PROCEDURE set_anims(pe, IIF(fwd < 0, 16, 15), NULL);
    ELSE IF (vlen(vx, vy, 0) <= 40 AND legs <> 22) THEN EXECUTE PROCEDURE set_anims(pe, 22, NULL);
  END
  -- footsteps (PM_Footsteps: "ducked characters never play footsteps")
  IF (onground = 1 AND ducked = 0 AND vlen(vx, vy, 0) > 100 AND stept < t) THEN
  BEGIN
    UPDATE player p SET p.step_time = :t + 0.3e0 WHERE p.id = 1;
    EXECUTE PROCEDURE snd(pe, 2, IIF(wl > 0, 'sound/player/footsteps/splash' || CAST(1 + FLOOR(RAND() * 4) AS INTEGER) || '.wav', 'sound/player/footsteps/step' || CAST(1 + FLOOR(RAND() * 4) AS INTEGER) || '.wav'), 0.6e0, 1);
  END

  -- G_TouchTriggers: triggers, jump pads, teleporters and items
  EXECUTE PROCEDURE touch_triggers(pe);
  IF (NOT EXISTS (SELECT 1 FROM ents e WHERE e.id = :pe AND e.deadflag = 0)) THEN EXIT;

  -- health above the maximum counts down, regeneration counts up
  IF (hdecay < t) THEN
  BEGIN
    UPDATE player p SET p.health_decay = :t + 1 WHERE p.id = 1;
    IF (regen > t) THEN
    BEGIN
      UPDATE ents e SET e.health = IIF(e.health < e.max_health, MINVALUE(e.health + 15, e.max_health * 1.1e0), IIF(e.health < e.max_health * 2, e.health + 5, e.health)) WHERE e.id = :pe;
      EXECUTE PROCEDURE snd(pe, 3, 'sound/items/regen.wav', 1, 1);
    END
    ELSE UPDATE ents e SET e.health = e.health - 1 WHERE e.id = :pe AND e.health > e.max_health;
    UPDATE player p SET p.armor = p.armor - 1 WHERE p.id = 1 AND p.armor > 100;
  END
  -- powerups wearing off
  IF (EXISTS (SELECT 1 FROM player p WHERE p.id = 1 AND ((p.quad_finished > :t - :dt AND p.quad_finished <= :t) OR (p.haste_finished > :t - :dt AND p.haste_finished <= :t)
       OR (p.invis_finished > :t - :dt AND p.invis_finished <= :t) OR (p.regen_finished > :t - :dt AND p.regen_finished <= :t) OR (p.enviro_finished > :t - :dt AND p.enviro_finished <= :t)))) THEN
    EXECUTE PROCEDURE snd(pe, 3, 'sound/items/wearoff.wav', 1, 1);

  -- weapon
  EXECUTE PROCEDURE player_fire(IIF(t < wend, 0, fire));   -- not before "fight!"
END^

SET TERM ; ^
