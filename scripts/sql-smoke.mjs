// sql-smoke.mjs – run the game's SQL against the real Firebird WASM engine
// in Node: load the PK3 and a map, play some tics, render frames, assert.
//
//   PAK=path/to/pak0.pk3 node scripts/sql-smoke.mjs [map]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pakPath = process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3');
const mapName = process.argv[2] ?? 'q3dm1';
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; } else console.log(`ok   ${msg}`);
}
const t = () => performance.now();
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });

let t0 = t();
await createSchema(db, sql);
console.log(`schema        ${(t() - t0).toFixed(0)} ms`);

const pak = new Pk3(fs.readFileSync(pakPath).buffer);
t0 = t();
const res = await loadResources(db, pak);
console.log(`resources     ${(t() - t0).toFixed(0)} ms (${res.models.size} models, ${res.players.size} player models)`);

t0 = t();
const bsp = await loadMap(db, pak, res, mapName, { skill: 2, bots: 3 });
console.log(`map ${mapName}     ${(t() - t0).toFixed(0)} ms`);

const counts = (await db.query(
  `SELECT (SELECT COUNT(*) FROM faces) f, (SELECT COUNT(*) FROM face_verts) fv, (SELECT COUNT(*) FROM leaves) l, (SELECT COUNT(*) FROM brushes) b,
          (SELECT COUNT(*) FROM nodes) n, (SELECT COUNT(*) FROM ents) e, (SELECT COUNT(*) FROM ents WHERE classname = 'bot') bots,
          (SELECT COUNT(*) FROM ents WHERE classname = 'item') items, (SELECT COUNT(*) FROM ents WHERE cluster IS NULL AND solid IN (2, 3)) nolink
     FROM rdb$database`)).rows[0];
console.log(counts);
assert(counts.F > 0 && counts.L > 0 && counts.B > 0, 'map geometry loaded');
assert(counts.BOTS === 3, `bots spawned (${counts.BOTS})`);
assert(counts.ITEMS > 0, `items spawned (${counts.ITEMS})`);

// the bots must not kill us while we test: god mode
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
const tic = (args) => db.query('SELECT * FROM q3_tic(?, ?, ?, ?, ?, ?, ?, ?, ?)', args).then((r) => r.rows[0]);
let s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
console.log('start', { x: s.PX, y: s.PY, z: s.PZ, yaw: s.YAW, leaf: s.LEAF, cluster: s.CLUSTER, health: s.HEALTH, msg: s.LEVEL_MSG, weapon: s.WEAPON, bullets: s.BULLETS });
assert(s.CLUSTER >= 0, 'player stands in a leaf with a cluster');
assert(s.HEALTH === 125 && s.WEAPON === 2 && s.BULLETS === 100, 'the starting inventory: 125 health, a machinegun with 100 bullets');
const start = { x: s.PX, y: s.PY, z: s.PZ };

// settle, then walk
for (let i = 0; i < 5; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
const settled = { x: s.PX, y: s.PY, z: s.PZ };
assert(Math.abs(settled.z - start.z) < 40, `player settled on the floor (dz ${(settled.z - start.z).toFixed(1)})`);
t0 = t();
for (let i = 0; i < 20; i++) s = await tic([1, 1, 0, 0, 0, 0, 0, 1, 0]);
console.log(`20 tics walking ${(t() - t0).toFixed(0)} ms`, { x: s.PX, y: s.PY, z: s.PZ, onground: s.ONGROUND, speed: s.MOVE_SPEED });
const moved = Math.hypot(s.PX - settled.x, s.PY - settled.y);
assert(moved > 150, `player ran forward (${moved.toFixed(1)} units in a second)`);
for (let i = 0; i < 10 && s.ONGROUND !== 1; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);   // the last step may have been off a stair
assert(s.ONGROUND === 1, 'player is on the ground after walking');

// crouch (PM_CheckDuck): the box and the eye go down, the walk slows to a quarter, and we stay down
// while something blocks standing up. Back the way we came, which is clear for 150 units
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  await tic([1, 0, 0, 180, 0, 0, 0, 1, 0]);
  for (let i = 0; i < 3; i++) s = await tic([1, 0, 0, 0, 0, 0, -1, 1, 0]);
  // (the eye's height in the tic row also carries the stair smoothing, so the table's offset is what we check)
  const box = (await db.query(`SELECT e.maxz, e.viewheight, p.view_ofs FROM ents e JOIN player p ON p.ent_id = e.id WHERE e.id = ${pe}`)).rows[0];
  assert(s.DUCKED === 1 && box.MAXZ === 16 && box.VIEW_OFS === 12 && box.VIEWHEIGHT === 12, `crouching: the box 16 high, the eye 12 above the origin instead of 26 (${box.VIEW_OFS})`);
  const from = { x: s.PX, y: s.PY };
  for (let i = 0; i < 20; i++) s = await tic([1, 1, 0, 0, 0, 0, -1, 1, 0]);
  const crept = Math.hypot(s.PX - from.x, s.PY - from.y);
  assert(crept > 40 && crept < 100, `crouch-walking is a quarter of the run (${crept.toFixed(1)} units in a second)`);
  // a bot standing on our head: no room to stand up
  const b = (await db.query("SELECT FIRST 1 id FROM ents WHERE classname = 'bot' ORDER BY id")).rows[0].ID;
  const keep = (await db.query(`SELECT x, y, z FROM ents WHERE id = ${b}`)).rows[0];
  await db.exec(`UPDATE ents SET x = ${s.PX}, y = ${s.PY}, z = ${s.PZ + 41}, vx = 0, vy = 0, vz = 0, nextthink = 1e9 WHERE id = ${b}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  for (let i = 0; i < 3; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.DUCKED === 1, 'no room above: we stay crouched with the key released');
  await db.exec(`UPDATE ents SET x = ${keep.X}, y = ${keep.Y}, z = ${keep.Z}, nextthink = 0 WHERE id = ${b}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const stood = (await db.query(`SELECT e.maxz, p.view_ofs FROM ents e JOIN player p ON p.ent_id = e.id WHERE e.id = ${pe}`)).rows[0];
  assert(s.DUCKED === 0 && stood.MAXZ === 32 && stood.VIEW_OFS === 26, 'room again: we stand up, the box 32 high, the eye back at 26');
  await tic([1, 0, 0, 180, 0, 0, 0, 1, 0]);
}

// turn around and walk into whatever is behind: we must never be inside a wall
await tic([1, 0, 0, 180, 0, 0, 0, 1, 0]);
for (let i = 0; i < 60; i++) s = await tic([1, 1, 0, 0, 0, 0, 0, 1, 0]);
const c = (await db.query(`SELECT point_contents(${s.PX}, ${s.PY}, ${s.PZ}) c FROM rdb$database`)).rows[0].C;
assert((c & 1) === 0, `player is not inside a wall after walking into things (contents ${c})`);

// back to a spawn point (on q3dm17 the walk ends in the void), then jump
await db.exec('EXECUTE PROCEDURE player_respawn');
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
for (let i = 0; i < 10; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
const zBefore = s.PZ;
s = await tic([1, 0, 0, 0, 0, 0, 1, 1, 0]);
let peak = s.PZ;
for (let i = 0; i < 12; i++) { s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]); peak = Math.max(peak, s.PZ); }
assert(peak - zBefore > 20, `jumping gained height (${(peak - zBefore).toFixed(1)} units)`);
for (let i = 0; i < 60 && s.ONGROUND !== 1; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
assert(s.ONGROUND === 1, 'landed again');

// fire the machinegun: a sound and a bullet somewhere
t0 = t();
s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
console.log(`fire            ${(t() - t0).toFixed(0)} ms`);
assert(s.BULLETS === 99, `firing used a bullet (${s.BULLETS})`);
const fired = (await db.query("SELECT COUNT(*) n FROM sound_events WHERE snd LIKE 'sound/weapons/machinegun/machgf%'")).rows[0].N;
assert(fired > 0, 'firing queued the machinegun sound');

// the frame
for (let i = 0; i < 3; i++) {
  t0 = t();
  const faces = await db.query('SELECT * FROM frame_faces_fast', [], { rowMode: 'array' });
  const t1 = t();
  const ents = await db.query('SELECT * FROM frame_ents', [], { rowMode: 'array' });
  const t2 = t();
  const all = await db.query('SELECT * FROM frame_all(0, 0, 0, 1)', [], { rowMode: 'array' });
  const t3 = t();
  const full = await db.query('SELECT * FROM frame_faces', [], { rowMode: 'array' });
  const t4 = t();
  console.log(`frame ${i}: ${faces.rows.length} faces in ${(t1 - t0).toFixed(0)} ms, ${ents.rows.length} ents in ${(t2 - t1).toFixed(0)} ms, frame_all ${all.rows.length} rows in ${(t3 - t2).toFixed(0)} ms, ${full.rows.length} vertex rows in ${(t4 - t3).toFixed(0)} ms`);
  if (i === 0) assert(faces.rows.length > 20, `the frame has faces (${faces.rows.length})`);
  await tic([1, 0, 0, 45, 0, 0, 0, 1, 0]);
}
for (let a = 0; a < 4; a++) {
  await tic([1, 0, 0, 90, 0, 0, 0, 1, 0]);
  const r = (await db.query('SELECT COUNT(*) c FROM frame_faces_fast')).rows[0].C;
  assert(r > 0, `heading +${(a + 1) * 90}°: ${r} faces`);
}

// the bots think: run 60 tics and see that they move about without error
t0 = t();
for (let i = 0; i < 30; i++) s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
console.log(`60 tics idle    ${(t() - t0).toFixed(0)} ms`);
const bots = (await db.query("SELECT bot, st, CAST(x AS INTEGER) x, CAST(y AS INTEGER) y, CAST(z AS INTEGER) z, enemy_id, health, legs_anim, weapon, cluster FROM ents WHERE classname = 'bot'")).rows;
console.log('bots', bots);
assert(bots.every((b) => b.CLUSTER !== null), 'every bot is linked into the world');

// cheat, then rocket the floor: splash damage must hurt us
s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 99]);
assert(s.ROCKETS === 200, 'impulse 99 gave ammo');
s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 5]);
for (let i = 0; i < 12; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
assert(s.WEAPON === 16, `switched to the rocket launcher (weapon ${s.WEAPON})`);
const hpBefore = s.HEALTH;
// without god mode for this one (it would stop the splash), the bots holding their fire
await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
await db.exec("UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(16)) WHERE classname = 'player'");
s = await tic([1, 0, 0, 0, 85, 1, 0, 1, 0]);
for (let i = 0; i < 20; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
assert(hpBefore - s.HEALTH > 10, `rocket at our feet hurt us (health ${hpBefore} → ${s.HEALTH})`);
assert(s.DMG_WORLD === 0, `and its splash came from where it blew up (${s.DMG_X.toFixed(0)}, ${s.DMG_Y.toFixed(0)}, ${s.DMG_Z.toFixed(0)})`);
// a bot's hit (8: through god mode) is recorded with where it came from, for the view's kick
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  const b = (await db.query("SELECT FIRST 1 id, x, y, z + (minz + maxz) / 2 cz FROM ents WHERE classname = 'bot' ORDER BY id")).rows[0];
  await db.exec(`EXECUTE PROCEDURE t_damage(${pe}, ${b.ID}, ${b.ID}, 10, 0, 8, 2)`);
  const d = (await db.query('SELECT dmg_x, dmg_y, dmg_z, dmg_world FROM player')).rows[0];
  assert(d.DMG_WORLD === 0 && Math.hypot(d.DMG_X - b.X, d.DMG_Y - b.Y, d.DMG_Z - b.CZ) < 0.01, `a bot's hit comes from the bot (${d.DMG_X.toFixed(0)}, ${d.DMG_Y.toFixed(0)}, ${d.DMG_Z.toFixed(0)})`);
}
// a far fall (PM_CrashLand): the view's dip is the far one, and the damage comes from no direction
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  for (let i = 0; i < 20 && s.ONGROUND !== 1; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  // (for the one tic without god mode, the bots hold their fire and nothing is in flight)
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  await db.exec("DELETE FROM ents WHERE classname IN ('rocket', 'grenade', 'plasma', 'bfg')");
  await db.exec(`UPDATE ents SET vz = -900, flags = BIN_AND(flags, BIN_NOT(512 + 16)) WHERE id = ${pe}`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
  await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
  assert(s.LAND_CHANGE === -24 && s.TIME_ - s.LAND_TIME < 0.11, `landing at 900 units a second: the far dip (${s.LAND_CHANGE})`);
  assert(s.DMG_WORLD === 1 && s.DMG_TAKE > 0, `the fall's damage comes from no direction (${s.DMG_TAKE} taken)`);
}
const boom = (await db.query("SELECT COUNT(*) n FROM fx_events WHERE kind = 2")).rows[0].N;
assert(boom > 0, 'the explosion was reported to the browser');

// a jump pad, if the map has one: stand on it and fly
const pad = (await db.query("SELECT FIRST 1 id, x + (minx + maxx) / 2 cx, y + (miny + maxy) / 2 cy, z + maxz + 26 cz, p1z FROM ents WHERE classname = 'trigger_push'")).rows[0];
if (pad) {
  await db.exec(`UPDATE ents SET x = ${pad.CX}, y = ${pad.CY}, z = ${pad.CZ}, vx = 0, vy = 0, vz = 0 WHERE id = (SELECT ent_id FROM player)`);
  await db.exec('EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))');
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const z0 = s.PZ;
  let top = z0;
  for (let i = 0; i < 20; i++) { s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]); top = Math.max(top, s.PZ); }
  assert(top - z0 > 50, `the jump pad threw us up (${(top - z0).toFixed(0)} units, launch vz ${pad.P1Z.toFixed(0)})`);
}

// every sound we queued exists in the pak
// the page's predicted eye: passed through when it is the real one, clamped by a trace when it runs into a wall
{
  const e = (await db.query('SELECT ex, ey, ez, fx, fy FROM view_setup')).rows[0];
  const eyeOf = async (x, y, z) => (await db.query(`SELECT * FROM frame_all(0, 2147483647, 2147483647, 0, ${x}, ${y}, ${z}, 0, 0)`, [], { rowMode: 'array' })).rows.find((r) => r[0] === 10);
  const same = await eyeOf(e.EX, e.EY, e.EZ);
  assert(same && Math.hypot(same[6] - e.EX, same[7] - e.EY, same[8] - e.EZ) < 0.01, 'frame_all paints from the eye it is given');
  const far = [e.EX + e.FX * 4000, e.EY + e.FY * 4000, e.EZ];
  const clamped = await eyeOf(...far);
  const d = Math.hypot(clamped[6] - e.EX, clamped[7] - e.EY, clamped[8] - e.EZ);
  const cl = (await db.query(`SELECT cluster FROM leaves WHERE id = point_leaf(${clamped[6]}, ${clamped[7]}, ${clamped[8]})`)).rows[0].CLUSTER;
  assert(d < 3990 && cl >= 0, `an eye predicted through a wall stops inside the world (${d.toFixed(0)} of 4000 units, cluster ${cl})`);
  // the zoom: the page's field of view culls and projects (CG_CalcFov's cg_zoomFov)
  const faces = async (mode, fov) => (await db.query(`SELECT * FROM frame_all(${mode}, 2147483647, 2147483647, 0, ${e.EX}, ${e.EY}, ${e.EZ}, 0, 0, ${fov})`, [], { rowMode: 'array' })).rows;
  const count = (rows) => rows.filter((r) => r[0] === 1).reduce((n, r) => n + r[16].split(',').length, 0);
  const wide = count(await faces(0, 90)), narrow = count(await faces(0, 22.5));
  assert(narrow > 0 && narrow < wide, `zoomed to 22.5 degrees, fewer faces pass the frustum (${narrow} of ${wide})`);
  // the same vertex, projected in SQL at both: about tan 45° / tan 11.25° = 5.03 times as far from the centre
  const w = (await db.query('SELECT w FROM viewcfg')).rows[0].W;
  const at = (rows) => new Map(rows.filter((r) => r[0] === 8 && r[6] > 16).map((r) => [`${r[1]}:${r[2]}`, r[9] - w / 2]));   // in front of the eye: the ones behind are left for the painter to clip
  const v90 = at(await faces(1, 90)), v22 = at(await faces(1, 22.5));
  const both = [...v22.keys()].filter((k) => v90.has(k) && Math.abs(v90.get(k)) > 2);
  const ratio = both.length ? v22.get(both[0]) / v90.get(both[0]) : 0;
  assert(both.length > 0 && Math.abs(ratio - 5.03) < 0.05, `the SQL projection zooms too: a vertex ${ratio.toFixed(2)} times as far from the centre`);
}

// the end of a match (CheckExitRules, BeginIntermission, CheckIntermissionExit)
{
  const said = async (name) => (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE snd = '${name}'`)).rows[0].N;
  // the bots hold still (a frag of theirs would decide the match before the test does)
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  // a six-minute limit, a moment before 60 s: the five-minute warning
  await db.exec(`UPDATE game SET timelimit = 6, time_warnings = 0, time_ = 59.93 WHERE id = 1`);
  await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
  s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(await said('sound/feedback/5_minute.wav') === 1 && s.TIMELIMIT === 6, 'five minutes left: the announcer says so, once');
  // the clock runs out with the lead tied: sudden death, no end
  await db.exec("UPDATE player SET frags = 3 WHERE id = 1");
  await db.exec("UPDATE ents SET frags = IIF(id = (SELECT MIN(id) FROM ents WHERE classname = 'bot'), 3, 0) WHERE classname = 'bot'");
  await db.exec('UPDATE game SET time_ = 359.9 WHERE id = 1');
  for (let i = 0; i < 3; i++) s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.MATCH_OVER === 0 && await said('sound/feedback/1_minute.wav') === 1, 'time is up with the lead tied: play on');
  for (let i = 0; i < 25; i++) s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.MATCH_OVER === 0 && await said('sound/feedback/sudden_death.wav') === 1, 'two seconds on, still tied: "sudden death"');
  // the tie broken: we win, the view goes to the intermission point, the bots leave
  await db.exec('UPDATE player SET frags = 4 WHERE id = 1');
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const ip = (await db.query("SELECT FIRST 1 ox, oy, oz FROM map_ents WHERE classname = 'info_player_intermission' ORDER BY id")).rows[0];
  const ent = (await db.query('SELECT ex, ey, ez FROM view_setup')).rows[0];
  const shown = (await db.query("SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND alpha = 0")).rows[0].N;
  assert(s.MATCH_OVER === 1 && s.WINNER === 'You', `the frag that breaks the tie wins (${s.WINNER})`);
  assert(!ip || Math.hypot(ent.EX - ip.OX, ent.EY - ip.OY, ent.EZ - ip.OZ) < 1, 'the view is at the info_player_intermission');
  assert(shown === 0, 'the bots have left the arena');
  const rot = (await db.query('SELECT name FROM map_list ORDER BY ord')).rows.map((r) => r.NAME);
  const want = rot[(rot.indexOf(mapName) + 1) % rot.length];
  assert(s.NEXT_MAP === want, `the next arena of the rotation (${rot.join(' → ')}): ${s.NEXT_MAP}`);
  // fire before five seconds does nothing; after, it is time to go
  s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert(s.EXIT_KIND === 0, 'fire in the first five seconds of the intermission is ignored');
  await db.exec(`UPDATE game SET time_ = time_ + 6 WHERE id = 1`);
  s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert(s.EXIT_KIND === 1, 'fire after five seconds: on to the next arena');
}

const snds = (await db.query('SELECT DISTINCT snd FROM sound_events')).rows.map((r) => r.SND);
const missing = snds.filter((n) => !pak.has(n));
assert(missing.length === 0, `all queued sounds exist in the pak (${missing.join(', ') || 'none missing'})`);

const msgs = (await db.query('SELECT msg FROM messages ORDER BY id')).rows.map((r) => r.MSG);
console.log('console:', msgs);
await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
