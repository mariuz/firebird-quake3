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
import { Strategist, ServerStrategist, LocalStrategist, LLM_MODELS, LOCAL_MODELS, smallMessages, smallWord, exportMemory, importMemory } from '../src/llm.js';

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
    // (the other API: an open model's server, OpenAI's chat completions)
    if (req.url === '/v1/chat/completions') { rsp.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: a.text } }], usage: { prompt_tokens: 900, completion_tokens: 30 } })); return; }
    rsp.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: requests.at(-1).body.model, stop_reason: a?.stop ?? 'end_turn', stop_sequence: null,
      content: a?.stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify({ note: '', ...(a ?? { action: 'roam', target: '', say: '' }) }) }], usage: { input_tokens: 700, output_tokens: 40 } }));
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
answers.push({ action: 'get', target: 'weapon_rocketlauncher', say: 'That launcher is mine.', note: 'The rocket launcher is a short run from where I start.' });
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

// the memory, which the database keeps for the model: each decision with what followed, the arena's totals, the notes
const memOf = async () => { const t = (await q('SELECT txt FROM bot_llm_ask'))[0].TXT; return t.slice(Math.max(0, t.indexOf('your last decisions'))); };
const m1 = await memOf();
console.log(m1.split('\n').map((l) => `     | ${l}`).join('\n'));
assert(/^your last decisions, the latest last, and what followed each:\n  \d+ s ago, get weapon_rocketlauncher: /.test(m1) && (got < 0 || /get weapon_rocketlauncher: [^\n]*picked up the Rocket Launcher/.test(m1))
  && /s ago, get weapon_bfg: could not be done/.test(m1) && /s ago, roam: under way/.test(m1) && /\nwhat your decisions have brought on this arena, in all your matches here:/.test(m1)
  && /\n  get weapon_bfg: 1 time \(1 could not be done\), frags \+0, deaths 0/.test(m1) && /\n  ambush: 1 time, frags [+-]\d+, deaths \d+/.test(m1)
  && /\nyour notes about this arena, which you wrote to remember:\n  The rocket launcher is a short run from where I start\./.test(m1),
  `what the model is sent after the situation: its last decisions with what followed each${got >= 0 ? ' (the rocket launcher picked up)' : ''}, the arena's totals by decision, its note`);
for (let i = 0; i < 13; i++) await q('SELECT done FROM bot_llm_apply(?, ?, ?, ?, ?)', [b, 'roam', '', '', `lesson ${i}`]);
await q('SELECT done FROM bot_llm_apply(?, ?, ?, ?, ?)', [b, 'roam', '', '', 'LESSON 12']);
const notes = (await q('SELECT TRIM(note) n FROM bot_llm_notes ORDER BY id')).map((r) => r.N);
assert(notes.length === 12 && notes[0] === 'lesson 1' && notes[11] === 'lesson 12', `a note is kept once, and the newest twelve of them (${notes.length}: ${notes[0]} … ${notes[11]})`);
// kept in the browser between visits: the rows out and back in, as decisions of earlier matches
const kept = JSON.parse(JSON.stringify(await exportMemory(db)));
const n1 = (await q('SELECT COUNT(*) n FROM bot_llm_log WHERE hp1 IS NOT NULL OR ok = 0'))[0].N;
const back = await importMemory(db, kept);
const [n2] = await q('SELECT COUNT(*) n, SUM(past) past, (SELECT COUNT(*) FROM bot_llm_notes) notes FROM bot_llm_log');
const m2 = await memOf();
assert(kept.log.length === n1 && back === n1 + 12 && n2.N === n1 && n2.PAST === n1 && n2.NOTES === 12 && !/your last decisions/.test(m2)
  && /what your decisions have brought on this arena/.test(m2) && /\n  roam: 1[45] times/.test(m2) && /\n  lesson 12/.test(m2) && (await importMemory(db, { version: 2 })) === 0,
  `the memory out to storage and back (${kept.log.length} decisions, ${kept.notes.length} notes): they count for the arena's totals, not as this match's last decisions`);

// an open model on the player's own server (Ollama, LM Studio), in Claude's place: the same question, OpenAI's API
const own = new ServerStrategist({ url: `${baseURL}/v1/`, model: 'llama3.1:8b', every: 0 });
const r0 = requests.length;
answers.push({ status: 400, type: 'invalid_request_error' }, { text: 'Here you go:\n{"action": "ambush", "target": "", "say": "Come and get it.", "note": "The corridor by the armor is a good ambush."}\n' });
await own.tick(db);
const o1 = await state();
answers.push({ text: 'I think the bot should hunt.' });
await own.tick(db);
const o2 = await state();
answers.push({ status: 404, type: 'not_found_error' });
await own.tick(db);
const [sr1, sr2, sr3] = requests.slice(r0);
assert(sr1.url === '/v1/chat/completions' && sr1.body.model === 'llama3.1:8b' && sr1.body.response_format.type === 'json_schema' && sr2.body.response_format.type === 'json_object'
  && sr3.body.response_format.type === 'json_object' && sr1.body.messages[0].role === 'system' && /^you: /.test(sr1.body.messages[1].content) && /what your decisions have brought/.test(sr1.body.messages[1].content)
  && sr1.headers['x-api-key'] === undefined && sr1.headers.authorization === undefined
  && o1.LASTD === 'ambush' && o1.CAMP_ID !== null && o2.LASTD === 'ambush' && own.decisions === 1 && own.notes === 1 && own.tokensIn === 1800
  && (await q("SELECT COUNT(*) n FROM bot_llm_notes WHERE note LIKE 'The corridor%'"))[0].N === 1 && own.stopped === 'the server has no model "llama3.1:8b"',
  `an open model on your own server is asked the same over OpenAI's chat API, no key sent: a server without JSON schemas gets the plainer mode, the object is found in what the model wrote around it, an answer with none is passed over, a model the server lacks ends it`);

// a small model in the browser, in Claude's place: SQL finds the best move of each kind, the model answers a word.
// (No model here either: the answers are given)
await db.exec(`UPDATE ents SET health = 30, armor = 0, weapons = 3, weapon = 2, ammo2 = 50 WHERE id = ${b} AND health > 0`);
for (let i = 0; i < 80 && (await q(`SELECT health h FROM ents WHERE id = ${b}`))[0].H <= 0; i++) await tic();
await db.exec(`UPDATE ents SET health = 30, armor = 0, weapons = 3, weapon = 2, ammo2 = 50 WHERE id = ${b}`);
// (every item back in its place first: the others have been taking them)
await db.exec("UPDATE ents e SET e.nextthink = (SELECT g.time_ FROM game g WHERE g.id = 1) WHERE e.think = 'item_respawn'");
await db.exec("UPDATE ents SET nextthink = nextthink + 5 WHERE classname = 'bot'");
for (let i = 0; i < 3; i++) await tic();
await db.exec(`UPDATE ents SET health = 30, armor = 0, weapons = 3, weapon = 2, ammo2 = 50 WHERE id = ${b}`);
const [of] = await q('SELECT eid, bot, txt, words FROM bot_llm_offer');
console.log(of.TXT.split('\n').map((l) => `     | ${l}`).join('\n'));
const BRIEF = /^Health \d+, armor \d+\. Guns: [^\n]+\.( Nearest enemy: \d+ units away(, in sight)?, holding the [A-Za-z0-9 ]+\.)?(\nheal: the [^\n]+, \d+ units away)?(\narm: the [^\n]+, \d+ units away)?(\nhunt: \w+)?\nwait: in ambush here$/;
const msgs = smallMessages(of.TXT, of.WORDS);
const examples = msgs.filter((m, i) => m.role === 'user' && i < msgs.length - 1).map((m) => m.content.replace(/\nOne word \([^\n]*\):$/, ''));
const offered = Object.fromEntries((await q(`SELECT TRIM(word) w, TRIM(action) a, TRIM(arg) g FROM bot_llm_choices WHERE eid = ${b}`)).map((r) => [r.W, `${r.A} ${r.G}`.trim()]));
assert(BRIEF.test(of.TXT) && of.WORDS.trim() === 'heal arm hunt wait' && /^Health 30, armor 0\. Guns: Gauntlet, Machinegun \(50\)\./.test(of.TXT)
  && /^get item_(health|armor)/.test(offered.heal) && /^get (weapon|item)_/.test(offered.arm) && /^hunt \w+/.test(offered.hunt) && offered.wait === 'ambush'
  && examples.length >= 4 && examples.every((e) => BRIEF.test(e)) && msgs[0].role === 'system' && msgs.at(-1).content.endsWith('One word (heal, arm, hunt or wait):')
  && smallWord(' Heal.', of.WORDS) === 'heal' && smallWord('I would arm', of.WORDS) === 'arm' && smallWord('7', of.WORDS) === '' && smallWord('arm', 'heal hunt wait') === '',
  `what a small model is offered: one line about the bot and the best move of each kind under a word (${Object.entries(offered).map(([w, m]) => `${w}: ${m}`).join('; ')}); the worked examples are in the same form`);
const words3 = ['heal', 'Hunt!', 'banana'], asked = [];
const small = new LocalStrategist({ every: 0, generate: async (m) => { asked.push(m); return words3.shift(); } });
await small.tick(db);
const p1 = await state();
await small.tick(db);
const p2 = await state();
await small.tick(db);
const p3 = await state();
const [lg] = await q(`SELECT COUNT(*) n FROM bot_llm_log WHERE past = 0 AND TRIM(action) || ' ' || TRIM(arg) = '${offered.heal}'`);
assert(p1.LASTD === offered.heal && /^item_(health|armor)/.test(p1.ITEM) && p2.LASTD === offered.hunt && p2.ENEMY_ID !== null && p3.LASTD === 'roam' && p3.GET_ID === null
  && asked.length === 3 && asked[0].at(-1).content.startsWith('Health 30, armor 0.') && small.decisions === 3 && lg.N === 1 && LOCAL_MODELS.length >= 1,
  `its word carried out: "heal" is ${offered.heal}, "Hunt!" is ${offered.hunt}, a word that was not offered lets the bot roam; the decisions are in the same memory`);

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
