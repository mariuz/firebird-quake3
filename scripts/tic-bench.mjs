// tic-bench.mjs – the cost of a tic over a stretch of play: mean and median of N tics
//   node scripts/tic-bench.mjs [map] [--tics=N] [--walk] [--bots=N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = Number(process.argv.find((a) => a.startsWith('--tics='))?.slice(7) ?? 200);
const bots = Number(process.argv.find((a) => a.startsWith('--bots='))?.slice(7) ?? 3);
const walk = process.argv.includes('--walk') ? 1 : 0;
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, args[0] ?? 'q3dm1', { skill: 2, bots });
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
const q = `SELECT * FROM q3_tic(1, ${walk}, 0, ${walk ? 3 : 0}, 0, 0, 0, 1, 0)`;
for (let i = 0; i < 20; i++) await db.query(q);
const ts = [];
for (let i = 0; i < N; i++) { const t0 = performance.now(); await db.query(q); ts.push(performance.now() - t0); }
const fr = [];
for (let i = 0; i < 20; i++) { const t0 = performance.now(); await db.query('SELECT * FROM frame_all(0, 0, 0, 0)', [], { rowMode: 'array' }); fr.push(performance.now() - t0); await db.query(q); }
ts.sort((a, b) => a - b); fr.sort((a, b) => a - b);
const mean = ts.reduce((a, b) => a + b, 0) / N;
console.log(`${N} tics (${bots} bots): mean ${mean.toFixed(2)} ms, median ${ts[N >> 1].toFixed(2)} ms, p90 ${ts[Math.floor(N * 0.9)].toFixed(2)} ms, max ${ts[N - 1].toFixed(1)} ms`);
console.log(`frame_all: median ${fr[10].toFixed(2)} ms, max ${fr[19].toFixed(1)} ms`);
console.log('bots:', (await db.query("SELECT bot, st, health, frags FROM ents WHERE classname = 'bot'")).rows.map((r) => `${r.BOT} ${r.ST.trim()} hp ${r.HEALTH} frags ${r.FRAGS}`).join(', '));
await db.close();
process.exit(0);
