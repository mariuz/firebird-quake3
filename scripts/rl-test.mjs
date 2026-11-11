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
import { createSchema, loadResources, loadMap, loadBotQ, loadBotNN, loadBotW, SQL_FILES } from '../src/loader.js';
import { BOT_W } from '../src/botw.js';
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

// the gun for the distance, by what was measured (bot_pick_weapon, bot_wdps): the shipped table, the choice by it,
// and the measuring
const wPick = async (dist) => (await q(`SELECT bot_pick_weapon(${b0}, ${dist}) w FROM rdb$database`))[0].W;
const wArm = (guns, extra = '') => db.exec(`UPDATE ents SET weapons = ${guns}, weapon = 2, ammo2 = 100, ammo3 = 20, ammo5 = 20, ammo6 = 100, ammo7 = 20, ammo8 = 100, w_pick = NULL${extra} WHERE id = ${b0}`);
const wCells = (await q('SELECT COUNT(*) n, SUM(secs) secs FROM bot_wdps'))[0];
await wArm(1 + 2 + 4 + 16 + 32 + 64);
await db.exec(`UPDATE ents SET wsel = 0 WHERE id = ${b0}`);
const wOwn = [await wPick(100), await wPick(1000)];
await loadBotW(db, [[2, 0, 100, 3000], [4, 0, 100, 6000], [32, 0, 100, 9000], [64, 0, 100, 2000], [16, 0, 10, 5000], [2, 4, 100, 400], [64, 4, 100, 1700], [4, 4, 100, 900]]);
await db.exec(`UPDATE ents SET wsel = 1 WHERE id = ${b0}`);
const wNear = await wPick(100), wFar = await wPick(1000), wUnknown = await wPick(2000);
await db.exec(`UPDATE ents SET ammo6 = 0 WHERE id = ${b0}`);
const wDry = await wPick(100);
await wArm(1 + 2 + 16);
const wFew = await wPick(100);   // (the rocket launcher fired 10 s there: not known; of the known it holds the machinegun alone)
assert(BOT_W.length >= 40 && wCells.N === BOT_W.length && wCells.SECS > 3600 && wOwn[0] === wOwn[1] && wNear === 32 && wFar === 64 && wUnknown === wOwn[1] && wDry === 4 && wFew === 2,
  `the gun for the distance: ${BOT_W.length} cells measured over ${(wCells.SECS / 3600).toFixed(1)} hours of fire ship; by a table a bot takes the lightning gun at 100 units (${wNear}), the railgun at 1000 (${wFar}), the shotgun when the lightning gun is dry (${wDry}), no gun fired under 30 s there (${wFew}), and its character's favourite where nothing is known (${wUnknown}, as without the table: ${wOwn[0]} at any distance)`);
await loadBotW(db, []);
await db.exec(`UPDATE ents SET wsel = 2, enemy_id = ${b1} WHERE id = ${b0}`);
await wArm(1 + 2 + 4 + 16 + 32 + 64);
const wDealt = new Set();
for (let i = 0; i < 40; i++) { wDealt.add(await wPick(300)); await db.exec(`UPDATE ents SET w_until = 0 WHERE id = ${b0}`); }
const wKept = [await wPick(300), await wPick(300), await wPick(300)];
await db.exec(`UPDATE ents SET x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, weapon = 16 WHERE id = ${b0}`);
await db.exec(`UPDATE ents SET x = ${sp.X + 400}, y = ${sp.Y}, z = ${sp.Z + 9}, health = 100 WHERE id = ${b1}`);
await db.exec(`EXECUTE PROCEDURE bot_w_shot(${b0})`);
await db.exec(`EXECUTE PROCEDURE bot_w_shot(${b0})`);
await db.exec(`EXECUTE PROCEDURE bot_w_damage(${b0}, ${b1}, 7, 45)`);    // (a rocket's splash: the launcher's)
await db.exec(`EXECUTE PROCEDURE bot_w_damage(${b0}, ${b1}, 13, 30)`);   // (a fall: no gun's)
await db.exec(`EXECUTE PROCEDURE bot_w_damage(${b1}, ${b0}, 2, 30)`);    // (the other is not measuring)
const wMeas = await q('SELECT w, band, secs, dmg FROM bot_wdps ORDER BY w, band');
assert(wDealt.size >= 5 && [...wDealt].every((w) => [1, 2, 4, 16, 32, 64].includes(w)) && wKept[0] === wKept[1] && wKept[1] === wKept[2]
  && wMeas.length === 1 && wMeas[0].W === 16 && wMeas[0].BAND === 2 && Math.abs(wMeas[0].SECS - 1.6) < 1e-9 && wMeas[0].DMG === 45,
  `measuring: a gun at random of those held (${[...wDealt].sort((a, b) => a - b).join(' ')}), kept for 3 s; two rockets at 400 units are ${wMeas[0]?.SECS} s of fire in band ${wMeas[0]?.BAND}, their 45 of splash the launcher's; a fall and another bot's shots are not counted`);
await db.exec(`UPDATE ents SET wsel = NULL, enemy_id = NULL WHERE id = ${b0}`);
await loadBotW(db, BOT_W);

// learning for real: the two set on each other, face to face, with the learning and the logging on
await loadBotQ(db, []);
await db.exec('UPDATE game SET bot_rl = 2, rl_logging = 1');
await db.exec(`UPDATE ents SET x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, health = 100, weapons = 3, weapon = 2, ammo2 = 100, enemy_id = ${b1}, search_time = 1e9, rl_a = NULL WHERE id = ${b0}`);
const [fl] = await q(`SELECT ex, ey, ez FROM trace_move(${b0}, -15, -15, -24, 15, 15, 32, ${sp.X}, ${sp.Y}, ${sp.Z + 9}, ${sp.X + 220}, ${sp.Y}, ${sp.Z + 9}, 65537)`);
await db.exec(`UPDATE ents SET x = ${fl.EX - 16}, y = ${fl.EY}, z = ${fl.EZ}, health = 100, weapons = 3, weapon = 2, ammo2 = 100, enemy_id = ${b0}, search_time = 1e9, rl_a = NULL WHERE id = ${b1}`);
for (const b of [b0, b1]) await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
// (15 s at least, and on until a logged move has a reward, 45 s at most: damage dealt between two moves, while the
// enemy is out of sight, is nobody's reward)
const paid = async () => (await q('SELECT COUNT(*) n FROM bot_rl_log WHERE r <> 0'))[0].N;
for (let i = 0; i < 900 && (i < 300 || (i % 20 !== 0) || (await paid()) === 0); i++) {
  // (healed and set on each other again every second, so that the fight lasts the whole test; and every three
  // seconds face to face again: a learned move is for an enemy in sight within reach on the bot's floor, and
  // backing off and strafing take them out of it, where they go on fighting by the hunt and nothing is learned)
  if (i % 20 === 0) await db.exec(`UPDATE ents e SET e.health = 100, e.ammo2 = 100, e.enemy_id = IIF(e.id = ${b0}, ${b1}, ${b0}), e.search_time = 1e9 WHERE e.id IN (${b0}, ${b1}) AND e.health > 0`);
  if (i % 60 === 0 && i > 0) {
    await db.exec(`UPDATE ents SET x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, vx = 0, vy = 0, vz = 0 WHERE id = ${b0} AND health > 0`);
    await db.exec(`UPDATE ents SET x = ${fl.EX - 16}, y = ${fl.EY}, z = ${fl.EZ}, vx = 0, vy = 0, vz = 0 WHERE id = ${b1} AND health > 0`);
    for (const b of [b0, b1]) await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  }
  await q('SELECT tic FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)');
}
const [lr] = await q('SELECT (SELECT COUNT(*) FROM bot_q) rows_, (SELECT COALESCE(SUM(n), 0) FROM bot_q) tries, (SELECT COUNT(*) FROM bot_rl_log) logged, (SELECT COUNT(*) FROM bot_rl_log WHERE r IS NOT NULL) scored, (SELECT COUNT(*) FROM bot_rl_log WHERE r <> 0) paid, (SELECT SUM(rl_given) FROM ents WHERE classname = \'bot\') given FROM rdb$database');
assert(lr.TRIES >= 6 && lr.LOGGED >= lr.TRIES && lr.SCORED >= lr.TRIES - 2 && lr.PAID > 0 && lr.GIVEN > 0,
  `two bots fighting with the learning on: ${lr.TRIES} moves scored into ${lr.ROWS_} rows of the table, ${lr.LOGGED} logged (${lr.PAID} with a reward: ${lr.GIVEN} health given in all)`);

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
