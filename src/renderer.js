// renderer.js – the painter. Firebird says which faces are on screen
// (FRAME_ALL) and which models stand where; this file turns that into
// pixels the way a 1999 software rasteriser would have, had Quake III
// shipped one: a 32-bit framebuffer and a z-buffer, perspective-correct
// spans (divided every 16 pixels) that multiply the texture by the
// lightmap page, triangle lists for the Bézier patches and meshes, MD3
// models lit from the light grid with the player parts hung on their tags,
// the sky's cloud layers by pixel direction, additive and alpha blended
// surfaces, particles and beams, and the 2D pictures of the HUD.

import { md3Normal, ANIM } from './md3.js';
import { loadImage, powerOfTwo, halve } from './image.js';
import { SURF } from './bsp.js';

const LIGHTMAP_SIZE = 128;

export class Renderer {
  constructor(canvas, res) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.res = res;
    this.pak = res.pak;
    this.textures = new Map();      // image name → { w, h, data, wm, hm, hasAlpha }
    this.looks = new Map();         // shader name → look
    this.lightmaps = new Map();     // bsp → [Uint8Array RGB]
    this.faceInfo = new Map();      // face id → { bsp, f, look }
    this.particles = [];
    this.lightScale = 2;            // the overbright shift: lightmaps ×2 (hue kept), as a 1999 card showed them
    this.modelLight = 1;
    this.skyLook = null;
    this.time = 0;
    this.vv = new Float64Array(64 * 9);    // a polygon's vertices in view space (vf vr vu sx sy s t u v)
    this.pp = new Float64Array(64 * 7);    // ... and on screen, clipped (sx sy iz s t u v)
    this.av = new Float32Array(2048 * 8);  // a model's transformed vertices (vf vr vu px py iz light pad)
    this.anorm = new Float32Array(3);
    this.setSize(320, 240);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.fb = new Uint32Array(this.image.data.buffer);
    this.zb = new Float32Array(w * h);
    this.edgeL = new Float32Array(h * 7);   // x, iz, s/z, t/z, u/z, v/z, light per scanline
    this.edgeR = new Float32Array(h * 7);
  }

  /** The model registry (loader.js's res) and the world's faces. */
  setResources(res) {
    this.res = res;
    this.faceInfo.clear();
    for (const m of res.models.values()) {
      if (m.kind !== 'B' || m.sub !== 0) continue;
      const bsp = m.bsp;
      bsp.faces.forEach((f, i) => {
        const tex = bsp.textures[f.texture];
        this.faceInfo.set(i, { bsp, f, look: this.look(tex?.name ?? '') });
      });
      this.bsp = bsp;
    }
  }

  look(name) {
    let l = this.looks.get(name);
    if (!l) { l = this.res.look(name); this.looks.set(name, l); }
    return l;
  }

  /** A picture by its texture/shader image name, cached; a checkerboard when the pak lacks it. */
  texture(name) {
    let t = this.textures.get(name);
    if (t !== undefined) return t;
    t = null;
    const file = this.pak.imageName(name);
    if (file) {
      try { t = powerOfTwo(loadImage(this.pak.get(file), file)); } catch (e) { console.warn(`${file}: ${e.message}`); t = null; }
    }
    if (!t) {
      const data = new Uint32Array(64 * 64);
      for (let i = 0; i < 64 * 64; i++) data[i] = ((i >> 3) + (i >> 9)) & 1 ? 0xff606060 : 0xff303030;
      t = { w: 64, h: 64, data, hasAlpha: false };
    }
    t.wm = t.w - 1; t.hm = t.h - 1;
    // the mip chain: a quarter of the texels per level, down to 8×8 (R_DrawSurface picks a level per polygon)
    t.mips = [t];
    let m = t;
    while (m.w > 8 && m.h > 8 && t.mips.length < 5) { m = halve(m); m.wm = m.w - 1; m.hm = m.h - 1; t.mips.push(m); }
    this.textures.set(name, t);
    return t;
  }

  /** The lightmap pages of a BSP with the overbright shift applied (R_ColorShiftLightingBytes). */
  lightmap(bsp, index) {
    let pages = this.lightmaps.get(bsp);
    if (!pages) { pages = []; this.lightmaps.set(bsp, pages); }
    let page = pages[index];
    if (page) return page;
    const n = LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3;
    page = new Uint8Array(n);
    const src = bsp.lightmaps.subarray(index * n, index * n + n);
    const scale = this.lightScale;
    for (let i = 0; i < n; i += 3) {
      let r = src[i] * scale, g = src[i + 1] * scale, b = src[i + 2] * scale;
      const max = Math.max(r, g, b);
      if (max > 255) { const k = 255 / max; r *= k; g *= k; b *= k; }
      page[i] = r; page[i + 1] = g; page[i + 2] = b;
    }
    pages[index] = page;
    return page;
  }

  setBrightness(scale) {
    this.lightScale = scale;
    this.lightmaps.clear();
  }

  setSky(name) {
    this.skyLook = name ? this.look(name) : null;
    if (this.skyLook && !this.skyLook.sky) this.skyLook = null;
  }

  // ── a frame ─────────────────────────────────────────────────────────────
  beginFrame(view) {
    this.view = view;
    const { w, h } = this;
    this.zb.fill(0);
    this.fb.fill(0xff000000);
    const yaw = (view.yaw * Math.PI) / 180, pitch = (view.pitch * Math.PI) / 180;
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    view.fwd = [cp * cy, cp * sy, -sp];
    view.right = [sy, -cy, 0];
    view.up = [sp * cy, sp * sy, cp];
    if (view.roll) {
      const r = (view.roll * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r);
      const R = view.right, U = view.up;
      view.right = [R[0] * cr + U[0] * sr, R[1] * cr + U[1] * sr, R[2] * cr + U[2] * sr];
      view.up = [-R[0] * sr + U[0] * cr, -R[1] * sr + U[1] * cr, -R[2] * sr + U[2] * cr];
    }
    view.scale = (w / 2) / Math.tan((view.fov * Math.PI) / 360);
    view.cx = w / 2;
    view.cy = h / 2;
    this.alphaPolys = [];
  }

  polyRoom(n) {
    if (this.vv.length < n * 9) { this.vv = new Float64Array(n * 9 * 2); this.pp = new Float64Array(n * 7 * 4); }
  }

  /**
   * FRAME_ALL's face rows [face, ent_id, ox, oy, oz]: SQL chose the faces, the vertices come
   * from the BSP held here. Polygons are scan-converted whole; patches and meshes triangle by triangle.
   */
  drawFaceList(rows, time, entAngles = new Map()) {
    this.time = time;
    const view = this.view;
    const [fx, fy, fz] = view.fwd, [rx, ry, rz] = view.right, [ux, uy, uz] = view.up;
    const near = 4, sc = view.scale, cx = view.cx, cy = view.cy;
    let lastEnt = -1, M = null;
    const vv = this.vv;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const face = row[0], ent = row[1], ox = row[2], oy = row[3], oz = row[4];
      const info = this.faceInfo.get(face);
      if (!info) continue;
      const { f, look } = info;
      if (look.nodraw || !f.nverts) continue;
      const lx = view.x - ox, ly = view.y - oy, lz = view.z - oz;
      if (ent !== lastEnt) { lastEnt = ent; M = ent && entAngles.get(ent) ? angleMatrix(entAngles.get(ent)) : null; }
      const verts = f.verts, m = f.nverts;
      this.polyRoom(m);
      let behind = false;
      for (let k = 0; k < m; k++) {
        const vi = k * 10;
        const x = verts[vi], y = verts[vi + 1], z = verts[vi + 2];
        let dx, dy, dz;
        if (M) { dx = M[0] * x + M[1] * y + M[2] * z - lx; dy = M[3] * x + M[4] * y + M[5] * z - ly; dz = M[6] * x + M[7] * y + M[8] * z - lz; }
        else { dx = x - lx; dy = y - ly; dz = z - lz; }
        const vf = dx * fx + dy * fy + dz * fz, vr = dx * rx + dy * ry + dz * rz, vu = dx * ux + dy * uy + dz * uz;
        const o = k * 9;
        vv[o] = vf; vv[o + 1] = vr; vv[o + 2] = vu;
        if (vf >= near) { vv[o + 3] = cx + (vr * sc) / vf; vv[o + 4] = cy - (vu * sc) / vf; } else behind = true;
        vv[o + 5] = verts[vi + 3]; vv[o + 6] = verts[vi + 4]; vv[o + 7] = verts[vi + 5]; vv[o + 8] = verts[vi + 6];
      }
      if (f.fan) this.emitPoly(0, 1, 2, m, behind, info, true);
      else {
        const tris = f.tris;
        // all vertices behind: nothing to draw
        let any = false;
        for (let k = 0; k < m && !any; k++) if (vv[k * 9] >= near) any = true;
        if (!any) continue;
        for (let k = 0; k + 2 < tris.length; k += 3) {
          const a = tris[k], b = tris[k + 1], c = tris[k + 2];
          const bh = vv[a * 9] < near || vv[b * 9] < near || vv[c * 9] < near;
          this.emitPoly(a, b, c, 3, bh, info, false);
        }
      }
    }
  }

  /**
   * FRAME_FACES rows (SQL projected every vertex): [face, seq, vf, vr, vu, sx, sy, s, t, u, v, ent_id]
   * in order; polygons whole, triangle lists three rows at a time.
   */
  drawFaces(rows, time) {
    this.time = time;
    const near = 4;
    let i = 0;
    const n = rows.length;
    const vv = this.vv;
    while (i < n) {
      const face = rows[i][0], ent = rows[i][11];
      const info = this.faceInfo.get(face);
      let j = i;
      while (i < n && rows[i][0] === face && rows[i][11] === ent) i++;
      if (!info || info.look.nodraw) continue;
      const m = i - j;
      this.polyRoom(m);
      let behind = false;
      for (let k = 0; k < m; k++) {
        const r = rows[j + k], o = k * 9;
        vv[o] = r[2]; vv[o + 1] = r[3]; vv[o + 2] = r[4]; vv[o + 3] = r[5]; vv[o + 4] = r[6]; vv[o + 5] = r[7]; vv[o + 6] = r[8]; vv[o + 7] = r[9]; vv[o + 8] = r[10];
        if (r[2] < near) behind = true;
      }
      if (info.f.fan) this.emitPoly(0, 1, 2, m, behind, info, true);
      else for (let k = 0; k + 2 < m; k += 3) this.emitPoly(k, k + 1, k + 2, 3, vv[k * 9] < near || vv[(k + 1) * 9] < near || vv[(k + 2) * 9] < near, info, false);
    }
  }

  /**
   * The polygon (vertex indices a, b, c… of this.vv: a..a+m-1 when `fan`, else the three given)
   * becomes screen-space vertices in this.pp (sx sy iz s t u v), clipped to the near plane when it
   * crosses it, and is drawn — or kept for after the opaque surfaces when it blends.
   */
  emitPoly(a, b, c, m, behind, info, fan) {
    const vv = this.vv, pp = this.pp;
    const view = this.view, near = 4;
    const idx = fan ? null : [a, b, c];
    const at = (k) => (fan ? a + k : idx[k]) * 9;
    let n = 0;
    if (!behind) {
      for (let k = 0; k < m; k++) {
        const o = at(k), q = k * 7;
        pp[q] = vv[o + 3]; pp[q + 1] = vv[o + 4]; pp[q + 2] = 1 / vv[o]; pp[q + 3] = vv[o + 5]; pp[q + 4] = vv[o + 6]; pp[q + 5] = vv[o + 7]; pp[q + 6] = vv[o + 8];
      }
      n = m;
    } else {
      for (let k = 0; k < m; k++) {
        const o = at(k), o2 = at((k + 1) % m);
        const ain = vv[o] >= near, bin = vv[o2] >= near;
        if (ain) { const q = n++ * 7; pp[q] = vv[o + 3]; pp[q + 1] = vv[o + 4]; pp[q + 2] = 1 / vv[o]; pp[q + 3] = vv[o + 5]; pp[q + 4] = vv[o + 6]; pp[q + 5] = vv[o + 7]; pp[q + 6] = vv[o + 8]; }
        if (ain !== bin) {
          const f = (near - vv[o]) / (vv[o2] - vv[o]);
          const r = vv[o + 1] + (vv[o2 + 1] - vv[o + 1]) * f, u = vv[o + 2] + (vv[o2 + 2] - vv[o + 2]) * f;
          const q = n++ * 7;
          pp[q] = view.cx + (r * view.scale) / near; pp[q + 1] = view.cy - (u * view.scale) / near; pp[q + 2] = 1 / near;
          for (let z = 3; z < 7; z++) pp[q + z] = vv[o + z + 2] + (vv[o2 + z + 2] - vv[o + z + 2]) * f;
        }
      }
      if (n < 3) return;
    }
    const look = info.look;
    if (look.blend !== 'opaque' && !look.sky) { this.alphaPolys.push({ verts: pp.slice(0, n * 7), n, info }); return; }
    this.drawSurfacePoly(pp, n, info);
  }

  /** The translucent surfaces, after everything opaque (they do not write depth). */
  drawAlphaPolys() {
    for (const p of this.alphaPolys) this.drawSurfacePoly(p.verts, p.n, p.info);
    this.alphaPolys = [];
  }

  drawSurfacePoly(poly, n, info) {
    const { f, look, bsp } = info;
    if (look.sky) { this.fillPolygon(poly, n, null, null, 'sky', 0, 0, 0, 0); return; }
    const tex = this.texture(this.animImage(look, look.image, look.anim, look.animFps));
    const page = look.lightmapped && f.lmIndex >= 0 && f.lmIndex < bsp.numLightmaps ? this.lightmap(bsp, f.lmIndex) : null;
    let ds = 0, dt = 0;
    const t = this.time;
    if (look.scroll) { ds = look.scroll[0] * t; dt = look.scroll[1] * t; }
    const scale = look.scale;
    // the vertex colour of unlit surfaces (q3map's vertex light), averaged over the polygon
    let flat = 255;
    if (!page && !look.sky) {
      let sum = 0;
      for (let k = 0; k < f.nverts; k++) sum += f.verts[k * 10 + 7] + f.verts[k * 10 + 8] + f.verts[k * 10 + 9];
      flat = f.nverts ? Math.min(255, (sum / (3 * f.nverts)) * this.lightScale) : 255;
      if (look.blend === 'add' || look.blend === 'blend' || !look.lightmapped) flat = 255;
      if (look.vertexColor) flat = Math.min(255, (sum / (3 * f.nverts)) * this.lightScale);
    }
    const mode = look.blend === 'add' ? 'add' : look.blend === 'blend' ? 'blend' : look.blend === 'filter' ? 'filter' : look.alphaTest ? 'alphatest' : 'opaque';
    this.fillPolygon(poly, n, tex, page, mode, flat, ds, dt, look.turb ? 1 : 0, scale);
    if (look.add && mode === 'opaque') {
      // the glow layer of lights and screens: added over the lit surface
      const addTex = this.texture(this.animImage(look, look.add.image, look.add.anim, look.add.animFps));
      const pulse = 0.75 + 0.25 * Math.sin(t * 2);
      this.fillPolygon(poly, n, addTex, null, 'add', 255 * pulse, look.add.scroll ? look.add.scroll[0] * t : 0, look.add.scroll ? look.add.scroll[1] * t : 0, 0, look.add.scale);
    }
  }

  animImage(look, image, anim, fps) {
    if (!anim || !anim.length) return image;
    return anim[Math.floor(this.time * fps) % anim.length];
  }

  /**
   * Scan-convert a convex polygon: n vertices of [sx, sy, iz, s, t, u, v]. 1/z and the
   * coordinates over z are affine in screen space; they are divided out every 16 pixels and
   * stepped linearly between (D_DrawSpans16). The depth test runs on every pixel.
   * mode: opaque | alphatest | add | blend | filter | sky
   */
  fillPolygon(poly, n, tex, page, mode, flat, ds, dt, turb, scale) {
    const { w, h, edgeL, edgeR, fb, zb } = this;
    let ymin = Infinity, ymax = -Infinity;
    for (let k = 0; k < n; k++) { const py = poly[k * 7 + 1]; if (py < ymin) ymin = py; if (py > ymax) ymax = py; }
    const y0 = Math.max(0, Math.ceil(ymin - 0.5));
    const y1 = Math.min(h - 1, Math.ceil(ymax - 0.5) - 1);
    if (y0 > y1) return;
    for (let y = y0; y <= y1; y++) { edgeL[y * 7] = Infinity; edgeR[y * 7] = -Infinity; }
    const sxs = scale ? scale[0] : 1, sys = scale ? scale[1] : 1;
    // the mip level: texels per pixel along the polygon's edges
    if (tex && tex.mips && tex.mips.length > 1) {
      let texels = 0, pixels = 0;
      for (let k = 0; k < n; k++) {
        const a = k * 7, b = ((k + 1) % n) * 7;
        texels += Math.hypot((poly[b + 3] - poly[a + 3]) * sxs * tex.w, (poly[b + 4] - poly[a + 4]) * sys * tex.h);
        pixels += Math.hypot(poly[b] - poly[a], poly[b + 1] - poly[a + 1]);
      }
      const ratio = texels / (pixels || 1);
      let level = ratio > 1 ? Math.floor(Math.log2(ratio)) : 0;
      if (level >= tex.mips.length) level = tex.mips.length - 1;
      if (level > 0) tex = tex.mips[level];
    }
    const tw = tex ? tex.w : 1, th = tex ? tex.h : 1;
    for (let k = 0; k < n; k++) {
      const a = k * 7, b = ((k + 1) % n) * 7;
      let ax = poly[a], ay = poly[a + 1], bx = poly[b], by = poly[b + 1];
      if (ay === by) continue;
      let aiz = poly[a + 2], biz = poly[b + 2];
      // texture coordinates in texels (wrapping by mask), lightmap in page texels; all over z
      let asz = (poly[a + 3] * sxs + ds) * tw * aiz, bsz = (poly[b + 3] * sxs + ds) * tw * biz;
      let atz = (poly[a + 4] * sys + dt) * th * aiz, btz = (poly[b + 4] * sys + dt) * th * biz;
      let auz = poly[a + 5] * LIGHTMAP_SIZE * aiz, buz = poly[b + 5] * LIGHTMAP_SIZE * biz;
      let avz = poly[a + 6] * LIGHTMAP_SIZE * aiz, bvz = poly[b + 6] * LIGHTMAP_SIZE * biz;
      if (ay > by) {
        let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; t = aiz; aiz = biz; biz = t;
        t = asz; asz = bsz; bsz = t; t = atz; atz = btz; btz = t; t = auz; auz = buz; buz = t; t = avz; avz = bvz; bvz = t;
      }
      const dy = by - ay;
      const dx = (bx - ax) / dy, diz = (biz - aiz) / dy, dsz = (bsz - asz) / dy, dtz = (btz - atz) / dy, duz = (buz - auz) / dy, dvz = (bvz - avz) / dy;
      const ys = Math.max(y0, Math.ceil(ay - 0.5)), ye = Math.min(y1, Math.ceil(by - 0.5) - 1);
      for (let y = ys; y <= ye; y++) {
        const t = y + 0.5 - ay;
        const x = ax + dx * t;
        const o = y * 7;
        if (x < edgeL[o]) { edgeL[o] = x; edgeL[o + 1] = aiz + diz * t; edgeL[o + 2] = asz + dsz * t; edgeL[o + 3] = atz + dtz * t; edgeL[o + 4] = auz + duz * t; edgeL[o + 5] = avz + dvz * t; }
        if (x > edgeR[o]) { edgeR[o] = x; edgeR[o + 1] = aiz + diz * t; edgeR[o + 2] = asz + dsz * t; edgeR[o + 3] = atz + dtz * t; edgeR[o + 4] = auz + duz * t; edgeR[o + 5] = avz + dvz * t; }
      }
    }
    if (mode === 'sky') { this.skySpans(y0, y1); return; }
    const td = tex.data, wm = tex.wm, hm = tex.hm;
    const lm = page;
    const tphase = this.time * 2;
    const fl = flat / 255;
    for (let y = y0; y <= y1; y++) {
      const o = y * 7;
      const xl = edgeL[o], xr = edgeR[o];
      if (xl === Infinity || xr === -Infinity) continue;
      const xs = Math.max(0, Math.ceil(xl - 0.5)), xe = Math.min(w - 1, Math.ceil(xr - 0.5) - 1);
      if (xs > xe) continue;
      const span = xr - xl || 1;
      const diz = (edgeR[o + 1] - edgeL[o + 1]) / span, dsz = (edgeR[o + 2] - edgeL[o + 2]) / span, dtz = (edgeR[o + 3] - edgeL[o + 3]) / span;
      const duz = (edgeR[o + 4] - edgeL[o + 4]) / span, dvz = (edgeR[o + 5] - edgeL[o + 5]) / span;
      const t0 = xs + 0.5 - xl;
      let iz = edgeL[o + 1] + diz * t0, sz = edgeL[o + 2] + dsz * t0, tz = edgeL[o + 3] + dtz * t0, uz = edgeL[o + 4] + duz * t0, vz = edgeL[o + 5] + dvz * t0;
      let idx = y * w + xs;
      let z = 1 / iz, s = sz * z, t = tz * z, u = uz * z, v = vz * z;
      let x = xs;
      while (x <= xe) {
        const run = xe - x + 1 < 16 ? xe - x + 1 : 16;
        const iz2 = iz + diz * run, sz2 = sz + dsz * run, tz2 = tz + dtz * run, uz2 = uz + duz * run, vz2 = vz + dvz * run;
        z = 1 / iz2;
        const s2 = sz2 * z, t2 = tz2 * z, u2 = uz2 * z, v2 = vz2 * z;
        const dss = (s2 - s) / run, dtt = (t2 - t) / run, duu = (u2 - u) / run, dvv = (v2 - v) / run;
        if (mode === 'opaque' && lm) {
          for (let k = 0; k < run; k++, idx++, iz += diz, s += dss, t += dtt, u += duu, v += dvv) {
            if (iz <= zb[idx]) continue;
            let ss = s, tt = t;
            if (turb) { ss += Math.sin(t * 0.05 + tphase) * 4; tt += Math.sin(s * 0.05 + tphase) * 4; }
            const c = td[((tt & hm) * tw + (ss & wm)) >>> 0];
            const li = (((v & 127) << 7) + (u & 127)) * 3;
            zb[idx] = iz;
            fb[idx] = (0xff000000 | (((((c >> 16) & 255) * lm[li + 2]) >> 8) << 16) | (((((c >> 8) & 255) * lm[li + 1]) >> 8) << 8) | (((c & 255) * lm[li]) >> 8)) >>> 0;
          }
        } else if (mode === 'opaque' || mode === 'alphatest') {
          const at = mode === 'alphatest';
          for (let k = 0; k < run; k++, idx++, iz += diz, s += dss, t += dtt) {
            if (iz <= zb[idx]) continue;
            let ss = s, tt = t;
            if (turb) { ss += Math.sin(t * 0.05 + tphase) * 4; tt += Math.sin(s * 0.05 + tphase) * 4; }
            const c = td[((tt & hm) * tw + (ss & wm)) >>> 0];
            if (at && (c >>> 24) < 128) continue;
            zb[idx] = iz;
            if (fl >= 1) fb[idx] = c | 0xff000000;
            else fb[idx] = (0xff000000 | ((((c >> 16) & 255) * fl) << 16) | ((((c >> 8) & 255) * fl) << 8) | ((c & 255) * fl)) >>> 0;
          }
        } else if (mode === 'add') {
          for (let k = 0; k < run; k++, idx++, iz += diz, s += dss, t += dtt) {
            if (iz <= zb[idx]) continue;
            const c = td[((t & hm) * tw + (s & wm)) >>> 0], d = fb[idx];
            let r = (d & 255) + (c & 255) * fl, g = ((d >> 8) & 255) + ((c >> 8) & 255) * fl, b = ((d >> 16) & 255) + ((c >> 16) & 255) * fl;
            if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
            fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
          }
        } else if (mode === 'blend') {
          for (let k = 0; k < run; k++, idx++, iz += diz, s += dss, t += dtt) {
            if (iz <= zb[idx]) continue;
            const c = td[((t & hm) * tw + (s & wm)) >>> 0], d = fb[idx];
            const a = (c >>> 24) / 255, ia = 1 - a;
            if (a <= 0) continue;
            const r = (d & 255) * ia + (c & 255) * a, g = ((d >> 8) & 255) * ia + ((c >> 8) & 255) * a, b = ((d >> 16) & 255) * ia + ((c >> 16) & 255) * a;
            fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
          }
        } else {
          for (let k = 0; k < run; k++, idx++, iz += diz, s += dss, t += dtt) {
            if (iz <= zb[idx]) continue;
            const c = td[((t & hm) * tw + (s & wm)) >>> 0], d = fb[idx];
            fb[idx] = (0xff000000 | (((((d >> 16) & 255) * ((c >> 16) & 255)) >> 8) << 16) | (((((d >> 8) & 255) * ((c >> 8) & 255)) >> 8) << 8) | (((d & 255) * (c & 255)) >> 8)) >>> 0;
          }
        }
        x += run; iz = iz2; sz = sz2; tz = tz2; uz = uz2; vz = vz2; s = s2; t = t2; u = u2; v = v2;
      }
    }
  }

  /** The sky by each pixel's direction: the cloud layers of the sky shader (or the box, when it has one). */
  skySpans(y0, y1) {
    const { w, edgeL, edgeR, fb, zb } = this;
    const view = this.view;
    const look = this.skyLook;
    const layers = look?.sky?.layers ?? [];
    const texs = layers.map((l) => this.texture(l.image));
    const fwd = view.fwd, right = view.right, up = view.up;
    const dk = 1 / view.scale;
    const t = this.time;
    const sdx = right[0] * dk, sdy = right[1] * dk, sdz = right[2] * dk;
    for (let y = y0; y <= y1; y++) {
      const o = y * 7;
      const xl = edgeL[o], xr = edgeR[o];
      if (xl === Infinity || xr === -Infinity) continue;
      const xs = Math.max(0, Math.ceil(xl - 0.5)), xe = Math.min(w - 1, Math.ceil(xr - 0.5) - 1);
      if (xs > xe) continue;
      const kx = (xs + 0.5 - view.cx) * dk, ky = (view.cy - y - 0.5) * dk;
      let dx = fwd[0] + right[0] * kx + up[0] * ky, dy = fwd[1] + right[1] * kx + up[1] * ky, dz = fwd[2] + right[2] * kx + up[2] * ky;
      let idx = y * w + xs;
      for (let x = xs; x <= xe; x++, idx++, dx += sdx, dy += sdy, dz += sdz) {
        if (1e-6 <= zb[idx]) continue;
        zb[idx] = 1e-6;
        if (!texs.length) { fb[idx] = 0xff201010; continue; }
        // a dome: the direction projected onto a plane above the eye (Q3's cloud sphere, flattened)
        const len = Math.hypot(dx, dy, dz) || 1;
        const nz = Math.max(0.12, Math.abs(dz) / len);
        const px = (dx / len) / nz, py = (dy / len) / nz;
        let r = 0, g = 0, b = 0;
        for (let li = 0; li < texs.length; li++) {
          const tex = texs[li], l = layers[li];
          const sc = l.scale ? l.scale[0] * 0.25 : 0.25;
          const ss = (px * sc + (l.scroll ? l.scroll[0] * t : 0)) * tex.w, tt = (py * sc + (l.scroll ? l.scroll[1] * t : 0)) * tex.h;
          const c = tex.data[((tt & tex.hm) * tex.w + (ss & tex.wm)) >>> 0];
          if (li === 0 || l.blend === 'opaque') { r = c & 255; g = (c >> 8) & 255; b = (c >> 16) & 255; }
          else { r += c & 255; g += (c >> 8) & 255; b += (c >> 16) & 255; }
        }
        if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
        fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  // ── MD3 models ──────────────────────────────────────────────────────────
  aliasRoom(n) {
    if (this.av.length < n * 8) this.av = new Float32Array(n * 8 * 2);
  }

  /**
   * Draw an MD3 at `origin` with `axis` (9 numbers: the rows forward, left, up — world =
   * origin + x·fwd + y·left + z·up), frame `frame`. `skin(surface)` names the picture of a surface.
   * light: { ambient, directed, dir } from the light grid (or null for full bright).
   */
  drawMd3(mdl, frame, origin, axis, skin, light, opts = {}) {
    const view = this.view;
    const fr = Math.min(Math.max(frame | 0, 0), mdl.numFrames - 1);
    const near = opts.near ?? 4;
    const ox = origin[0] - view.x, oy = origin[1] - view.y, oz = origin[2] - view.z;
    const fwd = view.fwd, right = view.right, up = view.up;
    const fx = fwd[0], fy = fwd[1], fz = fwd[2], rx = right[0], ry = right[1], rz = right[2], ux = up[0], uy = up[1], uz = up[2];
    const a0 = axis[0], a1 = axis[1], a2 = axis[2], a3 = axis[3], a4 = axis[4], a5 = axis[5], a6 = axis[6], a7 = axis[7], a8 = axis[8];
    const vcx = view.cx, vcy = view.cy, sc = view.scale;
    const depthHack = opts.depthHack ? 3 : 1;
    const ls = this.modelLight;
    let amb = 255, dir = 0, ldx = 0, ldy = 0, ldz = 1;
    if (light) {
      amb = Math.min(255, ((light.ambient[0] + light.ambient[1] + light.ambient[2]) / 3) * this.lightScale * ls);
      dir = Math.min(255, ((light.directed[0] + light.directed[1] + light.directed[2]) / 3) * this.lightScale * ls);
      ldx = light.dir[0]; ldy = light.dir[1]; ldz = light.dir[2];
      if (amb < 24) amb = 24;
    }
    const tint = opts.tint ?? null;
    const n3 = this.anorm;
    const blend = opts.blend ?? 'opaque';
    for (const surf of mdl.surfaces) {
      const img = skin ? skin(surf) : null;
      if (img === false) continue;
      const tex = this.texture(img ?? (surf.shaders[0] || ''));
      const nv = surf.numVerts;
      this.aliasRoom(nv);
      const av = this.av;
      const xyz = surf.xyz, base = fr * nv * 4;
      for (let i = 0; i < nv; i++) {
        const p = base + i * 4;
        const mx = xyz[p] / 64, my = xyz[p + 1] / 64, mz = xyz[p + 2] / 64;
        const wx = ox + mx * a0 + my * a3 + mz * a6;
        const wy = oy + mx * a1 + my * a4 + mz * a7;
        const wz = oz + mx * a2 + my * a5 + mz * a8;
        const f = wx * fx + wy * fy + wz * fz;
        const r = wx * rx + wy * ry + wz * rz, u = wx * ux + wy * uy + wz * uz;
        const o = i * 8;
        av[o] = f; av[o + 1] = r; av[o + 2] = u;
        if (f >= near) { av[o + 3] = vcx + (r * sc) / f; av[o + 4] = vcy - (u * sc) / f; av[o + 5] = (1 / f) * depthHack; }
        let l = amb;
        if (dir > 0) {
          md3Normal(xyz[p + 3] & 0xffff, n3, 0);
          const nx = n3[0] * a0 + n3[1] * a3 + n3[2] * a6, ny = n3[0] * a1 + n3[1] * a4 + n3[2] * a7, nz = n3[0] * a2 + n3[1] * a5 + n3[2] * a8;
          const d = nx * ldx + ny * ldy + nz * ldz;
          if (d > 0) l += dir * d;
        }
        av[o + 6] = l > 255 ? 255 : l;
      }
      const tris = surf.tris, st = surf.st;
      for (let t = 0; t < surf.numTris; t++) {
        const ia = tris[t * 3], ib = tris[t * 3 + 1], ic = tris[t * 3 + 2];
        const A = ia * 8, B = ib * 8, C = ic * 8;
        if (av[A] >= near && av[B] >= near && av[C] >= near) {
          const ax = av[A + 3], ay = av[A + 4], bx = av[B + 3], by = av[B + 4], cx = av[C + 3], cy = av[C + 4];
          if (!opts.twoSided && (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= 0) continue;   // back face (Q3 winding)
          this.triangle(ax, ay, av[A + 5], st[ia * 2] * tex.w, st[ia * 2 + 1] * tex.h, av[A + 6], bx, by, av[B + 5], st[ib * 2] * tex.w, st[ib * 2 + 1] * tex.h, av[B + 6],
            cx, cy, av[C + 5], st[ic * 2] * tex.w, st[ic * 2 + 1] * tex.h, av[C + 6], tex, blend, tint);
          continue;
        }
        if (av[A] < near && av[B] < near && av[C] < near) continue;
        // clip against the near plane in view space, then project the pieces
        const P = [av[A], av[A + 1], av[A + 2], st[ia * 2] * tex.w, st[ia * 2 + 1] * tex.h, av[A + 6]];
        const Q = [av[B], av[B + 1], av[B + 2], st[ib * 2] * tex.w, st[ib * 2 + 1] * tex.h, av[B + 6]];
        const R = [av[C], av[C + 1], av[C + 2], st[ic * 2] * tex.w, st[ic * 2 + 1] * tex.h, av[C + 6]];
        const inp = [P, Q, R], out = [];
        for (let k = 0; k < 3; k++) {
          const S = inp[k], T = inp[(k + 1) % 3];
          const sin = S[0] >= near, tin = T[0] >= near;
          if (sin) out.push(S);
          if (sin !== tin) {
            const kk = (near - S[0]) / (T[0] - S[0]);
            out.push([near, S[1] + (T[1] - S[1]) * kk, S[2] + (T[2] - S[2]) * kk, S[3] + (T[3] - S[3]) * kk, S[4] + (T[4] - S[4]) * kk, S[5] + (T[5] - S[5]) * kk]);
          }
        }
        const proj = (v) => [vcx + (v[1] * sc) / v[0], vcy - (v[2] * sc) / v[0], (1 / v[0]) * depthHack, v[3], v[4], v[5]];
        const drawTri = (X, Y, Z) => {
          const a = proj(X), b = proj(Y), c = proj(Z);
          if (!opts.twoSided && (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0) return;
          this.triangle(a[0], a[1], a[2], a[3], a[4], a[5], b[0], b[1], b[2], b[3], b[4], b[5], c[0], c[1], c[2], c[3], c[4], c[5], tex, blend, tint);
        };
        drawTri(out[0], out[1], out[2]);
        if (out.length === 4) drawTri(out[0], out[2], out[3]);
      }
    }
  }

  /** One edge of a triangle into the scanline tables (x, 1/z, s, t, light). */
  triEdge(ya, yb, ax, ay, aiz, as, at, al, bx, by, biz, bs, bt, bl) {
    if (ay === by) return;
    if (ay > by) {
      let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; t = aiz; aiz = biz; biz = t;
      t = as; as = bs; bs = t; t = at; at = bt; bt = t; t = al; al = bl; bl = t;
    }
    const { edgeL, edgeR } = this;
    const dy = by - ay;
    const dx = (bx - ax) / dy, diz = (biz - aiz) / dy, ds = (bs - as) / dy, dt = (bt - at) / dy, dl = (bl - al) / dy;
    const ys = Math.max(ya, Math.ceil(ay - 0.5)), ye = Math.min(yb, Math.ceil(by - 0.5) - 1);
    for (let y = ys; y <= ye; y++) {
      const t = y + 0.5 - ay, x = ax + dx * t, o = y * 7;
      if (x < edgeL[o]) { edgeL[o] = x; edgeL[o + 1] = aiz + diz * t; edgeL[o + 2] = as + ds * t; edgeL[o + 3] = at + dt * t; edgeL[o + 4] = al + dl * t; }
      if (x > edgeR[o]) { edgeR[o] = x; edgeR[o + 1] = aiz + diz * t; edgeR[o + 2] = as + ds * t; edgeR[o + 3] = at + dt * t; edgeR[o + 4] = al + dl * t; }
    }
  }

  /** A Gouraud-lit, affine-textured triangle with z-test. blend: opaque | add | blend; tint: [r, g, b] multipliers or null. */
  triangle(x0, y0, iz0, s0, t0, l0, x1, y1, iz1, s1, t1, l1, x2, y2, iz2, s2, t2, l2, tex, blend, tint) {
    const { w, h, edgeL, edgeR, fb, zb } = this;
    const ymin = Math.min(y0, y1, y2), ymax = Math.max(y0, y1, y2);
    const ya = Math.max(0, Math.ceil(ymin - 0.5)), yb = Math.min(h - 1, Math.ceil(ymax - 0.5) - 1);
    if (ya > yb) return;
    for (let y = ya; y <= yb; y++) { edgeL[y * 7] = Infinity; edgeR[y * 7] = -Infinity; }
    this.triEdge(ya, yb, x0, y0, iz0, s0, t0, l0, x1, y1, iz1, s1, t1, l1);
    this.triEdge(ya, yb, x1, y1, iz1, s1, t1, l1, x2, y2, iz2, s2, t2, l2);
    this.triEdge(ya, yb, x2, y2, iz2, s2, t2, l2, x0, y0, iz0, s0, t0, l0);
    const td = tex.data, tw = tex.w, wm = tex.wm, hm = tex.hm;
    const alpha = tex.hasAlpha;
    const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
    for (let y = ya; y <= yb; y++) {
      const o = y * 7, xl = edgeL[o], xr = edgeR[o];
      if (xl === Infinity) continue;
      const xs = Math.max(0, Math.ceil(xl - 0.5)), xe = Math.min(w - 1, Math.ceil(xr - 0.5) - 1);
      if (xs > xe) continue;
      const span = xr - xl || 1;
      const diz = (edgeR[o + 1] - edgeL[o + 1]) / span, ds = (edgeR[o + 2] - edgeL[o + 2]) / span;
      const dt = (edgeR[o + 3] - edgeL[o + 3]) / span, dl = (edgeR[o + 4] - edgeL[o + 4]) / span;
      const tt = xs + 0.5 - xl;
      let iz = edgeL[o + 1] + diz * tt, s = edgeL[o + 2] + ds * tt, t = edgeL[o + 3] + dt * tt, l = edgeL[o + 4] + dl * tt;
      let idx = y * w + xs;
      for (let x = xs; x <= xe; x++, idx++, iz += diz, s += ds, t += dt, l += dl) {
        if (iz <= zb[idx]) continue;
        const c = td[((t & hm) * tw + (s & wm)) >>> 0];
        const a = c >>> 24;
        if (alpha && blend === 'opaque' && a < 128) continue;
        const li = l / 255;
        let r = (c & 255) * li * tr, g = ((c >> 8) & 255) * li * tg, b = ((c >> 16) & 255) * li * tb;
        if (blend === 'add') {
          const d = fb[idx];
          r += d & 255; g += (d >> 8) & 255; b += (d >> 16) & 255;
          if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
        } else if (blend === 'blend') {
          const d = fb[idx], af = a / 255, ia = 1 - af;
          r = r * af + (d & 255) * ia; g = g * af + ((d >> 8) & 255) * ia; b = b * af + ((d >> 16) & 255) * ia;
        } else {
          zb[idx] = iz;
          if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
        }
        fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  /**
   * A player model: legs at the origin, the torso on the legs' tag_torso, the head on the torso's
   * tag_head, the weapon in hand on tag_weapon. The animations are (index, start time) pairs.
   */
  drawPlayer(pm, skinName, legsAnim, legsTime, torsoAnim, torsoTime, weaponBit, origin, yaw, time, light, opts = {}) {
    const p = this.res.players.get(pm) ?? this.res.players.values().next().value;
    if (!p) return;
    const skin = p.skins.get(skinName) ?? p.skins.get('default') ?? new Map();
    const sk = (surf) => { const img = skin.get(surf.name.toLowerCase()); return img && img !== 'nodraw' ? img : surf.shaders[0] || null; };
    const axis = yawAxis(yaw);
    const lf = animFrame(p.anims, legsAnim, time - legsTime);
    const tf = animFrame(p.anims, torsoAnim < 0 ? legsAnim : torsoAnim, time - (torsoAnim < 0 ? legsTime : torsoTime));
    this.drawMd3(p.lower, lf, origin, axis, sk, light, opts);
    const torso = tagTransform(p.lower, lf, 'tag_torso', origin, axis);
    if (!torso) return;
    this.drawMd3(p.upper, tf, torso.origin, torso.axis, sk, light, opts);
    const head = tagTransform(p.upper, tf, 'tag_head', torso.origin, torso.axis);
    if (head) this.drawMd3(p.head, 0, head.origin, head.axis, sk, light, opts);
    if (weaponBit) {
      const wm = this.weaponModel(weaponBit);
      const hand = tagTransform(p.upper, tf, 'tag_weapon', torso.origin, torso.axis);
      if (wm && hand) this.drawMd3(wm, 0, hand.origin, hand.axis, null, light, opts);
    }
  }

  weaponModel(bit) {
    const names = { 1: 'gauntlet/gauntlet', 2: 'machinegun/machinegun', 4: 'shotgun/shotgun', 8: 'grenadel/grenadel', 16: 'rocketl/rocketl', 32: 'lightning/lightning', 64: 'railgun/railgun', 128: 'plasma/plasma', 256: 'bfg/bfg' };
    const id = this.res.byName.get(`models/weapons2/${names[bit]}.md3`);
    return id ? this.res.models.get(id).mdl : null;
  }

  // ── sprites, beams, particles ──────────────────────────────────────────
  /** A camera-facing square of `size` units with a picture, added or blended. */
  drawSprite(img, origin, size, blend = 'add', light = 255) {
    const view = this.view;
    const wx = origin[0] - view.x, wy = origin[1] - view.y, wz = origin[2] - view.z;
    const f = wx * view.fwd[0] + wy * view.fwd[1] + wz * view.fwd[2];
    if (f < 4) return;
    const r = wx * view.right[0] + wy * view.right[1] + wz * view.right[2];
    const u = wx * view.up[0] + wy * view.up[1] + wz * view.up[2];
    const iz = 1 / f, k = view.scale * iz;
    const hs = size / 2;
    const x0 = view.cx + (r - hs) * k, x1 = view.cx + (r + hs) * k, y0 = view.cy - (u + hs) * k, y1 = view.cy - (u - hs) * k;
    const tex = this.texture(img);
    this.triangle(x0, y0, iz, 0, 0, light, x1, y0, iz, tex.w, 0, light, x1, y1, iz, tex.w, tex.h, light, tex, blend, null);
    this.triangle(x0, y0, iz, 0, 0, light, x1, y1, iz, tex.w, tex.h, light, x0, y1, iz, 0, tex.h, light, tex, blend, null);
  }

  /** A textured ribbon from a to b facing the camera (the lightning bolt, the rail core). */
  drawBeam(a, b, img, width, blend = 'add', scroll = 0) {
    const view = this.view;
    const toView = (p) => {
      const wx = p[0] - view.x, wy = p[1] - view.y, wz = p[2] - view.z;
      return [wx * view.fwd[0] + wy * view.fwd[1] + wz * view.fwd[2], wx * view.right[0] + wy * view.right[1] + wz * view.right[2], wx * view.up[0] + wy * view.up[1] + wz * view.up[2]];
    };
    let A = toView(a), B = toView(b);
    const near = 4;
    if (A[0] < near && B[0] < near) return;
    if (A[0] < near) { const k = (near - A[0]) / (B[0] - A[0]); A = [near, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]; }
    if (B[0] < near) { const k = (near - B[0]) / (A[0] - B[0]); B = [near, B[1] + (A[1] - B[1]) * k, B[2] + (A[2] - B[2]) * k]; }
    // the perpendicular in view space (right/up plane)
    const dr = B[1] - A[1], du = B[2] - A[2];
    const len = Math.hypot(dr, du) || 1;
    const pr = (-du / len) * width / 2, pu = (dr / len) * width / 2;
    const proj = (v) => [view.cx + (v[1] * view.scale) / v[0], view.cy - (v[2] * view.scale) / v[0], 1 / v[0]];
    const p0 = proj([A[0], A[1] + pr, A[2] + pu]), p1 = proj([A[0], A[1] - pr, A[2] - pu]);
    const p2 = proj([B[0], B[1] - pr, B[2] - pu]), p3 = proj([B[0], B[1] + pr, B[2] + pu]);
    const tex = this.texture(img);
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 64;
    const s0 = scroll * tex.w, s1 = (tl + scroll) * tex.w;
    this.triangle(p0[0], p0[1], p0[2], s0, 0, 255, p1[0], p1[1], p1[2], s0, tex.h, 255, p2[0], p2[1], p2[2], s1, tex.h, 255, tex, blend, null);
    this.triangle(p0[0], p0[1], p0[2], s0, 0, 255, p2[0], p2[1], p2[2], s1, tex.h, 255, p3[0], p3[1], p3[2], s1, 0, 255, tex, blend, null);
  }

  spawnParticles(kind, x, y, z, n, dir = [0, 0, 0], color = 0xffffffff) {
    const now = this.time ?? 0;
    const add = (p) => this.particles.push(p);
    const rnd = () => Math.random() * 2 - 1;
    if (kind === 'explosion') {
      for (let i = 0; i < 48; i++) add({ x: x + rnd() * 8, y: y + rnd() * 8, z: z + rnd() * 8, vx: rnd() * 300, vy: rnd() * 300, vz: rnd() * 300 + 100,
        color: i & 1 ? 0xff30a0ff : 0xff2060ff, die: now + 0.4 + Math.random() * 0.4, type: 'grav', size: 2 });
    } else if (kind === 'teleport') {
      for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28, r = 8 + Math.random() * 12; add({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z: z - 24 + Math.random() * 56, vx: 0, vy: 0, vz: 120 + Math.random() * 120, color: 0xffffa060, die: now + 0.5 + Math.random() * 0.4, type: 'still', size: 1 }); }
    } else if (kind === 'rail') {
      const [x2, y2, z2] = dir;
      const dx = x2 - x, dy = y2 - y, dz = z2 - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const nx = dx / len, ny = dy / len, nz = dz / len;
      let px = -ny, py = nx, pz = 0;
      if (Math.abs(nz) > 0.9) { px = 1; py = 0; pz = 0; }
      const ux = ny * pz - nz * py, uy = nz * px - nx * pz, uz = nx * py - ny * px;
      for (let i = 0; i < len; i += 2) {
        const a = i * 0.12, c = Math.cos(a) * 4, s = Math.sin(a) * 4;
        add({ x: x + nx * i + px * c + ux * s, y: y + ny * i + py * c + uy * s, z: z + nz * i + pz * c + uz * s, vx: 0, vy: 0, vz: 0, color: 0xff8030ff, die: now + 0.8 + Math.random() * 0.4, type: 'still', size: 1 });
      }
    } else {
      const scale = kind === 'blood' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        add({ x: x + rnd() * 2 * scale, y: y + rnd() * 2 * scale, z: z + rnd() * 2 * scale, vx: dir[0] * 60 + rnd() * 60, vy: dir[1] * 60 + rnd() * 60, vz: dir[2] * 60 + rnd() * 60 + 30,
          color, die: now + 0.15 + Math.random() * 0.35, type: kind === 'blood' ? 'grav' : 'slowgrav', size: 1 });
      }
    }
  }

  runParticles(dt, time) {
    this.time = time;
    const ps = this.particles;
    const grav = 800 * dt;
    let k = 0;
    for (const p of ps) {
      if (p.die < time) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.type === 'grav') p.vz -= grav; else if (p.type === 'slowgrav') p.vz -= grav * 0.1;
      ps[k++] = p;
    }
    ps.length = k;
  }

  drawParticles() {
    const view = this.view;
    const { fb, zb, w, h } = this;
    for (const p of this.particles) {
      const wx = p.x - view.x, wy = p.y - view.y, wz = p.z - view.z;
      const f = wx * view.fwd[0] + wy * view.fwd[1] + wz * view.fwd[2];
      if (f < 4) continue;
      const iz = 1 / f;
      const x = (view.cx + ((wx * view.right[0] + wy * view.right[1] + wz * view.right[2]) * view.scale) / f) | 0;
      const y = (view.cy - ((wx * view.up[0] + wy * view.up[1] + wz * view.up[2]) * view.scale) / f) | 0;
      const size = Math.max(1, Math.min(3, Math.round((p.size ?? 1) * 160 / f)));
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const idx = py * w + px;
        if (iz > zb[idx]) { fb[idx] = p.color; }
      }
    }
  }

  // ── 2D ──────────────────────────────────────────────────────────────────
  /** A picture scaled to rw×rh at (x, y), alpha blended (R_DrawStretchPic). */
  drawPic(img, x, y, rw = img?.w, rh = img?.h, tint = null) {
    if (!img) return;
    const { fb, w, h } = this;
    const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
    for (let j = 0; j < rh; j++) {
      const py = (y + j) | 0;
      if (py < 0 || py >= h) continue;
      const sy = Math.floor((j * img.h) / rh);
      for (let i = 0; i < rw; i++) {
        const px = (x + i) | 0;
        if (px < 0 || px >= w) continue;
        const c = img.data[sy * img.w + Math.floor((i * img.w) / rw)];
        const a = c >>> 24;
        if (a === 0) continue;
        const idx = py * w + px;
        if (a === 255 && !tint) { fb[idx] = c; continue; }
        const d = fb[idx], af = a / 255, ia = 1 - af;
        const r = (c & 255) * tr * af + (d & 255) * ia, g = ((c >> 8) & 255) * tg * af + ((d >> 8) & 255) * ia, b = ((c >> 16) & 255) * tb * af + ((d >> 16) & 255) * ia;
        fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  /** A character of the 16×16 grid of bigchars.tga, `size` pixels square. */
  drawChar(font, c, x, y, size = 8, tint = null) {
    if (!font || c === 32) return;
    const { fb, w, h } = this;
    const cw = font.w >> 4, ch = font.h >> 4;
    const cx = (c & 15) * cw, cy = (c >> 4) * ch;
    const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
    for (let j = 0; j < size; j++) {
      const py = y + j;
      if (py < 0 || py >= h) continue;
      const sy = cy + Math.floor((j * ch) / size);
      for (let i = 0; i < size; i++) {
        const px = x + i;
        if (px < 0 || px >= w) continue;
        const col = font.data[sy * font.w + cx + Math.floor((i * cw) / size)];
        const a = col >>> 24;
        if (a < 64) continue;
        const idx = py * w + px, d = fb[idx], af = a / 255, ia = 1 - af;
        const r = (col & 255) * tr * af + (d & 255) * ia, g = ((col >> 8) & 255) * tg * af + ((d >> 8) & 255) * ia, b = ((col >> 16) & 255) * tb * af + ((d >> 16) & 255) * ia;
        fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  drawString(font, s, x, y, size = 8, tint = null) {
    for (let i = 0; i < s.length; i++) this.drawChar(font, s.charCodeAt(i) & 255, x + i * size, y, size, tint);
  }

  fillRect(x, y, rw, rh, c, alpha = 1) {
    const { fb, w, h } = this;
    for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) {
      const idx = j * w + i;
      if (alpha >= 1) { fb[idx] = c; continue; }
      const d = fb[idx], ia = 1 - alpha;
      const r = (c & 255) * alpha + (d & 255) * ia, g = ((c >> 8) & 255) * alpha + ((d >> 8) & 255) * ia, b = ((c >> 16) & 255) * alpha + ((d >> 16) & 255) * ia;
      fb[idx] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  /** Put the frame on the canvas, with a colour blend over it (the damage flash, the water, the quad). */
  present(tint = null) {
    if (tint && tint[3] > 0) {
      const { fb } = this;
      const a = tint[3], ia = 1 - a, tr = tint[0] * a, tg = tint[1] * a, tb = tint[2] * a;
      for (let i = 0; i < fb.length; i++) {
        const c = fb[i];
        fb[i] = (0xff000000 | ((((c >> 16) & 255) * ia + tb) << 16) | ((((c >> 8) & 255) * ia + tg) << 8) | ((c & 255) * ia + tr)) >>> 0;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}

/** AngleVectors as a matrix with the columns forward, -right, up (the game's convention for brush models). */
export function angleMatrix([pitch, yaw, roll]) {
  const sy = Math.sin((yaw * Math.PI) / 180), cy = Math.cos((yaw * Math.PI) / 180);
  const sp = Math.sin((pitch * Math.PI) / 180), cp = Math.cos((pitch * Math.PI) / 180);
  const sr = Math.sin((roll * Math.PI) / 180), cr = Math.cos((roll * Math.PI) / 180);
  return [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy, cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy, -sp, sr * cp, cr * cp];
}

/** AnglesToAxis for a yaw alone: rows forward, left, up. */
export function yawAxis(yaw) {
  const s = Math.sin((yaw * Math.PI) / 180), c = Math.cos((yaw * Math.PI) / 180);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** AnglesToAxis: rows forward, left, up from pitch, yaw, roll (degrees, pitch positive down as the view has it). */
export function anglesAxis(pitch, yaw, roll) {
  const sy = Math.sin((yaw * Math.PI) / 180), cy = Math.cos((yaw * Math.PI) / 180);
  const sp = Math.sin((pitch * Math.PI) / 180), cp = Math.cos((pitch * Math.PI) / 180);
  const sr = Math.sin((roll * Math.PI) / 180), cr = Math.cos((roll * Math.PI) / 180);
  const fwd = [cp * cy, cp * sy, -sp];
  const right = [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp];
  const up = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  return [fwd[0], fwd[1], fwd[2], -right[0], -right[1], -right[2], up[0], up[1], up[2]];
}

/** CG_PositionRotatedEntityOnTag: the origin and axis of a tag of `mdl` at `frame` under a parent transform. */
export function tagTransform(mdl, frame, tagName, origin, axis) {
  const ti = mdl.tagIndex(tagName);
  if (ti < 0) return null;
  const fr = Math.min(Math.max(frame | 0, 0), mdl.numFrames - 1);
  const tag = mdl.tags[fr][ti];
  const o = tag.origin, ta = tag.axis;
  const out = new Float64Array(9);
  // out[i] = Σ_k tag.axis[i][k] · parent.axis[k]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = ta[i * 3] * axis[j] + ta[i * 3 + 1] * axis[3 + j] + ta[i * 3 + 2] * axis[6 + j];
  const org = [
    origin[0] + o[0] * axis[0] + o[1] * axis[3] + o[2] * axis[6],
    origin[1] + o[0] * axis[1] + o[1] * axis[4] + o[2] * axis[7],
    origin[2] + o[0] * axis[2] + o[1] * axis[5] + o[2] * axis[8],
  ];
  return { origin: org, axis: out };
}

/** The frame of an animation after `elapsed` seconds (looping into its loop frames, else holding the last). */
export function animFrame(anims, index, elapsed) {
  const a = anims[index];
  if (!a) return 0;
  let f = Math.floor(Math.max(0, elapsed) * a.fps);
  if (f >= a.count) {
    if (a.loop > 0) f = a.count - a.loop + ((f - (a.count - a.loop)) % a.loop);
    else f = a.count - 1;
  }
  return a.first + f;
}

export { ANIM, SURF };
