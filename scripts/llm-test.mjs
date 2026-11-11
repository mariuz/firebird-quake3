// llm-test.mjs – a bot led by a language model (sql/chat.sql: bot_llm_lead, bot_llm_state, bot_llm_apply;
// src/llm.js): SQL writes what the bot knows, the answer is carried out, and what the page sends to the API is
// what the API takes. No model is asked: a local server stands in for api.anthropic.com and answers as told.
//
//   node scripts/llm-test.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, buildWaypoints, SQL_FILES } from '../src/loader.js';
import { Strategist, LLM_MODELS } from '../src/llm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
await createSchema(db, sql);
const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
const res = await loadResources(db, pak);
await loadMap(db, pak, res, 'q3dm1', { skill: 3, bots: 3, link: false, fraglimit: 20 });
const q = async (s, p) => (await db.query(s, p)).rows;
const tic = () => q('SELECT tic FROM q3_tic(1, 0, 0, 0, 0, 0, 0, 1, 0)');
const pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16 + 64) WHERE id = ${pe}`);   // (god mode, no target)
while ((await buildWaypoints(db, 1e9, 1e9)) > 0);   // (the whole graph now: the page builds it as the match goes)
for (let i = 0; i < 10; i++) await tic();

// the stand-in for the API: it keeps the requests and answers with the next of `answers`
const requests = [], answers = [];
const server = http.createServer((req, rsp) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const a = answers.shift();
    if (a?.status) { rsp.writeHead(a.status, { 'content-type': 'application/json' }); rsp.end(JSON.stringify({ type: 'error', error: { type: a.type, message: a.type } })); return; }
    rsp.writeHead(200, { 'content-type': 'application/json' });
    rsp.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: requests.at(-1).body.model, stop_reason: a?.stop ?? 'end_turn', stop_sequence: null,
      content: a?.stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(a ?? { action: 'roam', target: '', say: '' }) }], usage: { input_tokens: 700, output_tokens: 40 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// who is led: nobody, then the first bot, then all
const led = async () => (await q("SELECT id, TRIM(bot) bot FROM ents WHERE classname = 'bot' AND llm = 1 ORDER BY id"));
await db.exec('EXECUTE PROCEDURE bot_llm_lead(2)');
const all = await led();
await db.exec('EXECUTE PROCEDURE bot_llm_lead(1)');
const one = await led();
assert(all.length === 3 && one.length === 1, `the model leads all the bots (${all.map((b) => b.BOT).join(', ')}) or the first (${one[0]?.BOT}), and the console says so`);
const b = one[0].ID;

// what the bot knows, as text
await db.exec(`UPDATE ents SET health = 35, armor = 0, weapons = 3, weapon = 2, ammo2 = 40 WHERE id = ${b}`);
const [st] = await q('SELECT eid, bot, txt FROM bot_llm_state');
console.log(st.TXT.split('\n').map((l) => `     | ${l}`).join('\n'));
assert(st.EID === b && /^you: \w+, health 35, armor 0, frags 0/.test(st.TXT) && /guns \(ammo\): Gauntlet, Machinegun \(40\)/.test(st.TXT) && /doing: roaming/.test(st.TXT)
  && /match: free for all on q3dm1, first to 20 frags/.test(st.TXT) && (st.TXT.match(/units away, (in|out of) sight, in hand/g) ?? []).length === 3
  && /weapon_rocketlauncher: Rocket Launcher, \d+ units away/.test(st.TXT) && /item_armor_/.test(st.TXT) && /entered the game|is led by/.test(st.TXT) && st.TXT.length < 4000,
  `the situation SQL writes for the model: the bot, its guns, what it is doing, the match, the three others, the items by class, the console (${st.TXT.length} characters)`);

// the answers carried out
const ask = new Strategist({ apiKey: 'test-key', baseURL, every: 0 });
const state = async () => (await q(`SELECT e.get_id, e.goal_id, e.enemy_id, e.camp_id, TRIM(e.llm_plan) lastd, (SELECT TRIM(g.item) FROM ents g WHERE g.id = e.get_id) item FROM ents e WHERE e.id = ${b}`))[0];
answers.push({ action: 'get', target: 'weapon_rocketlauncher', say: 'That launcher is mine.' });
await ask.tick(db);
const s1 = await state();
const said = await q("SELECT COUNT(*) n FROM messages WHERE msg LIKE '%: That launcher is mine.'");
const rq = requests[0];
assert(rq.url.startsWith('/v1/messages') && (rq.headers['x-api-key'] === 'test-key' || rq.headers.authorization === 'Bearer test-key') && rq.body.model === LLM_MODELS[0][0] && rq.body.messages.length === 1
  && rq.body.messages[0].content.startsWith(st.TXT.split('\n')[0]) && typeof rq.body.system === 'string'
  && rq.body.output_config.effort === 'low' && rq.body.output_config.format.type === 'json_schema' && rq.body.fallbacks === 'default'
  && /server-side-fallback-2026-07-01/.test(rq.headers['anthropic-beta'] ?? '') && rq.body.thinking === undefined && rq.body.temperature === undefined,
  `the request the page sends: ${rq.body.model}, the situation as the one user message, a JSON schema for the answer, low effort, the default fallback`);
assert(s1.ITEM === 'weapon_rocketlauncher' && s1.GOAL_ID === s1.GET_ID && s1.LASTD === 'get weapon_rocketlauncher' && said[0].N === 1,
  `"get weapon_rocketlauncher" and a line to say: the bot goes for the rocket launcher and says it`);
// (nobody to fight on the way: everyone notarget until it is there)
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 64), enemy_id = NULL WHERE classname = 'bot'");
let got = -1;
for (let i = 0; i < 700 && got < 0; i++) { await tic(); if ((await q(`SELECT BIN_AND(weapons, 16) w FROM ents WHERE id = ${b}`))[0].W) got = i; if (i % 100 === 99) await db.exec(`UPDATE ents SET get_until = get_until + 5, health = 100 WHERE id = ${b} AND get_id IS NOT NULL`); }
const [after] = await q(`SELECT get_id, health FROM ents WHERE id = ${b}`);
await db.exec("UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(64)) WHERE classname = 'bot'");
assert(got >= 0 || after.GET_ID === null, `it ${got >= 0 ? `has the rocket launcher after ${got} tics` : 'found it gone or was fragged on the way'}`);

await db.exec(`UPDATE ents SET health = 100 WHERE id = ${b} AND health > 0`);
for (let i = 0; i < 80 && (await q(`SELECT health h FROM ents WHERE id = ${b}`))[0].H <= 0; i++) await tic();
const other = (await q(`SELECT id, TRIM(bot) bot FROM ents WHERE classname = 'bot' AND id <> ${b} AND health > 0 ORDER BY id`))[0];
answers.push({ action: 'hunt', target: other.BOT.toLowerCase(), say: '' });
await ask.tick(db);
const s2 = await state();
answers.push({ action: 'ambush', target: '', say: '' });
await ask.tick(db);
const s3 = await state();
answers.push({ action: 'get', target: 'weapon_bfg', say: '' });   // (q3dm1 has none)
await ask.tick(db);
const s4 = await state();
answers.push({ action: 'hunt', target: 'Nobody', say: '' });
await ask.tick(db);
const s5 = await state();
answers.push({ action: 'roam', target: '', say: '' });
await ask.tick(db);
const s6 = await state();
const [st2] = await q('SELECT txt FROM bot_llm_state');
assert(s2.ENEMY_ID === other.ID && s2.LASTD === `hunt ${other.BOT.toLowerCase()}` && s3.CAMP_ID !== null && s3.LASTD === 'ambush'
  && s4.CAMP_ID !== null && s4.LASTD === 'get weapon_bfg: none there now' && s5.LASTD === 'hunt Nobody: nobody alive by that name'
  && s6.CAMP_ID === null && s6.GET_ID === null && s6.LASTD === 'roam' && /your last decision: roam/.test(st2.TXT),
  `"hunt ${other.BOT}" sets it on ${other.BOT}, "ambush" has it wait there, an item the arena lacks and a name nobody bears change nothing and say why, "roam" lets it go`);

// what can go wrong: a refusal is skipped, a limit waits, a wrong key ends it
answers.push({ stop: 'refusal' });
await ask.tick(db);
const n0 = ask.decisions;
answers.push({ status: 429, type: 'rate_limit_error' }, { status: 429, type: 'rate_limit_error' });
await ask.tick(db);
const waiting = ask.due.get(b) > performance.now() + 20_000 && !ask.stopped;
ask.due.clear();
answers.push({ status: 401, type: 'authentication_error' });
await ask.tick(db);
const before = requests.length;
await ask.tick(db);
assert(ask.decisions === n0 && waiting && ask.stopped === 'the API key was not accepted' && requests.length === before,
  `a refusal is passed over, a rate limit waits half a minute, a key the API does not accept ends the asking (${ask.decisions} decisions made, ${ask.tokensIn} tokens in)`);

await db.exec('EXECUTE PROCEDURE bot_llm_lead(0)');
assert((await led()).length === 0 && (await q('SELECT COUNT(*) n FROM bot_llm_state'))[0].N === 0, 'led by nobody again: no situation is written');

server.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
