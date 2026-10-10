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

// target_push (Use_target_push): the activator takes its velocity, and its sound plays once in 1.5 s
async function targetPushes(map) {
  const pushes = await q("SELECT e.id, e.p1x, e.p1y, e.p1z, e.noise1 FROM ents e WHERE e.classname = 'target_push'");
  if (!pushes.length) return;
  const pe = (await q('SELECT player_ent() pe FROM rdb$database'))[0].PE;
  await db.exec('UPDATE player SET flight_finished = 0 WHERE id = 1');
  let ok = 0;
  for (const p of pushes) {
    await db.exec(`UPDATE ents SET fly_sound_time = 0 WHERE id = ${pe}`);
    await db.exec('DELETE FROM sound_events');
    await db.exec(`EXECUTE PROCEDURE push_use(${p.ID}, ${pe})`);
    await db.exec(`EXECUTE PROCEDURE push_use(${p.ID}, ${pe})`);
    const [v] = await q(`SELECT vx, vy, vz FROM ents WHERE id = ${pe}`);
    const snds = (await q(`SELECT COUNT(*) n FROM sound_events WHERE snd = '${p.NOISE1}'`))[0].N;
    if (Math.hypot(v.VX - p.P1X, v.VY - p.P1Y, v.VZ - p.P1Z) < 1e-6 && Math.hypot(p.P1X, p.P1Y, p.P1Z) > 0 && snds === 1) ok++;
  }
  assert(ok === pushes.length, `${map}: ${ok} of ${pushes.length} target_push give their activator their velocity, the sound once`);
}

// shooter_* (Use_Shooter): a missile of its kind toward its target; a kill by one is the world's ("died", a frag lost)
async function shooters(map) {
  const sh = await q("SELECT e.id, e.classname, e.weapon, e.target FROM ents e WHERE e.classname LIKE 'shooter%'");
  if (!sh.length) return;
  let ok = 0;
  for (const s of sh) {
    await db.exec(`EXECUTE PROCEDURE shooter_use(${s.ID})`);
    const want = { 8: 'grenade', 16: 'rocket', 128: 'plasma' }[s.WEAPON];
    const [mis] = await q(`SELECT e.vx, e.vy, e.vz, e.x, e.y, e.z FROM ents e WHERE e.owner_id = ${s.ID} AND e.classname = '${want}'`);
    const [tg] = await q(`SELECT e.x, e.y, e.z FROM ents e WHERE e.targetname = '${s.TARGET}'`);
    // the spread is at most 45 degrees a side here: the shot heads more toward the target than away
    if (mis && tg && (tg.X - mis.X) * mis.VX + (tg.Y - mis.Y) * mis.VY + (tg.Z - mis.Z) * mis.VZ > 0) ok++;
  }
  assert(ok === sh.length, `${map}: ${ok} of ${sh.length} shooters fire a missile of their kind toward their target`);
  const [b] = await q("SELECT FIRST 1 e.id, e.frags FROM ents e WHERE e.classname = 'bot'");
  await db.exec(`EXECUTE PROCEDURE t_damage(${b.ID}, ${sh[0].ID}, ${sh[0].ID}, 1000, 0, 8, 7)`);
  const [a] = await q(`SELECT e.frags, e.health FROM ents e WHERE e.id = ${b.ID}`);
  const [msg] = await q("SELECT FIRST 1 msg FROM messages WHERE msg NOT CONTAINING ':' ORDER BY id DESC");   // not the bot's chat after it
  assert(a.HEALTH <= 0 && a.FRAGS === b.FRAGS - 1 && /\bdied\.$/.test(msg?.MSG ?? ''), `${map}: a shooter's kill is the world's: "${msg?.MSG}", frags ${b.FRAGS} → ${a.FRAGS}`);
}

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
    await targetPushes(m.map);
    await shooters(m.map);
  } catch (e) {
    assert(false, `${m.map}: ${e.message.split('\n')[0]}`);
  }
  // the next map goes on the demo alone again, as the page stacks one map pack at a time
  pak.reset([demo]);
}
await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
