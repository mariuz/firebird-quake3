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
import { findPortals, mirrorView } from '../src/scene.js';
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

// mirrors (a misc_portal_surface without a target): from 96 units before one, FRAME_PORTAL gives the reflected
// view's faces and the player's own body, and nothing whose origin is behind the glass
async function mirrors(map, bsp) {
  const ms = findPortals(bsp, (n) => surfaceLook(res.shaders, n)).filter((p) => p.mirror);
  if (!ms.length) return;
  const p = ms[0], [n, d] = p.plane, c = p.center, side = Math.sign(n[0] * p.origin[0] + n[1] * p.origin[1] + n[2] * p.origin[2] - d) || 1;
  const eye = [c[0] + n[0] * 96 * side, c[1] + n[1] * 96 * side, c[2] + n[2] * 96 * side];
  const feet = Math.abs(n[2]) > 0.7 ? [eye[0], eye[1], c[2] + 24 * side] : [eye[0], eye[1], eye[2] - 26];
  await db.exec(`UPDATE ents SET x = ${feet[0]}, y = ${feet[1]}, z = ${feet[2]}, health = 100 WHERE id = (SELECT ent_id FROM player)`);
  await db.exec('EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))');   // its clusters, for the PVS test
  const yaw = (Math.atan2(-n[1] * side, -n[0] * side) * 180) / Math.PI;
  const v = mirrorView(p, { x: eye[0], y: eye[1], z: eye[2], yaw: Math.abs(n[2]) > 0.7 ? 0 : yaw, pitch: Math.abs(n[2]) > 0.7 ? 60 * side : 0, fov: 90 });
  const rows = await q(`SELECT kind, lst, s, d1, d2, d3 FROM frame_portal(${v.x}, ${v.y}, ${v.z}, ${v.fwd.join(', ')}, ${v.right.join(', ')}, ${v.up.join(', ')}, 90, ${v.pvs.join(', ')}, ${v.clip.join(', ')})`);
  const faces = rows.filter((r) => r.KIND === 1).flatMap((r) => String(r.LST).split(',')).length;
  const me = rows.some((r) => r.KIND === 2 && String(r.LST).endsWith(',player'));
  const behind = rows.filter((r) => r.KIND === 2 && r.D1 * v.clip[0] + r.D2 * v.clip[1] + r.D3 * v.clip[2] < v.clip[3]).length;
  assert(faces > 0 && me && behind === 0, `${map}: ${ms.length} mirrors; before one, its view has ${faces} faces, ${me ? 'the player\'s body' : 'NOT the player\'s body'}, ${behind} models behind the glass`);
}

// area portals (CM_AdjustAreaPortalState): a door between two areas keeps the far one's faces out of the
// view while it is shut, lets them in while it is open, and shuts them out again when it closes
async function areaPortals(map) {
  const [door] = await q('SELECT FIRST 1 e.id, e.area1, e.area2, e.x + (e.minx + e.maxx) / 2 cx, e.y + (e.miny + e.maxy) / 2 cy, e.z + (e.minz + e.maxz) / 2 cz FROM ents e WHERE e.classname = \'func_door\' AND e.area2 IS NOT NULL AND e.linked_id IS NULL ORDER BY e.id');
  if (!door) return;
  const pe = (await q('SELECT player_ent() pe FROM rdb$database'))[0].PE;
  // the others hold still, out of the way
  await db.exec("UPDATE ents SET think = NULL, nextthink = NULL, solid = 0, x = -99999, y = -99999, z = -99999, vx = 0, vy = 0, vz = 0 WHERE classname = 'bot'");
  // stand in the near area, by the door: the middle of the nearest leaf of that area the door reaches
  const [spot] = await q(`SELECT FIRST 1 (l.minx + l.maxx) / 2 x, (l.miny + l.maxy) / 2 y, l.minz + 40 z FROM leaves l
     WHERE l.area = ${door.AREA1} AND l.cluster >= 0 AND (SELECT a.area FROM leaves a WHERE a.id = point_leaf((l.minx + l.maxx) / 2, (l.miny + l.maxy) / 2, l.minz + 40)) = ${door.AREA1}
     ORDER BY ABS((l.minx + l.maxx) / 2 - ${door.CX}) + ABS((l.miny + l.maxy) / 2 - ${door.CY}) + ABS(l.minz + 40 - ${door.CZ})`);
  await db.exec(`UPDATE ents SET x = ${spot.X}, y = ${spot.Y}, z = ${spot.Z}, vx = 0, vy = 0, vz = 0, flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  const farFaces = async () => {
    await q(`SELECT kind FROM frame_all(0, 0, 0, 0, ${spot.X}, ${spot.Y}, ${spot.Z + 20}, 0, 0, 90)`);
    const lf = (a) => `SELECT lf.face FROM leaves l JOIN leaffaces lf ON lf.id >= l.first_lf AND lf.id < l.first_lf + l.num_lf WHERE l.area = ${a}`;
    return (await q(`SELECT COUNT(*) n FROM vis_faces v WHERE v.face IN (${lf(door.AREA2)}) AND v.face NOT IN (${lf(door.AREA1)})`))[0].N;
  };
  const conn = async () => (await q(`SELECT areas_connected(${door.AREA1}, ${door.AREA2}) c FROM rdb$database`))[0].C;
  const shut = [await conn(), await farFaces()];
  await db.exec(`EXECUTE PROCEDURE door_use(${door.ID}, ${pe})`);
  const open = [await conn(), await farFaces()];
  // out of its trigger and its way, so it shuts after its wait
  await db.exec(`UPDATE ents SET solid = 0 WHERE classname = 'door_trigger' AND owner_id = ${door.ID}`);
  await db.exec(`UPDATE ents SET solid = 0, movetype = 0, x = -99999, y = -99999, z = -99999 WHERE id = ${pe}`);
  let tics = 0;
  while (tics < 400 && (await q(`SELECT mv_state FROM ents WHERE id = ${door.ID}`))[0].MV_STATE !== 1) { await q('SELECT * FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)'); tics++; }
  await db.exec(`UPDATE ents SET solid = 3, movetype = 3, x = ${spot.X}, y = ${spot.Y}, z = ${spot.Z} WHERE id = ${pe}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  const again = [await conn(), await farFaces()];
  assert(shut[0] === 0 && shut[1] === 0 && open[0] === 1 && open[1] > 0 && again[0] === 0 && again[1] === 0,
    `${map}: the door between areas ${door.AREA1} and ${door.AREA2}: shut ${shut[1]} faces of the far area marked (connected ${shut[0]}), open ${open[1]} (${open[0]}), shut again after ${tics} tics ${again[1]} (${again[0]})`);
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
    await mirrors(m.map, bsp);
    await areaPortals(m.map);
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
