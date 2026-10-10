// maps-test.mjs – the map packs the site hosts (scripts/fetch-maps.mjs: OpenArena's arenas and the OpenArena
// Community Map-Pack's), each on top of the Quake III demo pak as the page loads them: every face's
// pictures are there, and the arena loads, spawns its players and plays a second with a bot.
//
//   node scripts/maps-test.mjs [map …]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3, PakSet } from '../src/pk3.js';
import { loadShaders, surfaceLook } from '../src/shader.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public/pak/maps');
if (!fs.existsSync(path.join(dir, 'index.json'))) {
  console.log('no public/pak/maps/index.json: run npm run fetch-maps first');
  process.exit(0);
}
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const only = process.argv.slice(2);
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).filter((m) => !only.length || only.includes(m.map));
// pictures OpenArena itself lacks (it draws its default there too)
const UPSTREAM = new Set(['textures/evil6_trims/e6trim_basic128', 'textures/grass/moss2', 'textures/evil8_wall/e8_mtlwall3']);

const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const demo = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const pak = new PakSet([demo]);
const res = await loadResources(db, pak);
const q = async (s) => (await db.query(s)).rows;

for (const m of index) {
  const pk3 = new Pk3(fs.readFileSync(path.join(dir, m.file)).buffer);
  pk3.label = m.pack;
  pak.add(pk3);
  const shaders = loadShaders(pak);
  res.shaders.clear();
  for (const [k, v] of shaders) res.shaders.set(k, v);
  try {
    const t = performance.now();
    const bsp = await loadMap(db, pak, res, m.map, { skill: 2, bots: 1, link: false });
    // every picture the faces draw resolves (a sky box named "full" is none: ioq3 draws no box then)
    const missing = new Set();
    for (const f of bsp.faces) {
      const name = bsp.textures[f.texture].name;
      const look = surfaceLook(res.shaders, name);
      if (look.nodraw || look.sky || UPSTREAM.has(name.toLowerCase())) continue;
      for (const img of [look.image, look.add?.image, look.env?.image, ...(look.stages ?? []).filter((s) => !s.lightmap).map((s) => s.image)]) if (img && !pak.imageName(img)) missing.add(img);
    }
    for (let i = 0; i < 20; i++) await db.query('SELECT * FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)');
    const alive = (await q("SELECT COUNT(*) n FROM ents WHERE classname IN ('player', 'bot') AND health > 0 AND cluster IS NOT NULL"))[0].N;
    const items = (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'item'"))[0].N;
    assert(missing.size === 0 && alive === 2 && items > 0 && pak.mapSource(m.map) === m.pack,
      `${m.map} (${m.pack}, "${m.title}"): ${bsp.faces.length} faces, ${items} items, ${alive} players in the world, ${(performance.now() - t).toFixed(0)} ms${missing.size ? `; missing ${[...missing].slice(0, 4).join(', ')}` : ''}`);
  } catch (e) {
    assert(false, `${m.map}: ${e.message.split('\n')[0]}`);
  }
  // the next map goes on the demo alone again, as the page stacks one map pack at a time
  pak.reset([demo]);
}
await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
