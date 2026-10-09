// bsp.js – Quake III BSP version 46 (IBSP). Everything the SQL side needs
// is produced as plain arrays; what only the painter needs (the vertices
// with their texture and lightmap coordinates, the lightmap pages, the
// light grid) stays here.
//
// Against Quake 2: faces carry their own vertices (with lightmap
// coordinates per vertex, into 128×128 lightmap pages) and can be curved –
// Bézier patches are tessellated here, for drawing and, more coarsely, into
// one-sided collision facets that join the brushes; a leaf's contents are
// those of its brushes; brush models have no node tree but a list of
// brushes, so each gets a leaf of its own; the PVS is uncompressed.

import { cstr } from './pk3.js';

const LUMP = { entities: 0, textures: 1, planes: 2, nodes: 3, leafs: 4, leaffaces: 5, leafbrushes: 6, models: 7, brushes: 8, brushsides: 9, vertexes: 10, meshverts: 11, effects: 12, faces: 13, lightmaps: 14, lightvols: 15, visdata: 16 };

export const CONTENTS = {
  SOLID: 1, LAVA: 8, SLIME: 16, WATER: 32, FOG: 64, PLAYERCLIP: 0x10000, MONSTERCLIP: 0x20000, TELEPORTER: 0x40000, JUMPPAD: 0x80000,
  CLUSTERPORTAL: 0x100000, DONOTENTER: 0x200000, BOTCLIP: 0x400000, MOVER: 0x800000, ORIGIN: 0x1000000, BODY: 0x2000000, CORPSE: 0x4000000,
  DETAIL: 0x8000000, STRUCTURAL: 0x10000000, TRANSLUCENT: 0x20000000, TRIGGER: 0x40000000, NODROP: -0x80000000,
};
export const SURF = { NODAMAGE: 1, SLICK: 2, SKY: 4, LADDER: 8, NOIMPACT: 0x10, NOMARKS: 0x20, FLESH: 0x40, NODRAW: 0x80, HINT: 0x100, SKIP: 0x200, NOLIGHTMAP: 0x400, POINTLIGHT: 0x800, METALSTEPS: 0x1000, NOSTEPS: 0x2000, NONSOLID: 0x4000, LIGHTFILTER: 0x8000, ALPHASHADOW: 0x10000, NODLIGHT: 0x20000, DUST: 0x40000 };
export const MASK = { SOLID: 1, PLAYERSOLID: 1 | 0x10000 | 0x2000000, DEADSOLID: 1 | 0x10000, WATER: 56, OPAQUE: 25, SHOT: 1 | 0x2000000 | 0x4000000 };

export const RENDER_LEVEL = 4;      // Bézier subdivisions per control patch when drawing
export const COLLIDE_LEVEL = 2;     // ... and for the collision facets
const LIGHTMAP_SIZE = 128;

export class Bsp {
  constructor(buffer, name = '') {
    this.name = name;
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    if (cstr(bytes, 0, 4) !== 'IBSP') throw new Error(`${name}: not an IBSP file`);
    const version = dv.getInt32(4, true);
    if (version !== 46 && version !== 47) throw new Error(`${name}: BSP version ${version}, expected 46`);
    const lump = (i) => ({ off: dv.getInt32(8 + i * 8, true), len: dv.getInt32(12 + i * 8, true) });

    let l = lump(LUMP.entities);
    this.entityText = cstr(bytes, l.off, l.len);
    this.entities = parseEntities(this.entityText);

    l = lump(LUMP.textures);
    this.textures = [];
    for (let p = l.off; p < l.off + l.len; p += 72) {
      this.textures.push({ name: cstr(bytes, p, 64).toLowerCase().replace(/\\/g, '/'), flags: dv.getInt32(p + 64, true), contents: dv.getInt32(p + 68, true) });
    }

    l = lump(LUMP.planes);
    this.planes = [];
    for (let p = l.off; p < l.off + l.len; p += 16) {
      const nx = dv.getFloat32(p, true), ny = dv.getFloat32(p + 4, true), nz = dv.getFloat32(p + 8, true);
      this.planes.push({ nx, ny, nz, dist: dv.getFloat32(p + 12, true), type: nx === 1 ? 0 : ny === 1 ? 1 : nz === 1 ? 2 : 3 });
    }

    l = lump(LUMP.nodes);
    this.nodes = [];
    for (let p = l.off; p < l.off + l.len; p += 36) {
      this.nodes.push({
        plane: dv.getInt32(p, true), children: [dv.getInt32(p + 4, true), dv.getInt32(p + 8, true)],
        mins: [dv.getInt32(p + 12, true), dv.getInt32(p + 16, true), dv.getInt32(p + 20, true)],
        maxs: [dv.getInt32(p + 24, true), dv.getInt32(p + 28, true), dv.getInt32(p + 32, true)],
      });
    }

    l = lump(LUMP.leafs);
    this.leaves = [];
    for (let p = l.off; p < l.off + l.len; p += 48) {
      this.leaves.push({
        cluster: dv.getInt32(p, true), area: dv.getInt32(p + 4, true),
        mins: [dv.getInt32(p + 8, true), dv.getInt32(p + 12, true), dv.getInt32(p + 16, true)],
        maxs: [dv.getInt32(p + 20, true), dv.getInt32(p + 24, true), dv.getInt32(p + 28, true)],
        firstLeafFace: dv.getInt32(p + 32, true), numLeafFaces: dv.getInt32(p + 36, true),
        firstLeafBrush: dv.getInt32(p + 40, true), numLeafBrushes: dv.getInt32(p + 44, true), contents: 0,
      });
    }

    l = lump(LUMP.leaffaces);
    this.leaffaces = new Int32Array(bytes.buffer.slice(l.off, l.off + l.len));
    l = lump(LUMP.leafbrushes);
    this.leafbrushes = new Int32Array(bytes.buffer.slice(l.off, l.off + l.len));

    l = lump(LUMP.models);
    this.models = [];
    for (let p = l.off; p < l.off + l.len; p += 40) {
      this.models.push({
        mins: [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)],
        maxs: [dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true)],
        firstFace: dv.getInt32(p + 24, true), numFaces: dv.getInt32(p + 28, true),
        firstBrush: dv.getInt32(p + 32, true), numBrushes: dv.getInt32(p + 36, true),
      });
    }

    l = lump(LUMP.brushes);
    this.brushes = [];
    for (let p = l.off; p < l.off + l.len; p += 12) {
      const tex = dv.getInt32(p + 8, true);
      this.brushes.push({ firstSide: dv.getInt32(p, true), numSides: dv.getInt32(p + 4, true), texture: tex, contents: this.textures[tex]?.contents ?? 0, facet: false });
    }
    l = lump(LUMP.brushsides);
    this.brushsides = [];
    for (let p = l.off; p < l.off + l.len; p += 8) {
      const tex = dv.getInt32(p + 4, true);
      this.brushsides.push({ plane: dv.getInt32(p, true), texture: tex, flags: this.textures[tex]?.flags ?? 0 });
    }

    // vertices: position, texture st, lightmap st, normal, colour
    l = lump(LUMP.vertexes);
    const nv = (l.len / 44) | 0;
    this.numVertices = nv;
    this.vertices = new Float32Array(nv * 3);
    this.texcoords = new Float32Array(nv * 2);
    this.lmcoords = new Float32Array(nv * 2);
    this.normals = new Float32Array(nv * 3);
    this.colors = new Uint8Array(nv * 4);
    for (let i = 0, p = l.off; i < nv; i++, p += 44) {
      this.vertices[i * 3] = dv.getFloat32(p, true); this.vertices[i * 3 + 1] = dv.getFloat32(p + 4, true); this.vertices[i * 3 + 2] = dv.getFloat32(p + 8, true);
      this.texcoords[i * 2] = dv.getFloat32(p + 12, true); this.texcoords[i * 2 + 1] = dv.getFloat32(p + 16, true);
      this.lmcoords[i * 2] = dv.getFloat32(p + 20, true); this.lmcoords[i * 2 + 1] = dv.getFloat32(p + 24, true);
      this.normals[i * 3] = dv.getFloat32(p + 28, true); this.normals[i * 3 + 1] = dv.getFloat32(p + 32, true); this.normals[i * 3 + 2] = dv.getFloat32(p + 36, true);
      this.colors[i * 4] = bytes[p + 40]; this.colors[i * 4 + 1] = bytes[p + 41]; this.colors[i * 4 + 2] = bytes[p + 42]; this.colors[i * 4 + 3] = bytes[p + 43];
    }
    l = lump(LUMP.meshverts);
    this.meshverts = new Int32Array(bytes.buffer.slice(l.off, l.off + l.len));

    l = lump(LUMP.faces);
    this.faces = [];
    for (let p = l.off; p < l.off + l.len; p += 104) {
      this.faces.push({
        texture: dv.getInt32(p, true), effect: dv.getInt32(p + 4, true), type: dv.getInt32(p + 8, true),
        firstVert: dv.getInt32(p + 12, true), numVerts: dv.getInt32(p + 16, true),
        firstMeshVert: dv.getInt32(p + 20, true), numMeshVerts: dv.getInt32(p + 24, true),
        lmIndex: dv.getInt32(p + 28, true),
        lmStart: [dv.getInt32(p + 32, true), dv.getInt32(p + 36, true)], lmSize: [dv.getInt32(p + 40, true), dv.getInt32(p + 44, true)],
        lmOrigin: [dv.getFloat32(p + 48, true), dv.getFloat32(p + 52, true), dv.getFloat32(p + 56, true)],
        lmVecs: [[dv.getFloat32(p + 60, true), dv.getFloat32(p + 64, true), dv.getFloat32(p + 68, true)], [dv.getFloat32(p + 72, true), dv.getFloat32(p + 76, true), dv.getFloat32(p + 80, true)]],
        normal: [dv.getFloat32(p + 84, true), dv.getFloat32(p + 88, true), dv.getFloat32(p + 92, true)],
        size: [dv.getInt32(p + 96, true), dv.getInt32(p + 100, true)],
      });
    }

    // lightmaps: n pages of 128×128 RGB
    l = lump(LUMP.lightmaps);
    this.numLightmaps = (l.len / (LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3)) | 0;
    this.lightmaps = bytes.subarray(l.off, l.off + l.len);

    // the light grid (for models): ambient, directed, direction; 64×64×128 cells over the world
    l = lump(LUMP.lightvols);
    this.lightvols = bytes.subarray(l.off, l.off + l.len);
    const w = this.models[0];
    const gs = [64, 64, 128];
    this.gridMins = [0, 0, 0]; this.gridSize = gs; this.gridDims = [1, 1, 1];
    if (w) {
      for (let a = 0; a < 3; a++) {
        this.gridMins[a] = gs[a] * Math.ceil(w.mins[a] / gs[a]);
        const max = gs[a] * Math.floor(w.maxs[a] / gs[a]);
        this.gridDims[a] = (max - this.gridMins[a]) / gs[a] + 1;
      }
    }

    // the PVS of every cluster as a hex string: cluster j visible ⇔ bit j (low nibble first, so cluster j is at index j >> 2)
    l = lump(LUMP.visdata);
    this.numClusters = l.len >= 8 ? dv.getInt32(l.off, true) : 0;
    const rowBytes = l.len >= 8 ? dv.getInt32(l.off + 4, true) : 0;
    this.pvsHex = new Array(Math.max(0, this.numClusters));
    const hex = '0123456789abcdef';
    for (let c = 0; c < this.numClusters; c++) {
      let s = '';
      const p = l.off + 8 + c * rowBytes;
      for (let k = 0; k < rowBytes; k++) { const b = bytes[p + k]; s += hex[b & 15] + hex[b >> 4]; }
      this.pvsHex[c] = s;
    }

    // leaf contents: the union of the leaf's brushes (a bound: the trace clips brush by brush)
    for (const lf of this.leaves) {
      let c = 0;
      for (let k = 0; k < lf.numLeafBrushes; k++) c |= this.brushes[this.leafbrushes[lf.firstLeafBrush + k]].contents;
      lf.contents = c;
    }

    this.buildSurfaces();
    this.buildFacets();
    this.modelLeaves();
  }

  /**
   * The drawable geometry of every face: a polygon (planar faces keep their
   * vertex order), or a triangle list (meshes, and patches tessellated at
   * RENDER_LEVEL). Each face gets { verts: Float32Array(n × 10: x y z s t u v r g b), tris: Uint16Array | null, plane }.
   */
  buildSurfaces() {
    const V = this.vertices, T = this.texcoords, L = this.lmcoords, C = this.colors;
    for (const f of this.faces) {
      f.flags = this.textures[f.texture]?.flags ?? 0;
      if (f.type === 2) {
        const g = tessellate(this, f, RENDER_LEVEL);
        f.verts = g.verts; f.tris = g.tris; f.nverts = g.nverts; f.twoSided = true;
        f.plane = null;
      } else if (f.type === 1 || f.type === 3) {
        const n = f.numVerts;
        const verts = new Float32Array(n * 10);
        for (let k = 0; k < n; k++) {
          const vi = f.firstVert + k, o = k * 10;
          verts[o] = V[vi * 3]; verts[o + 1] = V[vi * 3 + 1]; verts[o + 2] = V[vi * 3 + 2];
          verts[o + 3] = T[vi * 2]; verts[o + 4] = T[vi * 2 + 1];
          verts[o + 5] = L[vi * 2]; verts[o + 6] = L[vi * 2 + 1];
          verts[o + 7] = C[vi * 4]; verts[o + 8] = C[vi * 4 + 1]; verts[o + 9] = C[vi * 4 + 2];
        }
        f.verts = verts; f.nverts = n;
        f.tris = new Uint16Array(this.meshverts.subarray(f.firstMeshVert, f.firstMeshVert + f.numMeshVerts));
        f.twoSided = f.type === 3;
        // the polygon's plane (type 1): the face normal, through its first vertex
        const nx = f.normal[0], ny = f.normal[1], nz = f.normal[2];
        f.plane = f.type === 1 ? { nx, ny, nz, dist: nx * verts[0] + ny * verts[1] + nz * verts[2] } : null;
        // is the polygon a plain fan over its vertices? then it can be scan-converted as one convex polygon
        f.fan = f.type === 1;   // planar faces are convex polygons in vertex order (their meshverts are a fan)
      } else {
        f.verts = new Float32Array(0); f.tris = null; f.nverts = 0; f.plane = null; f.twoSided = true;   // billboards: not drawn
      }
      // bounding sphere
      let cx = 0, cy = 0, cz = 0;
      const n = f.nverts;
      for (let k = 0; k < n; k++) { cx += f.verts[k * 10]; cy += f.verts[k * 10 + 1]; cz += f.verts[k * 10 + 2]; }
      if (n) { cx /= n; cy /= n; cz /= n; }
      let r = 0;
      for (let k = 0; k < n; k++) r = Math.max(r, Math.hypot(f.verts[k * 10] - cx, f.verts[k * 10 + 1] - cy, f.verts[k * 10 + 2] - cz));
      f.center = [cx, cy, cz]; f.radius = r;
    }
  }

  /**
   * Collision facets for the patches (cm_patch.c): every cell of a coarse
   * tessellation becomes a one-sided brush – its surface plane and a border
   * plane per edge – appended to the brushes and listed by every leaf whose
   * box it touches. The leafbrush arrays are rebuilt afterwards.
   */
  buildFacets() {
    const extra = [];   // { sides: [{nx,ny,nz,dist}], contents, mins, maxs }
    for (const f of this.faces) {
      if (f.type !== 2) continue;
      const tex = this.textures[f.texture];
      if (!tex || (tex.flags & SURF.NONSOLID) || !(tex.contents & (CONTENTS.SOLID | CONTENTS.PLAYERCLIP))) continue;
      const g = tessellate(this, f, COLLIDE_LEVEL);
      const P = g.verts;
      const pt = (i) => [P[i * 10], P[i * 10 + 1], P[i * 10 + 2]];
      for (let t = 0; t < g.tris.length; t += 3) {
        const a = pt(g.tris[t]), b = pt(g.tris[t + 1]), c = pt(g.tris[t + 2]);
        const n = cross(sub(c, a), sub(b, a));   // Q3 triangles are clockwise seen from the front
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-3) continue;   // degenerate
        n[0] /= len; n[1] /= len; n[2] /= len;
        const sides = [{ nx: n[0], ny: n[1], nz: n[2], dist: dot(n, a) }];
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          const e = sub(q, p);
          const bn = cross(n, e);   // outward for a clockwise triangle
          const bl = Math.hypot(bn[0], bn[1], bn[2]);
          if (bl < 1e-6) continue;
          bn[0] /= bl; bn[1] /= bl; bn[2] /= bl;
          sides.push({ nx: bn[0], ny: bn[1], nz: bn[2], dist: dot(bn, p) });
        }
        const mins = [Math.min(a[0], b[0], c[0]) - 1, Math.min(a[1], b[1], c[1]) - 1, Math.min(a[2], b[2], c[2]) - 1];
        const maxs = [Math.max(a[0], b[0], c[0]) + 1, Math.max(a[1], b[1], c[1]) + 1, Math.max(a[2], b[2], c[2]) + 1];
        extra.push({ sides, contents: tex.contents, mins, maxs });
      }
    }
    this.numFacets = extra.length;
    if (!extra.length) return;
    // append brushes and sides
    const planeBase = this.planes.length;
    for (const fb of extra) {
      const firstSide = this.brushsides.length;
      for (const s of fb.sides) {
        this.planes.push({ nx: s.nx, ny: s.ny, nz: s.nz, dist: s.dist, type: 3 });
        this.brushsides.push({ plane: this.planes.length - 1, texture: -1, flags: 0 });
      }
      fb.id = this.brushes.length;
      this.brushes.push({ firstSide, numSides: fb.sides.length, texture: -1, contents: fb.contents, facet: true, mins: fb.mins, maxs: fb.maxs });
    }
    // which leaves does each facet touch? walk the tree with its box
    const perLeaf = this.leaves.map((lf) => Array.from(this.leafbrushes.subarray(lf.firstLeafBrush, lf.firstLeafBrush + lf.numLeafBrushes)));
    const head = 0;
    for (const fb of extra) {
      const stack = [head];
      while (stack.length) {
        const n = stack.pop();
        if (n < 0) {
          const li = -1 - n;
          const lf = this.leaves[li];
          if (lf.cluster < 0 && lf.area < 0) continue;
          perLeaf[li].push(fb.id);
          lf.contents |= fb.contents;
          continue;
        }
        const node = this.nodes[n], pl = this.planes[node.plane];
        const d1 = pl.nx * (pl.nx >= 0 ? fb.maxs[0] : fb.mins[0]) + pl.ny * (pl.ny >= 0 ? fb.maxs[1] : fb.mins[1]) + pl.nz * (pl.nz >= 0 ? fb.maxs[2] : fb.mins[2]) - pl.dist;
        const d2 = pl.nx * (pl.nx >= 0 ? fb.mins[0] : fb.maxs[0]) + pl.ny * (pl.ny >= 0 ? fb.mins[1] : fb.maxs[1]) + pl.nz * (pl.nz >= 0 ? fb.mins[2] : fb.maxs[2]) - pl.dist;
        if (d1 >= 0) stack.push(node.children[0]);
        if (d2 <= 0) stack.push(node.children[1]);
      }
    }
    const out = [];
    this.leaves.forEach((lf, i) => { lf.firstLeafBrush = out.length; lf.numLeafBrushes = perLeaf[i].length; for (const b of perLeaf[i]) out.push(b); });
    this.leafbrushes = Int32Array.from(out);
    void planeBase;
  }

  /** Brush models have no tree: each gets a leaf listing its brushes, reached as a negative "head node". */
  modelLeaves() {
    this.models.forEach((m, mi) => {
      if (mi === 0) { m.headnode = 0; return; }
      const first = this.leafbrushes.length;
      const extra = [];
      let c = 0;
      for (let k = 0; k < m.numBrushes; k++) { extra.push(m.firstBrush + k); c |= this.brushes[m.firstBrush + k].contents; }
      const lb = new Int32Array(first + extra.length);
      lb.set(this.leafbrushes); lb.set(extra, first);
      this.leafbrushes = lb;
      const li = this.leaves.length;
      this.leaves.push({ cluster: -1, area: -1, mins: m.mins.map(Math.floor), maxs: m.maxs.map(Math.ceil), firstLeafFace: 0, numLeafFaces: 0, firstLeafBrush: first, numLeafBrushes: extra.length, contents: c, modelLeaf: true });
      m.headnode = -1 - li;
    });
  }

  /** The leaf containing a point (Mod_PointInLeaf). */
  pointLeaf(x, y, z) {
    let n = 0;
    while (n >= 0) {
      const node = this.nodes[n];
      const pl = this.planes[node.plane];
      n = node.children[x * pl.nx + y * pl.ny + z * pl.nz - pl.dist >= 0 ? 0 : 1];
    }
    return -1 - n;
  }

  /** The contents of the world's brushes at a point (CM_PointContents against model 0). */
  pointContents(x, y, z) {
    const lf = this.leaves[this.pointLeaf(x, y, z)];
    let c = 0;
    for (let k = 0; k < lf.numLeafBrushes; k++) {
      const b = this.brushes[this.leafbrushes[lf.firstLeafBrush + k]];
      if (!b.contents || (c & b.contents) === b.contents) continue;
      let inside = b.numSides > 0;
      for (let s = 0; s < b.numSides && inside; s++) {
        const pl = this.planes[this.brushsides[b.firstSide + s].plane];
        if (x * pl.nx + y * pl.ny + z * pl.nz - pl.dist > 0) inside = false;
      }
      if (inside) c |= b.contents;
    }
    return c;
  }

  /** The light grid sample at a point: { ambient: [r,g,b], directed: [r,g,b], dir: [x,y,z] } (R_SetupEntityLightingGrid, nearest cell). */
  lightGrid(x, y, z) {
    const d = this.gridDims, gs = this.gridSize, gm = this.gridMins;
    const out = { ambient: [64, 64, 64], directed: [0, 0, 0], dir: [0, 0, 1] };
    if (!this.lightvols.length) return out;
    const ix = Math.max(0, Math.min(d[0] - 1, Math.round((x - gm[0]) / gs[0])));
    const iy = Math.max(0, Math.min(d[1] - 1, Math.round((y - gm[1]) / gs[1])));
    const iz = Math.max(0, Math.min(d[2] - 1, Math.round((z - gm[2]) / gs[2])));
    const i = (ix + iy * d[0] + iz * d[0] * d[1]) * 8;
    const v = this.lightvols;
    if (i + 7 >= v.length) return out;
    out.ambient = [v[i], v[i + 1], v[i + 2]];
    out.directed = [v[i + 3], v[i + 4], v[i + 5]];
    const lat = v[i + 7] * (2 * Math.PI / 255), lng = v[i + 6] * (2 * Math.PI / 255);
    out.dir = [Math.cos(lat) * Math.sin(lng), Math.sin(lat) * Math.sin(lng), Math.cos(lng)];
    return out;
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function isFan(tris, n) {
  if (tris.length !== (n - 2) * 3) return false;
  for (let k = 0; k < n - 2; k++) if (tris[k * 3] !== 0 || tris[k * 3 + 1] !== k + 1 || tris[k * 3 + 2] !== k + 2) return false;
  return true;
}

/**
 * Tessellate a patch face: its numVerts control points form a size[0]×size[1]
 * grid of biquadratic Bézier patches (3×3 control points each, sharing
 * edges). `level` subdivisions per patch. Returns the vertex grid (x y z s t
 * u v r g b per vertex) and the triangle indices.
 */
export function tessellate(bsp, f, level) {
  const w = f.size[0], h = f.size[1];
  const V = bsp.vertices, T = bsp.texcoords, L = bsp.lmcoords, C = bsp.colors;
  const cp = (i, j) => {
    const vi = f.firstVert + j * w + i;
    return [V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2], T[vi * 2], T[vi * 2 + 1], L[vi * 2], L[vi * 2 + 1], C[vi * 4], C[vi * 4 + 1], C[vi * 4 + 2]];
  };
  const pw = (w - 1) >> 1, ph = (h - 1) >> 1;      // patches across and down
  const gw = pw * level + 1, gh = ph * level + 1;  // grid vertices
  const verts = new Float32Array(gw * gh * 10);
  const tmp = new Float64Array(10);
  for (let pj = 0; pj < ph; pj++) {
    for (let pi = 0; pi < pw; pi++) {
      // the 3×3 control points of this patch
      const P = [];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) P.push(cp(pi * 2 + i, pj * 2 + j));
      for (let v = 0; v <= level; v++) {
        if (pj > 0 && v === 0) continue;   // shared with the patch above
        const tv = v / level;
        const bv = [(1 - tv) * (1 - tv), 2 * tv * (1 - tv), tv * tv];
        for (let u = 0; u <= level; u++) {
          if (pi > 0 && u === 0) continue;
          const tu = u / level;
          const bu = [(1 - tu) * (1 - tu), 2 * tu * (1 - tu), tu * tu];
          tmp.fill(0);
          for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
            const wgt = bu[i] * bv[j];
            const p = P[j * 3 + i];
            for (let k = 0; k < 10; k++) tmp[k] += p[k] * wgt;
          }
          const gi = (pj * level + v) * gw + pi * level + u;
          verts.set(tmp, gi * 10);
        }
      }
    }
  }
  const tris = [];
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      tris.push(a, c, b, b, c, d);
    }
  }
  return { verts, tris: Uint16Array.from(tris), nverts: gw * gh, gw, gh };
}

/** The entity lump: [{ classname, origin: 'x y z', ... }, ...] with lower-cased keys. */
export function parseEntities(text) {
  const ents = [];
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const kv = {};
    const pr = /"([^"]*)"\s*"([^"]*)"/g;
    let p;
    while ((p = pr.exec(m[1]))) kv[p[1].toLowerCase()] = p[2];
    ents.push(kv);
  }
  return ents;
}

export const parseVec = (s) => {
  if (!s) return [0, 0, 0];
  const a = s.trim().split(/\s+/).map(Number);
  return [a[0] || 0, a[1] || 0, a[2] || 0];
};
