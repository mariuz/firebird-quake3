// chat-test.mjs – what the player says to the bots (sql/chat.sql): lines nobody wrote into the list are matched
// to the right intent by their EmbeddingGemma 2 embeddings (scripts/say-fixtures.json holds the test lines'
// vectors, made by scripts/embed-intents.mjs, so no model is needed here), and in a team game the bots do what
// they are told and answer: follow, camp, fetch an item, say where they are, stand down.
//
//   node scripts/chat-test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, buildWaypoints, SQL_FILES } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
const q = async (s, p) => (await db.query(s, p)).rows;
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'scripts/say-fixtures.json'), 'utf8'));
const vecOf = (text) => fixtures.find((f) => f.text === text).vec.join(',');
const say = async (text, vec = vecOf(text)) => (await q('SELECT * FROM player_say(?, ?)', [text, vec]))[0];
const tic = (n = 1) => q(`SELECT * FROM q3_tic(${n}, 0, 0, 0, 0, 0, 0, 1, 0)`);
const lines = async () => (await q('SELECT msg FROM messages ORDER BY id')).map((r) => r.MSG);

// a free-for-all first: every test line understood (or, for small talk, not), and an order obeyed by nobody
await loadMap(db, pak, res, 'q3dm1', { skill: 3, bots: 4, link: false });
let pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16 + 64) WHERE id = ${pe}`);   // we talk, unhurt and unhunted
const dims = (await q('SELECT COUNT(*) n, COUNT(DISTINCT phrase) p FROM bot_phrase_dims'))[0];
let right = 0;
const wrong = [];
let t = performance.now();
for (const f of fixtures) {
  const r = await say(f.text);
  if ((r.KIND?.trim() ?? null) === f.kind && (r.ARG?.trim() ?? null) === (f.arg ?? null)) right++;
  else wrong.push(`"${f.text}" → ${r.KIND?.trim()} ${r.ARG?.trim() ?? ''} (${r.SCORE?.toFixed(3)})`);
}
const ms = (performance.now() - t) / fixtures.length;
assert(dims.P > 80 && dims.N === dims.P * 128 && right === fixtures.length,
  `${dims.P} phrases embedded in 128 dimensions; ${right} of ${fixtures.length} lines nobody wrote into the list understood by meaning, ${ms.toFixed(0)} ms each${wrong.length ? ': ' + wrong.join('; ') : ''}`);
const ffa = await say('Sarge, follow me please');
const refused = (await lines()).some((l) => l.includes('team game'));
const obey = (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND acc_id IS NOT NULL"))[0].N;
assert(ffa.KIND.trim() === 'accompany' && ffa.HEARD === 0 && obey === 0 && refused, `in a free-for-all an order is understood (${ffa.KIND.trim()}) and obeyed by nobody (${obey}): the console says why`);
// a question is answered there by the bot named
const where = await say('Sarge where are you now');
const answer = (await lines()).find((l) => /Sarge\]?:/.test(l) && /near/i.test(l));
assert(where.KIND.trim() === 'whereareyou' && where.HEARD === 1 && answer, `"Sarge where are you now" → ${where.KIND.trim()}, Sarge alone answers: ${answer}`);
// without the model, a phrase has to be there word for word
const lit = await say('Grunt, what are you doing?', null), none = await say('stick with me', null);
assert(lit.KIND?.trim() === 'whatareyoudoing' && lit.SCORE === 1 && none.KIND === null, `without a vector a phrase in the line as it stands is matched (${lit.KIND?.trim()}), another way of saying it is not (${none.KIND})`);

// a team game: the bots of our team do as they are told
await loadMap(db, pak, res, 'q3dm1', { skill: 3, bots: 5, link: false, gametype: 3, team: 1 });
while ((await buildWaypoints(db, 1e9, 1e9)) > 0);
pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16 + 64) WHERE id = ${pe}`);
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 64) WHERE classname = 'bot'");   // (no fights meanwhile: nobody is a target)
// (a bot that spawned where we stand, unhurt as we are, would be stuck in us: it spawns again)
for (let k = 0; k < 20; k++) {
  const stuck = await q(`SELECT b.id FROM ents b, ents me WHERE me.id = ${pe} AND b.classname = 'bot' AND ABS(b.x - me.x) < 40 AND ABS(b.y - me.y) < 40 AND ABS(b.z - me.z) < 70`);
  if (!stuck.length) break;
  for (const b of stuck) { await db.exec(`EXECUTE PROCEDURE bot_respawn(${b.ID})`); await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE id = ${b.ID}`); }
}
const mates = (await q(`SELECT id, TRIM(bot) bot FROM ents WHERE classname = 'bot' AND pteam = (SELECT pteam FROM ents WHERE id = ${pe}) ORDER BY id`));
const others = (await q(`SELECT id FROM ents WHERE classname = 'bot' AND pteam <> (SELECT pteam FROM ents WHERE id = ${pe})`)).map((r) => r.ID);
const state = async () => q(`SELECT id, TRIM(bot) bot, acc_id, camp_id, get_id, goal_id, enemy_id, weapons, x, y, z FROM ents WHERE classname = 'bot' ORDER BY id`);
const mine = (rows) => rows.filter((r) => mates.some((m) => m.ID === r.ID));

// "everyone on me": the whole team accompanies us, the others do not; each says so within two seconds
const all = await say('everyone on me');
let st = await state();
for (let i = 0; i < 50; i++) await tic();
const told = (await lines()).filter((l) => mates.some((m) => l.includes(m.BOT + ']:')));
assert(all.KIND.trim() === 'accompany' && all.HEARD === mates.length && mine(st).every((r) => r.ACC_ID === pe) && st.filter((r) => others.includes(r.ID)).every((r) => r.ACC_ID === null) && told.length >= 1,
  `"everyone on me": the ${mates.length} bots of our team accompany us, the other team does not; ${told[0]}`);

// one named: it alone camps where we stand, the other goes on accompanying
// (nobody fights from here on: a bot that is fragged on its way loses its order with its life, and the test is of
// the orders; everyone is whole again and nobody a target)
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 64), enemy_id = NULL, health = IIF(health > 0, 100, health) WHERE classname IN ('bot', 'player')");
for (let i = 0; i < 120 && (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND health <= 0 AND queued = 0"))[0].N > 0; i++) await tic();
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 64), enemy_id = NULL WHERE classname = 'bot'");
const [m0, m1] = mates;
const [me] = await q(`SELECT x, y, z FROM ents WHERE id = ${pe}`);
const camp = await q('SELECT * FROM player_say(?, ?)', [`${m0.BOT} camp right here`, vecOf('Major camp right here')]);
st = await state();
const c0 = st.find((r) => r.ID === m0.ID), c1 = m1 && st.find((r) => r.ID === m1.ID);
const [spot] = await q(`SELECT classname, x, y, z FROM ents WHERE id = ${c0.CAMP_ID ?? -1}`);
let near = 1e9;
// (the spot is where we stand, with the mate that accompanies us beside us: the bot may be kept a step or two off)
for (let i = 0; i < 500 && near > 70; i++) { await tic(); const [b] = await q(`SELECT x, y, z FROM ents WHERE id = ${m0.ID}`); near = Math.hypot(b.X - me.X, b.Y - me.Y, b.Z - me.Z); }
assert(camp[0].KIND.trim() === 'camp' && camp[0].HEARD === 1 && spot?.CLASSNAME.trim() === 'camp_order' && Math.hypot(spot.X - me.X, spot.Y - me.Y) < 1 && c0.ACC_ID === null && (!c1 || c1.ACC_ID === pe) && near <= 250,
  `"${m0.BOT} camp right here": ${m0.BOT} alone camps where we stand and comes there (${near.toFixed(0)} away)${c1 ? `, ${m1.BOT} still accompanies us` : ''}`);

// "fetch the rocket launcher": off for the nearest one, and it says when it has it
// (the launcher put back in its place every tic meanwhile: another bot could take it first)
const putBack = () => db.exec(`UPDATE ents i SET i.solid = 1, i.alpha = 0, i.nextthink = NULL, i.think = NULL WHERE i.classname = 'item' AND i.item = 'weapon_rocketlauncher' AND i.solid = 0
  AND NOT EXISTS (SELECT 1 FROM ents b WHERE b.id = ${mates[0].ID} AND ABS(b.x - i.x) < 150 AND ABS(b.y - i.y) < 150)`);
await putBack();
await db.exec(`UPDATE ents SET weapons = 3 WHERE id = ${m0.ID}`);
const get = await q('SELECT * FROM player_say(?, ?)', [`${m0.BOT} fetch the rocket launcher`, vecOf('Sarge fetch the rocket launcher')]);
st = await state();
const g0 = st.find((r) => r.ID === m0.ID);
const [rl] = await q(`SELECT TRIM(item) item FROM ents WHERE id = ${g0.GET_ID ?? -1}`);
let got = -1, gone = false;
for (let i = 0; i < 900 && got < 0 && !gone; i++) {
  await tic();
  await putBack();
  const [b] = await q(`SELECT weapons w, get_id g FROM ents WHERE id = ${m0.ID}`);
  if ((b.W & 16) !== 0) got = i;
  else if (b.G === null) gone = true;   // (another bot took it as ours came in sight of the place: "the … isn't there")
}
for (let i = 0; i < 5; i++) await tic();
const said = (await lines()).filter((l) => l.includes(m0.BOT + ']:') && /rocket/i.test(l));
const after = (await state()).find((r) => r.ID === m0.ID);
assert(get[0].KIND.trim() === 'get' && get[0].ARG.trim() === 'weapon_rocketlauncher' && rl?.ITEM === 'weapon_rocketlauncher' && g0.CAMP_ID === null && (got >= 0 || gone) && after.GET_ID === null,
  `"${m0.BOT} fetch the rocket launcher": the camp is over, it goes for the rocket launcher and ${got >= 0 ? `has it after ${got} tics` : 'finds it gone'} (${said.join(' / ')})`);

// "stop": the team stands down
const stop = await say('stop');
st = await state();
assert(stop.KIND.trim() === 'dismiss' && mine(st).every((r) => r.ACC_ID === null && r.CAMP_ID === null && r.GET_ID === null),
  `"stop": dismissed, nobody of the team accompanies, camps or fetches any more`);

// "kill …": the team goes after the enemy named
const foe = (await q(`SELECT id, TRIM(bot) bot FROM ents WHERE id = ${others[0]}`))[0];
const kill = await q('SELECT * FROM player_say(?, ?)', [`kill ${foe.BOT}`, vecOf('kill Daemia')]);
st = await state();
assert(kill[0].KIND.trim() === 'kill' && mine(st).every((r) => r.ENEMY_ID === foe.ID), `"kill ${foe.BOT}": the team is after ${foe.BOT}`);

// "guard the rocket launcher": the bot named makes for the launcher's place, and once there is off about its own
// goals for a few seconds, then back (LTG_DEFENDKEYAREA); it says so, and says what it is doing when asked
await say('stop');
await db.exec("UPDATE ents SET enemy_id = NULL WHERE classname = 'bot'");
// (a bot says its line within two seconds; the console's lines are told apart by their ids)
const since = async (id) => (await q(`SELECT msg FROM messages WHERE id > ${id} ORDER BY id`)).map((r) => r.MSG);
const lastId = async () => (await q('SELECT COALESCE(MAX(id), 0) m FROM messages'))[0].M;
const id0 = await lastId();
const def = await q('SELECT * FROM player_say(?, ?)', [`${m0.BOT} guard the rocket launcher`, vecOf('Major guard the rocket launcher')]);
const dstate = async () => (await q(`SELECT e.def_id, e.def_until, e.def_away, e.goal_id, e.health, (SELECT g.time_ FROM game g WHERE g.id = 1) t,
  (SELECT TRIM(i.item) FROM ents i WHERE i.id = e.def_id) item,
  (SELECT SQRT((i.x - e.x) * (i.x - e.x) + (i.y - e.y) * (i.y - e.y) + (i.z - e.z) * (i.z - e.z)) FROM ents i WHERE i.id = e.def_id) d FROM ents e WHERE e.id = ${m0.ID}`))[0];
const d0 = await dstate();
let dsaid = [];
for (let i = 0; i < 60 && !dsaid.length; i++) { await tic(); dsaid = (await since(id0)).filter((l) => l.includes(m0.BOT + ')') && /Rocket Launcher/.test(l)); }
const other = (await state()).find((r) => m1 && r.ID === m1.ID);
let arrived = -1, away = -1, back = -1, farthest = 0;
for (let i = 0; i < 1500 && back < 0; i++) {
  await tic();
  const d = await dstate();
  if (arrived < 0 && d.D < 70) arrived = i;
  if (arrived >= 0 && away < 0 && d.DEF_AWAY > d.T) away = i;
  if (away >= 0) farthest = Math.max(farthest, d.D);
  if (away >= 0 && d.DEF_AWAY < d.T && d.GOAL_ID === d.DEF_ID) back = i;
}
const id1 = await lastId();
const doing = await say(`${m0.BOT} what are you doing?`, null);
let dsaid2 = [];
for (let i = 0; i < 60 && !dsaid2.length; i++) { await tic(); dsaid2 = (await since(id1)).filter((l) => l.includes(m0.BOT + ']') && /Rocket Launcher/.test(l)); }
assert(def[0].KIND.trim() === 'defend' && def[0].ARG.trim() === 'weapon_rocketlauncher' && def[0].HEARD === 1 && d0.ITEM === 'weapon_rocketlauncher' && Math.abs(d0.DEF_UNTIL - d0.T - 600) < 1
  && (!other || other.GOAL_ID !== d0.DEF_ID) && arrived >= 0 && away >= 0 && back > away && farthest < 1200 && dsaid.length >= 1 && doing.KIND?.trim() === 'whatareyoudoing' && dsaid2.length >= 1,
  `"${m0.BOT} guard the rocket launcher": ${m0.BOT} alone defends it for 600 s, is there after ${arrived} tics, off about its own goals (${farthest.toFixed(0)} units at the farthest) and back for it ${back - away} tics later; ${dsaid[0]}; asked: ${dsaid2.at(-1)}`);

// an order outlives the bot's death (AIEnter_Respawn resets the goals, not the order): fragged, the bot still
// defends; a camp it was told and an item it was told to get stay too, a camp of its own choosing does not
await db.exec(`UPDATE ents SET health = -10 WHERE id = ${m0.ID}`);
await db.exec(`EXECUTE PROCEDURE bot_die(${m0.ID}, ${m0.ID}, 0)`);
for (let i = 0; i < 200 && (await dstate()).HEALTH <= 0; i++) await tic();
const d1 = await dstate();
const [ownSpot] = await q(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN EXECUTE PROCEDURE spawn_ent('info_camp', ${me.X}, ${me.Y}, ${me.Z}) RETURNING_VALUES id; SUSPEND; END`);
await db.exec(`UPDATE ents SET camp_id = ${ownSpot.ID}, camp_until = 1e9 WHERE id = ${m1.ID}`);
await db.exec(`EXECUTE PROCEDURE bot_respawn(${m1.ID})`);
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE classname = 'bot'`);
const [own] = await q(`SELECT camp_id FROM ents WHERE id = ${m1.ID}`);
await q('SELECT * FROM player_say(?, ?)', [`${m1.BOT} camp right here`, vecOf('Major camp right here')]);
await db.exec(`EXECUTE PROCEDURE bot_respawn(${m1.ID})`);
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE classname = 'bot'`);
const [kept] = await q(`SELECT e.camp_id, (SELECT TRIM(c.classname) FROM ents c WHERE c.id = e.camp_id) cls FROM ents e WHERE e.id = ${m1.ID}`);
assert(d1.HEALTH > 0 && d1.DEF_ID === d0.DEF_ID && d1.DEF_AWAY === 0 && own.CAMP_ID === null && kept.CLS === 'camp_order',
  `an order outlives the bot: fragged and back, ${m0.BOT} still defends the rocket launcher; ${m1.BOT} respawned keeps the camp it was told, not one of its own choosing`);

// the leadership: we lead our team until we say we will not; then the bots find a leader among themselves, who
// answers "who is the leader?"; "I am the leader" takes it back
const leaderOf = async () => (await q(`SELECT IIF(o.pteam = 1, g.red_leader, g.blue_leader) l, g.not_leader n FROM game g, ents o WHERE g.id = 1 AND o.id = ${pe}`))[0];
const who0 = await say('who is our leader');
const quit = await say('i dont want to be leader anymore');
const l1 = await leaderOf();
await db.exec(`UPDATE ents SET enter_time = -100, tl_ask = 0, tl_become = 0 WHERE classname = 'bot'`);
let elected = null;
for (let i = 0; i < 700 && elected === null; i++) { await tic(); const l = await leaderOf(); if (l.L !== null && l.L !== pe) elected = l.L; }
const who1 = await say('who is our leader');
const answered = (await lines()).filter((l) => /I'm the team leader/.test(l)).at(-1);
const iam = await say('I am the leader now');
const l2 = await leaderOf();
const who2 = await say('who is our leader');
assert(who0.KIND.trim() === 'whoisleader' && who0.HEARD === 0 && quit.KIND.trim() === 'notleader' && quit.HEARD === mates.length && l1.L === null && l1.N === 1
  && mates.some((m) => m.ID === elected) && who1.HEARD === 1 && answered?.includes(mates.find((m) => m.ID === elected).BOT)
  && iam.KIND.trim() === 'iamleader' && l2.L === pe && l2.N === 0 && who2.HEARD === 0,
  `the leadership: we lead and nobody answers "who is our leader"; we quit and ${mates.find((m) => m.ID === elected)?.BOT} takes it: ${answered}; "I am the leader now" and it is ours again`);

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
