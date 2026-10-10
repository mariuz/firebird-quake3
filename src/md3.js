// md3.js – Quake III models (.md3, IDP3): several surfaces, each a
// triangle list with per-frame vertices (and normals as latitude/longitude
// bytes), the tags that attach a weapon to a hand or a head to a torso,
// and per-surface shader names. Also the player's animation.cfg and the
// .skin files that map surfaces to pictures.

import { cstr } from './pk3.js';

export class Md3 {
  constructor(buffer, name = '') {
    this.name = name;
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    if (cstr(bytes, 0, 4) !== 'IDP3') throw new Error(`${name}: not an MD3`);
    const version = dv.getInt32(4, true);
    if (version !== 15) throw new Error(`${name}: MD3 version ${version}`);
    this.flags = dv.getInt32(72, true);
    this.numFrames = dv.getInt32(76, true);
    const numTags = dv.getInt32(80, true);
    const numSurfaces = dv.getInt32(84, true);
    const ofsFrames = dv.getInt32(92, true), ofsTags = dv.getInt32(96, true), ofsSurfaces = dv.getInt32(100, true);
    this.frames = [];
    let radius = 0;
    for (let i = 0; i < this.numFrames; i++) {
      const p = ofsFrames + i * 56;
      const fr = {
        mins: [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)],
        maxs: [dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true)],
        origin: [dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true), dv.getFloat32(p + 32, true)],
        radius: dv.getFloat32(p + 36, true), name: cstr(bytes, p + 40, 16),
      };
      this.frames.push(fr);
      if (fr.radius > radius) radius = fr.radius;
    }
    this.radius = radius;
    // tags: per frame, numTags of them
    this.tagNames = [];
    this.tags = [];   // [frame][tag] → { origin, axis: 9 numbers (rows = forward, left, up) }
    for (let f = 0; f < this.numFrames; f++) {
      const row = [];
      for (let t = 0; t < numTags; t++) {
        const p = ofsTags + (f * numTags + t) * 112;
        const tn = cstr(bytes, p, 64);
        if (f === 0) this.tagNames.push(tn);
        const axis = new Float32Array(9);
        for (let k = 0; k < 9; k++) axis[k] = dv.getFloat32(p + 76 + k * 4, true);
        row.push({ origin: [dv.getFloat32(p + 64, true), dv.getFloat32(p + 68, true), dv.getFloat32(p + 72, true)], axis });
      }
      this.tags.push(row);
    }
    this.surfaces = [];
    let p = ofsSurfaces;
    for (let s = 0; s < numSurfaces; s++) {
      // R_LoadMD3 lowercases the name and strips a trailing _1 or _2 ("a crutch for q3data being a mess"): a
      // level of detail's surfaces (l_legs_1) then find the skin's entries (l_legs)
      let sname = cstr(bytes, p + 4, 64).toLowerCase();
      if (sname.length > 2 && sname[sname.length - 2] === '_') sname = sname.slice(0, -2);
      const nf = dv.getInt32(p + 72, true), ns = dv.getInt32(p + 76, true), nv = dv.getInt32(p + 80, true), nt = dv.getInt32(p + 84, true);
      const ofsTris = dv.getInt32(p + 88, true), ofsShaders = dv.getInt32(p + 92, true), ofsSt = dv.getInt32(p + 96, true), ofsXyz = dv.getInt32(p + 100, true), ofsEnd = dv.getInt32(p + 104, true);
      const shaders = [];
      for (let i = 0; i < ns; i++) shaders.push(cstr(bytes, p + ofsShaders + i * 68, 64).toLowerCase().replace(/\\/g, '/'));
      const tris = new Int32Array(nt * 3);
      for (let i = 0; i < nt * 3; i++) tris[i] = dv.getInt32(p + ofsTris + i * 4, true);
      const st = new Float32Array(nv * 2);
      for (let i = 0; i < nv * 2; i++) st[i] = dv.getFloat32(p + ofsSt + i * 4, true);
      // vertices: x y z (int16 / 64) and the normal as two bytes (lat, lng)
      const xyz = new Int16Array(nf * nv * 4);
      for (let i = 0; i < nf * nv * 4; i++) xyz[i] = dv.getInt16(p + ofsXyz + i * 2, true);
      this.surfaces.push({ name: sname, numFrames: nf, numVerts: nv, numTris: nt, shaders, tris, st, xyz, image: null });
      p += ofsEnd;
    }
    this.numVerts = this.surfaces.reduce((a, s) => a + s.numVerts, 0);
  }

  tagIndex(name) { return this.tagNames.indexOf(name); }
}

/** The normal of an MD3 vertex from its latitude/longitude bytes. */
export function md3Normal(packed, out, o = 0) {
  const lat = ((packed >> 8) & 255) * (2 * Math.PI / 255), lng = (packed & 255) * (2 * Math.PI / 255);
  out[o] = Math.cos(lat) * Math.sin(lng);
  out[o + 1] = Math.sin(lat) * Math.sin(lng);
  out[o + 2] = Math.cos(lng);
}

// The player model's animation table (bg_public.h's animNumber_t order).
export const ANIM = {
  BOTH_DEATH1: 0, BOTH_DEAD1: 1, BOTH_DEATH2: 2, BOTH_DEAD2: 3, BOTH_DEATH3: 4, BOTH_DEAD3: 5,
  TORSO_GESTURE: 6, TORSO_ATTACK: 7, TORSO_ATTACK2: 8, TORSO_DROP: 9, TORSO_RAISE: 10, TORSO_STAND: 11, TORSO_STAND2: 12,
  LEGS_WALKCR: 13, LEGS_WALK: 14, LEGS_RUN: 15, LEGS_BACK: 16, LEGS_SWIM: 17, LEGS_JUMP: 18, LEGS_LAND: 19, LEGS_JUMPB: 20, LEGS_LANDB: 21,
  LEGS_IDLE: 22, LEGS_IDLECR: 23, LEGS_TURN: 24,
};
export const ANIM_NAMES = Object.keys(ANIM);

/** animation.cfg → [{ first, count, loop, fps }] in ANIM order; the legs rows are rebased to the legs model's frames. */
export function parseAnimationCfg(text) {
  const anims = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('//')[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4 || !/^\d+$/.test(parts[0])) continue;
    anims.push({ first: +parts[0], count: +parts[1], loop: +parts[2], fps: +parts[3] || 15 });
    if (anims.length === ANIM_NAMES.length) break;
  }
  // the legs animations are stored with the torso frames in front of them (bg's skip)
  if (anims.length > ANIM.LEGS_WALKCR) {
    const skip = anims[ANIM.LEGS_WALKCR].first - anims[ANIM.TORSO_GESTURE].first;
    for (let i = ANIM.LEGS_WALKCR; i < anims.length; i++) anims[i].first -= skip;
  }
  return anims;
}

/** A .skin file: surface name → image/shader name. */
export function parseSkin(text) {
  const map = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const i = line.indexOf(',');
    if (i < 0) continue;
    const surf = line.slice(0, i).trim().toLowerCase(), img = line.slice(i + 1).trim().toLowerCase().replace(/\\/g, '/');
    if (img) map.set(surf, img);
  }
  return map;
}
