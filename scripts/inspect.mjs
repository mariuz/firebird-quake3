// inspect.mjs – what is in the pk3? Maps, their entities and shaders, the
// models, the sounds. Handy while porting game code.
//
//   node scripts/inspect.mjs                 overview
//   node scripts/inspect.mjs map q3dm1       one map's entity classes, shaders, face types
//   node scripts/inspect.mjs ents q3dm1      the full entity lump
//   node scripts/inspect.mjs model models/powerups/armor/armor_red.md3
//   node scripts/inspect.mjs shader textures/skies/tim_hell
//   node scripts/inspect.mjs grep rocket     file names matching
//   node scripts/inspect.mjs winding q3dm1   check the triangle winding against the face normals

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3 } from '../src/pk3.js';
import { Bsp } from '../src/bsp.js';
import { Md3 } from '../src/md3.js';
import { loadShaders, surfaceLook } from '../src/shader.js';
import { loadImage } from '../src/image.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = performance.now();
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const [, , cmd, arg] = process.argv;

if (!cmd) {
  const byDir = new Map();
  for (const n of pak.files.keys()) { const d = n.split('/')[0]; byDir.set(d, (byDir.get(d) ?? 0) + 1); }
  console.log('files per top directory:', Object.fromEntries(byDir));
  console.log('maps:', pak.mapNames());
  console.log('models:', pak.list('models/', '.md3').length, 'md3; textures:', pak.list('textures/').length, '; sounds:', pak.list('sound/', '.wav').length);
  const t1 = performance.now();
  pak.inflateAll((n) => !/^(demos|video|vm|botfiles|menu|levelshots)\//.test(n) && !n.endsWith('.aas'));
  console.log(`inflated everything in ${(performance.now() - t1).toFixed(0)} ms`);
  const shaders = loadShaders(pak);
  console.log('shaders:', shaders.size);
  for (const m of pak.mapNames()) {
    const b = new Bsp(pak.buffer(`maps/${m}.bsp`), m);
    const ws = b.entities.find((e) => e.classname === 'worldspawn');
    const types = {};
    for (const f of b.faces) types[f.type] = (types[f.type] ?? 0) + 1;
    console.log(`${m}: ${b.faces.length} faces ${JSON.stringify(types)}, ${b.leaves.length} leaves, ${b.numClusters} clusters, ${b.brushes.length} brushes (${b.numFacets} patch facets), ${b.brushsides.length} sides, ${b.nodes.length} nodes, ${b.models.length} models, ${b.entities.length} ents, ${b.textures.length} shaders, ${b.numLightmaps} lightmaps, grid ${b.gridDims}; "${ws?.message}" music ${ws?.music}`);
  }
} else if (cmd === 'map') {
  const b = new Bsp(pak.buffer(`maps/${arg}.bsp`), arg);
  const shaders = loadShaders(pak);
  const cls = new Map();
  for (const e of b.entities) cls.set(e.classname, (cls.get(e.classname) ?? 0) + 1);
  console.log('classes:', [...cls].sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' '));
  const keys = new Set();
  for (const e of b.entities) for (const k of Object.keys(e)) keys.add(k);
  console.log('keys:', [...keys].sort().join(' '));
  for (const t of b.textures) {
    const look = surfaceLook(shaders, t.name);
    const img = look.image ? pak.imageName(look.image) : null;
    console.log(`${t.name.padEnd(48)} flags ${t.flags.toString(16).padStart(5)} contents ${(t.contents >>> 0).toString(16).padStart(8)} → ${look.sky ? 'SKY ' + look.sky.layers.map((l) => l.image).join('+') : look.nodraw ? 'nodraw' : `${img ?? '(missing ' + look.image + ')'} ${look.blend}${look.lightmapped ? ' lm' : ''}${look.twoSided ? ' 2s' : ''}${look.anim ? ' anim' + look.anim.length : ''}${look.add ? ' +' + look.add.image : ''}`}`);
  }
  console.log('models:', b.models.map((m, i) => `*${i}:${m.numFaces}f/${m.numBrushes}b`).join(' '));
  console.log('starts:', b.entities.filter((e) => e.classname.startsWith('info_player')).map((e) => `${e.classname}@${e.origin}`).join(' '));
} else if (cmd === 'ents') {
  const b = new Bsp(pak.buffer(`maps/${arg}.bsp`), arg);
  for (const e of b.entities) console.log(JSON.stringify(e));
} else if (cmd === 'model') {
  const m = new Md3(pak.buffer(arg), arg);
  console.log(`${arg}: ${m.numFrames} frames, tags ${m.tagNames.join(',')}, radius ${m.radius.toFixed(1)}`);
  for (const s of m.surfaces) console.log(`  ${s.name}: ${s.numVerts} verts ${s.numTris} tris shaders ${s.shaders.join(',')} → ${s.shaders.map((n) => pak.imageName(n)).join(',')}`);
} else if (cmd === 'shader') {
  const shaders = loadShaders(pak);
  console.log(shaders.get(arg.toLowerCase()));
  console.log(surfaceLook(shaders, arg));
} else if (cmd === 'grep') {
  for (const n of pak.files.keys()) if (n.includes(arg)) console.log(n, pak.files.get(n).size);
} else if (cmd === 'image') {
  const img = loadImage(pak.get(arg), arg);
  console.log(arg, img.w, img.h, 'alpha', img.hasAlpha, 'first pixels', [...img.data.slice(0, 4)].map((v) => v.toString(16)));
} else if (cmd === 'winding') {
  const b = new Bsp(pak.buffer(`maps/${arg}.bsp`), arg);
  let agree = 0, disagree = 0, fans = 0;
  for (const f of b.faces) {
    if (f.type !== 1 || !f.tris || f.tris.length < 3) continue;
    if (f.fan) fans++;
    const v = f.verts, a = f.tris[0] * 10, c = f.tris[1] * 10, d = f.tris[2] * 10;
    const e1 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]], e2 = [v[d] - v[a], v[d + 1] - v[a + 1], v[d + 2] - v[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dp = n[0] * f.normal[0] + n[1] * f.normal[1] + n[2] * f.normal[2];
    if (dp > 0) agree++; else disagree++;
  }
  console.log(`planar faces: triangle winding agrees with the face normal (cross(v1-v0, v2-v0)·n > 0) in ${agree}, disagrees in ${disagree}; ${fans} are plain fans`);
}
console.log(`(${(performance.now() - t0).toFixed(0)} ms)`);
