// pk3.js – Quake III's archive format: a PK3 is a zip (stored or deflated
// entries), read from an ArrayBuffer. Entries are inflated on demand and
// kept, so the loaders and the painter can take a file synchronously once
// it has been opened once; `inflateAll` opens everything a game needs up
// front (about a second for the demo pak). The inflater is RFC 1951 in
// plain JavaScript, the same in the browser and under Node.

const td = new TextDecoder('latin1');

export const cstr = (bytes, off, len) => {
  let end = off;
  const max = off + len;
  while (end < max && bytes[end] !== 0) end++;
  return td.decode(bytes.subarray(off, end));
};


export class Pk3 {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    const b = this.bytes;
    const dv = new DataView(buffer);
    this.dv = dv;
    // the end of central directory record, searched backwards from the end
    let eocd = -1;
    for (let p = b.length - 22; p >= Math.max(0, b.length - 70000); p--) {
      if (b[p] === 0x50 && b[p + 1] === 0x4b && b[p + 2] === 0x05 && b[p + 3] === 0x06) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('not a zip / pk3 file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    this.files = new Map();     // name → { off (local header), method, csize, size, data (once inflated) }
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = td.decode(b.subarray(p + 46, p + 46 + nlen)).toLowerCase().replace(/\\/g, '/');
      if (!name.endsWith('/')) this.files.set(name, { off, method, csize, size, data: null });
      p += 46 + nlen + elen + clen;
    }
  }

  has(name) { return this.files.has(name.toLowerCase()); }

  /** The file's bytes (inflated the first time). */
  get(name) {
    const e = this.files.get(name.toLowerCase());
    if (!e) throw new Error(`${name} not in pk3`);
    if (e.data) return e.data;
    const dv = this.dv, b = this.bytes;
    const h = e.off;
    if (dv.getUint32(h, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const nlen = dv.getUint16(h + 26, true), elen = dv.getUint16(h + 28, true);
    const start = h + 30 + nlen + elen;
    const raw = b.subarray(start, start + e.csize);
    if (e.method === 0) e.data = raw;
    else if (e.method === 8) e.data = inflate(raw, e.size);
    else throw new Error(`${name}: unsupported compression method ${e.method}`);
    return e.data;
  }

  /** A copy as an ArrayBuffer (for DataView parsers and decodeAudioData). */
  buffer(name) {
    const d = this.get(name);
    return d.slice().buffer;
  }

  /** Inflate every entry (that passes the filter) now. */
  inflateAll(filter = () => true) {
    for (const name of this.files.keys()) if (filter(name)) this.get(name);
  }

  list(prefix = '', suffix = '') {
    return [...this.files.keys()].filter((n) => n.startsWith(prefix) && n.endsWith(suffix)).sort();
  }

  mapNames() {
    return this.list('maps/', '.bsp').map((n) => n.slice(5, -4));
  }

  /** The image file for a texture or shader name: name.tga, then name.jpg (Q3's order). */
  imageName(name) {
    const base = name.toLowerCase().replace(/\.(tga|jpg|jpeg|png)$/, '');
    if (this.has(base + '.tga')) return base + '.tga';
    if (this.has(base + '.jpg')) return base + '.jpg';
    return null;
  }

  text(name) {
    return td.decode(this.get(name));
  }
}

/**
 * Several paks searched as one, as FS_FOpenFileRead walks the search path: a file in a later pak hides the
 * same name in an earlier one (Quake III loads pak0 … pak8 and then the others in order, the last first in
 * the search). The same interface as a Pk3, so the loaders, the painters and the sound take either. Each
 * pak may carry a `label` (the game or pack it came from) that `mapSource` reports for a map.
 */
export class PakSet {
  constructor(paks = []) {
    this.paks = [];
    this.files = new Map();     // name → the pak's entry (the winning pak's)
    this.owner = new Map();     // name → the pak it is read from
    for (const p of paks) this.add(p);
  }

  /** The paks, bottom first, in place of the present ones (the same object: whoever holds it sees them) */
  reset(paks) {
    this.paks = [];
    this.files.clear();
    this.owner.clear();
    for (const p of paks) this.add(p);
    return this;
  }

  /** Put a pak on top of the others. */
  add(pak) {
    this.paks.push(pak);
    for (const [name, e] of pak.files) { this.files.set(name, e); this.owner.set(name, pak); }
    return this;
  }

  has(name) { return this.owner.has(name.toLowerCase()); }

  get(name) {
    const pak = this.owner.get(name.toLowerCase());
    if (!pak) throw new Error(`${name} not in any pak`);
    return pak.get(name);
  }

  buffer(name) { return this.get(name).slice().buffer; }

  inflateAll(filter = () => true) {
    for (const [name, pak] of this.owner) if (filter(name)) pak.get(name);
  }

  list(prefix = '', suffix = '') {
    return [...this.owner.keys()].filter((n) => n.startsWith(prefix) && n.endsWith(suffix)).sort();
  }

  mapNames() {
    return this.list('maps/', '.bsp').map((n) => n.slice(5, -4));
  }

  /** The label of the pak a map's BSP comes from (the Quake III demo, OpenArena, a map pack) */
  mapSource(map) {
    return this.owner.get(`maps/${map.toLowerCase()}.bsp`)?.label ?? null;
  }

  imageName(name) {
    const base = name.toLowerCase().replace(/\.(tga|jpg|jpeg|png)$/, '');
    if (this.has(base + '.tga')) return base + '.tga';
    if (this.has(base + '.jpg')) return base + '.jpg';
    return null;
  }

  text(name) { return td.decode(this.get(name)); }
}

// ── inflate (RFC 1951) ────────────────────────────────────────────────────
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code as a lookup table over `bits` bits: entry = symbol << 4 | length. */
function huffman(lengths) {
  let max = 0;
  for (const l of lengths) if (l > max) max = l;
  if (max === 0) return { table: new Uint32Array(1), bits: 1 };
  const blCount = new Uint16Array(max + 1);
  for (const l of lengths) if (l) blCount[l]++;
  const next = new Uint16Array(max + 2);
  let code = 0;
  for (let b = 1; b <= max; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  const size = 1 << max;
  const table = new Uint32Array(size);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (!l) continue;
    let c = next[l]++;
    // the code is read MSB first; our bit buffer is LSB first: reverse it
    let r = 0;
    for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    for (let fill = r; fill < size; fill += 1 << l) table[fill] = (s << 4) | l;
  }
  return { table, bits: max };
}

let fixedLit = null, fixedDist = null;

export function inflate(src, expected = 0) {
  let out = new Uint8Array(expected > 0 ? expected : src.length * 4);
  let op = 0;
  let pos = 0, bitbuf = 0, bitcnt = 0;
  const n = src.length;
  const need = (k) => {
    while (bitcnt < k) { bitbuf |= (pos < n ? src[pos++] : 0) << bitcnt; bitcnt += 8; }
  };
  const bits = (k) => { need(k); const v = bitbuf & ((1 << k) - 1); bitbuf >>>= k; bitcnt -= k; return v; };
  const decode = (h) => {
    need(h.bits);
    const e = h.table[bitbuf & ((1 << h.bits) - 1)];
    const l = e & 15;
    bitbuf >>>= l; bitcnt -= l;
    return e >>> 4;
  };
  const grow = (extra) => {
    if (op + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, op + extra));
    bigger.set(out.subarray(0, op));
    out = bigger;
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      grow(len);
      out.set(src.subarray(pos, pos + len), op);
      op += len; pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedLit = huffman(l);
        fixedDist = huffman(new Uint8Array(30).fill(5));
      }
      lit = fixedLit; dist = fixedDist;
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clh = huffman(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else if (sym === 16) { const prev = lens[i - 1], r = 3 + bits(2); for (let k = 0; k < r; k++) lens[i++] = prev; }
        else if (sym === 17) { const r = 3 + bits(3); i += r; }
        else { const r = 11 + bits(7); i += r; }
      }
      lit = huffman(lens.subarray(0, hlit));
      dist = huffman(lens.subarray(hlit));
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { if (op >= out.length) grow(1); out[op++] = sym; continue; }
      if (sym === 256) break;
      const li = sym - 257;
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(dist);
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      grow(len);
      let from = op - d;
      for (let k = 0; k < len; k++) out[op++] = out[from++];
    }
  }
  return op === out.length ? out : out.subarray(0, op);
}
