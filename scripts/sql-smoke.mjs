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
assert(s.ONGROUND === 1, 'player is on the ground after walking');

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
s = await tic([1, 0, 0, 0, 85, 1, 0, 1, 0]);
for (let i = 0; i < 20; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
assert(s.HEALTH < hpBefore, `rocket at our feet hurt us (health ${hpBefore} → ${s.HEALTH})`);
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
const snds = (await db.query('SELECT DISTINCT snd FROM sound_events')).rows.map((r) => r.SND);
const missing = snds.filter((n) => !pak.has(n));
assert(missing.length === 0, `all queued sounds exist in the pak (${missing.join(', ') || 'none missing'})`);

const msgs = (await db.query('SELECT msg FROM messages ORDER BY id')).rows.map((r) => r.MSG);
console.log('console:', msgs);
await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
