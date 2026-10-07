// raster-bench.mjs – where does the painter spend its time? Paints the same frame N times.
//   node scripts/raster-bench.mjs [map] [--n=30] [--size=320x240] [--at=x,y,z,yaw]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';
import { Renderer } from '../src/renderer.js';
import { Hud } from '../src/hud.js';
import { drawScene, FrameState } from '../src/scene.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 30);
const size = (process.argv.find((a) => a.startsWith('--size=')) ?? '--size=320x240').slice(7).split('x').map(Number);
const [W, H] = size;
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const stub = { width: W, height: H, getContext: () => ({ createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak, { width: W, height: H });
const bsp = await loadMap(db, pak, res, args[0] ?? 'q3dm1', { skill: 2, bots: 3 });
const at = process.argv.find((a) => a.startsWith('--at='));
if (at) { const [x, y, z, yaw] = at.slice(5).split(',').map(Number); await db.exec(`UPDATE ents SET x = ${x}, y = ${y}, z = ${z}, yaw = ${yaw} WHERE id = (SELECT ent_id FROM player)`); await db.exec('EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))'); }
const renderer = new Renderer(stub, res);
renderer.setSize(W, H); renderer.setBrightness(4); renderer.setResources(res);
renderer.setSky((await db.query('SELECT sky FROM game')).rows[0].SKY);
const hud = new Hud(pak, renderer);
const state = new FrameState();
const last = (await db.query('SELECT * FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)')).rows[0];
const rows = (await db.query('SELECT * FROM frame_all(0, 0, 0, 1)', [], { rowMode: 'array' })).rows;
const frame = state.parse(rows);
const paint = () => { drawScene(renderer, hud, res, bsp, last, frame, { fov: 90, state }); renderer.present(); };
paint();
let t0 = performance.now();
for (let i = 0; i < N; i++) paint();
console.log(`${W}×${H}, ${frame.faces.length} faces, ${frame.ents.length} ents: ${((performance.now() - t0) / N).toFixed(1)} ms a frame`);
t0 = performance.now();
for (let i = 0; i < N; i++) { renderer.beginFrame({ x: last.PX, y: last.PY, z: last.VIEW_Z, yaw: last.YAW, pitch: last.PITCH, fov: 90 }); renderer.drawFaceList(frame.faces, last.TIME_, state.brushAngles); renderer.drawAlphaPolys(); }
console.log(`world faces only: ${((performance.now() - t0) / N).toFixed(1)} ms`);
t0 = performance.now();
for (let i = 0; i < N; i++) { renderer.beginFrame({ x: last.PX, y: last.PY, z: last.VIEW_Z, yaw: last.YAW, pitch: last.PITCH, fov: 90 }); }
console.log(`clear only: ${((performance.now() - t0) / N).toFixed(1)} ms`);
await db.close();
process.exit(0);
