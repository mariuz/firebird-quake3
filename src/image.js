// image.js – Quake III's picture formats: TGA (types 2, 3 and 10, 8/24/32
// bit, either origin) and JPEG (baseline, through jpeg-js). Pictures come
// back as { w, h, data: Uint32Array } of ABGR pixels (what an ImageData's
// buffer holds on a little-endian machine), resampled to a power of two the
// way R_ResampleTexture did, so the painter can wrap with a mask.

import jpeg from 'jpeg-js';

export function loadTga(bytes, name = '') {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = bytes[0], cmType = bytes[1], type = bytes[2];
  const cmLen = dv.getUint16(5, true), cmBits = bytes[7];
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true);
  const depth = bytes[16], desc = bytes[17];
  const topDown = (desc & 0x20) !== 0;
  if (type !== 2 && type !== 3 && type !== 10 && type !== 1 && type !== 9) throw new Error(`${name}: TGA type ${type} not supported`);
  let p = 18 + idLen;
  let cmap = null;
  if (cmType === 1) {
    const bpc = cmBits >> 3;
    cmap = new Uint32Array(cmLen);
    for (let i = 0; i < cmLen; i++, p += bpc) {
      const b = bytes[p], g = bpc > 1 ? bytes[p + 1] : b, r = bpc > 2 ? bytes[p + 2] : b, a = bpc > 3 ? bytes[p + 3] : 255;
      cmap[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  const data = new Uint32Array(w * h);
  const bpp = depth >> 3;
  const rle = type >= 9;
  let hasAlpha = false;
  const px = () => {
    let v;
    if (cmap) v = cmap[bytes[p++]] ?? 0;
    else if (bpp === 1) { const g = bytes[p++]; v = (255 << 24) | (g << 16) | (g << 8) | g; }
    else if (bpp === 2) {
      const s = bytes[p] | (bytes[p + 1] << 8); p += 2;
      const r = ((s >> 10) & 31) << 3, g = ((s >> 5) & 31) << 3, b = (s & 31) << 3;
      v = (255 << 24) | (b << 16) | (g << 8) | r;
    } else {
      const b = bytes[p], g = bytes[p + 1], r = bytes[p + 2], a = bpp === 4 ? bytes[p + 3] : 255;
      p += bpp;
      if (a !== 255) hasAlpha = true;
      v = (a << 24) | (b << 16) | (g << 8) | r;
    }
    return v >>> 0;
  };
  let i = 0;
  const total = w * h;
  if (!rle) {
    for (; i < total; i++) data[i] = px();
  } else {
    while (i < total) {
      const hdr = bytes[p++];
      const cnt = (hdr & 0x7f) + 1;
      if (hdr & 0x80) { const v = px(); for (let k = 0; k < cnt && i < total; k++) data[i++] = v; }
      else for (let k = 0; k < cnt && i < total; k++) data[i++] = px();
    }
  }
  if (!topDown) {
    // bottom-up: flip the rows
    const row = new Uint32Array(w);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * w, b = (h - 1 - y) * w;
      row.set(data.subarray(a, a + w));
      data.copyWithin(a, b, b + w);
      data.set(row, b);
    }
  }
  return { w, h, data, hasAlpha };
}

export function loadJpeg(bytes, name = '') {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  const w = img.width, h = img.height;
  const data = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  // jpeg-js writes R,G,B,A bytes in memory order, which read as ABGR words: exactly what we want
  for (let i = 0; i < w * h; i++) data[i] |= 0xff000000;
  return { w, h, data: new Uint32Array(data), hasAlpha: false };
}

/** Decode by extension. */
export function loadImage(bytes, name) {
  return /\.jpe?g$/i.test(name) ? loadJpeg(bytes, name) : loadTga(bytes, name);
}

const isPow2 = (n) => (n & (n - 1)) === 0;

/** The picture resampled to the nearest (lower) power of two per side, if it is not one already. */
export function powerOfTwo(img) {
  if (isPow2(img.w) && isPow2(img.h)) return img;
  const w = 1 << Math.floor(Math.log2(img.w)), h = 1 << Math.floor(Math.log2(img.h));
  const data = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y * img.h) / h);
    for (let x = 0; x < w; x++) data[y * w + x] = img.data[sy * img.w + Math.floor((x * img.w) / w)];
  }
  return { w, h, data, hasAlpha: img.hasAlpha };
}

/** Halve a picture (box filter) – a mip level. */
export function halve(img) {
  const w = Math.max(1, img.w >> 1), h = Math.max(1, img.h >> 1);
  const data = new Uint32Array(w * h);
  const s = img.data, sw = img.w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = s[(y * 2) * sw + x * 2], b = s[(y * 2) * sw + Math.min(sw - 1, x * 2 + 1)];
      const c = s[Math.min(img.h - 1, y * 2 + 1) * sw + x * 2], d = s[Math.min(img.h - 1, y * 2 + 1) * sw + Math.min(sw - 1, x * 2 + 1)];
      const r = ((a & 255) + (b & 255) + (c & 255) + (d & 255)) >> 2;
      const g = (((a >> 8) & 255) + ((b >> 8) & 255) + ((c >> 8) & 255) + ((d >> 8) & 255)) >> 2;
      const bl = (((a >> 16) & 255) + ((b >> 16) & 255) + ((c >> 16) & 255) + ((d >> 16) & 255)) >> 2;
      const al = ((a >>> 24) + (b >>> 24) + (c >>> 24) + (d >>> 24)) >> 2;
      data[y * w + x] = ((al << 24) | (bl << 16) | (g << 8) | r) >>> 0;
    }
  }
  return { w, h, data, hasAlpha: img.hasAlpha };
}
