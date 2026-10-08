// tourney-test.mjs – the tournament (GT_TOURNAMENT): two play, the rest wait their turn as spectators; the
// countdown starts when both are there; the winner stays, the loser goes to the back of the queue and the
// arena restarts with the one who waited longest (CheckTournament, AddTournamentPlayer,
// AdjustTournamentScores, RemoveTournamentLoser and map_restart in g_main.c and g_client.c).
//
//   node scripts/tourney-test.mjs [map]

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
await loadMap(db, pak, res, mapName, { skill: 3, bots: 3, gametype: 1, fraglimit: 3, warmup: 4 });
const q = async (s) => (await db.query(s)).rows;
const tic = (n = 1, fire = 0) => db.query(`SELECT * FROM q3_tic(${n}, 0, 0, 0, 0, ${fire}, 0, 1, 0)`).then((r) => r.rows[0]);
const pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);   // invulnerable
const bots = await q("SELECT id, bot FROM ents WHERE classname = 'bot' ORDER BY id");
const name = (id) => (id === pe ? 'You' : bots.find((b) => b.ID === id)?.BOT.trim());
const playing = async () => (await q('SELECT eid FROM duel_ranked')).map((r) => r.EID).sort((a, b) => a - b);
const queue = async () => (await q("SELECT name, team FROM scoreboard")).filter((r) => r.TEAM === 3).map((r) => r.NAME.trim());

// the first two to come play: us and the first bot; the other two wait, out of sight and reach
{
  const d = await playing();
  const waiting = await q("SELECT id, alpha, solid, takedamage, flags, st FROM ents WHERE classname = 'bot' AND queued = 1 ORDER BY id");
  assert(d.length === 2 && d.includes(pe) && d.includes(bots[0].ID) && waiting.length === 2, `the duel: ${d.map(name).join(' vs ')}; waiting: ${(await queue()).join(', ')}`);
  assert(waiting.every((w) => w.ALPHA === 1 && w.SOLID === 0 && w.TAKEDAMAGE === 0 && (w.FLAGS & 64) && w.ST.trim() === 'queue'), 'the waiting bots are spectators: unseen, not solid, nothing to shoot at');
  const s0 = (await q('SELECT COALESCE(MAX(id), 0) m FROM sound_events'))[0].M;
  let s = await tic();
  const g = (await q('SELECT warmup_end, time_ FROM game'))[0];
  const said = (await q(`SELECT snd FROM sound_events WHERE id > ${s0}`)).map((r) => r.SND.trim());
  assert(g.WARMUP_END > g.TIME_ + 3 && g.WARMUP_END < g.TIME_ + 5 && said.includes('sound/feedback/prepare.wav') && /vs/.test(s.CPRINT ?? ''),
    `with both there the countdown starts: "${s.CPRINT}", "prepare to fight"`);
  // a waiting bot is nobody's target: one 80 units in front of the playing bot, with us out of its sight
  const b0 = (await q(`SELECT x, y, z, yaw FROM ents WHERE id = ${bots[0].ID}`))[0], rad = b0.YAW * Math.PI / 180;
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE id = ${pe}`);
  await db.exec(`UPDATE ents SET x = ${b0.X + Math.cos(rad) * 80}, y = ${b0.Y + Math.sin(rad) * 80}, z = ${b0.Z} WHERE id = ${bots[1].ID}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${bots[1].ID})`);
  const sees = (await q(`SELECT bot_find_target(${bots[0].ID}) t FROM rdb$database`))[0].T;
  await db.exec(`UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(64)) WHERE id = ${pe}`);
  assert(sees === null, `a waiting bot in plain view is no target (${name(bots[0].ID)} sees ${sees ? name(sees) : 'nobody'})`);
  for (let i = 0; i < 100; i++) s = await tic();
}

// the duel ends: the bot wins 3 to 0; a win for it, a loss for us; after the intermission we join the
// spectators at the back of the queue and the next bot comes in, the scores from nothing
{
  for (let i = 0; i < 3; i++) await db.exec(`EXECUTE PROCEDURE score_frag(${bots[0].ID}, ${pe}, 7)`);
  const g = (await q('SELECT match_over, winner FROM game'))[0];
  const wl = (await q(`SELECT id, wins, losses FROM ents WHERE id IN (${pe}, ${bots[0].ID})`));
  const w = (id) => wl.find((r) => r.ID === id);
  assert(g.MATCH_OVER === 1 && g.WINNER.trim() === bots[0].BOT.trim() && w(bots[0].ID).WINS === 1 && w(pe).LOSSES === 1,
    `${g.WINNER.trim()} wins the duel: a win for it, a loss for us (AdjustTournamentScores)`);
  // the fire after five seconds of intermission (CheckIntermissionExit), through ExitLevel
  await db.exec('UPDATE game SET over_time = time_ - 6 WHERE id = 1');
  let s = await tic(1, 1);
  s = await tic();
  const d = await playing();
  const sp = (await q('SELECT spectator FROM player'))[0].SPECTATOR;
  const g2 = (await q('SELECT match_over, exit_kind, warmup_end, time_ FROM game'))[0];
  const frags = (await q("SELECT SUM(frags) f FROM ents WHERE classname = 'bot'"))[0].F;
  assert(sp === 1 && d.length === 2 && d.includes(bots[0].ID) && d.includes(bots[1].ID) && g2.MATCH_OVER === 0 && g2.EXIT_KIND === 0 && g2.WARMUP_END > g2.TIME_ && frags === 0,
    `no new arena: we wait, ${name(bots[1].ID)} comes in against the winner, the scores from nothing, the countdown again (queue: ${(await queue()).join(', ')})`);
  assert((await queue()).join(',') === `${bots[2].BOT.trim()},You`, 'the queue: the one who waited longest first, the loser last');
  // we ask to play: we wait our turn
  await db.exec('EXECUTE PROCEDURE set_spectator(0)');
  assert((await q('SELECT spectator FROM player'))[0].SPECTATOR === 1, 'asking to play while two play: still waiting');
}

// two more duels: the loser of the next goes behind us, so we are in the one after
{
  for (let i = 0; i < 100; i++) await tic();
  for (let i = 0; i < 3; i++) await db.exec(`EXECUTE PROCEDURE score_frag(${bots[0].ID}, ${bots[1].ID}, 7)`);
  await db.exec('UPDATE game SET over_time = time_ - 31 WHERE id = 1');   // nobody presses: thirty seconds
  await tic(); await tic();
  let d = await playing();
  assert(d.includes(bots[0].ID) && d.includes(bots[2].ID), `${name(bots[1].ID)} lost and waits; ${name(bots[2].ID)} comes in (queue: ${(await queue()).join(', ')})`);
  for (let i = 0; i < 100; i++) await tic();
  for (let i = 0; i < 3; i++) await db.exec(`EXECUTE PROCEDURE score_frag(${bots[2].ID}, ${bots[0].ID}, 7)`);
  await db.exec('UPDATE game SET over_time = time_ - 31 WHERE id = 1');
  await tic(); const s = await tic();
  d = await playing();
  assert(d.includes(pe) && d.includes(bots[2].ID) && s.SPECTATOR === 0 && s.HEALTH > 0, `our turn: we play ${name(bots[2].ID)}, who beat ${name(bots[0].ID)} (queue: ${(await queue()).join(', ')})`);
  const board = await q('SELECT * FROM scoreboard');
  console.log('scoreboard', board.map((r) => `${r.NAME.trim()}${r.TEAM === 3 ? ' (waiting)' : ''} ${r.WINS}-${r.LOSSES}`).join(', '));
}

// one of the two leaves while behind: the other gets the win (ClientDisconnect), the next comes in
{
  for (let i = 0; i < 100; i++) await tic();
  const d = await playing();
  const other = d.find((x) => x !== pe);
  await db.exec(`UPDATE player SET frags = 2 WHERE id = 1`);
  const w0 = (await q(`SELECT wins w FROM ents WHERE id = ${pe}`))[0].W;
  await db.exec(`EXECUTE PROCEDURE kick_bot('${name(other)}')`);
  await tic();
  const w1 = (await q(`SELECT wins w FROM ents WHERE id = ${pe}`))[0].W;
  const d2 = await playing();
  assert(w1 === w0 + 1 && d2.length === 2 && d2.includes(pe) && !d2.includes(other), `${name(other)} leaves the duel behind 0 to 2: a win for us, ${name(d2.find((x) => x !== pe))} comes in`);
}

// alone: waiting for players; a bot comes in at the console and the countdown starts
{
  await loadMap(db, pak, res, mapName, { skill: 3, bots: 0, gametype: 1, warmup: 4 });
  let s = await tic(); s = await tic();
  const g = (await q('SELECT warmup_end FROM game'))[0];
  assert(g.WARMUP_END > 1e8 && /Waiting for players/.test(s.CPRINT ?? ''), `alone: "${s.CPRINT}"`);
  await q("SELECT id FROM spawn_bot('Sarge')");
  await q("SELECT id FROM spawn_bot('Grunt')");
  s = await tic();
  const g2 = (await q('SELECT warmup_end, time_ FROM game'))[0];
  const d = await playing();
  assert(g2.WARMUP_END < 1e8 && d.length === 2 && (await queue()).join(',') === 'Grunt', `two come in at the console: Sarge plays us, Grunt waits; the countdown starts`);
}

await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
