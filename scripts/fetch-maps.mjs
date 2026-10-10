// fetch-maps.mjs – OpenArena's arenas and the OpenArena Community Map-Pack, one small pk3 a map.
//
// OpenArena (GPLv2 game data) ships its maps in baseoa/pak1-maps.pk3 with their textures spread over the
// other baseoa paks; the Community Map-Pack (z_oacmp-volume1-v3.pk3) builds on those textures too. Hosting
// the whole of either is 440 MB, so for every map with deathmatch spawn points this writes
// public/pak/maps/<map>.pk3 holding what the map itself uses: its BSP, the shaders its faces, fogs and sky
// name (copied into one scripts/zz_<map>.shader, so they win over the demo's of the same name), every
// picture those shaders' stages draw, the sky box, the sounds and music its entities play, its levelshot.
// The items, weapons and players stay the Quake III demo's. public/pak/maps/index.json lists them for the
// page's Arena menu, which fetches a map's pk3 when it is picked. By default only the arenas the packs' arena
// lists give for free for all or the tournament.
//
//   node scripts/fetch-maps.mjs                 downloads into .cache/maps/ (440 MB once) and builds
//   OA_ZIP=… OACMP=… node scripts/fetch-maps.mjs    uses the files you have
//   node scripts/fetch-maps.mjs oa_dm1 oacmpdm1 builds only those; --all every map with deathmatch spawns

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Pk3, PakSet } from '../src/pk3.js';
import { Bsp } from '../src/bsp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache/maps');
const outDir = path.join(root, 'public/pak/maps');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const SOURCES = {
  oa: { file: 'openarena-0.8.8.zip', env: 'OA_ZIP', size: 425189255, urls: ['https://download.tuxfamily.org/openarena/rel/088/openarena-0.8.8.zip'] },
  cmp: { file: 'z_oacmp-volume1-v3.pk3', env: 'OACMP', size: 37137812, urls: ['https://download.tuxfamily.org/openarena/autodownload/baseoa/z_oacmp-volume1-v3.pk3'] },
};

async function source(key) {
  const s = SOURCES[key];
  if (process.env[s.env]) return fs.readFileSync(process.env[s.env]);
  const file = path.join(cache, s.file);
  if (fs.existsSync(file) && fs.statSync(file).size === s.size) return fs.readFileSync(file);
  for (const url of s.urls) {
    try {
      console.log(`downloading ${url}…`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (e) { console.warn(`  ${e.message}`); }
  }
  throw new Error(`could not download ${s.file}; give its path in ${s.env}`);
}

// a zip entry's bytes, inflated by zlib (the paks are hundreds of megabytes)
function entry(pk3, name) {
  const e = pk3.files.get(name);
  const dv = pk3.dv, h = e.off;
  const start = h + 30 + dv.getUint16(h + 26, true) + dv.getUint16(h + 28, true);
  const raw = pk3.bytes.subarray(start, start + e.csize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}
const toBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// OpenArena's paks in their load order, then the map pack on top
const oaZip = new Pk3(toBuffer(await source('oa')));
const paks = new PakSet();
for (const name of oaZip.list('openarena-0.8.8/baseoa/', '.pk3')) {
  const p = new Pk3(toBuffer(entry(oaZip, name)));
  p.label = 'OpenArena';
  paks.add(p);
}
const cmp = new Pk3(toBuffer(await source('cmp')));
cmp.label = 'OpenArena Community Map-Pack';
paks.add(cmp);
const read = (name) => entry(paks.owner.get(name), name);
const text = (name) => new TextDecoder('latin1').decode(read(name));

// every shader block's text by name (the last definition in the search order wins, as in the game)
const shaderText = new Map();
for (const f of paks.list('scripts/', '.shader')) {
  const src = text(f);
  let i = 0;
  const n = src.length;
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) { while (i < n && src[i] !== '\n') i++; continue; }
      if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      return;
    }
  };
  while (i < n) {
    skip();
    const s = i;
    while (i < n && !/[\s{}]/.test(src[i])) i++;
    const name = src.slice(s, i).toLowerCase();
    skip();
    if (src[i] !== '{') { i++; continue; }
    let depth = 0;
    const b = i;
    for (; i < n; i++) {
      if (src.startsWith('//', i)) { while (i < n && src[i] !== '\n') i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { i++; break; }
    }
    if (name) shaderText.set(name, `${name}\n${src.slice(b, i)}\n`);
  }
}

// the arenas' long names and game types (scripts/arenas.txt and scripts/*.arena)
const arenas = new Map();
for (const f of [...paks.list('scripts/arenas.txt'), ...paks.list('scripts/', '.arena')]) {
  for (const m of text(f).matchAll(/\{([^}]*)\}/g)) {
    const kv = {};
    for (const p of m[1].matchAll(/(\w+)\s+"([^"]*)"/g)) kv[p[1].toLowerCase()] = p[2];
    if (kv.map) arenas.set(kv.map.toLowerCase(), kv);
  }
}

// the Quake III demo's shader names: a texture OpenArena draws plainly but the demo scripts (concretefloor1)
// gets a plain shader of its own here, so the demo's does not take its place on top of the demo pak
const demoPak = path.join(root, 'public/pak/pak0.pk3');
const demoShaders = new Set();
if (fs.existsSync(demoPak)) {
  const demo = new Pk3(toBuffer(fs.readFileSync(demoPak)));
  for (const f of demo.list('scripts/', '.shader')) for (const m of new TextDecoder('latin1').decode(entry(demo, f)).matchAll(/^([\w/.-]+)\s*(?:\r?\n)\s*\{/gm)) demoShaders.add(m[1].toLowerCase());
}

const imageFile = (name) => paks.imageName(name.replace(/\\/g, '/'));
const all = process.argv.includes('--all');
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const index = [];
let total = 0;
for (const map of paks.mapNames().sort()) {
  if (wanted.length && !wanted.includes(map)) continue;
  const bspName = `maps/${map}.bsp`;
  const bsp = new Bsp(toBuffer(read(bspName)));
  const ents = bsp.entities;
  // a deathmatch arena: spawn points that free for all keeps
  const spawns = ents.filter((e) => (e.classname === 'info_player_deathmatch' || e.classname === 'info_player_start') && e.notfree !== '1'
    && (!e.gametype || e.gametype.toLowerCase().includes('ffa')));
  if (spawns.length < 2) continue;
  // by default the arenas the packs list for free for all or the tournament (the others are capture the flag's
  // and the like, which this game has not); --all takes every map with spawn points
  const types = arenas.get(map)?.type?.toLowerCase() ?? '';
  if (!all && !wanted.length && !/\b(ffa|tourney)\b/.test(types)) continue;
  const files = new Set([bspName]);
  const shaders = new Set(), plain = [];
  const addImage = (name) => { const f = name && imageFile(name); if (f) files.add(f); };
  const names = new Set([...bsp.faces.map((f) => bsp.textures[f.texture]?.name), ...(bsp.fogs ?? []).map((f) => f.name)].filter(Boolean).map((n) => n.toLowerCase()));
  for (const name of names) {
    const sh = shaderText.get(name);
    if (!sh) {
      addImage(name);
      if (demoShaders.has(name)) plain.push(`${name}\n{\n\t{\n\t\tmap $lightmap\n\t}\n\t{\n\t\tmap ${name}\n\t\tblendFunc filter\n\t}\n}\n`);
      continue;
    }
    shaders.add(name);
    // every picture its stages draw (map, clampmap, animmap, videomap aside), and a sky box's six sides
    for (const m of sh.matchAll(/\b(?:map|clampmap)\s+(\S+)/gi)) if (!m[1].startsWith('$')) addImage(m[1]);
    for (const m of sh.matchAll(/\banimmap\s+[\d.]+\s+([^\n}]+)/gi)) for (const img of m[1].trim().split(/\s+/)) addImage(img);
    const sky = /skyparms\s+(\S+)/i.exec(sh);
    if (sky && sky[1] !== '-') for (const side of ['rt', 'bk', 'lf', 'ft', 'up', 'dn']) addImage(`${sky[1]}_${side}`);
    const editor = /qer_editorimage\s+(\S+)/i.exec(sh);
    if (editor && !/^\s*(?:map|animmap)/im.test(sh)) addImage(editor[1]);
  }
  // the sounds and music its entities play; its levelshot
  for (const e of ents) for (const k of ['noise', 'music']) {
    const s = e[k]?.replace(/\\/g, '/').toLowerCase();
    if (s && !s.startsWith('*') && paks.has(s)) files.add(s);
  }
  for (const ext of ['jpg', 'tga']) if (paks.has(`levelshots/${map}.${ext}`)) files.add(`levelshots/${map}.${ext}`);
  for (const f of paks.list(`maps/${map}/`)) files.add(f);   // q3map2's external lightmaps

  const label = paks.mapSource(map);
  const arena = arenas.get(map) ?? {};
  const shaderFile = [...[...shaders].sort().map((n) => shaderText.get(n)), ...plain].join('\n');
  const readme = `${map}: from ${label}${label === 'OpenArena' ? ' 0.8.8 (http://openarena.ws)' : ' volume 1 v3 (http://openarena.ws)'}, GPLv2 game data.\n` +
    'Only the files this map draws and plays are here; the complete pack, sources and licence are at the address above.\n';
  const entries = [...files].sort().map((f) => [f, read(f)]);
  entries.push([`scripts/zz_${map}.shader`, Buffer.from(shaderFile, 'latin1')]);
  entries.push([`maps/${map}.txt`, Buffer.from(readme)]);
  const zip = writeZip(entries);
  fs.writeFileSync(path.join(outDir, `${map}.pk3`), zip);
  total += zip.length;
  index.push({ map, title: arena.longname ?? ents[0]?.message ?? map, pack: label, file: `${map}.pk3`, bytes: zip.length, types: arena.type ?? null });
  console.log(`${map}\t${label}\t${files.size} files\t${(zip.length / 1048576).toFixed(1)} MB\t${arena.longname ?? ents[0]?.message ?? ''}`);
}
if (!wanted.length) fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${index.length} maps, ${(total / 1048576).toFixed(1)} MB`);

// a zip of [name, bytes]: deflated where that is smaller (pk3s are plain zips)
function writeZip(list) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of list) {
    const nameBuf = Buffer.from(name, 'latin1');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(off, 42);
    parts.push(head, nameBuf, body);
    central.push(cd, nameBuf);
    off += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
