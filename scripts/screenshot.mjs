// screenshot.mjs – render frames headlessly: the SQL runs in Firebird WASM
// under Node, the painter runs against a stub canvas, and the frames are
// written as PNGs to docs/. Also a convenient end-to-end test.
//
//   node scripts/screenshot.mjs [map] [out-prefix] [--at=x,y,z,yaw] [--sql] [--size=640x480] [--bots=N] [--team] [--scores]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';
import { Renderer } from '../src/renderer.js';
import { Hud } from '../src/hud.js';
import { drawScene, FrameState } from '../src/scene.js';
import { png } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const mapName = args[0] ?? 'q3dm1';
const prefix = args[1] ?? path.join(root, 'docs/screenshot');
const size = (process.argv.find((a) => a.startsWith('--size=')) ?? '--size=320x240').slice(7).split('x').map(Number);
const W = size[0], H = size[1];
const bright = Number((process.argv.find((a) => a.startsWith('--bright=')) ?? '--bright=3').slice(9));
const bots = Number((process.argv.find((a) => a.startsWith('--bots=')) ?? '--bots=3').slice(7));
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));

const stubCanvas = {
  width: W, height: H,
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img) { stubCanvas.image = img; },
  }),
};

const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak, { width: W, height: H });
const bsp = await loadMap(db, pak, res, mapName, { skill: 2, bots, link: false, gametype: process.argv.includes('--team') ? 3 : 0, team: 1 });   // the bots need no routes for a still frame
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
const renderer = new Renderer(stubCanvas, res);
renderer.setSize(W, H);
renderer.setBrightness(bright);
renderer.setResources(res);
renderer.setSky((await db.query('SELECT sky FROM game')).rows[0].SKY);
const hud = new Hud(pak, renderer);

const at = process.argv.find((a) => a.startsWith('--at='));
if (at) {
  const [x, y, z, yaw] = at.slice(5).split(',').map(Number);
  await db.exec(`UPDATE ents SET x = ${x}, y = ${y}, z = ${z}, yaw = ${yaw}, vx = 0, vy = 0, vz = 0 WHERE id = (SELECT ent_id FROM player)`);
  await db.exec('EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))');
}
if (process.argv.includes('--look=bot')) {
  // stand 220 units from the first bot, facing it
  for (let i = 0; i < 10; i++) await db.query('SELECT * FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)');
  const b = (await db.query("SELECT FIRST 1 x, y, z, yaw FROM ents WHERE classname = 'bot'")).rows[0];
  const yaw = b.YAW + 180, rad = (b.YAW * Math.PI) / 180;
  await db.exec(`UPDATE ents SET x = ${b.X + Math.cos(rad) * 220}, y = ${b.Y + Math.sin(rad) * 220}, z = ${b.Z + 4}, yaw = ${yaw}, vx = 0, vy = 0, vz = 0 WHERE id = (SELECT ent_id FROM player)`);
  await db.exec('EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))');
  await db.exec("UPDATE ents SET nextthink = NULL, think = NULL WHERE classname = 'bot'");
}
const tic = (a) => db.query('SELECT * FROM q3_tic(?, ?, ?, ?, ?, ?, ?, ?, ?)', a, { rowMode: 'object' }).then((r) => r.rows[0]);
const arr = { rowMode: 'array' };
const useSql = process.argv.includes('--sql');
const state = new FrameState();

async function shot(name) {
  const last = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const t0 = performance.now();
  const rows = (await db.query(`SELECT * FROM frame_all(${useSql ? 1 : 0}, 0, 0, 1)`, [], arr)).rows;
  const t1 = performance.now();
  const frame = state.parse(rows);
  const scores = process.argv.includes('--scores') ? (await db.query('SELECT * FROM scoreboard', [], arr)).rows : undefined;
  drawScene(renderer, hud, res, bsp, last, frame, { fov: 90, sqlProjected: useSql, scoreboard: !!scores, scores });
  renderer.present();
  const t2 = performance.now();
  console.log(`${name}: ${frame.faces.length} face rows, ${frame.ents.length} ents — query ${(t1 - t0).toFixed(0)} ms, paint ${(t2 - t1).toFixed(0)} ms, at ${last.PX.toFixed(0)},${last.PY.toFixed(0)},${last.PZ.toFixed(0)} yaw ${last.YAW.toFixed(0)}`);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  fs.writeFileSync(`${prefix}-${mapName}-${name}.png`, png(W, H, new Uint8Array(stubCanvas.image.data.buffer)));
}

await shot('0');
for (let i = 0; i < 2; i++) await tic([1, 0, 0, 90, 0, 0, 0, 1, 0]);
await shot('1');
for (let i = 0; i < 40; i++) await tic([1, 1, 0, 0, 0, 0, 0, 1, 0]);
await shot('2');
for (let i = 0; i < 2; i++) await tic([1, 0, 0, 90, 0, 0, 0, 1, 0]);
await shot('3');
await db.close();
process.exit(0);
