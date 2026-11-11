// wsel-train.mjs – which gun does the most at which distance, measured by self-play (bot_pick_weapon, bot_w_shot,
// bot_w_damage in sql/bots.sql): six bots fight each other on an arena, each with a gun at random of those it
// holds (game.bot_wsel 2), and bot_wdps counts the seconds of fire and the health taken off for every gun and
// distance band. Plain counting, no learning rate: the runs of several arenas are added up.
//
//   node scripts/wsel-train.mjs <map> <tics> <out.json>              measure
//   node scripts/wsel-train.mjs --merge src/botw.js a.json b.json …  several runs added up into the shipped table
//   node scripts/wsel-train.mjs --eval <map> <tics> [table.json]     two bots on the table against two of botlib's
//                                                                    (SWAP=1: the other two; DEAL=0: no guns dealt)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const NAMES = { 1: 'Gauntlet', 2: 'Machinegun', 4: 'Shotgun', 8: 'Grenade Launcher', 16: 'Rocket Launcher', 32: 'Lightning Gun', 64: 'Railgun', 128: 'Plasma Gun', 256: 'BFG10K' };
const BANDS = ['<150', '<300', '<500', '<800', '<1200', '1200+'];

/** The table as text: each gun's damage a second of fire by distance band (a dot where it fired under 30 s) */
const show = (rows) => {
  const cell = new Map(rows.map(([w, b, secs, dmg]) => [`${w},${b}`, secs >= 30 ? (dmg / secs).toFixed(0) : '.']));
  const guns = [...new Set(rows.map((r) => r[0]))].sort((a, b) => a - b);
  return [`${'damage a second of fire'.padEnd(18)}${BANDS.map((b) => b.padStart(7)).join('')}`,
    ...guns.map((w) => `${(NAMES[w] ?? w).padEnd(18)}${BANDS.map((_, b) => (cell.get(`${w},${b}`) ?? '').padStart(7)).join('')}`),
    `${'best'.padEnd(18)}${BANDS.map((_, b) => { const best = rows.filter((r) => r[1] === b && r[2] >= 30).sort((x, y) => y[3] / y[2] - x[3] / x[2])[0]; return (best ? NAMES[best[0]].split(' ')[0] : '').padStart(7).slice(0, 7); }).join('')}`].join('\n');
};

if (args[0] === '--merge') {
  const [, out, ...files] = args;
  const m = new Map();
  for (const f of files) for (const [w, b, secs, dmg] of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const o = m.get(`${w},${b}`) ?? [w, b, 0, 0];
    o[2] += secs; o[3] += dmg; m.set(`${w},${b}`, o);
  }
  const rows = [...m.values()].map(([w, b, secs, dmg]) => [w, b, Math.round(secs * 10) / 10, Math.round(dmg)]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const head = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n') : '// botw.js';
  fs.writeFileSync(out, `${head}\nexport const BOT_W = [\n${rows.map((r) => `  [${r.join(', ')}],`).join('\n')}\n];\n`);
  if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rows));
  console.log(`${rows.length} cells, ${(rows.reduce((a, r) => a + r[2], 0) / 3600).toFixed(1)} hours of fire, ${rows.reduce((a, r) => a + r[3], 0)} health taken off → ${out}\n${show(rows)}`);
  process.exit(0);
}

const { FirebirdBrowser, DirectTransport } = await import('firebird-wasm/browser');
const { Pk3 } = await import('../src/pk3.js');
const { createSchema, loadResources, loadMap, buildWaypoints, loadBotW, SQL_FILES } = await import('../src/loader.js');
const evalMode = args[0] === '--eval';
const [mapName, ticsArg, a3] = evalMode ? args.slice(1) : args;
const tics = Number(ticsArg) || 6000;
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
const q = async (s) => (await db.query(s)).rows;
if (evalMode && a3) await loadBotW(db, JSON.parse(fs.readFileSync(a3, 'utf8')));
if (!evalMode) await db.exec('DELETE FROM bot_wdps');
const skill = Number(process.env.SKILL) || 4;
const dealing = process.env.DEAL !== '0';

// the guns dealt: the machinegun and the gauntlet always, each other gun of the demo two times in three
const deal = async () => {
  if (!dealing) return;
  for (const b of await q("SELECT id FROM ents WHERE classname = 'bot'")) {
    let w = 3;
    for (const bit of [4, 8, 16, 32, 64, 128]) if (Math.random() < 0.67) w |= bit;
    await db.exec(`UPDATE ents SET weapons = ${w}, ammo2 = 100, ammo3 = 50, ammo4 = 30, ammo5 = 50, ammo6 = 150, ammo7 = 50, ammo8 = 150 WHERE id = ${b.ID}`);
  }
};
const start = async () => {
  await loadMap(db, pak, res, mapName, { skill, bots: Number(process.env.BOTS) || (evalMode ? 4 : 6), link: false, fraglimit: 0, timelimit: 0 });
  while ((await buildWaypoints(db, 1e9, 1e9)) > 0);
  await db.exec('EXECUTE PROCEDURE set_spectator(1)');   // we watch: the bots fight each other
  await db.exec(`UPDATE game SET bot_rl = 0, bot_wsel = ${evalMode ? 0 : 2}, fraglimit = 0`);
  if (evalMode) {
    // the first two by the table, the other two botlib's (SWAP=1: the other way about, so that the bots' own
    // characters do not decide it)
    const ids = (await q("SELECT id FROM ents WHERE classname = 'bot' ORDER BY id")).map((r) => r.ID);
    if (process.env.SWAP === '1') ids.reverse();
    await db.exec(`UPDATE ents SET wsel = 1 WHERE id IN (${ids.slice(0, 2).join(',')})`);
    await db.exec(`UPDATE ents SET wsel = 0 WHERE id IN (${ids.slice(2).join(',')})`);
  }
  await deal();
};
await start();
const t0 = performance.now();
for (let i = 0; i < tics; i += 2) {
  const [r] = await q('SELECT match_over FROM q3_tic(2, 0, 0, 0, 0, 0, 0, 1, 0)');
  if (r.MATCH_OVER) await start();
  if (i % 400 === 0) await deal();
  // (measuring: no roaming for items, every second each bot with no enemy is set on the nearest other)
  if (!evalMode && i % 20 === 0) await db.exec(`UPDATE ents e SET e.search_time = 1e9, e.goal_id = NULL, e.enemy_id = (SELECT FIRST 1 o.id FROM ents o WHERE o.classname = 'bot' AND o.id <> e.id AND o.health > 0 AND o.deadflag = 0
      ORDER BY (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) + (o.z - e.z) * (o.z - e.z))
    WHERE e.classname = 'bot' AND e.health > 0 AND e.deadflag = 0 AND (e.enemy_id IS NULL OR NOT EXISTS (SELECT 1 FROM ents o WHERE o.id = e.enemy_id AND o.health > 0 AND o.deadflag = 0))`);
  if (i % 4000 === 0 && i) console.log(`${mapName} ${i} tics, ${((performance.now() - t0) / i).toFixed(1)} ms a tic`);
}
if (evalMode) {
  const rows = await q("SELECT e.bot, e.wsel, e.frags, e.deaths, e.rl_given, e.rl_taken FROM ents e WHERE e.classname = 'bot' ORDER BY e.id");
  const sum = (on, k) => rows.filter((r) => (r.WSEL === 1) === on).reduce((a, r) => a + r[k], 0);
  const side = (on) => ({ frags: sum(on, 'FRAGS'), deaths: sum(on, 'DEATHS'), given: sum(on, 'RL_GIVEN'), taken: sum(on, 'RL_TAKEN') });
  const L = side(true), C = side(false);
  console.log(`EVAL ${mapName} ${tics} tics: by the table ${L.frags} frags / ${L.deaths} deaths, ${L.given} given / ${L.taken} taken; botlib's ${C.frags} / ${C.deaths}, ${C.given} / ${C.taken}`);
  console.log(JSON.stringify({ map: mapName, learned: L, classic: C }));
} else {
  const rows = (await db.query('SELECT w, band, secs, dmg FROM bot_wdps ORDER BY w, band', [], { rowMode: 'array' })).rows;
  fs.writeFileSync(a3, JSON.stringify(rows));
  console.log(`${mapName}: ${rows.length} cells, ${(rows.reduce((a, r) => a + r[2], 0) / 60).toFixed(0)} minutes of fire in ${((performance.now() - t0) / 1000).toFixed(0)} s → ${a3}\n${show(rows)}`);
}
process.exit(0);
