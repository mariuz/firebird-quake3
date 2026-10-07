// loader.js – copy a PK3's models and a BSP into Firebird.
//
// Shared by the browser (src/main.js) and the Node tests (scripts/*.mjs), so
// CI exercises exactly the SQL the page runs.
//
// Bulk loading: the WASM build binds parameters as text, so each table has a
// generated LOAD_<table> procedure that takes a 30 KB chunk of '|'-separated
// lines and parses it in PSQL. That is 2–3× faster than a block of INSERTs.

import { Bsp, parseVec, SURF, CONTENTS } from './bsp.js';
import { Md3, parseAnimationCfg, parseSkin } from './md3.js';
import { loadShaders, surfaceLook } from './shader.js';
import { loadBotChat } from './botchat.js';
import { ITEMS, BOTS } from './gamedata.js';

const CHUNK = 30000;

// column specs: name:type where type ∈ i (integer) d (double) s (string)
const TABLES = {
  nodes: 'id:i nx:d ny:d nz:d dist:d ptype:i c0:i c1:i cc0:i cc1:i',
  leaves: 'id:i contents:i cluster:i area:i minx:d miny:d minz:d maxx:d maxy:d maxz:d first_lf:i num_lf:i first_lb:i num_lb:i pvs:s',
  leaffaces: 'id:i face:i',
  leafbrushes: 'id:i brush:i',
  brushes: 'id:i contents:i first_side:i num_sides:i facet:i minx:d miny:d minz:d maxx:d maxy:d maxz:d',
  brushsides: 'id:i nx:d ny:d nz:d dist:d flags:i',
  faces: 'id:i model_id:i nx:d ny:d nz:d dist:d twosided:i ftype:i nverts:i tex:i flags:i cx:d cy:d cz:d radius:d',
  face_verts: 'face:i seq:i x:d y:d z:d s:d t:d u:d v:d',
  textures: 'id:i name:s flags:i contents:i',
  models: 'id:i name:s kind:s minx:d miny:d minz:d maxx:d maxy:d maxz:d headnode:i first_face:i num_faces:i nframes:i flags:i radius:d',
  map_ents: 'id:i classname:s targetname:s target:s team:s model:s ox:d oy:d oz:d angle:d apitch:d ayaw:d aroll:d spawnflags:i message:s wait_:d delay:d random_:d speed:d lip:d height:d health:i light:i dmg:i count_:i noise:s phase:d gravity:d music:s notfree:i nobots:i',
};

const SQL_TYPE = { i: 'INTEGER', d: 'DOUBLE PRECISION', s: 'VARCHAR(2048) CHARACTER SET ASCII' };

/** The LOAD_<table> procedures, generated from the column specs. */
export function loaderSql() {
  let out = 'SET TERM ^ ;\n';
  for (const [table, spec] of Object.entries(TABLES)) {
    const cols = spec.split(' ').map((c) => c.split(':'));
    out += `CREATE OR ALTER PROCEDURE load_${table} (s VARCHAR(32000) CHARACTER SET ASCII) AS\n`;
    out += 'DECLARE p INTEGER = 1; DECLARE q INTEGER; DECLARE e INTEGER; DECLARE len INTEGER; DECLARE f VARCHAR(2048) CHARACTER SET ASCII;\n';
    for (const [name, type] of cols) out += `DECLARE v_${name} ${SQL_TYPE[type]};\n`;
    out += 'BEGIN\n  len = CHAR_LENGTH(s);\n  WHILE (p <= len) DO BEGIN\n';
    out += "    e = POSITION(ASCII_CHAR(10), s, p); IF (e = 0) THEN e = len + 1;\n";
    cols.forEach(([name, type], i) => {
      const last = i === cols.length - 1;
      out += last
        ? `    f = SUBSTRING(s FROM p FOR e - p);\n`
        : `    q = POSITION('|', s, p); f = SUBSTRING(s FROM p FOR q - p); p = q + 1;\n`;
      out += type === 's'
        ? `    v_${name} = NULLIF(f, '');\n`
        : `    v_${name} = CAST(NULLIF(f, '') AS ${SQL_TYPE[type]});\n`;
    });
    out += `    INSERT INTO ${table} (${cols.map((c) => c[0]).join(', ')}) VALUES (${cols.map((c) => ':v_' + c[0]).join(', ')});\n`;
    out += '    p = e + 1;\n  END\nEND^\n';
  }
  return out + 'SET TERM ; ^\n';
}

const num = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v));
const str = (v) => (v === null || v === undefined ? '' : String(v).replace(/[|\n\r]/g, ' ').replace(/[^\x20-\x7e]/g, '?'));

/** rows: arrays of values in column order. */
export async function bulkLoad(db, table, rows) {
  const lines = rows.map((r) => r.map((v) => (typeof v === 'string' ? str(v) : num(v))).join('|'));
  let chunk = '';
  const flush = async () => {
    if (chunk) await db.query(`EXECUTE PROCEDURE load_${table}(?)`, [chunk]);
    chunk = '';
  };
  for (const line of lines) {
    if (chunk.length + line.length + 1 > CHUNK) await flush();
    chunk += line + '\n';
  }
  await flush();
}

export const SQL_FILES = ['schema', 'physics', 'game', 'waypoints', 'player', 'bots', 'render'];

export async function createSchema(db, sql) {
  await db.exec(sql.schema);
  await db.exec(loaderSql());
  for (const f of SQL_FILES.slice(1)) await db.exec(sql[f]);
}

/**
 * Resources: everything that does not change between maps – the MD3 models,
 * the player models with their animations and skins, the item and bot
 * definitions, the shader scripts. Returns the registry the painter needs.
 */
export async function loadResources(db, pak, { width = 320, height = 240, fov = 90 } = {}) {
  await db.exec('DELETE FROM models; DELETE FROM item_defs; DELETE FROM bot_defs; DELETE FROM game; DELETE FROM player; DELETE FROM viewcfg; DELETE FROM messages; ' +
    'DELETE FROM face_verts; DELETE FROM faces; DELETE FROM textures; DELETE FROM nodes; DELETE FROM leaves; DELETE FROM leaffaces; DELETE FROM leafbrushes; ' +
    'DELETE FROM brushes; DELETE FROM brushsides; DELETE FROM ents; DELETE FROM map_ents');

  const shaders = loadShaders(pak);
  const res = { models: new Map(), byName: new Map(), nextModel: 1, pak, shaders, players: new Map(), look: (name) => surfaceLook(shaders, name) };
  const modelRows = [];
  for (const name of pak.list('models/', '.md3')) {
    let m;
    try { m = new Md3(pak.buffer(name), name); } catch (e) { console.warn(e.message); continue; }
    const id = res.nextModel++;
    res.models.set(id, { id, name, kind: 'M', mdl: m });
    res.byName.set(name, id);
    const f0 = m.frames[0] ?? { mins: [-8, -8, -8], maxs: [8, 8, 8] };
    modelRows.push([id, name, 'M', f0.mins[0], f0.mins[1], f0.mins[2], f0.maxs[0], f0.maxs[1], f0.maxs[2], null, null, null, m.numFrames, m.flags, m.radius]);
  }
  // sprites: a picture drawn facing the camera (the plasma ball)
  for (const name of pak.list('sprites/')) {
    if (!/.(tga|jpg)$/.test(name)) continue;
    const base = name.replace(/.(tga|jpg)$/, '');
    if (res.byName.has(base)) continue;
    const id = res.nextModel++;
    res.models.set(id, { id, name: base, kind: 'S', size: 24 });
    res.byName.set(base, id);
    modelRows.push([id, base, 'S', -12, -12, -12, 12, 12, 12, null, null, null, 1, 0, 16]);
  }
  await bulkLoad(db, 'models', modelRows);

  // player models: models/players/<name>/{lower,upper,head}.md3 + animation.cfg + *.skin
  const dirs = new Set(pak.list('models/players/').map((n) => n.split('/')[2]));
  for (const pm of dirs) {
    const dir = `models/players/${pm}/`;
    if (!pak.has(dir + 'lower.md3') || !pak.has(dir + 'upper.md3') || !pak.has(dir + 'head.md3') || !pak.has(dir + 'animation.cfg')) continue;
    const part = (n) => res.models.get(res.byName.get(dir + n + '.md3')).mdl;
    const skins = new Map();
    for (const f of pak.list(dir, '.skin')) {
      const m = /\/(lower|upper|head)_([a-z0-9]+)\.skin$/.exec(f);
      if (!m) continue;
      if (!skins.has(m[2])) skins.set(m[2], new Map());
      for (const [surf, img] of parseSkin(pak.text(f))) skins.get(m[2]).set(surf, img);
    }
    res.players.set(pm, { name: pm, lower: part('lower'), upper: part('upper'), head: part('head'), anims: parseAnimationCfg(pak.text(dir + 'animation.cfg')), skins });
  }

  const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const items = ITEMS.map((it) => `INSERT INTO item_defs (cls, kind, model, snd, name, qty, respawn, bit) VALUES (${lit(it.cls)}, ${lit(it.kind)}, ${lit(it.models.split(',')[0])}, ${lit(it.snd)}, ${lit(it.name)}, ${it.qty}, ${it.respawn}, ${it.bit ?? 0});`).join('\n');
  const bots = BOTS.filter((b) => res.players.has(b.model)).map((b) => `INSERT INTO bot_defs (name, model, skin, skill) VALUES (${lit(b.name)}, ${lit(b.model)}, ${lit(b.skin)}, ${b.skill});`).join('\n');
  await db.exec(`SET TERM ^ ;\nEXECUTE BLOCK AS BEGIN\n${items}\n${bots}\nEND^\nSET TERM ; ^`);
  await db.exec('INSERT INTO game (id) VALUES (1); INSERT INTO player (id) VALUES (1)');
  // the bots' chat files (src/botchat.js), in blocks of statements
  const chat = loadBotChat(pak, BOTS.filter((b) => res.players.has(b.model)));
  await db.exec('DELETE FROM bot_chat; DELETE FROM bot_rnd; DELETE FROM bot_chatchar');
  const stmts = [
    ...chat.rnd.map(([n, i, m]) => `INSERT INTO bot_rnd (name, idx, msg) VALUES (${lit(n)}, ${i}, ${lit(m)});`),
    ...chat.chat.map(([b, ty, i, m]) => `INSERT INTO bot_chat (bot, ctype, idx, msg) VALUES (${lit(b)}, ${lit(ty)}, ${i}, ${lit(m)});`),
    ...chat.chars.map(([b, s, k, v]) => `INSERT INTO bot_chatchar (bot, skill, ckey, val) VALUES (${lit(b)}, ${s}, ${lit(k)}, ${v});`),
  ];
  // (200 at a time: one statement may name tables at most 256 times)
  for (let i = 0; i < stmts.length; i += 200) await db.exec(`SET TERM ^ ;\nEXECUTE BLOCK AS BEGIN\n${stmts.slice(i, i + 200).join('\n')}\nEND^\nSET TERM ; ^`);
  // the rotation: the pak's arenas in natural order (q3dm1, q3dm7, q3dm17, q3tourney2)
  const maps = pak.mapNames().slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  await db.exec('DELETE FROM map_list');
  if (maps.length) await db.exec(`SET TERM ^ ;\nEXECUTE BLOCK AS BEGIN\n${maps.map((m, i) => `INSERT INTO map_list (ord, name) VALUES (${i}, ${lit(m)});`).join('\n')}\nEND^\nSET TERM ; ^`);
  await setView(db, width, height, fov);
  res.items = ITEMS;
  return res;
}

export async function setView(db, width, height, fov = 90) {
  await db.exec(`UPDATE OR INSERT INTO viewcfg (id, w, h, fov, near_z) VALUES (1, ${width}, ${height}, ${fov}, 4) MATCHING (id)`);
}

/**
 * Rows for one BSP's geometry. Faces, nodes, leaves, brushes and their index
 * tables all use the BSP's own indices (one map is loaded at a time).
 */
function geometryRows(bsp, res) {
  const out = { faces: [], faceVerts: [], textures: [], models: [], nodes: [], leaves: [], leaffaces: [], leafbrushes: [], brushes: [], brushsides: [], modelIds: [], modelInfo: new Map() };

  bsp.textures.forEach((t, i) => out.textures.push([i, t.name, t.flags, t.contents]));
  const modelOfFace = new Int32Array(bsp.faces.length).fill(-1);
  bsp.models.forEach((m, mi) => {
    for (let f = m.firstFace; f < m.firstFace + m.numFaces; f++) modelOfFace[f] = mi;
  });
  const modelIds = bsp.models.map(() => res.nextModel++);
  out.modelIds = modelIds;
  bsp.faces.forEach((f, fi) => {
    const tex = bsp.textures[f.texture];
    let flags = tex?.flags ?? 0;
    const look = res.look(tex?.name ?? '');
    if (look.nodraw || (!look.image && !look.sky) || f.type === 4) flags |= SURF.NODRAW;
    if (look.sky) flags |= SURF.SKY;
    const pl = f.plane;
    out.faces.push([fi, modelIds[modelOfFace[fi]] ?? modelIds[0], pl ? pl.nx : 0, pl ? pl.ny : 0, pl ? pl.nz : 0, pl ? pl.dist : 0, f.twoSided ? 1 : 0, f.type, f.nverts,
      f.texture, flags, f.center[0], f.center[1], f.center[2], f.radius]);
    if (flags & SURF.NODRAW) return;
    const v = f.verts;
    if (f.fan) {
      for (let k = 0; k < f.nverts; k++) { const o = k * 10; out.faceVerts.push([fi, k, v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5], v[o + 6]]); }
    } else if (f.tris) {
      for (let k = 0; k < f.tris.length; k++) { const o = f.tris[k] * 10; out.faceVerts.push([fi, k, v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5], v[o + 6]]); }
    }
  });
  bsp.models.forEach((m, mi) => {
    const id = modelIds[mi];
    const name = mi === 0 ? bsp.name : `*${mi}`;
    out.models.push([id, name, 'B', m.mins[0], m.mins[1], m.mins[2], m.maxs[0], m.maxs[1], m.maxs[2], m.headnode, m.firstFace, m.numFaces, 1, 0, 0]);
    out.modelInfo.set(id, { id, name, kind: 'B', bsp, sub: mi, faceBase: 0 });
  });
  bsp.nodes.forEach((n, ni) => {
    const pl = bsp.planes[n.plane];
    const cc = (c) => (c < 0 ? bsp.leaves[-1 - c].contents : null);
    out.nodes.push([ni, pl.nx, pl.ny, pl.nz, pl.dist, pl.type < 3 ? pl.type : 3, n.children[0], n.children[1], cc(n.children[0]), cc(n.children[1])]);
  });
  bsp.leaves.forEach((l, li) => {
    out.leaves.push([li, l.contents, l.cluster, l.area, ...l.mins, ...l.maxs, l.firstLeafFace, l.numLeafFaces, l.firstLeafBrush, l.numLeafBrushes,
      l.cluster >= 0 ? bsp.pvsHex[l.cluster] ?? '' : '']);
  });
  for (let i = 0; i < bsp.leaffaces.length; i++) out.leaffaces.push([i, bsp.leaffaces[i]]);
  for (let i = 0; i < bsp.leafbrushes.length; i++) out.leafbrushes.push([i, bsp.leafbrushes[i]]);
  // a brush's bounds: the union of the leaves that list it, tightened by its axial sides (facets carry their own)
  const bb = new Float64Array(bsp.brushes.length * 6);
  for (let i = 0; i < bsp.brushes.length; i++) { bb[i * 6] = bb[i * 6 + 1] = bb[i * 6 + 2] = Infinity; bb[i * 6 + 3] = bb[i * 6 + 4] = bb[i * 6 + 5] = -Infinity; }
  for (const lf of bsp.leaves) {
    for (let k = 0; k < lf.numLeafBrushes; k++) {
      const b = bsp.leafbrushes[lf.firstLeafBrush + k] * 6;
      for (let a = 0; a < 3; a++) { if (lf.mins[a] < bb[b + a]) bb[b + a] = lf.mins[a]; if (lf.maxs[a] > bb[b + 3 + a]) bb[b + 3 + a] = lf.maxs[a]; }
    }
  }
  bsp.brushes.forEach((b, bi) => {
    const o = bi * 6;
    const fin = (v, d) => (Number.isFinite(v) ? v : d);
    let bounds;
    if (b.facet) bounds = [...b.mins, ...b.maxs];
    else {
      bounds = [fin(bb[o], -99999), fin(bb[o + 1], -99999), fin(bb[o + 2], -99999), fin(bb[o + 3], 99999), fin(bb[o + 4], 99999), fin(bb[o + 5], 99999)];
      for (let k = 0; k < b.numSides; k++) {
        const pl = bsp.planes[bsp.brushsides[b.firstSide + k].plane];
        const n = [pl.nx, pl.ny, pl.nz];
        for (let ax = 0; ax < 3; ax++) {
          if (n[ax] > 0.9999) bounds[3 + ax] = Math.min(bounds[3 + ax], pl.dist);
          else if (n[ax] < -0.9999) bounds[ax] = Math.max(bounds[ax], -pl.dist);
        }
      }
    }
    out.brushes.push([bi, b.contents, b.firstSide, b.numSides, b.facet ? 1 : 0, ...bounds]);
  });
  bsp.brushsides.forEach((s, si) => {
    const pl = bsp.planes[s.plane];
    out.brushsides.push([si, pl.nx, pl.ny, pl.nz, pl.dist, s.flags]);
  });
  return out;
}

/** SV_SpawnServer: replace the current map with `name` from the PK3. */
// `link`: finish the bots' waypoint graph now (the Node scripts), or leave it to buildWaypoints a few
// columns a frame (the browser, so the arena opens at once)
export async function loadMap(db, pak, res, name, { skill = 2, newGame = true, bots = 3, link = true, fraglimit = 20, timelimit = 0, warmup = 0 } = {}) {
  const bsp = new Bsp(pak.buffer(`maps/${name}.bsp`), `maps/${name}.bsp`);
  await db.exec(`DELETE FROM sound_events; DELETE FROM fx_events; DELETE FROM messages; DELETE FROM ents; DELETE FROM map_ents; DELETE FROM vis_faces; UPDATE viewcfg SET vis_cluster = NULL;
    DELETE FROM face_verts; DELETE FROM faces; DELETE FROM textures; DELETE FROM nodes; DELETE FROM leaves; DELETE FROM leaffaces; DELETE FROM leafbrushes;
    DELETE FROM brushes; DELETE FROM brushsides; DELETE FROM models WHERE kind = 'B'`);
  for (const [id, m] of [...res.models]) if (m.kind === 'B') res.models.delete(id);
  const geo = geometryRows(bsp, res);
  for (const [mid, info] of geo.modelInfo) res.models.set(mid, info);
  res.world = { bsp, modelIds: geo.modelIds, faceBase: 0 };

  await bulkLoad(db, 'models', geo.models);
  await bulkLoad(db, 'textures', geo.textures);
  await bulkLoad(db, 'faces', geo.faces);
  await bulkLoad(db, 'face_verts', geo.faceVerts);
  await bulkLoad(db, 'nodes', geo.nodes);
  await bulkLoad(db, 'leaves', geo.leaves);
  await bulkLoad(db, 'leaffaces', geo.leaffaces);
  await bulkLoad(db, 'leafbrushes', geo.leafbrushes);
  await bulkLoad(db, 'brushes', geo.brushes);
  await bulkLoad(db, 'brushsides', geo.brushsides);

  const entRows = bsp.entities.map((e, i) => {
    const o = parseVec(e.origin);
    const angles = e.angles ? parseVec(e.angles) : [null, null, null];
    const n = (k) => (e[k] === undefined || e[k] === '' || Number.isNaN(Number(e[k])) ? null : Number(e[k]));
    return [i, e.classname ?? 'unknown', e.targetname ?? null, e.target ?? null, e.team ?? null, e.model ?? null, o[0], o[1], o[2], n('angle'), angles[0], angles[1], angles[2],
      n('spawnflags') ?? 0, e.message ?? null, n('wait'), n('delay'), n('random'), n('speed'), n('lip'), n('height'), n('health'), n('light'), n('dmg'), n('count'),
      e.noise ?? null, n('phase'), n('gravity'), e.music ?? null, n('notfree'), n('nobots')];
  });
  await bulkLoad(db, 'map_ents', entRows);

  await db.exec(`EXECUTE PROCEDURE init_map('${name}', ${geo.modelIds[0]}, ${skill}, ${newGame ? 1 : 0}, ${bots}, ${Number(fraglimit) | 0}, ${Number(timelimit) | 0}, ${Number(warmup) || 0})`);
  if (link) while ((await buildWaypoints(db, 1e9, 1e9)) > 0);
  return bsp;
}

// go on building the bots' waypoint graph: up to `cols` grid columns scanned, or up to `links` nodes'
// edges traced once the grid is done; returns how much is left, 0 when the graph is complete
export async function buildWaypoints(db, cols, links) {
  const { rows } = await db.query(`SELECT remaining r FROM wp_build_chunk(${cols}, ${links})`);
  return rows[0].R;
}

export { SURF, CONTENTS };
