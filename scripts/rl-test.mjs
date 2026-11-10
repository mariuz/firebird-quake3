// rl-test.mjs – the bots' learned fight moves (sql/bots.sql: bot_rl_learn, bot_rl_move, bot_nn_best): the
// Q-learning step does its arithmetic, the table's choice leaves Quake III's move only for one clearly better and
// tried enough, the network's forward pass in SQL is the same as one written out in JavaScript, and two bots
// fighting with the learning on fill the table and the log.
//
//   node scripts/rl-test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, loadBotQ, loadBotNN, SQL_FILES } from '../src/loader.js';
import { BOT_Q } from '../src/botq.js';
import { BOT_NN } from '../src/botnn.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, 'q3dm1', { skill: 5, bots: 2, link: false, fraglimit: 0 });
const q = async (s, p) => (await db.query(s, p)).rows;
const pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16 + 64) WHERE id = ${pe}`);
const [b0, b1] = (await q("SELECT id FROM ents WHERE classname = 'bot' ORDER BY id")).map((r) => r.ID);

// what ships: a table and a network, the states as bot_rl_state numbers them
const states = new Set();
for (const w of [1, 2, 64, 16]) for (const ew of [1, 2, 16]) for (const d of [100, 300, 600, 900]) for (const hp of [30, 80, 120]) for (const dz of [-100, 0, 100])
  states.add((await q(`SELECT bot_rl_state(${w}, ${ew}, ${d}, ${hp}, ${dz}) s FROM rdb$database`))[0].S);
assert(states.size === 432 && Math.min(...states) === 0 && Math.max(...states) === 431 && BOT_Q.length > 500 && BOT_NN.length > 1000,
  `432 states of a fight; the shipped table has ${BOT_Q.length} rows over ${new Set(BOT_Q.map((r) => r[0])).size} of them, the network ${BOT_NN.length} weights`);

// the Q-learning step: Q ← Q + 0.1 (r + 0.8 max Q(s′) − Q)
await loadBotQ(db, [[7, 0, 10, 5], [7, 3, 40, 5]]);
await db.exec(`UPDATE ents SET rl_s = 3, rl_a = 2, rl_given = 30, rl_g0 = 0, rl_taken = 10, rl_t0 = 0 WHERE id = ${b0}`);
await db.exec(`EXECUTE PROCEDURE bot_rl_learn(${b0}, NULL, 0)`);
const [l1] = await q('SELECT q, n FROM bot_q WHERE s = 3 AND a = 2');
await db.exec(`EXECUTE PROCEDURE bot_rl_learn(${b0}, 7, 0)`);
const [l2] = await q('SELECT q, n FROM bot_q WHERE s = 3 AND a = 2');
await db.exec('UPDATE game SET bot_rl = 2');
await db.exec(`EXECUTE PROCEDURE bot_rl_end(${b0})`);
const [l3] = await q('SELECT q, n FROM bot_q WHERE s = 3 AND a = 2');
const near = (a, b) => Math.abs(a - b) < 1e-9;
assert(near(l1.Q, 2) && l1.N === 1 && near(l2.Q, 2 + 0.1 * (20 + 0.8 * 40 - 2)) && l2.N === 2 && near(l3.Q, l2.Q + 0.1 * (20 - 50 - l2.Q)) && l3.N === 3,
  `the Q-learning step: 20 health ahead at a fight's end rates the move ${l1.Q}; with a state worth 40 to follow, ${l2.Q.toFixed(2)}; dying on it (50 off), ${l3.Q.toFixed(2)}`);

// the table's choice: two bots 200 apart, level, machineguns; skill 5 makes one move in thirty at random
const [sp] = await q("SELECT FIRST 1 ox x, oy y, oz z FROM map_ents WHERE classname = 'info_player_deathmatch'");
const place = async () => {
  await db.exec(`UPDATE ents SET x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, vx = 0, vy = 0, vz = 0, health = 100, weapon = 2, rl_a = NULL, flags = BIN_OR(flags, 512) WHERE id = ${b0}`);
  await db.exec(`UPDATE ents SET weapon = 2 WHERE id = ${b1}`);
};
const s0 = (await q('SELECT bot_rl_state(2, 2, 200, 100, 0) s FROM rdb$database'))[0].S;
const choose = async (mode, n = 40) => {
  const c = new Array(6).fill(0);
  for (let i = 0; i < n; i++) {
    await place();
    await q(`SELECT bot_rl_move(${b0}, ${b1}, 1, ${mode}, 200, 0, 2, 20) m FROM rdb$database`);
    c[(await q(`SELECT rl_a a FROM ents WHERE id = ${b0}`))[0].A]++;
  }
  return c;
};
await loadBotQ(db, [[s0, 5, 10, 40], [s0, 3, 30, 40], [s0, 1, 60, 5]]);   // back off rated 20 above Quake III's; a strafe higher still on 5 tries
const better = await choose(1);
await loadBotQ(db, [[s0, 5, 10, 40], [s0, 3, 12, 40]]);                    // only 2 above: not enough
const close = await choose(1);
await loadBotQ(db, []);
const unknown = await choose(1);
assert(better[3] >= 34 && better[1] <= 3 && close[5] >= 34 && unknown[5] >= 34,
  `playing the table: a move rated 20 above Quake III's on 40 tries is made (${better[3]} of 40; one rated higher on 5 tries is not: ${better[1]}), one 2 above is not (Quake III's ${close[5]} of 40), and with nothing known it is Quake III's (${unknown[5]})`);

// the network: the pass in SQL is the pass written out here, on the shipped weights
await loadBotNN(db, BOT_NN);
const layers = [1, 2, 3].map((l) => BOT_NN.filter((r) => r[0] === l));
const fwd = (x) => { let a = x; layers.forEach((rs, k) => { const o = new Array(Math.max(...rs.map((r) => r[1])) + 1).fill(0); for (const [, j, i, w] of rs) o[j] += w * (i < 0 ? 1 : a[i]); a = k < 2 ? o.map((v) => Math.max(0, v)) : o; }); return a; };
let worst = 0, same = 0, ms = 0;
const picks = new Array(6).fill(0);
for (let k = 0; k < 36; k++) {
  const wc = k % 4, ec = k % 3;
  const x = [wc === 0, wc === 1, wc === 2, wc === 3, ec === 0, ec === 1, ec === 2].map(Number).concat([0.05 + (k % 9) * 0.15, 0.2 + (k % 5) * 0.4, (k % 4) * 0.5, ((k % 7) - 3) * 0.4, k % 6 === 0 ? 1 : 0]);
  const js = fwd(x);
  const t = performance.now();
  const r = await q(`EXECUTE BLOCK RETURNS (best SMALLINT, i SMALLINT, v DOUBLE PRECISION) AS BEGIN best = bot_nn_best(${x.join(', ')}); FOR SELECT x.i, x.v FROM nn_x x WHERE x.l = 3 ORDER BY x.i INTO i, v DO SUSPEND; END`);
  ms += performance.now() - t;
  worst = Math.max(worst, ...r.map((o) => Math.abs(o.V - js[o.I])));
  let best = 5;
  for (let a = 0; a < 5; a++) if (js[a] >= js[5] + 3 && (best === 5 || js[a] > js[best])) best = a;
  if (r.length === 6 && r[0].BEST === best) same++;
  picks[best]++;
}
assert(worst < 1e-6 && same === 36, `the network's forward pass in SQL is the one written out in JavaScript: the six values within ${worst.toExponential(1)} on 36 inputs, the same move chosen on ${same} (${(ms / 36).toFixed(1)} ms a pass); it leaves Quake III's move on ${36 - picks[5]} of them`);
const net3 = await choose(3, 10);
assert(net3.reduce((a, n) => a + n, 0) === 10, `a bot asks the network in a fight (mode 3): moves ${net3.join(' ')}`);

// learning for real: the two set on each other, face to face, with the learning and the logging on
await loadBotQ(db, []);
await db.exec('UPDATE game SET bot_rl = 2, rl_logging = 1');
await db.exec(`UPDATE ents SET x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, health = 100, weapons = 3, weapon = 2, ammo2 = 100, enemy_id = ${b1}, search_time = 1e9, rl_a = NULL WHERE id = ${b0}`);
const [fl] = await q(`SELECT ex, ey, ez FROM trace_move(${b0}, -15, -15, -24, 15, 15, 32, ${sp.X}, ${sp.Y}, ${sp.Z + 9}, ${sp.X + 220}, ${sp.Y}, ${sp.Z + 9}, 65537)`);
await db.exec(`UPDATE ents SET x = ${fl.EX - 16}, y = ${fl.EY}, z = ${fl.EZ}, health = 100, weapons = 3, weapon = 2, ammo2 = 100, enemy_id = ${b0}, search_time = 1e9, rl_a = NULL WHERE id = ${b1}`);
for (const b of [b0, b1]) await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
for (let i = 0; i < 160; i++) await q('SELECT tic FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)');
const [lr] = await q('SELECT (SELECT COUNT(*) FROM bot_q) rows_, (SELECT COALESCE(SUM(n), 0) FROM bot_q) tries, (SELECT COUNT(*) FROM bot_rl_log) logged, (SELECT COUNT(*) FROM bot_rl_log WHERE r IS NOT NULL) scored, (SELECT COUNT(*) FROM bot_rl_log WHERE r <> 0) paid, (SELECT SUM(rl_given) FROM ents WHERE classname = \'bot\') given FROM rdb$database');
assert(lr.TRIES >= 10 && lr.LOGGED >= lr.TRIES && lr.SCORED >= lr.TRIES - 2 && lr.PAID > 0 && lr.GIVEN > 0,
  `two bots fighting for 8 s with the learning on: ${lr.TRIES} moves scored into ${lr.ROWS_} rows of the table, ${lr.LOGGED} logged (${lr.PAID} with a reward: ${lr.GIVEN} health given in all)`);

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
