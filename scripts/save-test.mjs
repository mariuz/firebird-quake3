// save-test.mjs – a save game (sql/save.sql, src/save.js): saved in the middle of a fight, played on, then loaded
// on a fresh arena, the game is back as it was saved (every saved table row for row, the player's state, the
// frame in view, the scores), and it plays on from there (new entities do not take saved ids).
//
//   node scripts/save-test.mjs [map]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, buildWaypoints, SQL_FILES } from '../src/loader.js';
import { exportSave, importSave, saveMap } from '../src/save.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapName = process.argv[2] ?? 'q3dm1';
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, mapName, { skill: 3, bots: 3, link: false });
const q = async (s, p) => (await db.query(s, p)).rows;
const arr = { rowMode: 'array' };
const tic = (fwd, side, yaw, fire) => q('SELECT * FROM q3_tic(1, ?, ?, ?, 0, ?, 0, 1, 0)', [fwd, side, yaw, fire]);
// the graph half built: the save carries the build where it stands
for (let i = 0; i < 160; i++) await buildWaypoints(db, 3, 2);

// play: the rocket launcher, moving, turning and firing, the bots at it
await db.exec('UPDATE player SET weapons = 511, weapon = 16, rockets = 50 WHERE id = 1');
for (let i = 0; i < 100; i++) await tic(1, i % 40 < 20 ? 0.5 : -0.5, 3, i % 8 < 2 || i >= 98 ? 1 : 0);

// what the game is, as rows (the caches of what is in view aside)
// (a brush model by its name: a fresh load of the map numbers the map's models anew)
const dump = async () => {
  const bm = new Map((await db.query("SELECT id, name FROM models WHERE kind = 'B'", [], arr)).rows.map(([id, n]) => [id, n.trim()]));
  const named = (v) => bm.get(v) ?? v;
  return {
  ents: JSON.stringify((await db.query('SELECT * FROM ents ORDER BY id', [], arr)).rows.map((r) => r.map((v, i) => (i === modelId ? named(v) : v)).filter((_, i) => i !== visCl && i !== vis))),
  player: JSON.stringify((await q('SELECT * FROM player'))),
  game: JSON.stringify((await db.query('SELECT * FROM game', [], arr)).rows.map((r) => r.map((v, i) => (i === worldModel ? named(v) : v)))),
  graph: JSON.stringify(await q('SELECT (SELECT COUNT(*) FROM waypoints) n, (SELECT COUNT(*) FROM wp_edges) e, (SELECT SUM(a + b * 3 + kind) FROM wp_edges) s, (SELECT gx + gy * 7 + phase FROM wp_build) b FROM rdb$database')),
  routes: JSON.stringify(await q('SELECT * FROM bot_routes ORDER BY ent_id')),
  scores: JSON.stringify(await q('SELECT * FROM scoreboard')),
  frame: await frameOf(),
  };
};
const fields = (await db.query('SELECT * FROM ents ROWS 1', [], arr)).fields.map((f) => f.name);
const visCl = fields.indexOf('VIS_CL'), vis = fields.indexOf('VIS'), modelId = fields.indexOf('MODEL_ID');
const worldModel = (await db.query('SELECT * FROM game', [], arr)).fields.findIndex((f) => f.name === 'WORLD_MODEL');
// (the eye as view_setup takes it)
const tic0 = async () => (await q('SELECT e.x px, e.y py, e.z + p.view_ofs - p.stepz view_z, e.yaw, p.pitch FROM player p JOIN ents e ON e.id = p.ent_id WHERE p.id = 1'))[0];
const frameOf = async () => {
  const r = await tic0();
  const rows = (await db.query('SELECT * FROM frame_all(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [0, 2147483647, 2147483647, 0, r.PX, r.PY, r.VIEW_Z, r.YAW, r.PITCH, 90], arr)).rows;
  return rows.filter((x) => x[0] === 2 || x[0] === 1).map((x) => x[0] === 1 ? `F${x[2]}:${String(x[16]).length}` : `${x[1]}:${x[2]}:${x[6].toFixed(2)},${x[7].toFixed(2)},${x[8].toFixed(2)}`).sort().join(' ');
};

const before = await dump();
const flying = (await q("SELECT COUNT(*) n FROM ents WHERE classname IN ('rocket', 'plasma', 'grenade', 'bfg')"))[0].N;
const text = JSON.stringify(await exportSave(db));
const save = JSON.parse(text);
assert(saveMap(save) === mapName && save.tables.ents.rows.length > 30 && save.tables.waypoints.rows.length > 0,
  `saved: ${mapName} at ${save.time.toFixed(2)} s, ${save.tables.ents.rows.length} entities (${flying} missiles in flight), ${save.tables.waypoints.rows.length} nodes and ${save.tables.wp_edges.rows.length} edges of the graph; ${(text.length / 1024).toFixed(0)} KB`);

// play on: the game moves away from the save
for (let i = 0; i < 60; i++) await tic(1, 0, -4, 1);
const moved = await dump();
assert(moved.ents !== before.ents && moved.player !== before.player, 'played on, the game is no longer the saved one');

// loaded on a fresh arena: back as it was
await loadMap(db, pak, res, mapName, { skill: 3, bots: 3, link: false });
const t0 = performance.now();
await importSave(db, save);
const ms = performance.now() - t0;
const after = await dump();
const diff = (a, b) => { const x = new Set(a.split(' ')), y = new Set(b.split(' ')); return `only saved: ${[...x].filter((v) => !y.has(v)).join(' ').slice(0, 300)}; only loaded: ${[...y].filter((v) => !x.has(v)).join(' ').slice(0, 300)}`; };
for (const k of Object.keys(before)) assert(after[k] === before[k], `loaded: ${k} as saved${after[k] === before[k] ? '' : ` (${diff(before[k], after[k])})`}`);
console.log(`(loaded in ${ms.toFixed(0)} ms)`);

// and on from there: the bots think, the rockets fly, new ones get ids of their own
const maxId = (await q('SELECT MAX(id) m FROM ents'))[0].M;
// (alive, invulnerable and with the rocket launcher: its rockets are new entities)
if ((await q('SELECT e.deadflag d FROM player p JOIN ents e ON e.id = p.ent_id'))[0].D) await db.exec('EXECUTE PROCEDURE player_respawn');
await db.exec('UPDATE player SET weapons = 511, weapon = 16, rockets = 50, pending_weapon = 0 WHERE id = 1');
await db.exec('UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = (SELECT ent_id FROM player)');
let err = null, newer = 0;
// (counted every tic: a rocket into a near wall is gone the next)
try {
  for (let i = 0; i < 60; i++) {
    await tic(1, 0.3, 2, i % 6 < 2 ? 1 : 0);
    newer = Math.max(newer, (await q(`SELECT COUNT(*) n FROM ents WHERE id > ${maxId}`))[0].N);
  }
} catch (e) { err = e.message; }
const [g] = await q('SELECT tic, time_ FROM game');
assert(!err && newer > 0 && g.TIME_ > save.time + 2.9, `played on after the load: ${err ?? `3 s more (time ${g.TIME_.toFixed(2)}), new entities past the saved ids (${newer} at once)`}`);

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
