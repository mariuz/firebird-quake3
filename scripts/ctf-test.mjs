// ctf-test.mjs – capture the flag (GT_CTF, sql/ctf.sql) on one of OpenArena's arenas: the flags and the teams'
// spawn points, taking the enemy flag, dropping it, its return, a capture, the bonuses, the capturelimit, and
// the bots' flag play.
//
//   node scripts/ctf-test.mjs [map]      (needs npm run fetch-maps: the arena and public/pak/ctf.pk3)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3, PakSet } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, buildWaypoints, SQL_FILES } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapName = process.argv[2] ?? 'ps9ctf';
const mapPak = path.join(root, `public/pak/maps/${mapName}.pk3`), ctfPak = path.join(root, 'public/pak/ctf.pk3');
if (!fs.existsSync(mapPak) || !fs.existsSync(ctfPak)) {
  console.log(`no ${path.relative(root, mapPak)} or public/pak/ctf.pk3: run npm run fetch-maps first`);
  process.exit(0);
}
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const buf = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const demo = new Pk3(buf(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')));
// the page's order: the demo's pak, capture the flag's files under it, the arena's own on top
const pak = new PakSet([demo, new Pk3(buf(ctfPak)), new Pk3(buf(mapPak))]);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, mapName, { skill: 3, bots: 5, gametype: 4, team: 1, link: false });
const q = async (s) => (await db.query(s)).rows;
const tic = (n = 1) => db.query(`SELECT * FROM q3_tic(${n}, 0, 0, 0, 0, 0, 0, 1, 0)`).then((r) => r.rows[0]);
const frame = async () => (await db.query('SELECT * FROM frame_all(0, 2147483647, 2147483647, 0)', [], { rowMode: 'array' })).rows;
const pe = (await q('SELECT ent_id e FROM player'))[0].E;
const god = (on) => db.exec(`UPDATE ents SET flags = ${on ? 'BIN_OR(flags, 16)' : 'BIN_AND(flags, BIN_NOT(16))'} WHERE id = ${pe}`);
const hold = () => db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot' AND deadflag = 0");
const said = async () => (await q('SELECT msg FROM messages ORDER BY id')).map((r) => r.MSG.trim());
const lastSound = async () => (await q('SELECT COALESCE(MAX(id), 0) m FROM sound_events'))[0].M;
const sounds = async (since) => (await q(`SELECT snd FROM sound_events WHERE id > ${since} ORDER BY id`)).map((r) => r.SND.trim().replace('sound/teamplay/', '').replace('.wav', ''));
const status = async () => (await q('SELECT ctf_status(1) r, ctf_status(2) b FROM rdb$database'))[0];
const put = async (id, at) => { await db.exec(`UPDATE ents SET x = ${at.X}, y = ${at.Y}, z = ${at.Z + 4}, vx = 0, vy = 0, vz = 0 WHERE id = ${id}`); };
await god(true);
await hold();

// the arena: both flags, each team's spawn points; the teams; everyone starts on its own side
const [redFlag] = await q('SELECT e.id, e.x, e.y, e.z, e.solid, e.alpha, m.name FROM ents e JOIN models m ON m.id = e.model_id WHERE e.id = ctf_base(1)');
const [blueFlag] = await q('SELECT e.id, e.x, e.y, e.z, e.solid, e.alpha, m.name FROM ents e JOIN models m ON m.id = e.model_id WHERE e.id = ctf_base(2)');
const spots = Object.fromEntries((await q("SELECT classname c, COUNT(*) n FROM ents WHERE classname LIKE 'team_CTF_%' GROUP BY classname")).map((r) => [r.C.trim(), r.N]));
assert(redFlag?.SOLID === 1 && blueFlag?.SOLID === 1 && redFlag.NAME.trim() === 'models/flags/r_flag.md3' && blueFlag.NAME.trim() === 'models/flags/b_flag.md3'
  && (spots.team_CTF_redspawn ?? 0) + (spots.team_CTF_redplayer ?? 0) > 0 && (spots.team_CTF_bluespawn ?? 0) + (spots.team_CTF_blueplayer ?? 0) > 0,
  `${mapName}: the two flags stand at their bases with their models, and the teams have their spawn points (${Object.entries(spots).map(([k, v]) => `${v} ${k.slice(9)}`).join(', ')})`);
const all = await q("SELECT id, classname, bot, pteam, x, y, z FROM ents WHERE classname IN ('player', 'bot') ORDER BY id");
const dist = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
const red = all.filter((e) => e.PTEAM === 1), blue = all.filter((e) => e.PTEAM === 2);
const home = all.filter((e) => dist(e, e.PTEAM === 1 ? redFlag : blueFlag) < dist(e, e.PTEAM === 1 ? blueFlag : redFlag)).length;
assert(red.length === 3 && blue.length === 3 && all.find((e) => e.ID === pe).PTEAM === 1 && home === 6, `three against three, we are red, and all six start nearer their own flag (${home})`);
let s = await tic();
let fr = await frame();
assert(s.GAMETYPE === 4 && s.RED_SCORE === 0 && s.BLUE_SCORE === 0 && fr.some((r) => r[0] === 13 && r[1] === 0 && r[2] === 0 && r[3] === 0), 'the tic says capture the flag, and the frame that both flags are at their bases');

// we touch the blue flag: we carry it, its base is empty, everyone is told and we hear it
let snd0 = await lastSound();
await put(pe, blueFlag);
s = await tic(2);
let st = await status();
const [mine] = await q(`SELECT effects, ctf_carried(${pe}) c FROM ents WHERE id = ${pe}`);
const [base] = await q(`SELECT solid, alpha FROM ents WHERE id = ${blueFlag.ID}`);
fr = await frame();
assert(mine.C === 2 && (mine.EFFECTS & 262144) !== 0 && st.B === 1 && st.R === 0 && base.SOLID === 0 && base.ALPHA === 1
  && (await said()).some((m) => /got the BLUE flag!/.test(m)) && (await sounds(snd0)).includes('voc_you_flag') && fr.some((r) => r[0] === 13 && r[2] === 1 && r[3] === 2),
  `touching the enemy flag we carry it: its base is empty, "${(await said()).find((m) => /got the/.test(m))}", "you have the flag", and the frame says so`);
// our own flag at its base without theirs does nothing; theirs brought to it is a capture
const [f0] = await q('SELECT frags FROM player');
snd0 = await lastSound();
await put(pe, redFlag);
s = await tic(2);
st = await status();
const [f1] = await q('SELECT frags FROM player');
assert(s.RED_SCORE === 1 && s.BLUE_SCORE === 0 && f1.FRAGS === f0.FRAGS + 5 && st.R === 0 && st.B === 0 && (await q(`SELECT ctf_carried(${pe}) c FROM rdb$database`))[0].C === 0
  && (await q(`SELECT solid FROM ents WHERE id = ${blueFlag.ID}`))[0].SOLID === 1 && (await said()).some((m) => /captured the BLUE flag!/.test(m))
  && (await sounds(snd0)).includes('flagcapture_yourteam') && (await sounds(snd0)).includes('voc_red_scores'),
  `the enemy flag brought to ours is a capture: a point for red (${s.RED_SCORE}), five frags for us, both flags at their bases, "${(await said()).find((m) => /captured/.test(m))}"`);

// a carrier that dies drops the flag where it stood; one of the flag's team that touches it sends it home
await put(pe, blueFlag);
await tic(2);
const mid = { X: (redFlag.X + blueFlag.X) / 2, Y: (redFlag.Y + blueFlag.Y) / 2, Z: blueFlag.Z };
await god(false);
await db.exec(`EXECUTE PROCEDURE t_damage(${pe}, ${blue[0].ID}, ${blue[0].ID}, 1000, 0, 0, 2)`);
await god(true);
st = await status();
const [dropped] = await q('SELECT e.id, e.x, e.y, e.z, e.think, e.nextthink - now_() left_ FROM ents e WHERE e.id = ctf_dropped(2)');
const [killer] = await q(`SELECT frags FROM ents WHERE id = ${blue[0].ID}`);
assert(st.B === 2 && dropped && dropped.THINK.trim() === 'flag_return' && Math.abs(dropped.LEFT_ - 30) < 0.2 && (await q(`SELECT ctf_carried(${pe}) c FROM rdb$database`))[0].C === 0
  && killer.FRAGS === 3 && (await said()).some((m) => /fragged RED's flag carrier!/.test(m)),
  `killed with the flag we drop it: it lies there for 30 seconds, and the bot that did it has a frag and two more (${killer.FRAGS}): "${(await said()).find((m) => /flag carrier/.test(m))}"`);
// (let it land, then a blue bot walks onto it)
for (let i = 0; i < 40; i++) await tic();
const [lying] = await q('SELECT e.id, e.x, e.y, e.z FROM ents e WHERE e.id = ctf_dropped(2)');
snd0 = await lastSound();
const [bf0] = await q(`SELECT frags FROM ents WHERE id = ${blue[1].ID}`);
await db.exec(`UPDATE ents SET x = ${lying.X}, y = ${lying.Y}, z = ${lying.Z + 10}, vx = 0, vy = 0, vz = 0, nextthink = 0, enemy_id = NULL, goal_id = NULL WHERE id = ${blue[1].ID}`);
for (let i = 0; i < 6 && (await status()).B !== 0; i++) await tic();
await hold();
st = await status();
const [bf1] = await q(`SELECT frags FROM ents WHERE id = ${blue[1].ID}`);
assert(st.B === 0 && bf1.FRAGS === bf0.FRAGS + 1 && (await q(`SELECT solid FROM ents WHERE id = ${blueFlag.ID}`))[0].SOLID === 1 && (await said()).some((m) => /returned the BLUE flag!/.test(m))
  && (await sounds(snd0)).includes('flagreturn_opponent'),
  `a bot of its team walks onto the dropped flag: it is home, a frag for the bot, "${(await said()).find((m) => /returned the/.test(m))}"`);
// nobody touching it, it goes home by itself after the 30 seconds
if ((await q('SELECT deadflag d FROM ents WHERE id = ' + pe))[0].D) await db.exec('EXECUTE PROCEDURE player_respawn');
await god(true);
await put(pe, blueFlag);
await tic(2);
await god(false);
await db.exec(`EXECUTE PROCEDURE t_damage(${pe}, ${pe}, ${pe}, 1000, 0, 0, 20)`);
await god(true);
await db.exec('UPDATE ents e SET e.nextthink = now_() + 0.1 WHERE e.id = ctf_dropped(2)');
await tic(4);
st = await status();
assert(st.B === 0 && (await said()).some((m) => m === 'The BLUE flag has returned!'), 'a dropped flag nobody touches goes home when its time is up: "The BLUE flag has returned!"');

// the bots' flag play: with both flags home one of each team's bots defends its base and the others go for the
// enemy flag; one of them takes it and brings it home
if ((await q('SELECT deadflag d FROM ents WHERE id = ' + pe))[0].D) await db.exec('EXECUTE PROCEDURE player_respawn');
await db.exec('EXECUTE PROCEDURE set_spectator(1)');
while ((await buildWaypoints(db, 1e9, 1e9)) > 0);
await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
await tic(10);
const roles = await q("SELECT e.id, e.bot, e.pteam, e.get_id, e.def_id, e.ctf_goal FROM ents e WHERE e.classname = 'bot' ORDER BY e.id");
const baseOf = { 1: redFlag.ID, 2: blueFlag.ID };
const defenders = roles.filter((b) => b.DEF_ID === baseOf[b.PTEAM]), attackers = roles.filter((b) => b.GET_ID === baseOf[3 - b.PTEAM]);
assert(defenders.length === 2 && defenders[0].PTEAM !== defenders[1].PTEAM && attackers.length === roles.length - 2 && roles.every((b) => b.CTF_GOAL === 1),
  `the bots split up: ${defenders.map((b) => b.BOT.trim()).join(' and ')} defend their bases, ${attackers.map((b) => b.BOT.trim()).join(', ')} go for the enemy flag`);
let taken = null, captured = null;
const t0 = (await q('SELECT time_ t FROM game'))[0].T, score0 = s.RED_SCORE + s.BLUE_SCORE;
for (let i = 0; i < 2400 && captured === null; i += 4) {
  s = await tic(4);
  st = await status();
  if (taken === null && (st.R === 1 || st.B === 1)) taken = s.TIME_ - t0;
  if (s.RED_SCORE + s.BLUE_SCORE > score0) captured = s.TIME_ - t0;
}
assert(taken !== null && taken < 120, `left to themselves, a bot has an enemy flag ${taken === null ? 'never' : `after ${taken.toFixed(0)} s`}${captured !== null ? `, and one is captured after ${captured.toFixed(0)} s (${s.RED_SCORE} to ${s.BLUE_SCORE})` : ' (none captured in two minutes)'}`);

// the capturelimit ends the match for the team that reaches it
await db.exec(`UPDATE game SET capturelimit = ${s.RED_SCORE + 1}`);
await hold();
await db.exec('EXECUTE PROCEDURE ctf_reset_flag(1)'); await db.exec('EXECUTE PROCEDURE ctf_reset_flag(2)');
await db.exec('EXECUTE PROCEDURE set_spectator(0)');
await god(true);
await db.exec("UPDATE ents SET x = x + 4000 WHERE classname = 'bot'");   // (out of the way)
await put(pe, blueFlag);
await tic(2);
await put(pe, redFlag);
s = await tic(2);
assert(s.MATCH_OVER === 1 && String(s.WINNER).trim() === 'Red team', `the capturelimit: red's capture number ${s.RED_SCORE} ends the match (${String(s.WINNER).trim()} wins)`);

console.log('console:', (await said()).slice(-6));
if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
console.log('all good');
process.exit(0);
