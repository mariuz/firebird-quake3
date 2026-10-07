// fetch-pak.mjs – get the Quake III Arena demo data into public/pak/pak0.pk3.
//
// The Linux demo installer (linuxq3ademo-1.11-6.x86.gz.sh, 47 MB) is freely
// redistributable: a shell script with a gzipped tar appended, which holds
// demoq3/pak0.pk3. Node's zlib inflates it and a dozen lines read the tar.
//
//   node scripts/fetch-pak.mjs                       downloads and extracts
//   PAK=/path/to/pak0.pk3 node scripts/fetch-pak.mjs copies a pak you have (the full game works too)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public/pak');
const out = path.join(outDir, 'pak0.pk3');
fs.mkdirSync(outDir, { recursive: true });

if (process.env.PAK) {
  fs.copyFileSync(process.env.PAK, out);
  console.log(`copied ${process.env.PAK} → ${path.relative(root, out)}`);
  process.exit(0);
}
if (fs.existsSync(out)) {
  console.log(`${path.relative(root, out)} already present (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  process.exit(0);
}

const URLS = [
  'https://ftp.gwdg.de/pub/misc/ftp.idsoftware.com/idstuff/quake3/linux/linuxq3ademo-1.11-6.x86.gz.sh',
  'https://archive.org/download/linuxq3ademo-1.11-6.x86.gz/linuxq3ademo-1.11-6.x86.gz.sh',
  'https://files.ioquake3.org/linuxq3ademo-1.11-6.x86.gz.sh',
];
const SIZE = 49289300;

let buf = null;
if (process.env.Q3DEMO_SH) buf = fs.readFileSync(process.env.Q3DEMO_SH);
else {
  for (const url of URLS) {
    try {
      console.log(`downloading ${url}…`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length !== SIZE) console.warn(`  size ${buf.length} differs from the known ${SIZE}; trying anyway`);
      break;
    } catch (e) {
      console.warn(`  ${e.message}`);
      buf = null;
    }
  }
}
if (!buf) {
  console.error('could not download the Quake III demo; put a pak0.pk3 at public/pak/pak0.pk3 yourself (PAK=... node scripts/fetch-pak.mjs)');
  process.exit(1);
}

// the tarball starts at the first gzip magic after the script
let off = -1;
for (let i = 0; i < buf.length - 2; i++) if (buf[i] === 0x1f && buf[i + 1] === 0x8b && buf[i + 2] === 0x08) { off = i; break; }
if (off < 0) { console.error('no gzip data inside the installer'); process.exit(1); }
console.log(`inflating the tar at offset ${off}…`);
const tar = zlib.gunzipSync(buf.subarray(off));

// walk the tar: 512-byte headers, the size in octal at 124, the name at 0 (+ a prefix at 345)
let p = 0, found = null;
while (p + 512 <= tar.length) {
  const name = tar.toString('latin1', p, p + 100).replace(/\0.*$/, '');
  if (!name) break;
  const prefix = tar.toString('latin1', p + 345, p + 500).replace(/\0.*$/, '');
  const size = parseInt(tar.toString('latin1', p + 124, p + 136).replace(/\0.*$/, '').trim() || '0', 8);
  const full = (prefix ? prefix + '/' : '') + name;
  if (/(^|\/)pak0\.pk3$/i.test(full)) { found = tar.subarray(p + 512, p + 512 + size); break; }
  p += 512 + Math.ceil(size / 512) * 512;
}
if (!found) { console.error('pak0.pk3 not found inside the installer'); process.exit(1); }
fs.writeFileSync(out, found);
console.log(`wrote ${path.relative(root, out)} (${(found.length / 1048576).toFixed(1)} MB)`);
