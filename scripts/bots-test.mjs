// bots-test.mjs – the bots: spawned, they find each other and the player,
// chase, shoot, pick things up, die and respawn; the score keeps up.
//
//   node scripts/bots-test.mjs [map]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapName = process.argv[2] ?? 'q3dm1';
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, mapName, { skill: 3, bots: 4 });
const q = async (s) => (await db.query(s)).rows;
const tic = (n = 1) => db.query(`SELECT * FROM q3_tic(${n}, 0, 0, 0, 0, 0, 0, 1, 0)`).then((r) => r.rows[0]);
const pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);   // we watch, invulnerable

const bots = await q("SELECT id, bot, pmodel FROM ents WHERE classname = 'bot'");
assert(bots.length === 4, `four bots joined (${bots.map((b) => b.BOT).join(', ')})`);

// a bot sees the player: put one in front of us
const b = bots[0].ID;
const p = (await q(`SELECT x, y, z, yaw FROM ents WHERE id = ${pe}`))[0];
await db.exec(`UPDATE ents SET x = ${p.X + Math.cos((p.YAW * Math.PI) / 180) * 200}, y = ${p.Y + Math.sin((p.YAW * Math.PI) / 180) * 200}, z = ${p.Z}, vx = 0, vy = 0, vz = 0, enemy_id = NULL WHERE id = ${b}`);
await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
for (let i = 0; i < 70; i++) await tic();
let s = (await q(`SELECT enemy_id, st, attack_finished, weapon FROM ents WHERE id = ${b}`))[0];
assert(s.ENEMY_ID !== null, `the bot found an enemy (${s.ENEMY_ID}, ${s.ST.trim()})`);
const shots = (await q("SELECT COUNT(*) n FROM sound_events WHERE snd LIKE 'sound/weapons/%' AND ent_id <> " + pe))[0].N;
assert(shots > 0, `the bots fired (${shots} shots)`);

// a bot dies and respawns
const hpBefore = (await q(`SELECT health FROM ents WHERE id = ${b}`))[0].HEALTH;
await db.exec(`EXECUTE PROCEDURE t_damage(${b}, ${pe}, ${pe}, ${hpBefore + 20}, 50, 0, 17)`);
s = (await q(`SELECT st, deadflag, respawn_time FROM ents WHERE id = ${b}`))[0];
assert(s.DEADFLAG === 1 && s.ST.trim() === 'dead', `the bot died (hp was ${hpBefore})`);
const frags = (await q('SELECT frags FROM player'))[0].FRAGS;
assert(frags === 1, `we were credited the frag (${frags})`);
const obit = (await q('SELECT msg FROM messages ORDER BY id DESC'))[0]?.MSG;
assert(obit && obit.includes('railed'), `the obituary reads "${obit}"`);
const corpses = (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'corpse'"))[0].N;
assert(corpses >= 1, `a corpse was left (${corpses})`);
for (let i = 0; i < 120; i++) await tic();
s = (await q(`SELECT st, deadflag, health, cluster FROM ents WHERE id = ${b}`))[0];
assert(s.DEADFLAG === 0 && s.HEALTH > 0 && s.CLUSTER !== null, `the bot respawned (hp ${s.HEALTH})`);

// a bot picks up a weapon: drop it on one
const item = (await q("SELECT FIRST 1 e.id, e.x, e.y, e.z, d.bit FROM ents e JOIN item_defs d ON d.cls = e.item WHERE d.kind = 'W' AND e.solid = 1 ORDER BY e.id"))[0];
if (item) {
  await db.exec(`UPDATE ents SET x = ${item.X}, y = ${item.Y}, z = ${item.Z + 2}, weapons = 3, vx = 0, vy = 0, vz = 0 WHERE id = ${b}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  await db.exec(`EXECUTE PROCEDURE touch_triggers(${b})`);
  s = (await q(`SELECT weapons FROM ents WHERE id = ${b}`))[0];
  assert((s.WEAPONS & item.BIT) !== 0, `the bot picked up weapon bit ${item.BIT} (weapons ${s.WEAPONS})`);
  const taken = (await q(`SELECT solid, nextthink FROM ents WHERE id = ${item.ID}`))[0];
  assert(taken.SOLID === 0 && taken.NEXTTHINK > 0, 'the weapon is gone until it respawns');
}

// a minute of play: the bots keep fragging each other, nobody is stuck in the void
let t0 = performance.now();
for (let i = 0; i < 600; i++) await tic(2);
console.log(`1200 tics in ${(performance.now() - t0).toFixed(0)} ms`);
const board = await q('SELECT * FROM scoreboard');
console.log('scores', board.map((r) => `${r.NAME.trim()} ${r.FRAGS}/${r.DEATHS}`).join(', '));
const total = board.reduce((a, r) => a + r.FRAGS, 0);
assert(total !== 0 || board.some((r) => r.DEATHS > 0), 'frags were scored during a minute of play');
const lost = (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND health > 0 AND cluster IS NULL"))[0].N;
assert(lost === 0, 'no living bot is outside the world');
const msgs = (await q('SELECT msg FROM messages ORDER BY id'));
console.log('console', msgs.map((m) => m.MSG));
await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
