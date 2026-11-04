// demo-test.mjs – a demo (CL_Record, CL_PlayDemo): a match recorded snapshot by snapshot and played back with the
// game not running gives back, tic by tic, the rows the page painted: the player's state, the models in view with
// their poses, the sounds and the effects; at its end the arena starts again.
//
//   node scripts/demo-test.mjs [map]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';
import { exportDemo, importDemo } from '../src/demo.js';

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

// the frame as the page asks for it, from the row's eye (no prediction), reduced to what is painted
let lastSound = 0, lastFx = 0;
const frameOf = async (row) => {
  const rows = (await db.query('SELECT * FROM frame_all(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [0, lastSound, lastFx, 0, row.PX, row.PY, row.VIEW_Z, row.YAW, row.PITCH, 90], arr)).rows;
  const models = [], sounds = [], fx = [];
  for (const r of rows) {
    if (r[0] === 2) models.push(`${r[1]}:${r[2]}:${r[3]}:${r[4]}:${r[6].toFixed(1)},${r[7].toFixed(1)},${r[8].toFixed(1)}:${r[10].toFixed(1)}:${r[15] ?? ''}:${r[16]}`);
    if (r[0] === 4) { sounds.push(r[15]); lastSound = Math.max(lastSound, r[1]); }
    if (r[0] === 5) { fx.push(`${r[2]}:${r[6].toFixed(1)},${r[7].toFixed(1)},${r[8].toFixed(1)}`); lastFx = Math.max(lastFx, r[1]); }
  }
  return { models: models.sort().join(' '), sounds: sounds.join(' '), fx: fx.join(' ') };
};
const KEYS = ['TIC', 'TIME_', 'HEALTH', 'ARMOR', 'WEAPON', 'PX', 'PY', 'PZ', 'YAW', 'PITCH', 'VIEW_Z', 'FRAGS', 'DEAD', 'MSG', 'BULLETS'];
const sig = (r) => KEYS.map((k) => (typeof r[k] === 'number' ? r[k].toFixed(3) : String(r[k]))).join('|');

// record: forward and turning, firing now and then (from now on: what came before is not in the demo)
lastSound = (await q('SELECT COALESCE(MAX(id), 0) m FROM sound_events'))[0].M;
lastFx = (await q('SELECT COALESCE(MAX(id), 0) m FROM fx_events'))[0].M;
const [{ DEMO_ID: did }] = await q('SELECT * FROM demo_record_start');
const live = [];
let tTic = 0;
for (let i = 0; i < 120; i++) {
  const t = performance.now();
  const [row] = await q('SELECT * FROM q3_tic(?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, 1, i % 40 < 20 ? 0.5 : -0.5, 3, 0, i % 10 < 4 ? 1 : 0, 0, 1, 0]);
  tTic += performance.now() - t;
  live.push({ row: sig(row), frame: await frameOf(row) });
}
await db.exec('EXECUTE PROCEDURE demo_record_stop');
const [dm] = await q(`SELECT frames, seconds, (SELECT COUNT(*) FROM demo_ents e WHERE e.demo_id = ${did}) ents, (SELECT COUNT(*) FROM demo_ents e WHERE e.demo_id = ${did} AND e.n = 0) base,
                             (SELECT COUNT(*) FROM demo_sounds s WHERE s.demo_id = ${did}) snds, (SELECT COUNT(*) FROM demo_fx s WHERE s.demo_id = ${did}) fxs FROM demos WHERE id = ${did}`);
assert(dm.FRAMES === 120 && Math.abs(dm.SECONDS - 5.95) < 0.01 && dm.BASE > 30 && dm.ENTS - dm.BASE < 119 * 40 && dm.SNDS > 0 && dm.FXS > 0,
  `recorded: ${dm.FRAMES} snapshots, ${dm.SECONDS.toFixed(2)} s; ${dm.BASE} entities in the first, ${dm.ENTS - dm.BASE} changed in the rest (${((dm.ENTS - dm.BASE) / 119).toFixed(1)} a snapshot); ${dm.SNDS} sounds, ${dm.FXS} effects`);

// what recording costs a tic
let tPlain = 0;
for (let i = 0; i < 60; i++) { const t = performance.now(); await q('SELECT * FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)'); tPlain += performance.now() - t; }
console.log(`(a tic ${(tPlain / 60).toFixed(1)} ms, recording ${(tTic / 120).toFixed(1)} ms)`);

// play it back: the arena's entities give way to the demo's, the game does not run
await db.exec(`EXECUTE PROCEDURE demo_play_start(${did})`);
lastSound = (await q('SELECT COALESCE(MAX(id), 0) m FROM sound_events'))[0].M;
lastFx = (await q('SELECT COALESCE(MAX(id), 0) m FROM fx_events'))[0].M;
let same = 0, firstBad = null;
for (let i = 0; i < 120; i++) {
  const [row] = await q('SELECT * FROM demo_play(1)');
  const fr = await frameOf(row);
  const ok = sig(row) === live[i].row && fr.models === live[i].frame.models && fr.sounds === live[i].frame.sounds && fr.fx === live[i].frame.fx;
  if (ok) same++;
  else if (!firstBad) firstBad = { i, row: [sig(row), live[i].row], models: [fr.models, live[i].frame.models], sounds: [fr.sounds, live[i].frame.sounds], fx: [fr.fx, live[i].frame.fx] };
}
if (firstBad) console.log('first difference', JSON.stringify(firstBad, null, 1).slice(0, 3000));
assert(same === 120, `played back, every snapshot is what was painted (${same} of 120: the player's row, the models and poses in view, the sounds, the effects)`);
const [end] = await q('SELECT * FROM demo_play(1)');
const [g] = await q('SELECT demo_play FROM game');
assert(end.EXIT_KIND === 3 && g.DEMO_PLAY === null, `at the end the arena starts again (exit ${end.EXIT_KIND}, playing ${g.DEMO_PLAY})`);

// two tics a call (the page's catch-up) still lands on the recorded snapshots
await db.exec(`EXECUTE PROCEDURE demo_play_start(${did})`);
const [r2] = await q('SELECT * FROM demo_play(2)');
const [r3] = await q('SELECT * FROM demo_play(2)');
assert(sig(r2) === live[1].row && sig(r3) === live[3].row, `two tics a call: the 2nd and 4th snapshots (${r2.TIC}, ${r3.TIC})`);

// saved to a file and loaded back (the page's Save and Load): the same demo under a new id
const text = JSON.stringify(await exportDemo(db, did));
const did2 = await importDemo(db, JSON.parse(text));
await db.exec(`EXECUTE PROCEDURE demo_play_start(${did2})`);
let same2 = 0;
for (let i = 0; i < 120; i++) { const [row] = await q('SELECT * FROM demo_play(1)'); if (sig(row) === live[i].row) same2++; }
assert(did2 !== did && same2 === 120, `saved (${(text.length / 1024).toFixed(0)} KB for ${dm.SECONDS.toFixed(0)} s) and loaded back as demo ${did2}: ${same2} of 120 snapshots the same`);

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
