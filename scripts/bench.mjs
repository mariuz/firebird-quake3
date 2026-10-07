// bench.mjs – where does a tic and a frame spend their time?
//   node scripts/bench.mjs [map]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, process.argv[2] ?? 'q3dm1', { skill: 2, bots: 3 });
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
const t = () => performance.now();
async function time(label, q, n = 5) {
  const t0 = t();
  let r;
  for (let i = 0; i < n; i++) r = await db.query(q, [], { rowMode: 'array' });
  console.log(`${label.padEnd(44)} ${((t() - t0) / n).toFixed(1)} ms  (${r.rows.length} rows)`);
  return r;
}
const q1 = (s) => db.query(s).then((r) => r.rows[0]);
const pe = (await q1('SELECT ent_id e FROM player')).E;
const p = await q1(`SELECT x, y, z FROM ents WHERE id = ${pe}`);
await time('tic (1 tic, idle)', 'SELECT * FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)');
await time('tic (1 tic, running)', 'SELECT * FROM q3_tic(1, 1, 0, 0, 0, 0, 0, 1, 0)');
await time('player_think only', 'EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE player_think(0.05, 1, 0, 0, 0, 0, 0, 1, 0); END');
await time('run_pushers', 'EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE run_pushers(0.05); END');
await time('run_physics', 'EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE run_physics(0.05); END');
await time('trace_move (player box, 100 units fwd)', `SELECT * FROM trace_move(${pe}, -15, -15, -24, 15, 15, 32, ${p.X}, ${p.Y}, ${p.Z}, ${p.X + 100}, ${p.Y}, ${p.Z}, 33619969)`);
await time('trace_move (point, 2048 units)', `SELECT * FROM trace_move(${pe}, 0, 0, 0, 0, 0, 0, ${p.X}, ${p.Y}, ${p.Z + 26}, ${p.X + 2048}, ${p.Y}, ${p.Z + 26}, 100663297)`);
await time('trace_hull world only (box)', `SELECT * FROM trace_hull(0, 0, 0, 0, -15, -15, -24, 15, 15, 32, ${p.X}, ${p.Y}, ${p.Z}, ${p.X + 100}, ${p.Y}, ${p.Z}, 33619969)`);
await time('ground trace (0.25 down)', `SELECT * FROM trace_move(${pe}, -15, -15, -24, 15, 15, 32, ${p.X}, ${p.Y}, ${p.Z}, ${p.X}, ${p.Y}, ${p.Z - 0.25}, 33619969)`);
await time('point_leaf', `SELECT point_leaf(${p.X}, ${p.Y}, ${p.Z}) FROM rdb$database`);
await time('point_contents', `SELECT point_contents(${p.X}, ${p.Y}, ${p.Z}) FROM rdb$database`);
await time('link_ent(player)', `EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE link_ent(${pe}); END`);
await time('check_water(player)', `SELECT * FROM check_water(${pe})`);
await time('fly_move', `SELECT * FROM fly_move(${pe}, 0.05)`);
await time('walk_move', `EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE walk_move(${pe}, 0.05); END`);
await time('touch_triggers', `EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE touch_triggers(${pe}); END`);
const b = (await q1("SELECT FIRST 1 id FROM ents WHERE classname = 'bot'"))?.ID;
if (b) {
  await time('bot_think', `EXECUTE BLOCK AS BEGIN EXECUTE PROCEDURE bot_think(${b}); END`);
  await time('bot_find_target', `SELECT bot_find_target(${b}) FROM rdb$database`);
  await time('visible(bot, player)', `SELECT visible(${b}, ${pe}) FROM rdb$database`);
  await time('move_step', `SELECT move_step(${b}, 5, 5, 0) FROM rdb$database`);
}
await time('view_setup', 'SELECT * FROM view_setup');
await time('frame_faces_fast', 'SELECT * FROM frame_faces_fast');
await time('frame_ents', 'SELECT * FROM frame_ents');
await time('frame_all (fast)', 'SELECT * FROM frame_all(0, 0, 0, 1)');
await time('frame_faces (SQL projection)', 'SELECT * FROM frame_faces');
const v = await q1('SELECT * FROM view_setup');
await time('mark faces (insert distinct)', `EXECUTE BLOCK AS BEGIN DELETE FROM vis_faces; UPDATE viewcfg SET vis_cluster = NULL; EXECUTE PROCEDURE mark_faces('${v.PVS}', ${v.CLUSTER}); END`);
await db.close();
process.exit(0);
