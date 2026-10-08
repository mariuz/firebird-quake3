// team-test.mjs – team deathmatch (GT_TEAM): the teams picked and coloured, no friendly fire, the bots
// leave their teammates alone, the team scores, the announcer, the fraglimit and the time limit by team.
//
//   node scripts/team-test.mjs [map]

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
await loadMap(db, pak, res, mapName, { skill: 3, bots: 4, gametype: 3, team: 1 });
const q = async (s) => (await db.query(s)).rows;
const tic = (n = 1) => db.query(`SELECT * FROM q3_tic(${n}, 0, 0, 0, 0, 0, 0, 1, 0)`).then((r) => r.rows[0]);
const pe = (await q('SELECT ent_id e FROM player'))[0].E;
await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);   // we watch, invulnerable
const sounds = async (since) => (await q(`SELECT snd FROM sound_events WHERE id > ${since} ORDER BY id`)).map((r) => r.SND.trim());
const lastSound = async () => (await q('SELECT COALESCE(MAX(id), 0) m FROM sound_events'))[0].M;

// the teams: we asked for red; the bots by PickTeam: the smaller team, and on a tie the one behind, else
// blue: blue, blue, red, blue, so 2 against 3
const all = await q("SELECT id, classname, bot, pteam, pskin FROM ents WHERE classname IN ('player', 'bot') ORDER BY id");
const red = all.filter((e) => e.PTEAM === 1), blue = all.filter((e) => e.PTEAM === 2);
assert(all.find((e) => e.ID === pe).PTEAM === 1 && red.length === 2 && blue.length === 3,
  `the teams: red ${red.map((e) => e.BOT ?? 'You').join(', ')}; blue ${blue.map((e) => e.BOT).join(', ')}`);
assert(all.every((e) => e.PSKIN.trim() === (e.PTEAM === 1 ? 'red' : 'blue')), 'everyone wears the team\'s skin');
let s = await tic();
assert(s.GAMETYPE === 3 && s.TEAM === 1 && s.RED_SCORE === 0 && s.BLUE_SCORE === 0, 'the tic says the game type, our team and the team scores');
const mate = red.find((e) => e.CLASSNAME === 'bot');
const foe = blue[0], foe2 = blue[1];

// no friendly fire: a teammate's rocket knocks, it does not hurt; the enemy's hurts
{
  await db.exec(`UPDATE ents SET health = 100, armor = 0, vx = 0, vy = 0, vz = 0 WHERE id IN (${mate.ID}, ${foe.ID})`);
  await db.exec(`EXECUTE PROCEDURE t_damage(${mate.ID}, ${pe}, ${pe}, 50, 50, 0, 7)`);
  await db.exec(`EXECUTE PROCEDURE t_damage(${foe.ID}, ${pe}, ${pe}, 50, 50, 0, 7)`);
  const [m, f] = [(await q(`SELECT health, vx, vy, vz FROM ents WHERE id = ${mate.ID}`))[0], (await q(`SELECT health FROM ents WHERE id = ${foe.ID}`))[0]];
  assert(m.HEALTH === 100 && Math.hypot(m.VX, m.VY, m.VZ) > 100 && f.HEALTH === 50, `no friendly fire: the teammate is knocked (${Math.hypot(m.VX, m.VY, m.VZ).toFixed(0)}) and keeps ${m.HEALTH}, the enemy drops to ${f.HEALTH}`);
}

// the bots: a teammate in full view is no enemy, an enemy is; a teammate in the line of fire holds it
// (BotCheckAttack). On a line through our spot that is clear for 320 units: us at 0, then 150 and 300 out
{
  await db.exec("UPDATE ents SET nextthink = 1e9, enemy_id = NULL WHERE classname = 'bot'");
  for (const e of all.filter((e) => e.CLASSNAME === 'bot' && ![mate.ID, foe.ID, foe2.ID].includes(e.ID))) await db.exec(`UPDATE ents SET st = 'dead', deadflag = 1, health = 0, solid = 0, respawn_time = 1e9 WHERE id = ${e.ID}`);
  const spot = (await q(`SELECT x, y, z FROM ents WHERE id = ${pe}`))[0];
  let dir = null;
  for (const yaw of [0, 90, 180, 270, 45, 135, 225, 315]) {
    const c = Math.cos(yaw * Math.PI / 180), sn = Math.sin(yaw * Math.PI / 180);
    const t = (await q(`SELECT fraction f FROM trace_move(${pe}, -15,-15,-24,15,15,32, ${spot.X}, ${spot.Y}, ${spot.Z}, ${spot.X + c * 330}, ${spot.Y + sn * 330}, ${spot.Z}, 65537)`))[0];
    if (t.F >= 1) { dir = [c, sn, yaw]; break; }
  }
  const place = async (id, d) => {
    await db.exec(`UPDATE ents SET x = ${spot.X + dir[0] * d}, y = ${spot.Y + dir[1] * d}, z = ${spot.Z}, vx = 0, vy = 0, vz = 0, yaw = ${(dir[2] + 180) % 360},
                   health = 100, deadflag = 0, solid = 3, takedamage = 2, st = 'run', respawn_time = 1e9, enemy_id = NULL WHERE id = ${id}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${id})`);
  };
  const far = async (id) => { await db.exec(`UPDATE ents SET solid = 0, z = z - 10000 WHERE id = ${id}`); await db.exec(`EXECUTE PROCEDURE link_ent(${id})`); };
  await place(mate.ID, 150); await far(foe.ID); await far(foe2.ID);
  const mateSees = (await q(`SELECT bot_find_target(${mate.ID}) t FROM rdb$database`))[0].T;
  await place(foe.ID, 300);
  const foeSees = (await q(`SELECT bot_find_target(${foe.ID}) t FROM rdb$database`))[0].T;
  assert(dir && mateSees !== pe && foeSees === mate.ID, `a bot never picks a teammate (red ${mate.BOT} facing us: ${mateSees ?? 'nobody'}; blue ${foe.BOT} behind it: ${foeSees === mate.ID ? mate.BOT : foeSees})`);
  // blue at 300 aims at us: with red between it fires (the rocket finds the red one first, as it may);
  // with a blue teammate between it holds its fire
  await db.exec(`UPDATE ents SET enemy_id = ${pe}, weapons = BIN_OR(weapons, 16), weapon = 16 WHERE id = ${foe.ID}`);
  const rockets = async () => (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'rocket'"))[0].N;
  const r0 = await rockets();
  await db.exec(`EXECUTE PROCEDURE bot_fire(${foe.ID})`);
  const r1 = await rockets();
  await db.exec("DELETE FROM ents WHERE classname = 'rocket'");
  await far(mate.ID); await place(foe2.ID, 150);
  await db.exec(`EXECUTE PROCEDURE bot_fire(${foe.ID})`);
  const r2 = await rockets();
  assert(r1 === r0 + 1 && r2 === 0, `a bot fires with an enemy in the way (${r1 - r0} rocket), not through a teammate (${r2}) (BotCheckAttack)`);
  await db.exec("DELETE FROM ents WHERE classname = 'rocket'");
  await place(mate.ID, 200);
  await db.exec("UPDATE ents SET respawn_time = 0, health = 1 WHERE classname = 'bot' AND deadflag = 1");
}

// the scores: a frag is the team's too, a teammate's or one's own costs one; the announcer calls the lead
{
  const s0 = await lastSound();
  await db.exec('UPDATE player SET frags = 0 WHERE id = 1');
  await db.exec("UPDATE ents SET frags = 0 WHERE classname = 'bot'");
  await db.exec('UPDATE game SET red_score = 0, blue_score = 0, team_lead = 0 WHERE id = 1');
  await db.exec(`EXECUTE PROCEDURE score_frag(${pe}, ${foe.ID}, 7)`);          // red +1: red leads
  const a = (await q('SELECT red_score r, blue_score b FROM game'))[0];
  await db.exec(`EXECUTE PROCEDURE score_frag(${foe.ID}, ${mate.ID}, 7)`);     // blue +1: tied
  await db.exec(`EXECUTE PROCEDURE score_frag(${foe2.ID}, ${pe}, 7)`);         // blue +1: blue leads
  await db.exec(`EXECUTE PROCEDURE score_frag(${foe.ID}, ${foe2.ID}, 7)`);     // a teammate: blue -1, tied again
  await db.exec(`EXECUTE PROCEDURE score_frag(NULL, ${mate.ID}, 13)`);         // a fall: red -1, blue leads
  const b = (await q('SELECT red_score r, blue_score b FROM game'))[0];
  const bf = (await q(`SELECT frags f FROM ents WHERE id = ${foe.ID}`))[0].F;
  const said = (await sounds(s0)).filter((x) => /leads|tied/.test(x)).map((x) => x.replace(/.*\//, '').replace('.wav', ''));
  assert(a.R === 1 && a.B === 0 && b.R === 0 && b.B === 1 && bf === 0, `the team scores follow the frags (red 1 : blue 0, then 0 : 1; ${foe.BOT} +1 then -1 for its teammate: ${bf})`);
  assert(said.join(',') === 'redleads,teamstied,blueleads,teamstied,blueleads', `the announcer: ${said.join(', ')}`);
}

// the fraglimit is the team's
{
  await db.exec('UPDATE game SET fraglimit = 5, red_score = 4, blue_score = 1 WHERE id = 1');
  await db.exec(`EXECUTE PROCEDURE score_frag(${mate.ID}, ${foe.ID}, 7)`);
  const g = (await q('SELECT match_over, winner FROM game'))[0];
  const msg = (await q('SELECT msg FROM player'))[0].MSG;
  assert(g.MATCH_OVER === 1 && g.WINNER.trim() === 'Red team' && msg === 'Red hit the fraglimit.', `red reaches 5 first: "${msg}", ${g.WINNER.trim()} wins`);
  s = await tic();
  const board = await q('SELECT * FROM scoreboard');
  assert(board.every((r, i) => i === 0 || r.TEAM >= board[i - 1].TEAM) && board.filter((r) => r.TEAM === 1).length === 2, `the scoreboard lists the teams, red first (${board.map((r) => `${r.NAME.trim()}:${r.TEAM}`).join(' ')})`);
}

// the time limit: a tie by team is sudden death; the next frag ends it
{
  await db.exec('UPDATE game SET match_over = 0, winner = NULL, fraglimit = 0, timelimit = 1, warmup_end = 0, time_warnings = 0, red_score = 3, blue_score = 3, time_ = 70 WHERE id = 1');
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  for (let i = 0; i < 4; i++) s = await tic();
  const still = (await q('SELECT match_over m FROM game'))[0].M;
  await db.exec(`EXECUTE PROCEDURE score_frag(${foe.ID}, ${mate.ID}, 7)`);
  s = await tic();
  const g = (await q('SELECT match_over, winner FROM game'))[0];
  assert(still === 0 && g.MATCH_OVER === 1 && g.WINNER.trim() === 'Blue team', `past the time limit with the teams tied it plays on; blue's frag ends it (${g.WINNER})`);
}

// a minute of play: frags, and every team's score is the sum of its members' frags (nothing slipped past AddScore)
{
  await loadMap(db, pak, res, mapName, { skill: 3, bots: 4, gametype: 3 });
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16 + 64) WHERE id = (SELECT ent_id FROM player)`);
  for (let i = 0; i < 400; i++) s = await tic(2);
  const sums = (await q(`SELECT
      (SELECT COALESCE(SUM(e.frags), 0) FROM ents e WHERE e.classname = 'bot' AND e.pteam = 1) + (SELECT IIF(o.pteam = 1, p.frags, 0) FROM player p JOIN ents o ON o.id = p.ent_id) r,
      (SELECT COALESCE(SUM(e.frags), 0) FROM ents e WHERE e.classname = 'bot' AND e.pteam = 2) + (SELECT IIF(o.pteam = 2, p.frags, 0) FROM player p JOIN ents o ON o.id = p.ent_id) b,
      g.red_score rs, g.blue_score bs FROM game g`))[0];
  const deaths = (await q("SELECT SUM(deaths) d FROM ents WHERE classname = 'bot'"))[0].D;
  assert(deaths > 0 && sums.R === sums.RS && sums.B === sums.BS, `40 seconds of team play: ${deaths} deaths, red ${sums.RS} = its members' ${sums.R}, blue ${sums.BS} = ${sums.B}`);
  console.log('scores', (await q('SELECT * FROM scoreboard')).map((r) => `${r.NAME.trim()}(${r.TEAM === 1 ? 'red' : 'blue'}) ${r.FRAGS}/${r.DEATHS}`).join(', '));
}

await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
