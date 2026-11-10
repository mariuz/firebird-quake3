// rl-train.mjs – the bots learn their fight moves by self-play (tabular Q-learning: bot_rl_move, bot_rl_learn in
// sql/bots.sql): four bots fight each other on an arena with the learning on (game.bot_rl 2), their guns dealt at
// random now and then so every kind of fight comes up, and the Q table is written out.
//
//   node scripts/rl-train.mjs <map> <tics> <out.json> [in.json]     train (from in.json's table, if given)
//   node scripts/rl-train.mjs --merge src/botq.js a.json b.json …   the tables of several runs into the shipped one
//   node scripts/rl-train.mjs --eval <map> <tics> [table.json]      two learned bots against two of Quake III's

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (args[0] === '--merge') {
  // each (state, move): the tries added up, the value the runs' average weighted by the tries each made. With
  // BASE=<table the runs started from>, its tries are counted once, not once a run
  const [, out, ...files] = args;
  const base = new Map(process.env.BASE ? JSON.parse(fs.readFileSync(process.env.BASE, 'utf8')).map(([s, a, q, n]) => [`${s},${a}`, n]) : []);
  const m = new Map();
  for (const f of files) for (const [s, a, q, n] of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const k = `${s},${a}`, o = m.get(k) ?? [s, a, 0, 0, base.get(k) ?? 0], b = base.get(k) ?? 0;
    const w = n - b + b / files.length;
    o[2] += q * w; o[3] += w; o[4] += n - b; m.set(k, o);
  }
  const rows = [...m.values()].filter((r) => r[3] > 0).map(([s, a, q, w, n]) => [s, a, Math.round((q / w) * 100) / 100, Math.round(n)]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const head = fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n');
  fs.writeFileSync(out, `${head}\nexport const BOT_Q = [\n${rows.map((r) => `  [${r.join(', ')}],`).join('\n')}\n];\n`);
  if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rows));
  const states = new Set(rows.map((r) => r[0]));
  console.log(`${rows.length} rows over ${states.size} of 432 states, ${rows.reduce((a, r) => a + r[3], 0)} tries → ${out}`);
  process.exit(0);
}

const { FirebirdBrowser, DirectTransport } = await import('firebird-wasm/browser');
const { Pk3 } = await import('../src/pk3.js');
const { createSchema, loadResources, loadMap, buildWaypoints, loadBotQ, loadBotNN, SQL_FILES } = await import('../src/loader.js');
const evalMode = args[0] === '--eval';
const [mapName, ticsArg, a3, a4] = evalMode ? args.slice(1) : args;
const tics = Number(ticsArg) || 6000;
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
const q = async (s) => (await db.query(s)).rows;
const table = evalMode ? a3 : a4;
if (table) await loadBotQ(db, JSON.parse(fs.readFileSync(table, 'utf8')));
if (process.env.NN) await loadBotNN(db, JSON.parse(fs.readFileSync(process.env.NN, 'utf8')));
const skill = Number(process.env.SKILL) || 4;

// the guns dealt: the machinegun and the gauntlet always, each other gun of the demo one time in two
const deal = async () => {
  for (const b of await q("SELECT id FROM ents WHERE classname = 'bot'")) {
    let w = 3;
    for (const bit of [4, 16, 32, 64, 128]) if (Math.random() < 0.5) w |= bit;
    if (Math.random() < 0.1) w = 1;   // (now and then the gauntlet alone)
    await db.exec(`UPDATE ents SET weapons = ${w}, ammo2 = ${w === 1 ? 0 : 100}, ammo3 = 50, ammo5 = 50, ammo6 = 100, ammo7 = 50, ammo8 = 100 WHERE id = ${b.ID}`);
  }
};
const start = async () => {
  await loadMap(db, pak, res, mapName, { skill, bots: Number(process.env.BOTS) || 4, link: false, fraglimit: 0, timelimit: 0 });
  while ((await buildWaypoints(db, 1e9, 1e9)) > 0);
  await db.exec('EXECUTE PROCEDURE set_spectator(1)');   // we watch: the bots fight each other
  await db.exec(`UPDATE game SET bot_rl = ${evalMode ? 0 : 2}, fraglimit = 0, rl_logging = ${!evalMode && process.env.LOG === '1' ? 1 : 0}`);
  if (evalMode) {
    // the first two learned, the other two Quake III's
    // (SWAP=1: the other way about, so that the bots' own characters do not decide it)
    const ids = (await q("SELECT id FROM ents WHERE classname = 'bot' ORDER BY id")).map((r) => r.ID);
    if (process.env.SWAP === '1') ids.reverse();
    await db.exec(`UPDATE ents SET rl = ${Number(process.env.MODE) || 1} WHERE id IN (${ids.slice(0, 2).join(',')})`);   // (MODE=3: the network)
    await db.exec(`UPDATE ents SET rl = 0 WHERE id IN (${ids.slice(2).join(',')})`);
  }
  await deal();
};
await start();
const t0 = performance.now();
for (let i = 0; i < tics; i += 2) {
  const [r] = await q('SELECT match_over FROM q3_tic(2, 0, 0, 0, 0, 0, 0, 1, 0)');
  if (r.MATCH_OVER) await start();
  if (i % 400 === 0) await deal();
  // (no roaming for items while training: every second each bot with no enemy is set on the nearest other, to hunt)
  if (!evalMode && i % 20 === 0) await db.exec(`UPDATE ents e SET e.search_time = 1e9, e.goal_id = NULL, e.enemy_id = (SELECT FIRST 1 o.id FROM ents o WHERE o.classname = 'bot' AND o.id <> e.id AND o.health > 0 AND o.deadflag = 0
      ORDER BY (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) + (o.z - e.z) * (o.z - e.z))
    WHERE e.classname = 'bot' AND e.health > 0 AND e.deadflag = 0 AND (e.enemy_id IS NULL OR NOT EXISTS (SELECT 1 FROM ents o WHERE o.id = e.enemy_id AND o.health > 0 AND o.deadflag = 0))`);
  if (i % 4000 === 0 && i) console.log(`${mapName} ${i} tics, ${((performance.now() - t0) / i).toFixed(1)} ms a tic`);
}
if (evalMode) {
  const rows = await q("SELECT e.bot, e.rl, e.frags, e.deaths, e.rl_given, e.rl_taken FROM ents e WHERE e.classname = 'bot' ORDER BY e.id");
  const sum = (rl, k) => rows.filter((r) => r.RL === rl).reduce((a, r) => a + r[k], 0);
  console.log(`EVAL ${mapName} ${tics} tics: learned ${sum(1, 'FRAGS')} frags / ${sum(1, 'DEATHS')} deaths, ${sum(1, 'RL_GIVEN')} given / ${sum(1, 'RL_TAKEN')} taken; Quake III's ${sum(0, 'FRAGS')} / ${sum(0, 'DEATHS')}, ${sum(0, 'RL_GIVEN')} / ${sum(0, 'RL_TAKEN')}`);
  console.log(JSON.stringify({ map: mapName, learned: { frags: sum(1, 'FRAGS'), deaths: sum(1, 'DEATHS'), given: sum(1, 'RL_GIVEN'), taken: sum(1, 'RL_TAKEN') }, classic: { frags: sum(0, 'FRAGS'), deaths: sum(0, 'DEATHS'), given: sum(0, 'RL_GIVEN'), taken: sum(0, 'RL_TAKEN') } }));
} else {
  const rows = (await db.query('SELECT s, a, q, n FROM bot_q ORDER BY s, a', [], { rowMode: 'array' })).rows;
  fs.writeFileSync(a3, JSON.stringify(rows));
  // (LOG=1: the moves themselves, for the network: scripts/rl-deep.mjs)
  if (process.env.LOG === '1') fs.writeFileSync(a3.replace(/\.json$/, '') + '.log.json', JSON.stringify((await db.query('SELECT * FROM bot_rl_log WHERE r IS NOT NULL ORDER BY id', [], { rowMode: 'array' })).rows));
  console.log(`${mapName}: ${rows.length} rows over ${new Set(rows.map((r) => r[0])).size} states, ${rows.reduce((a, r) => a + r[3], 0)} tries in ${((performance.now() - t0) / 1000).toFixed(0)} s → ${a3}`);
}
process.exit(0);
