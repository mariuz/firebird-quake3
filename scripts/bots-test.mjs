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
// (the obituary, among the last lines: the dying bot may have said something after it)
const obit = (await q('SELECT FIRST 4 msg FROM messages ORDER BY id DESC')).map((m) => m.MSG).find((m) => m.includes('railed'));
assert(obit, `the obituary reads "${obit}"`);
const corpses = (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'corpse'"))[0].N;
assert(corpses >= 1, `a corpse was left (${corpses})`);
// (watched tic by tic: back in the fight, it can die again before the six seconds are up)
for (let i = 0; i < 120; i++) {
  await tic();
  s = (await q(`SELECT st, deadflag, health, cluster FROM ents WHERE id = ${b}`))[0];
  if (s.DEADFLAG === 0 && s.HEALTH > 0) break;
}
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

// the bot hunts us out of sight: from the farthest spawn, over the waypoint graph (sql/waypoints.sql)
{
  const wp = (await q('SELECT COUNT(*) n, (SELECT COUNT(*) FROM wp_edges) e FROM waypoints'))[0];
  assert(wp.N > 20 && wp.E > wp.N, `the waypoint graph has ${wp.N} nodes and ${wp.E} edges`);
  // we stand on a spawn point (the earlier play may have knocked us into q3dm17's void, god mode or not)
  const home = (await q("SELECT FIRST 1 e.x, e.y, e.z FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY e.id"))[0];
  await db.exec(`UPDATE ents SET x = ${home.X}, y = ${home.Y}, z = ${home.Z + 9}, vx = 0, vy = 0, vz = 0 WHERE id = ${pe}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  await tic(2);
  const me = (await q(`SELECT x, y, z FROM ents WHERE id = ${pe}`))[0];
  const far = (await q(`SELECT FIRST 1 e.id, e.x, e.y, e.z FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY (e.x - ${me.X}) * (e.x - ${me.X}) + (e.y - ${me.Y}) * (e.y - ${me.Y}) DESC`))[0];
  // the other bots sit this one out
  await db.exec(`UPDATE ents SET st = 'dead', deadflag = 1, health = 0, solid = 0, respawn_time = 1e9, enemy_id = NULL WHERE classname = 'bot' AND id <> ${b}`);
  // the hunter holds its fire (a rocket would knock us off the ledge)
  await db.exec(`UPDATE ents SET x = ${far.X}, y = ${far.Y}, z = ${far.Z}, vx = 0, vy = 0, vz = 0, enemy_id = ${pe}, search_time = 1e9, goal_id = NULL, health = 100, st = 'run', attack_finished = 1e9 WHERE id = ${b}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  const d0 = Math.hypot(far.X - me.X, far.Y - me.Y, far.Z - me.Z);
  let best = d0, n = 0, died = null;
  for (; n < 600; n++) {
    await tic();
    const r = (await q(`SELECT e.x - p.x dx, e.y - p.y dy, e.z - p.z dz, e.health hp FROM ents e CROSS JOIN ents p WHERE e.id = ${b} AND p.id = ${pe}`))[0];
    const d = Math.hypot(r.DX, r.DY, r.DZ);
    if (d < best) best = d;
    if (d < 350) break;     // in sight and in range it circle-strafes instead of closing in
    if (r.HP <= 0 && died === null) died = n;
  }
  const st = (await q(`SELECT e.st, e.health, e.enemy_id, CAST(e.x AS INTEGER) x, CAST(e.y AS INTEGER) y, CAST(e.z AS INTEGER) z, r.path, (SELECT CAST(p.x AS INTEGER) || ',' || CAST(p.y AS INTEGER) || ',' || CAST(p.z AS INTEGER) FROM ents p WHERE p.id = ${pe}) me FROM ents e LEFT JOIN bot_routes r ON r.ent_id = e.id WHERE e.id = ${b}`))[0];
  const last = (await q('SELECT FIRST 2 msg FROM messages ORDER BY id DESC')).map((m) => m.MSG).join(' / ');
  assert(best < Math.max(350, d0 * 0.5), `the bot hunted us from ${d0.toFixed(0)} away down to ${best.toFixed(0)} in ${n} tics (route ${st.PATH ?? 'none'}; now ${st.ST.trim()} hp ${st.HEALTH} enemy ${st.ENEMY_ID} at ${st.X},${st.Y},${st.Z}, we at ${st.ME}${died !== null ? `; died at tic ${died}: ${last}` : ''})`);
  await db.exec(`UPDATE ents SET respawn_time = 0, health = 1 WHERE classname = 'bot' AND id <> ${b}`);
}

// a rocket jump (BotTravel_RocketJump): up to a ledge the walk does not reach, from a rocket-jump edge's
// start, with a target on its end; bot_follow_route drives it each think
{
  const hops = (p) => (p ? p.split(',').length - 2 : null);
  const edges = (await q('SELECT e.a, e.b, a.x ax, a.y ay, a.z az, b.x bx, b.y by_, b.z bz, wp_route(e.a, e.b, 0) walk FROM wp_edges e JOIN waypoints a ON a.id = e.a JOIN waypoints b ON b.id = e.b WHERE e.kind = 4 ORDER BY e.a'))
    .filter((e) => e.WALK === null || hops(e.WALK) > 13);
  if (!edges.length) console.log('(no rocket jump here the bots would take)');
  else {
    const e = edges[0];
    await db.exec(`UPDATE ents SET st = 'dead', deadflag = 1, health = 0, solid = 0, respawn_time = 1e9, enemy_id = NULL WHERE classname = 'bot' AND id <> ${b}`);
    await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE id = ${pe}`);   // notarget: nothing to fight
    const tgt = (await q(`SELECT id FROM spawn_ent('info_notnull', ${e.BX}, ${e.BY_}, ${e.BZ})`))[0].ID;
    await db.exec(`UPDATE ents SET x = ${e.AX + 20}, y = ${e.AY + 10}, z = ${e.AZ - 1}, vx = 0, vy = 0, vz = 0, health = 100, armor = 0, weapons = BIN_OR(weapons, 16), quad_finished = 0,
                   nextthink = 1e9, flags = BIN_OR(flags, 512), enemy_id = NULL, st = 'run' WHERE id = ${b}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
    await db.exec(`DELETE FROM bot_routes WHERE ent_id = ${b}`);
    const can = (await q(`SELECT bot_can_rj(${b}) c FROM rdb$database`))[0].C;
    let arrived = null, top = -1e9, hp = 100;
    for (let i = 0; i < 100 && arrived === null; i++) {
      if (i % 2 === 0 && ((await q(`SELECT flags FROM ents WHERE id = ${b}`))[0].FLAGS & 512)) await q(`SELECT moved FROM bot_follow_route(${b}, ${tgt}, 32)`);
      await tic();
      const r = (await q(`SELECT x, y, z, health, flags FROM ents WHERE id = ${b}`))[0];
      top = Math.max(top, r.Z); hp = r.HEALTH;
      if ((r.FLAGS & 512) && Math.hypot(r.X - e.BX, r.Y - e.BY_) < 48 && Math.abs(r.Z - (e.BZ - 1)) < 30) arrived = i;
    }
    assert(can === 1 && arrived !== null && top - e.AZ > 150 && hp < 100,
      `a bot rocket-jumps up ${(e.BZ - e.AZ).toFixed(0)} to a ledge ${hops(e.WALK) === null ? 'no walk reaches' : `a ${hops(e.WALK)}-node walk away`} (up ${(top - e.AZ).toFixed(0)}, there in ${arrived} tics, its own rocket half as hard: ${hp} health)`);
    // and it would not with less than 60 health (BotCanAndWantsToRocketJump)
    await db.exec(`UPDATE ents SET health = 50 WHERE id = ${b}`);
    assert((await q(`SELECT bot_can_rj(${b}) c FROM rdb$database`))[0].C === 0, 'with 50 health it would rather walk');
    await db.exec(`UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(64)) WHERE id = ${pe}`);
    await db.exec(`UPDATE ents SET respawn_time = 0, health = 1 WHERE classname = 'bot' AND id <> ${b}`);
    await db.exec(`UPDATE ents SET nextthink = 0, health = 100 WHERE id = ${b}`);
    await db.exec(`DELETE FROM ents WHERE id = ${tgt}`);
  }
}

// joining and leaving mid-game: addbot at a skill, one of each; kick, and nothing is left pointing at it
{
  const absent = (await q("SELECT name FROM bot_defs d WHERE NOT EXISTS (SELECT 1 FROM ents e WHERE e.classname = 'bot' AND e.bot = d.name) ORDER BY name"))[0].NAME.trim();
  await db.exec(`EXECUTE PROCEDURE add_bot('${absent}', 4)`);
  await db.exec(`EXECUTE PROCEDURE add_bot('${absent}', 4)`);
  await db.exec("EXECUTE PROCEDURE add_bot('Nobody', 4)");
  const added = await q(`SELECT e.id, e.health, e.cluster, d.skill FROM ents e JOIN bot_defs d ON d.name = e.bot WHERE e.classname = 'bot' AND e.bot = '${absent}'`);
  const n = (await q('SELECT num_bots n FROM game'))[0].N;
  assert(added.length === 1 && added[0].HEALTH > 0 && added[0].CLUSTER !== null && added[0].SKILL === 4 && n === bots.length + 1,
    `${absent} joins mid-game at skill 4, once (${n} bots now; an unknown name is nothing)`);
  // something of it for the kick to clear: a rocket in flight, a bot after it, our view on it
  const id = added[0].ID;
  await db.exec(`EXECUTE PROCEDURE launch_missile(${id}, 'rocket', 'models/ammo/rocket/rocket.md3', 0, 0, 2000, 1, 0, 0, 900, 100, 100, 120, 0, 10)`);
  await db.exec(`UPDATE ents SET enemy_id = ${id} WHERE id = ${bots[0].ID}`);
  await db.exec(`UPDATE player SET follow_id = ${id} WHERE id = 1`);
  await db.exec(`EXECUTE PROCEDURE kick_bot('${absent}')`);
  const left = (await q(`SELECT (SELECT COUNT(*) FROM ents WHERE id = ${id} OR owner_id = ${id}) e, (SELECT COUNT(*) FROM ents WHERE enemy_id = ${id}) en,
                         (SELECT follow_id FROM player) f, (SELECT num_bots FROM game) n FROM rdb$database`))[0];
  const said = (await q('SELECT FIRST 3 msg FROM messages ORDER BY id DESC')).map((m) => m.MSG);
  assert(left.E === 0 && left.EN === 0 && left.F === null && left.N === bots.length && said.includes(`${absent} was kicked.`),
    `${absent} is kicked: gone with its rocket, nobody's enemy or view (${said.join(' / ')})`);
  await tic();
}

// the chat files are in, and a line comes out whole (variables filled, random strings drawn, no marks left)
{
  const n = (await q('SELECT (SELECT COUNT(*) FROM bot_chat) c, (SELECT COUNT(*) FROM bot_rnd) r, (SELECT COUNT(*) FROM bot_chatchar) k FROM rdb$database'))[0];
  assert(n.C > 500 && n.R > 1000 && n.K > 100, `the bots' chat files are loaded (${n.C} lines, ${n.R} random strings, ${n.K} characteristics)`);
  const bot = (await q("SELECT FIRST 1 id, bot FROM ents WHERE classname = 'bot' ORDER BY id"))[0];
  const lines = [];
  for (const type of ['game_enter', 'level_start', 'kill_insult', 'death_praise', 'random_misc', 'random_insult', 'level_end_victory', 'hit_nokill']) {
    for (let i = 0; i < 4; i++) {
      await db.exec(`EXECUTE PROCEDURE bot_say(${bot.ID}, '${type}', 'Visor', 'Grunt', NULL, 'Major', 'Arena Gate', 'Railgun')`);
      lines.push((await q('SELECT FIRST 1 msg FROM messages ORDER BY id DESC'))[0].MSG);
    }
  }
  const bad = lines.filter((l) => !l.startsWith(bot.BOT.trim() + ': ') || /[{}~^]/.test(l));
  assert(bad.length === 0, `${lines.length} lines said whole, e.g. "${lines[0]}" (bad: ${bad.slice(0, 2).join(' | ') || 'none'})`);
}
let chats = 0;
const talkers = new RegExp(`^(${bots.map((b) => b.BOT.trim()).join('|')}): `);
let lastMsg = 0;

// a minute of play: the bots keep fragging each other, nobody is stuck in the void
const padEdges = (await q('SELECT COUNT(*) n FROM wp_edges WHERE kind = 1'))[0].N;
let flew = 0;
let t0 = performance.now();
for (let i = 0; i < 600; i++) {
  await tic(2);
  if (i % 3 === 0) for (const m of await q(`SELECT id, msg FROM messages WHERE id > ${lastMsg} ORDER BY id`)) { lastMsg = m.ID; if (talkers.test(m.MSG)) { chats++; if (chats <= 3) console.log('chat', m.MSG); } }
  if (padEdges && i % 2 === 0) flew += (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND health > 0 AND vz > 450 AND BIN_AND(flags, 512) = 0"))[0].N;
}
console.log(`1200 tics in ${(performance.now() - t0).toFixed(0)} ms`);
assert(chats > 0, `the bots talked during the minute (${chats} lines)`);
if (padEdges >= 6) assert(flew > 0, `the bots took the jump pads (${padEdges} pad edges, airborne with upward speed ${flew} times)`);
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
