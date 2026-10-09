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

// a bot sees the player: put one in front of us, on a floor (on q3dm17 straight ahead may be the void)
const b = bots[0].ID;
const p = (await q(`SELECT x, y, z, yaw FROM ents WHERE id = ${pe}`))[0];
let spot = null;
for (const d of [200, 150, 100, 64]) {
  for (const turn of [0, 45, -45, 90, -90]) {
    const a = ((p.YAW + turn) * Math.PI) / 180, x = p.X + Math.cos(a) * d, y = p.Y + Math.sin(a) * d;
    const c = (await q(`SELECT point_contents(${x}, ${y}, ${p.Z}) here, point_contents(${x}, ${y}, ${p.Z - 32}) below FROM rdb$database`))[0];
    if (c.HERE === 0 && (c.BELOW & 65537) !== 0) { spot = [x, y]; break; }
  }
  if (spot) break;
}
spot ??= [p.X + Math.cos((p.YAW * Math.PI) / 180) * 200, p.Y + Math.sin((p.YAW * Math.PI) / 180) * 200];
await db.exec(`UPDATE ents SET x = ${spot[0]}, y = ${spot[1]}, z = ${p.Z}, vx = 0, vy = 0, vz = 0, enemy_id = NULL WHERE id = ${b}`);
await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
// (noticed at any tic: the fight that follows may kill it before the 70 are up)
let found = null;
for (let i = 0; i < 70; i++) {
  await tic();
  found ??= (await q(`SELECT enemy_id FROM ents WHERE id = ${b}`))[0].ENEMY_ID;
}
let s = (await q(`SELECT enemy_id, st, attack_finished, weapon FROM ents WHERE id = ${b}`))[0];
assert(found !== null, `the bot found an enemy (${found}; now ${s.ST.trim()})`);
const shots = (await q("SELECT COUNT(*) n FROM sound_events WHERE snd LIKE 'sound/weapons/%' AND ent_id <> " + pe))[0].N;
assert(shots > 0, `the bots fired (${shots} shots)`);

// a bot dies and respawns (alive for it: the fight above may have killed it already)
if ((await q(`SELECT deadflag FROM ents WHERE id = ${b}`))[0].DEADFLAG) await db.exec(`EXECUTE PROCEDURE bot_respawn(${b})`);
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

// the body queue (CopyToBodyQue, BodySink): a corpse waits for its owner to respawn, lies 5 s more, then sinks
// a unit every 100 ms and is gone 6.5 s after the respawn; 8 bodies at most
{
  const released = await q("SELECT id, nextthink - ltime wait FROM ents WHERE classname = 'corpse' AND think = 'body_sink'");
  const waiting = (await q("SELECT COUNT(*) n FROM ents c JOIN ents o ON o.id = c.body_of WHERE c.classname = 'corpse' AND (c.think IS NOT NULL OR o.deadflag = 0)"))[0].N;
  assert(released.length >= 1 && released.every((r) => Math.abs(r.WAIT - 5) < 1e-6) && waiting === 0,
    `a respawn leaves its body 5 s more (${released.length} released); a body whose owner is still dead waits`);
  const c = released[0]?.ID ?? -1;
  const z0 = (await q(`SELECT z FROM ents WHERE id = ${c}`))[0].Z;
  await db.exec(`UPDATE ents SET ltime = (SELECT now_() FROM rdb$database) - 5, nextthink = (SELECT now_() FROM rdb$database) WHERE id = ${c}`);
  for (let i = 0; i < 10; i++) await tic();
  const sunk = z0 - ((await q(`SELECT z FROM ents WHERE id = ${c}`))[0]?.Z ?? z0);
  await db.exec(`UPDATE ents SET ltime = (SELECT now_() FROM rdb$database) - 6.6 WHERE id = ${c}`);
  for (let i = 0; i < 3; i++) await tic();
  const gone = (await q(`SELECT COUNT(*) n FROM ents WHERE id = ${c}`))[0].N === 0;
  assert(sunk >= 4 && sunk <= 6 && gone, `half a second into its sinking the body is ${sunk} units down; 6.5 s after the respawn it is gone`);
  const made = [];
  for (let i = 0; i < 9; i++) {
    const id = (await q("SELECT id FROM spawn_ent('corpse', 0, 0, -9000)"))[0].ID;
    await db.exec(`EXECUTE PROCEDURE body_queue(${id}, ${pe})`);
    made.push(id);
  }
  const left = await q("SELECT id FROM ents WHERE classname = 'corpse' ORDER BY id");
  assert(left.length === 8 && !left.some((r) => r.ID === made[0]), `the queue holds 8 bodies, the oldest making room (${left.length})`);
  await db.exec(`DELETE FROM ents WHERE id IN (${made.join(',')})`);
}

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
  // we stand on a spawn point (the earlier play may have knocked us into q3dm17's void, god mode or not: the
  // trigger_hurt goes through it, and a dead player is no enemy to hunt)
  if ((await q(`SELECT deadflag FROM ents WHERE id = ${pe}`))[0].DEADFLAG || (await q(`SELECT health FROM ents WHERE id = ${pe}`))[0].HEALTH <= 0) await db.exec('EXECUTE PROCEDURE player_respawn');
  const home = (await q("SELECT FIRST 1 e.x, e.y, e.z FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY e.id"))[0];
  await db.exec(`UPDATE ents SET x = ${home.X}, y = ${home.Y}, z = ${home.Z + 9}, vx = 0, vy = 0, vz = 0 WHERE id = ${pe}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  await tic(2);
  const me = (await q(`SELECT x, y, z FROM ents WHERE id = ${pe}`))[0];
  const far = (await q(`SELECT FIRST 1 e.id, e.x, e.y, e.z FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY (e.x - ${me.X}) * (e.x - ${me.X}) + (e.y - ${me.Y}) * (e.y - ${me.Y}) DESC`))[0];
  // the other bots sit this one out, and what they fired goes (a grenade lying about moves the hunter off its spot)
  await db.exec("DELETE FROM ents WHERE classname IN ('rocket', 'grenade', 'plasma', 'bfg')");
  await db.exec(`UPDATE ents SET st = 'dead', deadflag = 1, health = 0, solid = 0, respawn_time = 1e9, enemy_id = NULL WHERE classname = 'bot' AND id <> ${b}`);
  // the hunter alive (it may have died in the fighting before: a dead one would respawn under us, its enemy forgotten)
  if ((await q(`SELECT deadflag FROM ents WHERE id = ${b}`))[0].DEADFLAG) await db.exec(`EXECUTE PROCEDURE bot_respawn(${b})`);
  // the hunter holds its fire (a rocket would knock us off the ledge). It carries the quad: BotWantsToChase
  // would not have it chase with the machinegun alone, hurt, or after an enemy 200 above (q3dm17's
  // spawns), and the quad outweighs all of them (BotAggression 70)
  await db.exec(`UPDATE ents SET x = ${far.X}, y = ${far.Y}, z = ${far.Z}, vx = 0, vy = 0, vz = 0, enemy_id = ${pe}, search_time = 1e9, goal_id = NULL, health = 100, st = 'run', attack_finished = 1e9, quad_finished = 1e9 WHERE id = ${b}`);
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
  await db.exec(`UPDATE ents SET respawn_time = 0, health = 1, quad_finished = 0 WHERE classname = 'bot' AND id <> ${b}`);
  await db.exec(`UPDATE ents SET quad_finished = 0 WHERE id = ${b}`);
}

// BotAggression: keen with a good gun and its health, not with the machinegun alone, hurt, or the enemy far above;
// the quad makes up for a poor gun. And a bot keeps 160 units off a grenade (BotCheckSnapshot's avoid spot)
{
  const set = (sql) => db.exec(`UPDATE ents SET ${sql} WHERE id = ${b}`);
  const aggr = async () => (await q(`SELECT bot_aggression(${b}, ${pe}) a FROM rdb$database`))[0].A;
  const me = (await q(`SELECT z FROM ents WHERE id = ${pe}`))[0];
  await set(`health = 100, armor = 0, weapons = 3, quad_finished = 0, z = ${me.Z}`);
  const mg = await aggr();
  await set('weapons = 3 + 64'); const rail = await aggr();
  await set('health = 70'); const hurt = await aggr();
  await set('armor = 50'); const armoured = await aggr();
  await set('health = 50'); const low = await aggr();
  await set(`weapons = 3, health = 100, quad_finished = 1e9, weapon = 2`); const quad = await aggr();
  assert(mg === 0 && rail === 95 && hurt === 0 && armoured === 95 && low === 0 && quad === 70,
    `aggression: machinegun ${mg}, railgun ${rail}, at 70 health ${hurt} (with 50 armour ${armoured}), at 50 ${low}, quad ${quad}`);
  await set('quad_finished = 0, health = 100, armor = 0');
  // the retreat's goal is an item in sight; a health item first when hurt (the bot stands on one)
  const hi = (await q("SELECT FIRST 1 e.x, e.y, e.z FROM ents e JOIN item_defs d ON d.cls = e.item WHERE d.kind = 'H' AND e.solid = 1 ORDER BY e.id"))[0];
  await set(`health = 30, x = ${hi.X}, y = ${hi.Y}, z = ${hi.Z}`);
  const goal = (await q(`SELECT i.kind FROM ents g JOIN item_defs i ON i.cls = g.item WHERE g.id = bot_retreat_goal(${b})`))[0];
  assert(goal?.KIND.trim() === 'H', `hurt, a retreating bot runs for the health item it sees (${goal?.KIND})`);
  await set('health = 100');
  // a grenade lying 60 units off: the bot steps away from it (on a spawn point with room on the far side: the
  // bots never step off a ledge)
  let away = null, none = null;
  for (const sp of await q("SELECT FIRST 6 x, y, z FROM ents WHERE classname = 'info_player_deathmatch' ORDER BY id")) {
    for (const [gx, gy] of [[60, 0], [-60, 0], [0, 60], [0, -60]]) {
      await set(`x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 1}, vx = 0, vy = 0, vz = 0, flags = BIN_OR(flags, 512)`);
      await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
      const g = (await q(`SELECT id FROM spawn_ent('grenade', ${sp.X + gx}, ${sp.Y + gy}, ${sp.Z + 1})`))[0].ID;
      const stepped = (await q(`SELECT bot_avoid_grenade(${b}, 20) s FROM rdb$database`))[0].S;
      const p = (await q(`SELECT x, y FROM ents WHERE id = ${b}`))[0];
      await db.exec(`DELETE FROM ents WHERE id = ${g}`);
      if (stepped === 1) { away = Math.hypot(p.X - sp.X - gx, p.Y - sp.Y - gy) - 60; none = (await q(`SELECT bot_avoid_grenade(${b}, 20) s FROM rdb$database`))[0].S; break; }
    }
    if (away !== null) break;
  }
  assert(away > 5 && none === 0, `a grenade 60 units off: the bot steps ${away?.toFixed(0)} further from it; without it, nothing`);
}

// the powerups on a bot: it takes them all but flight; regeneration counts its health up and health over the
// maximum counts down (ClientTimerActions); the battle suit halves damage and ignores splash; an invisible bot
// that is not shooting goes unnoticed (BotFindEnemy)
{
  const bset = (id, sql) => db.exec(`UPDATE ents SET ${sql} WHERE id = ${id}`);
  const b2 = bots[1].ID;
  for (const id of [b, b2]) if ((await q(`SELECT deadflag FROM ents WHERE id = ${id}`))[0].DEADFLAG) await db.exec(`EXECUTE PROCEDURE bot_respawn(${id})`);
  const me = (await q(`SELECT x, y, z FROM ents WHERE id = ${pe}`))[0];
  // a spot away from us with room ahead: a spawn point, the other bot 100 units along its facing
  let spot = null;
  for (const sp of await q("SELECT x, y, z, yaw FROM ents WHERE classname = 'info_player_deathmatch' ORDER BY id")) {
    if (Math.hypot(sp.X - me.X, sp.Y - me.Y) < 400) continue;
    const a = (sp.YAW * Math.PI) / 180;
    await bset(b, `x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, yaw = ${sp.YAW}, vx = 0, vy = 0, vz = 0, health = 100, armor = 0, invis_finished = 0, attack_finished = 1e9`);
    await bset(b2, `x = ${sp.X + Math.cos(a) * 100}, y = ${sp.Y + Math.sin(a) * 100}, z = ${sp.Z + 9}, vx = 0, vy = 0, vz = 0, health = 100, invis_finished = 0, attack_finished = 0`);
    for (const id of [b, b2]) await db.exec(`EXECUTE PROCEDURE link_ent(${id})`);
    if ((await q(`SELECT visible(${b}, ${b2}) v, bot_find_target(${b}) t FROM rdb$database`))[0].T === b2) { spot = sp; break; }
  }
  assert(spot, 'a bot notices another 100 units in front of it');
  await bset(b2, 'invis_finished = 1e9');
  const hidden = (await q(`SELECT bot_find_target(${b}) t FROM rdb$database`))[0].T;
  await bset(b2, 'attack_finished = 1e9');
  const shooting = (await q(`SELECT bot_find_target(${b}) t FROM rdb$database`))[0].T;
  assert(hidden !== b2 && shooting === b2, `an invisible bot goes unnoticed (${hidden}) until it shoots (${shooting})`);
  await bset(b2, 'invis_finished = 0, attack_finished = 0');

  // accuracy (FireWeapon's accuracy_shots, LogAccuracyHit's accuracy_hits): the bot shoots the other, both
  // holding still; a bullet that hits, one that misses, a shotgun blast (one hit for the pattern), a gauntlet
  // swing at nothing (no shot), a rocket in the face (its splash not counted again)
  {
    const pos = (await q(`SELECT e.x, e.y, e.z, o.x ox, o.y oy, o.z oz FROM ents e CROSS JOIN ents o WHERE e.id = ${b} AND o.id = ${b2}`))[0];
    await db.exec(`UPDATE ents SET nextthink = 1e9, health = 1000 WHERE id IN (${b}, ${b2})`);
    await bset(b, 'acc_shots = 0, acc_hits = 0');
    // (the target put back each time: the shots knock it away)
    const fire = async (w, sign = 1) => {
      await db.exec(`UPDATE ents SET x = ${pos.OX}, y = ${pos.OY}, z = ${pos.OZ}, vx = 0, vy = 0, vz = 0 WHERE id = ${b2}`);
      await db.exec(`EXECUTE PROCEDURE link_ent(${b2})`);
      return fireAt(w, sign);
    };
    const fireAt = (w, sign = 1) => db.exec(`EXECUTE PROCEDURE fire_weapon(${b}, ${w}, ${pos.X}, ${pos.Y}, ${pos.Z + 10}, ${sign * (pos.OX - pos.X)}, ${sign * (pos.OY - pos.Y)}, 0, 1)`);
    const acc = async () => { const r = (await q(`SELECT acc_shots s, acc_hits h FROM ents WHERE id = ${b}`))[0]; return `${r.S}/${r.H}`; };
    const seen = [];
    await fire(2); seen.push(await acc());
    await fire(2, -1); seen.push(await acc());
    await fire(4); seen.push(await acc());
    await fire(1, -1); seen.push(await acc());
    await fire(16);
    for (let i = 0; i < 10 && (await q("SELECT COUNT(*) n FROM ents WHERE classname = 'rocket'"))[0].N > 0; i++) await tic();
    seen.push(await acc());
    assert(seen.join(' ') === '1/1 2/1 3/2 3/2 4/3', `accuracy shots/hits: a hit, a miss, a shotgun blast, a gauntlet swing, a rocket (${seen.join(' ')})`);
    await db.exec(`UPDATE ents SET nextthink = (SELECT now_() FROM rdb$database), health = 100 WHERE id IN (${b}, ${b2})`);
  }

  // Touch_Item: a haste is taken, a flight is not
  const touch = async (cls) => {
    const g = (await q(`SELECT id FROM spawn_ent('item', ${spot.X}, ${spot.Y}, ${spot.Z})`))[0].ID;
    await db.exec(`UPDATE ents SET item = '${cls}', solid = 1 WHERE id = ${g}`);
    await db.exec(`EXECUTE PROCEDURE bot_item_touch(${g}, ${b})`);
    const taken = (await q(`SELECT solid FROM ents WHERE id = ${g}`))[0].SOLID === 0;
    await db.exec(`DELETE FROM ents WHERE id = ${g}`);
    return taken;
  };
  const haste = await touch('item_haste'), hasteLeft = (await q(`SELECT haste_finished - (SELECT now_() FROM rdb$database) h FROM ents WHERE id = ${b}`))[0].H;
  const flight = await touch('item_flight');
  assert(haste && hasteLeft > 25 && !flight, `a bot takes the haste (${hasteLeft.toFixed(0)} s) and leaves the flight`);

  // a second of regeneration: 15 health; and without it, a point off health over the maximum
  const think = async (sql) => { await bset(b, `${sql}, health_tick = 0, attack_finished = 1e9`); await db.exec(`EXECUTE PROCEDURE bot_think(${b})`); return (await q(`SELECT health FROM ents WHERE id = ${b}`))[0].HEALTH; };
  const regen = await think('health = 50, regen_finished = 1e9');
  const decay = await think('health = 150, regen_finished = 0');
  assert(regen === 65 && decay === 149, `regeneration: 50 health to ${regen} in a second; 150 counts down to ${decay}`);

  // the battle suit: no splash, half the rest
  await bset(b, 'health = 100, armor = 0, enviro_finished = 1e9');
  await db.exec(`EXECUTE PROCEDURE t_damage(${b}, ${pe}, ${pe}, 40, 0, 1, 7)`);
  const afterSplash = (await q(`SELECT health FROM ents WHERE id = ${b}`))[0].HEALTH;
  await db.exec(`EXECUTE PROCEDURE t_damage(${b}, ${pe}, ${pe}, 40, 0, 0, 7)`);
  const afterHit = (await q(`SELECT health FROM ents WHERE id = ${b}`))[0].HEALTH;
  assert(afterSplash === 100 && afterHit === 80, `the battle suit: splash ignored (${afterSplash}), a hit of 40 takes ${100 - afterHit}`);
  await bset(b, 'health = 100, enviro_finished = 0, haste_finished = 0, regen_finished = 0, attack_finished = 0');
}

// the long-term goal (BotChooseLTGItem) by the bot's item weights (its *_i.c over fw_items.c): armour and health
// weigh by what it has, a gun by whether it holds it; and an item it took is timed (the avoid goal): a goal
// again only when the trip is longer than the wait
{
  const set = (sql) => db.exec(`UPDATE ents SET ${sql} WHERE id = ${b}`);
  const w = async (cls) => (await q(`SELECT bot_item_weight(${b}, '${cls}') w FROM rdb$database`))[0].W;
  await set('health = 30, armor = 0, weapons = 3'); const hurt = await w('item_health'), bare = await w('item_armor_body'), noRl = await w('weapon_rocketlauncher');
  await set('health = 100, armor = 150, weapons = 3 + 16'); const fine = await w('item_health'), clad = await w('item_armor_body'), rl = await w('weapon_rocketlauncher');
  const rows = (await q(`SELECT COUNT(*) n FROM bot_iw WHERE bot = (SELECT bot FROM ents WHERE id = ${b})`))[0].N;
  assert(rows > 100 && hurt > fine && bare > clad && noRl > rl && rl <= 1,
    `item weights from the botfiles (${rows} rows): health hurt ${hurt} / fine ${fine}, red armour bare ${bare} / at 150 ${clad}, rocket launcher ${noRl} / held ${rl}`);
  // the timing, on a quad 48 units off, every other item gone for the while (and not known to come back)
  const me = (await q(`SELECT x, y, z FROM ents WHERE id = ${b}`))[0];
  const gone = (await q("SELECT id FROM ents WHERE classname = 'item' AND solid = 1")).map((r) => r.ID);
  if (gone.length) await db.exec(`UPDATE ents SET solid = 0 WHERE id IN (${gone.join(',')})`);
  await db.exec(`DELETE FROM bot_avoid WHERE ent_id = ${b}`);
  const quad = (await q(`SELECT id FROM spawn_ent('item', ${me.X + 48}, ${me.Y}, ${me.Z})`))[0].ID;
  await db.exec(`UPDATE ents SET item = 'item_quad', solid = 1 WHERE id = ${quad}`);
  const ltg = async () => (await q(`SELECT bot_choose_ltg(${b}) g FROM rdb$database`))[0].G;
  const present = await ltg();
  await db.exec(`EXECUTE PROCEDURE bot_item_touch(${quad}, ${b})`);
  const avoid = (await q(`SELECT avoid_until - (SELECT now_() FROM rdb$database) a FROM bot_avoid WHERE ent_id = ${b} AND item_id = ${quad}`))[0]?.A;
  const taken = await ltg();
  await db.exec(`UPDATE bot_avoid SET avoid_until = (SELECT now_() FROM rdb$database) + 0.1 WHERE ent_id = ${b} AND item_id = ${quad}`);
  const timed = await ltg();
  await db.exec(`DELETE FROM bot_avoid WHERE ent_id = ${b} AND item_id = ${quad}`);
  const unknown = await ltg();
  assert(present === quad && Math.abs(avoid - 120) < 1 && taken === null && timed === quad && unknown === null,
    `a quad 48 off: the goal (${present === quad}); taken, avoided for its 120 s (${avoid?.toFixed(0)}) and no goal (${taken}); back in 0.1 s, a goal again (${timed === quad}); gone and not its own, nothing (${unknown})`);
  await db.exec(`DELETE FROM ents WHERE id = ${quad}`);
  if (gone.length) await db.exec(`UPDATE ents SET solid = 1 WHERE id IN (${gone.join(',')})`);
  await set('health = 100, armor = 0, weapons = 3, quad_finished = 0');
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

// a jump across a gap (TRAVEL_JUMP, BotTravel_Jump): from a jump edge's start, with a target on its end, the
// widest level gap the map has; the bot runs onto the start and jumps, in the air from the edge to the landing
{
  const edges = await q('SELECT e.a, e.b, a.x ax, a.y ay, a.z az, b.x bx, b.y by_, b.z bz FROM wp_edges e JOIN waypoints a ON a.id = e.a JOIN waypoints b ON b.id = e.b WHERE e.kind = 5');
  // (a level one first; q3dm1's are all across and down a ledge)
  const level = (u) => (u.BZ > u.AZ - 48 ? 0 : 1);
  edges.sort((u, v) => level(u) - level(v) || Math.hypot(v.BX - v.AX, v.BY_ - v.AY) - Math.hypot(u.BX - u.AX, u.BY_ - u.AY));
  if (!edges.length) console.log('(no jump across a gap here)');
  else {
    const e = edges[0];
    await db.exec(`UPDATE ents SET st = 'dead', deadflag = 1, health = 0, solid = 0, respawn_time = 1e9, enemy_id = NULL WHERE classname = 'bot' AND id <> ${b}`);
    await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE id = ${pe}`);   // notarget: nothing to fight
    const tgt = (await q(`SELECT id FROM spawn_ent('info_notnull', ${e.BX}, ${e.BY_}, ${e.BZ})`))[0].ID;
    await db.exec(`UPDATE ents SET x = ${e.AX}, y = ${e.AY}, z = ${e.AZ - 1}, vx = 0, vy = 0, vz = 0, health = 100, nextthink = 1e9, flags = BIN_OR(flags, 512), enemy_id = NULL, st = 'run' WHERE id = ${b}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
    await db.exec(`DELETE FROM bot_routes WHERE ent_id = ${b}`);
    let arrived = null, air = 0;
    for (let i = 0; i < 60 && arrived === null; i++) {
      const f = (await q(`SELECT flags FROM ents WHERE id = ${b}`))[0].FLAGS;
      if (!(f & 512)) air++;
      else if (i % 2 === 0) await q(`SELECT moved FROM bot_follow_route(${b}, ${tgt}, 32)`);
      await tic();
      const r = (await q(`SELECT x, y, z, flags FROM ents WHERE id = ${b}`))[0];
      if ((r.FLAGS & 512) && Math.hypot(r.X - e.BX, r.Y - e.BY_) < 48 && Math.abs(r.Z - (e.BZ - 1)) < 30) arrived = i;
    }
    const d = Math.hypot(e.BX - e.AX, e.BY_ - e.AY);
    assert(arrived !== null && air >= 5, `a bot jumps a ${d.toFixed(0)}-unit gap (${(e.BZ - e.AZ).toFixed(0)} up): ${air} tics in the air, across in ${arrived}`);
    await db.exec(`UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(64)) WHERE id = ${pe}`);
    await db.exec(`UPDATE ents SET respawn_time = 0, health = 1 WHERE classname = 'bot' AND id <> ${b}`);
    await db.exec(`UPDATE ents SET nextthink = 0 WHERE id = ${b}`);
    await db.exec(`DELETE FROM ents WHERE id = ${tgt}`);
  }
}

// a pad that throws straight up, steered in the air to a place it would not land on (AAS_Reachability_JumpPad,
// BotFinishTravel_JumpPad): on q3dm17 the centre pad to the red armour's ledge, the farthest such edge
{
  const edges = await q('SELECT e.a, e.b, a.x ax, a.y ay, a.z az, b.x bx, b.y by_, b.z bz FROM wp_edges e JOIN waypoints a ON a.id = e.a JOIN waypoints b ON b.id = e.b WHERE e.kind = 6');
  edges.sort((u, v) => Math.hypot(v.BX - v.AX, v.BY_ - v.AY) - Math.hypot(u.BX - u.AX, u.BY_ - u.AY));
  if (!edges.length) console.log('(no pad here that wants steering)');
  else {
    const e = edges[0];
    await db.exec(`UPDATE ents SET st = 'dead', deadflag = 1, health = 0, solid = 0, respawn_time = 1e9, enemy_id = NULL WHERE classname = 'bot' AND id <> ${b}`);
    await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 64) WHERE id = ${pe}`);   // notarget: nothing to fight
    const tgt = (await q(`SELECT id FROM spawn_ent('info_notnull', ${e.BX}, ${e.BY_}, ${e.BZ})`))[0].ID;
    await db.exec(`UPDATE ents SET x = ${e.AX}, y = ${e.AY}, z = ${e.AZ - 1}, vx = 0, vy = 0, vz = 0, health = 100, nextthink = 1e9, flags = BIN_OR(flags, 512), enemy_id = NULL, st = 'run' WHERE id = ${b}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
    await db.exec(`DELETE FROM bot_routes WHERE ent_id = ${b}`);
    let arrived = null, top = -1e9;
    for (let i = 0; i < 100 && arrived === null; i++) {
      if (i % 2 === 0 && ((await q(`SELECT flags FROM ents WHERE id = ${b}`))[0].FLAGS & 512)) {
        await q(`SELECT moved FROM bot_follow_route(${b}, ${tgt}, 32)`);
        await db.exec(`EXECUTE PROCEDURE touch_triggers(${b})`);   // (bot_think's, which launches it off the pad)
      }
      await tic();
      const r = (await q(`SELECT x, y, z, flags FROM ents WHERE id = ${b}`))[0];
      top = Math.max(top, r.Z);
      if ((r.FLAGS & 512) && Math.hypot(r.X - e.BX, r.Y - e.BY_) < 48 && Math.abs(r.Z - (e.BZ - 1)) < 30) arrived = i;
    }
    const d = Math.hypot(e.BX - e.AX, e.BY_ - e.AY);
    assert(arrived !== null && top - e.AZ > 150, `a bot steers a pad's throw ${d.toFixed(0)} across to a floor ${(e.BZ - e.AZ).toFixed(0)} up (up ${(top - e.AZ).toFixed(0)}, there in ${arrived} tics)`);
    await db.exec(`UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(64)) WHERE id = ${pe}`);
    await db.exec(`UPDATE ents SET respawn_time = 0, health = 1 WHERE classname = 'bot' AND id <> ${b}`);
    await db.exec(`UPDATE ents SET nextthink = 0 WHERE id = ${b}`);
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
