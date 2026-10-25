// sql-smoke.mjs – run the game's SQL against the real Firebird WASM engine
// in Node: load the PK3 and a map, play some tics, render frames, assert.
//
//   PAK=path/to/pak0.pk3 node scripts/sql-smoke.mjs [map]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { Pk3 } from '../src/pk3.js';
import { createSchema, loadResources, loadMap, SQL_FILES } from '../src/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pakPath = process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3');
const mapName = process.argv[2] ?? 'q3dm1';
const sql = Object.fromEntries(SQL_FILES.map((n) => [n, fs.readFileSync(path.join(root, `sql/${n}.sql`), 'utf8')]));

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; } else console.log(`ok   ${msg}`);
}
const t = () => performance.now();
const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });

let t0 = t();
await createSchema(db, sql);
console.log(`schema        ${(t() - t0).toFixed(0)} ms`);

const pak = new Pk3(fs.readFileSync(pakPath).buffer);
t0 = t();
const res = await loadResources(db, pak);
console.log(`resources     ${(t() - t0).toFixed(0)} ms (${res.models.size} models, ${res.players.size} player models)`);

t0 = t();
const bsp = await loadMap(db, pak, res, mapName, { skill: 2, bots: 3 });
console.log(`map ${mapName}     ${(t() - t0).toFixed(0)} ms`);

const counts = (await db.query(
  `SELECT (SELECT COUNT(*) FROM faces) f, (SELECT COUNT(*) FROM face_verts) fv, (SELECT COUNT(*) FROM leaves) l, (SELECT COUNT(*) FROM brushes) b,
          (SELECT COUNT(*) FROM nodes) n, (SELECT COUNT(*) FROM ents) e, (SELECT COUNT(*) FROM ents WHERE classname = 'bot') bots,
          (SELECT COUNT(*) FROM ents WHERE classname = 'item') items, (SELECT COUNT(*) FROM ents WHERE cluster IS NULL AND solid IN (2, 3)) nolink
     FROM rdb$database`)).rows[0];
console.log(counts);
assert(counts.F > 0 && counts.L > 0 && counts.B > 0, 'map geometry loaded');
assert(counts.BOTS === 3, `bots spawned (${counts.BOTS})`);
assert(counts.ITEMS > 0, `items spawned (${counts.ITEMS})`);

// the bots must not kill us while we test: god mode
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
const tic = (args) => db.query('SELECT * FROM q3_tic(?, ?, ?, ?, ?, ?, ?, ?, ?)', args).then((r) => r.rows[0]);
let s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
console.log('start', { x: s.PX, y: s.PY, z: s.PZ, yaw: s.YAW, leaf: s.LEAF, cluster: s.CLUSTER, health: s.HEALTH, msg: s.LEVEL_MSG, weapon: s.WEAPON, bullets: s.BULLETS });
assert(s.CLUSTER >= 0, 'player stands in a leaf with a cluster');
assert(s.HEALTH === 125 && s.WEAPON === 2 && s.BULLETS === 100, 'the starting inventory: 125 health, a machinegun with 100 bullets');
const start = { x: s.PX, y: s.PY, z: s.PZ };

// settle, then walk
for (let i = 0; i < 5; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
const settled = { x: s.PX, y: s.PY, z: s.PZ };
assert(Math.abs(settled.z - start.z) < 40, `player settled on the floor (dz ${(settled.z - start.z).toFixed(1)})`);
t0 = t();
for (let i = 0; i < 20; i++) s = await tic([1, 1, 0, 0, 0, 0, 0, 1, 0]);
console.log(`20 tics walking ${(t() - t0).toFixed(0)} ms`, { x: s.PX, y: s.PY, z: s.PZ, onground: s.ONGROUND, speed: s.MOVE_SPEED });
const moved = Math.hypot(s.PX - settled.x, s.PY - settled.y);
assert(moved > 150, `player ran forward (${moved.toFixed(1)} units in a second)`);
for (let i = 0; i < 10 && s.ONGROUND !== 1; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);   // the last step may have been off a stair
assert(s.ONGROUND === 1, 'player is on the ground after walking');

// crouch (PM_CheckDuck): the box and the eye go down, the walk slows to a quarter, and we stay down
// while something blocks standing up. Back the way we came, which is clear for 150 units
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");   // no rocket's knock in the measurement
  await tic([1, 0, 0, 180, 0, 0, 0, 1, 0]);
  for (let i = 0; i < 3; i++) s = await tic([1, 0, 0, 0, 0, 0, -1, 1, 0]);
  // (the eye's height in the tic row also carries the stair smoothing, so the table's offset is what we check)
  const box = (await db.query(`SELECT e.maxz, e.viewheight, p.view_ofs FROM ents e JOIN player p ON p.ent_id = e.id WHERE e.id = ${pe}`)).rows[0];
  assert(s.DUCKED === 1 && box.MAXZ === 16 && box.VIEW_OFS === 12 && box.VIEWHEIGHT === 12, `crouching: the box 16 high, the eye 12 above the origin instead of 26 (${box.VIEW_OFS})`);
  // (the speed on the floor: from some spawn points the way back ends at a ledge, and crouched in the
  // air there is no quarter cap)
  let crept = 0, grounded = 0;
  for (let i = 0; i < 20; i++) {
    const a = s;
    s = await tic([1, 1, 0, 0, 0, 0, -1, 1, 0]);
    if (i >= 4 && a.ONGROUND === 1 && s.ONGROUND === 1) { crept += Math.hypot(s.PX - a.PX, s.PY - a.PY); grounded++; }
  }
  crept = grounded ? crept / (grounded * 0.05) : 0;
  assert(grounded >= 5 && crept > 40 && crept < 100, `crouch-walking is a quarter of the run (${crept.toFixed(1)} units a second on the floor)`);
  // a bot standing on our head: no room to stand up
  const b = (await db.query("SELECT FIRST 1 id FROM ents WHERE classname = 'bot' ORDER BY id")).rows[0].ID;
  const keep = (await db.query(`SELECT x, y, z FROM ents WHERE id = ${b}`)).rows[0];
  await db.exec(`UPDATE ents SET x = ${s.PX}, y = ${s.PY}, z = ${s.PZ + 41}, vx = 0, vy = 0, vz = 0, nextthink = 1e9 WHERE id = ${b}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  for (let i = 0; i < 3; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.DUCKED === 1, 'no room above: we stay crouched with the key released');
  await db.exec(`UPDATE ents SET x = ${keep.X}, y = ${keep.Y}, z = ${keep.Z}, nextthink = 0 WHERE id = ${b}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const stood = (await db.query(`SELECT e.maxz, p.view_ofs FROM ents e JOIN player p ON p.ent_id = e.id WHERE e.id = ${pe}`)).rows[0];
  assert(s.DUCKED === 0 && stood.MAXZ === 32 && stood.VIEW_OFS === 26, 'room again: we stand up, the box 32 high, the eye back at 26');
  await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot' AND nextthink > 1e8");
  await tic([1, 0, 0, 180, 0, 0, 0, 1, 0]);
}

// turn around and walk into whatever is behind: we must never be inside a wall
await tic([1, 0, 0, 180, 0, 0, 0, 1, 0]);
for (let i = 0; i < 60; i++) s = await tic([1, 1, 0, 0, 0, 0, 0, 1, 0]);
const c = (await db.query(`SELECT point_contents(${s.PX}, ${s.PY}, ${s.PZ}) c FROM rdb$database`)).rows[0].C;
assert((c & 1) === 0, `player is not inside a wall after walking into things (contents ${c})`);

// back to a spawn point (on q3dm17 the walk ends in the void), then jump
// (the bots held for it: the spawn point is picked away from them, but one may walk onto it, or over us)
await db.exec('EXECUTE PROCEDURE player_respawn');
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot' AND deadflag = 0");
for (let i = 0; i < 10 || (i < 60 && s.ONGROUND !== 1); i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
const zBefore = s.PZ;
s = await tic([1, 0, 0, 0, 0, 0, 1, 1, 0]);
let peak = s.PZ;
for (let i = 0; i < 12; i++) { s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]); peak = Math.max(peak, s.PZ); }
await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot' AND nextthink > 1e8");
assert(peak - zBefore > 20, `jumping gained height (${(peak - zBefore).toFixed(1)} units, from ${s.PX.toFixed(0)} ${s.PY.toFixed(0)} ${zBefore.toFixed(0)})`);
for (let i = 0; i < 60 && s.ONGROUND !== 1; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
assert(s.ONGROUND === 1, 'landed again');

// fire the machinegun: a sound and a bullet somewhere
t0 = t();
s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
console.log(`fire            ${(t() - t0).toFixed(0)} ms`);
assert(s.BULLETS === 99, `firing used a bullet (${s.BULLETS})`);
const fired = (await db.query("SELECT COUNT(*) n FROM sound_events WHERE snd LIKE 'sound/weapons/machinegun/machgf%'")).rows[0].N;
assert(fired > 0, 'firing queued the machinegun sound');
// and told the browser to throw a shell out of the player's side (CG_MachineGunEjectBrass)
// (the bots may be firing too: the player's is this tic's nearest the player)
const brass = (await db.query(`SELECT FIRST 1 f.x, f.y, f.z, f.x2, f.n, e.x ex, e.yaw FROM fx_events f, ents e, game g
  WHERE f.kind = 17 AND f.tic = g.tic AND e.id = (SELECT ent_id FROM player) ORDER BY (f.x - e.x) * (f.x - e.x) + (f.y - e.y) * (f.y - e.y)`)).rows[0];
assert(brass && brass.N === 2 && Math.abs(brass.X2 - brass.YAW) < 1e-6, `a machinegun shot ejects brass, with the shooter's yaw (${brass ? brass.X2.toFixed(0) : 'none'})`);
// CG_MissileHitWall: a machinegun bullet into the floor ricochets (ric1-3), a shotgun blast does not
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  const [p] = (await db.query(`SELECT x, y, z FROM ents WHERE id = ${pe}`)).rows;
  const ric = async () => (await db.query("SELECT COUNT(*) n FROM sound_events WHERE snd STARTING WITH 'sound/weapons/machinegun/ric'")).rows[0].N;
  const r0 = await ric();
  await db.exec(`EXECUTE PROCEDURE fire_bullets(${pe}, 11, ${p.X}, ${p.Y}, ${p.Z}, 0, 0, -1, 700, 10, 3)`);
  const r1 = await ric();
  await db.exec(`EXECUTE PROCEDURE fire_bullets(${pe}, 1, ${p.X}, ${p.Y}, ${p.Z}, 0, 0, -1, 0, 7, 2)`);
  const r2 = await ric();
  assert(r1 === r0 && r2 === r0 + 1, `a bullet into the floor ricochets (${r2 - r1}), the shotgun's pellets do not (${r1 - r0})`);
}

// PM_FootstepForSurface: a step on an ordinary floor, the clank on a metalsteps one, nothing on nosteps (the
// floor's sides under us made metal, then silent, and put back)
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  const [me] = (await db.query(`SELECT z + minz fz FROM ents WHERE id = ${pe}`)).rows;
  const ids = (await db.query(`SELECT id FROM brushsides WHERE nz > 0.99 AND ABS(dist / nz - ${me.FZ}) < 0.5 AND BIN_AND(flags, 4096 + 8192) = 0`)).rows.map((r) => r.ID);
  const step = async () => (await db.query(`SELECT footstep_sound(${pe}) s FROM rdb$database`)).rows[0].S;
  const plain = await step();
  if (ids.length) {
    await db.exec(`UPDATE brushsides SET flags = flags + 4096 WHERE id IN (${ids.join(',')})`);
    const metal = await step();
    await db.exec(`UPDATE brushsides SET flags = flags - 4096 + 8192 WHERE id IN (${ids.join(',')})`);
    const none = await step();
    await db.exec(`UPDATE brushsides SET flags = flags - 8192 WHERE id IN (${ids.join(',')})`);
    assert(/footsteps\/step[1-4]\.wav$/.test(plain) && /footsteps\/clank[1-4]\.wav$/.test(metal) && none === null && /footsteps\/step/.test(await step()),
      `footsteps by the floor: ${plain}, on metal ${metal}, on nosteps ${none}`);
  } else console.log(`(no floor side found under the player: the footstep surfaces skipped; plain ${plain})`);
}

// EF_FIRING: set while the trigger is held with ammunition, for the gun's firing sound; not without ammunition
{
  const held = s.WEAPON_SOUND;
  const up = (await tic([1, 0, 0, 0, 0, 0, 0, 1, 0])).WEAPON_SOUND;
  await db.exec('UPDATE player SET bullets = 0 WHERE id = 1');
  const dry = (await tic([1, 0, 0, 0, 0, 1, 0, 1, 0])).WEAPON_SOUND;
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  await db.exec('UPDATE player SET bullets = 99 WHERE id = 1');
  assert(held === 1 && up === 0 && dry === 0, `the firing flag: held ${held}, released ${up}, held with no ammunition ${dry}`);
  // a bot's gun is heard from it: a railgun hums (CG_AddPlayerWeapon's readySound)
  const [bot] = (await db.query("SELECT FIRST 1 id FROM ents WHERE classname = 'bot' AND health > 0 ORDER BY id")).rows;
  if (bot) {
    const w0 = (await db.query(`SELECT weapon w, weapons ws FROM ents WHERE id = ${bot.ID}`)).rows[0];
    await db.exec(`UPDATE ents SET weapon = 64, weapons = BIN_OR(weapons, 64) WHERE id = ${bot.ID}`);
    const hum = (await db.query('SELECT * FROM frame_all(0, 2147483647, 2147483647, 0)', [], { rowMode: 'array' })).rows.find((r) => r[0] === 12 && r[1] === bot.ID);
    await db.exec(`UPDATE ents SET weapon = 2 WHERE id = ${bot.ID}`);
    const mg = (await db.query('SELECT * FROM frame_all(0, 2147483647, 2147483647, 0)', [], { rowMode: 'array' })).rows.find((r) => r[0] === 12 && r[1] === bot.ID);
    await db.exec(`UPDATE ents SET weapon = ${w0.W}, weapons = ${w0.WS} WHERE id = ${bot.ID}`);
    assert(hum?.[15] === 'sound/weapons/railgun/rg_hum.wav' && !mg, `a bot's railgun hums from it (${hum?.[15] ?? 'silent'}), its machinegun is silent (${mg ? mg[15] : 'silent'})`);
  }
}

// the frame
for (let i = 0; i < 3; i++) {
  t0 = t();
  const faces = await db.query('SELECT * FROM frame_faces_fast', [], { rowMode: 'array' });
  const t1 = t();
  const ents = await db.query('SELECT * FROM frame_ents', [], { rowMode: 'array' });
  const t2 = t();
  const all = await db.query('SELECT * FROM frame_all(0, 0, 0, 1)', [], { rowMode: 'array' });
  const t3 = t();
  const full = await db.query('SELECT * FROM frame_faces', [], { rowMode: 'array' });
  const t4 = t();
  console.log(`frame ${i}: ${faces.rows.length} faces in ${(t1 - t0).toFixed(0)} ms, ${ents.rows.length} ents in ${(t2 - t1).toFixed(0)} ms, frame_all ${all.rows.length} rows in ${(t3 - t2).toFixed(0)} ms, ${full.rows.length} vertex rows in ${(t4 - t3).toFixed(0)} ms`);
  if (i === 0) assert(faces.rows.length > 20, `the frame has faces (${faces.rows.length})`);
  await tic([1, 0, 0, 45, 0, 0, 0, 1, 0]);
}
for (let a = 0; a < 4; a++) {
  await tic([1, 0, 0, 90, 0, 0, 0, 1, 0]);
  const r = (await db.query('SELECT COUNT(*) c FROM frame_faces_fast')).rows[0].C;
  assert(r > 0, `heading +${(a + 1) * 90}°: ${r} faces`);
}

// the bots think: run 60 tics and see that they move about without error
t0 = t();
for (let i = 0; i < 30; i++) s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
console.log(`60 tics idle    ${(t() - t0).toFixed(0)} ms`);
const bots = (await db.query("SELECT bot, st, CAST(x AS INTEGER) x, CAST(y AS INTEGER) y, CAST(z AS INTEGER) z, enemy_id, health, legs_anim, weapon, cluster FROM ents WHERE classname = 'bot'")).rows;
console.log('bots', bots);
assert(bots.every((b) => b.CLUSTER !== null), 'every bot is linked into the world');

// cheat, then rocket the floor: splash damage must hurt us. Alive for it (a bot's rocket in the idle
// tics may have knocked us into a void, which kills through god mode), the bots holding their fire
if (s.DEAD || s.HEALTH <= 0) {
  await db.exec('EXECUTE PROCEDURE player_respawn');
  await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
}
await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
// (and what they already fired goes: a rocket still in flight could knock us off q3dm17's platforms)
await db.exec("DELETE FROM ents WHERE classname IN ('rocket', 'grenade', 'plasma', 'bfg')");
s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 99]);
assert(s.ROCKETS === 200, 'impulse 99 gave ammo');
const oldWeapon = s.WEAPON;
s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 5]);
// the switch (PM_BeginWeaponChange, PM_FinishWeaponChange): the old weapon down, then the new one up
const states = [[s.WEAPONSTATE, s.WEAPON]];
for (let i = 0; i < 12; i++) { s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]); states.push([s.WEAPONSTATE, s.WEAPON]); }
assert(s.WEAPON === 16, `switched to the rocket launcher (weapon ${s.WEAPON})`);
const firstRaise = states.findIndex(([st]) => st === 3), firstReady = states.findIndex(([st], i) => st === 0 && i > firstRaise);
assert(states[0][0] === 2 && states[0][1] === oldWeapon && firstRaise > 0 && states.slice(0, firstRaise).every(([st, w]) => st === 2 && w === oldWeapon)
  && firstReady > firstRaise && states.slice(firstRaise, firstReady).every(([st, w]) => st === 3 && w === 16),
  `the old weapon went down, then the new one came up (${states.map(([st]) => st).join('')})`);
// on a spawn point's floor, looking level (wherever the walks above left us, a floor may not be under the feet)
{
  const home = (await db.query("SELECT FIRST 1 e.x, e.y, e.z FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY e.id")).rows[0];
  await db.exec(`UPDATE ents SET x = ${home.X}, y = ${home.Y}, z = ${home.Z + 9}, vx = 0, vy = 0, vz = 0 WHERE classname = 'player'`);
  await db.exec('UPDATE player SET pitch = 0 WHERE id = 1');
  await db.exec("EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))");
  for (let i = 0; i < 6; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
}
const hpBefore = s.HEALTH;
// without god mode for this one (it would stop the splash)
await db.exec("UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(16)) WHERE classname = 'player'");
s = await tic([1, 0, 0, 0, 85, 1, 0, 1, 0]);
for (let i = 0; i < 20; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
assert(hpBefore - s.HEALTH > 10, `rocket at our feet hurt us (health ${hpBefore} → ${s.HEALTH})`);
assert(s.DMG_WORLD === 0, `and its splash came from where it blew up (${s.DMG_X.toFixed(0)}, ${s.DMG_Y.toFixed(0)}, ${s.DMG_Z.toFixed(0)})`);
// a bot's hit (8: through god mode) is recorded with where it came from, for the view's kick
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  const b = (await db.query("SELECT FIRST 1 id, x, y, z + (minz + maxz) / 2 cz FROM ents WHERE classname = 'bot' ORDER BY id")).rows[0];
  await db.exec(`EXECUTE PROCEDURE t_damage(${pe}, ${b.ID}, ${b.ID}, 10, 0, 8, 2)`);
  const d = (await db.query('SELECT dmg_x, dmg_y, dmg_z, dmg_world FROM player')).rows[0];
  assert(d.DMG_WORLD === 0 && Math.hypot(d.DMG_X - b.X, d.DMG_Y - b.Y, d.DMG_Z - b.CZ) < 0.01, `a bot's hit comes from the bot (${d.DMG_X.toFixed(0)}, ${d.DMG_Y.toFixed(0)}, ${d.DMG_Z.toFixed(0)})`);
}
// a far fall (PM_CrashLand): the view's dip is the far one, and the damage comes from no direction
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  // on the spawn point's floor again (the rocket's knock may have thrown us off a platform's edge)
  const home = (await db.query("SELECT FIRST 1 e.x, e.y, e.z FROM ents e WHERE e.classname = 'info_player_deathmatch' ORDER BY e.id")).rows[0];
  await db.exec(`UPDATE ents SET x = ${home.X}, y = ${home.Y}, z = ${home.Z + 9}, vx = 0, vy = 0, vz = 0 WHERE id = ${pe}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  for (let i = 0; i < 20 && s.ONGROUND !== 1; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  // (for the one tic without god mode, the bots hold their fire and nothing is in flight)
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  await db.exec("DELETE FROM ents WHERE classname IN ('rocket', 'grenade', 'plasma', 'bfg')");
  // (30 units up, coming down at 900: the contact at 926 units a second, PM_CrashLand's delta 86)
  await db.exec(`UPDATE ents SET z = z + 30, vz = -900, flags = BIN_AND(flags, BIN_NOT(512 + 16)) WHERE id = ${pe}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
  await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
  assert(s.LAND_CHANGE === -24 && s.TIME_ - s.LAND_TIME < 0.11, `coming down at 900 units a second: the far dip (${s.LAND_CHANGE})`);
  assert(s.DMG_WORLD === 1 && s.DMG_TAKE > 0, `the fall's damage comes from no direction (${s.DMG_TAKE} taken)`);
}
const boom = (await db.query("SELECT COUNT(*) n FROM fx_events WHERE kind = 2")).rows[0].N;
assert(boom > 0, 'the explosion was reported to the browser');
// the explosion carries the plane it hit, for the burn mark (CG_MissileHitWall's CG_ImpactMark)
const plane = (await db.query('SELECT FIRST 1 x2, y2, z2 FROM fx_events WHERE kind = 2 ORDER BY id')).rows[0];
const nlen = Math.hypot(plane.X2, plane.Y2, plane.Z2);
assert(Math.abs(nlen - 1) < 1e-3, `the explosion faces the plane it hit (${[plane.X2, plane.Y2, plane.Z2].map((v) => v.toFixed(2)).join(' ')})`);

// a jump pad, if the map has one: stand on it and fly
const pad = (await db.query("SELECT FIRST 1 id, x + (minx + maxx) / 2 cx, y + (miny + maxy) / 2 cy, z + maxz + 26 cz, p1z FROM ents WHERE classname = 'trigger_push'")).rows[0];
if (pad) {
  await db.exec(`UPDATE ents SET x = ${pad.CX}, y = ${pad.CY}, z = ${pad.CZ}, vx = 0, vy = 0, vz = 0 WHERE id = (SELECT ent_id FROM player)`);
  await db.exec('EXECUTE PROCEDURE link_ent((SELECT ent_id FROM player))');
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const z0 = s.PZ;
  let top = z0;
  for (let i = 0; i < 20; i++) { s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]); top = Math.max(top, s.PZ); }
  assert(top - z0 > 50, `the jump pad threw us up (${(top - z0).toFixed(0)} units, launch vz ${pad.P1Z.toFixed(0)})`);
}

// every sound we queued exists in the pak
// the rewards (player_die, weapon_railgun_fire): excellent, gauntlet, impressive
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  const said = async (name) => (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE snd = '${name}'`)).rows[0].N;
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  const bots = (await db.query("SELECT id FROM ents WHERE classname = 'bot' ORDER BY id")).rows.map((r) => r.ID);
  // (a bot the earlier play killed stands up again for this)
  // (its old body let go, as a respawn does: a dead client is kept at its body)
  // (on a spawn point of its own: one that fell into q3dm17's void would be killed there again by the next tic)
  // (the farthest from us: one under our feet would leave its body in ours for the railgun's shots)
  const spawns = (await db.query(`SELECT s.x, s.y, s.z FROM ents s, ents p WHERE s.classname = 'info_player_deathmatch' AND p.id = ${pe}
                                  ORDER BY (s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y) + (s.z - p.z) * (s.z - p.z) DESC`)).rows;
  const revive = async (b) => {
    await db.exec(`EXECUTE PROCEDURE body_release(${b})`);
    const sp = spawns[bots.indexOf(b) % spawns.length];
    await db.exec(`UPDATE ents SET health = 125, deadflag = 0, st = 'stand', solid = 3, takedamage = 2, alpha = 0, flags = 32, viewheight = 26,
                   x = ${sp.X}, y = ${sp.Y}, z = ${sp.Z + 9}, vx = 0, vy = 0, vz = 0, minz = -24, maxz = 32, attack_crouch = NULL WHERE id = ${b}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${b})`);
  };
  const before = (await db.query(`SELECT n_excellent, n_gauntlet, n_impressive FROM ents WHERE id = ${pe}`)).rows[0];
  // two frags within three seconds
  await revive(bots[0]); await revive(bots[1]); await revive(bots[2]);
  await db.exec(`EXECUTE PROCEDURE t_damage(${bots[0]}, ${pe}, ${pe}, 500, 0, 8, 2)`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  await db.exec(`EXECUTE PROCEDURE t_damage(${bots[1]}, ${pe}, ${pe}, 500, 0, 8, 2)`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.AWARD === 1 && s.N_EXCELLENT === before.N_EXCELLENT + 1 && await said('sound/feedback/excellent.wav') > 0, `two frags in three seconds: excellent (${s.N_EXCELLENT})`);
  // a gauntlet frag
  await db.exec(`EXECUTE PROCEDURE t_damage(${bots[2]}, ${pe}, ${pe}, 500, 0, 8, 1)`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.N_GAUNTLET === before.N_GAUNTLET + 1 && await said('sound/feedback/humiliation.wav') > 0, `a gauntlet frag: the gauntlet medal, "humiliation" (${s.N_GAUNTLET})`);
  // the medal floats over a bot's head too: give one to a bot and look at it
  await db.exec(`EXECUTE PROCEDURE give_award(${bots[0]}, 2)`);
  const fx = (await db.query(`SELECT e.effects + IIF(e.award > 0 AND e.award_time > (SELECT time_ FROM game) - 2, 32768, 0) f FROM ents e WHERE e.id = ${bots[0]}`)).rows[0].F;
  assert((fx & 32768) !== 0, 'a bot\'s fresh medal is an effect bit for the painter');
  // two railgun hits in a row: impressive. Standing still on a spawn point facing a heading with 200 units of
  // room, a bot 150 units ahead (the player put back there before each shot: on q3dm17 the jump pad's flight
  // before can still be carrying us off, over the void)
  let p0 = null;
  // (none with a body or a bot on it: the frags before left corpses on the spawn points)
  for (const sp of (await db.query(`SELECT s.x, s.y, s.z FROM ents s WHERE s.classname = 'info_player_deathmatch'
                                     AND NOT EXISTS (SELECT 1 FROM ents o WHERE o.id NOT IN (${pe}, ${bots[1]}) AND o.solid IN (2, 3, 4)
                                                     AND ABS(o.x - s.x) < 256 AND ABS(o.y - s.y) < 256 AND ABS(o.z - s.z) < 96) ORDER BY s.id`)).rows) {
    for (const yaw of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const a = (yaw * Math.PI) / 180;
      const t = (await db.query(`SELECT fraction f FROM trace_move(${pe}, -15, -15, -24, 15, 15, 32, ${sp.X}, ${sp.Y}, ${sp.Z + 9}, ${sp.X + Math.cos(a) * 200}, ${sp.Y + Math.sin(a) * 200}, ${sp.Z + 9}, 1)`)).rows[0];
      if (t.F === 1) { p0 = { X: sp.X, Y: sp.Y, Z: sp.Z + 9, YAW: yaw }; break; }
    }
    if (p0) break;
  }
  const stand = async () => {
    await db.exec(`UPDATE ents SET x = ${p0.X}, y = ${p0.Y}, z = ${p0.Z}, yaw = ${p0.YAW}, vx = 0, vy = 0, vz = 0 WHERE id = ${pe}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
  };
  const aim = async () => {
    await stand();
    const p = p0;
    const a = (p.YAW * Math.PI) / 180;
    await db.exec(`EXECUTE PROCEDURE body_release(${bots[1]})`);
    await db.exec(`UPDATE ents SET x = ${p.X + Math.cos(a) * 150}, y = ${p.Y + Math.sin(a) * 150}, z = ${p.Z}, vx = 0, vy = 0, vz = 0, health = 125, deadflag = 0, st = 'stand', solid = 3, takedamage = 2, alpha = 0, viewheight = 26,
                   minx = -15, miny = -15, minz = -24, maxx = 15, maxy = 15, maxz = 32, attack_crouch = NULL WHERE id = ${bots[1]}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${bots[1]})`);
  };
  await db.exec(`UPDATE player SET pitch = 0, weapons = 511, slugs = 50 WHERE id = 1`);
  await stand();
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 7]);
  for (let i = 0; i < 12; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const imp0 = s.N_IMPRESSIVE;
  const shots = [];
  // (up to four shots: a missile left from the play before can still knock us off; a miss starts the count again)
  for (let shot = 0; shot < 4 && s.N_IMPRESSIVE === imp0; shot++) {
    await aim();
    s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
    shots.push({ ...(await db.query(`SELECT p.rail_hits r, b.health h, p.x px, p.y py, p.z pz, b.x bx, b.y by_, b.z bz, b.maxz bmz FROM ents p, ents b WHERE p.id = ${pe} AND b.id = ${bots[1]}`)).rows[0], W: s.WEAPON });
    for (let i = 0; i < 32; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  }
  assert(s.WEAPON === 64 && s.N_IMPRESSIVE === imp0 + 1 && await said('sound/feedback/impressive.wav') > 0,
    `two railgun hits in a row: impressive (${s.N_IMPRESSIVE}; after each shot the hits in a row and the bot's health: ${shots.map((x) => `${x.R}/${x.H}`).join(', ')})`);
  if (s.N_IMPRESSIVE !== imp0 + 1) console.log('the shots:', JSON.stringify(shots));
  await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
}

// the countdown (CG_DrawWarmup): three, two, one, "fight!", and no firing before it
{
  // (sound events live 40 tics: note each as it comes)
  let seen = (await db.query('SELECT MAX(id) m FROM sound_events')).rows[0].M ?? 0;
  const heard = new Map();
  await db.exec('UPDATE game SET warmup_end = time_ + 3.5, warmup_said = 4 WHERE id = 1');
  // (the bots hold still: once it is over, a rocket of theirs could knock us into q3dm17's void)
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  // (alive on a spawn point, with the railgun up: the play before may have left us dead or over q3dm17's void)
  await db.exec('EXECUTE PROCEDURE player_respawn');
  await db.exec("DELETE FROM ents WHERE classname IN ('rocket', 'grenade', 'plasma', 'bfg')");
  await db.exec('UPDATE player SET weapons = 511, weapon = 64, pending_weapon = 0, weaponstate = 0, slugs = 50 WHERE id = 1');
  const ammo = (await db.query('SELECT slugs FROM player')).rows[0].SLUGS;
  for (let i = 0; i < 80; i++) {
    s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
    for (const e of (await db.query(`SELECT id, snd FROM sound_events WHERE id > ${seen} ORDER BY id`)).rows) {
      seen = e.ID;
      const m = /feedback\/(three|two|one|fight)\.wav/.exec(e.SND);
      if (m && !heard.has(m[1])) heard.set(m[1], i);
    }
  }
  const order = ['three', 'two', 'one', 'fight'].map((n) => heard.get(n));
  const shotDuring = (await db.query('SELECT slugs FROM player')).rows[0].SLUGS;
  assert(order.every((n) => n !== undefined) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], `the countdown: three, two, one, fight, a second apart (at tics ${order.join(', ')})`);
  assert(shotDuring < ammo, `firing works once it is over (${ammo} → ${shotDuring} slugs)`);
  await db.exec('UPDATE game SET warmup_end = time_ + 2, warmup_said = 4 WHERE id = 1');
  const a0 = (await db.query('SELECT slugs FROM player')).rows[0].SLUGS;
  for (let i = 0; i < 20; i++) s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  const a1 = (await db.query('SELECT slugs FROM player')).rows[0].SLUGS;
  assert(a1 === a0 && s.WARMUP_END > s.TIME_, `no firing before "fight!" (${a0} slugs, still ${a1})`);
  for (let i = 0; i < 30; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  await db.exec('UPDATE game SET warmup_end = 0, warmup_said = 0 WHERE id = 1');
  await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
}

// water (the demo arenas have none: their lava, turned into water for this): a shot from the air into it
// leaves bubbles from the surface down (CG_Bullet); a rocket in it is marked for bubbles, not smoke
{
  // (a spot where a shot straight down ends in the lava, with room above it for us: q3dm1's is under a grate)
  let spot = null;
  for (const l of (await db.query('SELECT minx, maxx, miny, maxy, maxz FROM leaves WHERE BIN_AND(contents, 8) <> 0 AND cluster >= 0 ORDER BY (maxx - minx) * (maxy - miny) DESC')).rows) {
    const cx = (l.MINX + l.MAXX) / 2, cy = (l.MINY + l.MAXY) / 2;
    const surf = (await db.query(`SELECT ez, fraction f FROM trace_move(NULL, 0,0,0,0,0,0, ${cx}, ${cy}, ${l.MAXZ + 300}, ${cx}, ${cy}, ${l.MAXZ - 300}, 8)`)).rows[0];
    if (surf.F >= 1) continue;
    const eye = surf.EZ + 100;
    const shot = (await db.query(`SELECT ez, fraction f, startsolid s FROM trace_move(NULL, 0,0,0,0,0,0, ${cx}, ${cy}, ${eye}, ${cx}, ${cy}, ${surf.EZ - 300}, 100663297)`)).rows[0];
    const room = (await db.query(`SELECT startsolid s FROM trace_move(NULL, -15,-15,-24,15,15,32, ${cx}, ${cy}, ${eye - 26}, ${cx}, ${cy}, ${eye - 26}, 1)`)).rows[0];
    // (and the shot must stop inside the liquid, not on a floor below a thin sheet of it)
    const inside = shot.S ? 0 : (await db.query(`SELECT point_contents(${cx}, ${cy}, ${shot.EZ}) c FROM rdb$database`)).rows[0].C & 8;
    if (shot.S || room.S || shot.EZ >= surf.EZ || !inside) continue;
    spot = { cx, cy, surf };
    break;
  }
  if (!spot) console.log('(no open lava here to turn into water)');
  else {
    const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
    const { cx, cy, surf } = spot;
    await db.exec('UPDATE brushes SET contents = BIN_OR(BIN_AND(contents, BIN_NOT(8)), 32) WHERE BIN_AND(contents, 8) <> 0');
    await db.exec('UPDATE leaves SET contents = BIN_OR(BIN_AND(contents, BIN_NOT(8)), 32) WHERE BIN_AND(contents, 8) <> 0');
    // (and the copies on the tree's nodes, which let a trace skip a leaf with nothing in its mask)
    await db.exec('UPDATE nodes SET cc0 = BIN_OR(BIN_AND(cc0, BIN_NOT(8)), 32) WHERE BIN_AND(cc0, 8) <> 0');
    await db.exec('UPDATE nodes SET cc1 = BIN_OR(BIN_AND(cc1, BIN_NOT(8)), 32) WHERE BIN_AND(cc1, 8) <> 0');
    await db.exec('UPDATE game SET has_water = 1 WHERE id = 1');
    await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
    // over the pool
    await db.exec(`UPDATE ents SET x = ${cx}, y = ${cy}, z = ${surf.EZ + 74}, vx = 0, vy = 0, vz = 0 WHERE id = ${pe}`);
    await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
    // (one bullet straight down, no spread: q3dm1's lava is under a grate with gaps)
    const fx0 = (await db.query('SELECT COALESCE(MAX(id), 0) m FROM fx_events')).rows[0].M;
    await db.exec(`EXECUTE PROCEDURE fire_bullets(${pe}, 1, ${cx}, ${cy}, ${surf.EZ + 100}, 0, 0, -1, 0, 7, 2)`);
    const trail = (await db.query(`SELECT FIRST 1 x, y, z, x2, y2, z2 FROM fx_events WHERE kind = 15 AND id > ${fx0} ORDER BY id`)).rows[0];
    assert(trail && Math.abs(trail.Z - surf.EZ) < 2 && trail.Z2 < trail.Z, `a shot into the water: bubbles from the surface (${trail ? trail.Z.toFixed(1) : '-'}, the surface at ${surf.EZ.toFixed(1)}) down to the hit (${trail ? trail.Z2.toFixed(1) : '-'})`);
    // a slow rocket just under the surface: in the frame, marked as in water
    await db.exec(`EXECUTE PROCEDURE launch_missile(${pe}, 'rocket', 'models/ammo/rocket/rocket.md3', ${cx}, ${cy}, ${surf.EZ - 3}, 1, 0, 0, 20, 0, 0, 0, 16, 10)`);
    const rocket = (await db.query("SELECT MAX(id) id FROM ents WHERE classname = 'rocket'")).rows[0].ID;
    s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
    const rows = (await db.query(`SELECT * FROM frame_all(0, 2147483647, 2147483647, 0, ${cx - 60}, ${cy}, ${surf.EZ + 10}, 0, 10, 90)`, [], { rowMode: 'array' })).rows;
    const row = rows.find((r) => r[0] === 2 && r[1] === rocket);
    assert(row && (row[5] & 65536) && (row[5] & 16), `a rocket in the water is drawn with bubbles for smoke (effects ${row ? row[5] : 'not in view'})`);
    await db.exec(`DELETE FROM ents WHERE id = ${rocket}`);
    // and back to lava
    await db.exec('UPDATE brushes SET contents = BIN_OR(BIN_AND(contents, BIN_NOT(32)), 8) WHERE BIN_AND(contents, 32) <> 0');
    await db.exec('UPDATE leaves SET contents = BIN_OR(BIN_AND(contents, BIN_NOT(32)), 8) WHERE BIN_AND(contents, 32) <> 0');
    await db.exec('UPDATE nodes SET cc0 = BIN_OR(BIN_AND(cc0, BIN_NOT(32)), 8) WHERE BIN_AND(cc0, 32) <> 0');
    await db.exec('UPDATE nodes SET cc1 = BIN_OR(BIN_AND(cc1, BIN_NOT(32)), 8) WHERE BIN_AND(cc1, 32) <> 0');
    await db.exec('UPDATE game SET has_water = 0 WHERE id = 1');
    await db.exec("UPDATE ents SET nextthink = 0 WHERE classname = 'bot'");
    await db.exec('EXECUTE PROCEDURE player_respawn');
    await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
    s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  }
}

// spectating (SetTeam, SpectatorThink, Cmd_FollowCycle_f, StopFollowing)
{
  const pe = (await db.query('SELECT ent_id e FROM player')).rows[0].E;
  // alive (a bot may have fragged us in the tics before; leaving dead costs nothing) and safe until we go
  if (s.DEAD || s.HEALTH <= 0) await db.exec('EXECUTE PROCEDURE player_respawn');
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${(await db.query('SELECT ent_id e FROM player')).rows[0].E}`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const frags0 = s.FRAGS;
  await db.exec('EXECUTE PROCEDURE set_spectator(1)');
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const me = (await db.query(`SELECT solid, takedamage, flags, x, y, z FROM ents WHERE id = ${pe}`)).rows[0];
  assert(s.SPECTATOR === 1 && me.SOLID === 0 && me.TAKEDAMAGE === 0 && (me.FLAGS & 64) && s.FRAGS === frags0 - 1, `out of the match: no body, nothing to shoot at, a frag less for leaving alive (${frags0} → ${s.FRAGS})`);
  const ip = (await db.query("SELECT FIRST 1 ox, oy, oz FROM map_ents WHERE classname = 'info_player_intermission' ORDER BY id")).rows[0];
  assert(!ip || Math.hypot(s.PX - ip.OX, s.PY - ip.OY, s.VIEW_Z - ip.OZ) < 1, 'a new spectator watches from the intermission point');
  // flying: up with jump, no gravity when still
  const z0 = s.PZ;
  for (let i = 0; i < 10; i++) s = await tic([1, 0, 0, 0, 0, 0, 1, 1, 0]);
  const up = s.PZ - z0;
  for (let i = 0; i < 20; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const z1 = s.PZ;
  for (let i = 0; i < 10; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(up > 20 && Math.abs(s.PZ - z1) < 1, `flying: up ${up.toFixed(0)} units on jump, hanging still after (${(s.PZ - z1).toFixed(2)})`);
  // the bots let a spectator be
  for (let i = 0; i < 30; i++) s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const hunted = (await db.query(`SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND enemy_id = ${pe}`)).rows[0].N;
  assert(hunted === 0, 'no bot has a spectator for its enemy');
  // following: fire cycles through the bots, the view is theirs; jump lets go where they were
  s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  const f1 = s.FOLLOW_NAME;
  const b1 = (await db.query(`SELECT x, y, z, viewheight FROM ents WHERE classname = 'bot' AND bot = '${f1}'`)).rows[0];
  assert(f1 && Math.hypot(s.PX - b1.X, s.PY - b1.Y) < 1 && Math.abs(s.VIEW_Z - (b1.Z + b1.VIEWHEIGHT)) < 1, `fire: following ${f1}, through its eyes`);
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert(s.FOLLOW_NAME && s.FOLLOW_NAME !== f1, `fire again: the next one (${s.FOLLOW_NAME})`);
  const b2 = (await db.query(`SELECT x, y FROM ents WHERE classname = 'bot' AND bot = '${s.FOLLOW_NAME}'`)).rows[0];
  s = await tic([1, 0, 0, 0, 0, 0, 1, 1, 0]);
  const at = (await db.query(`SELECT x, y FROM ents WHERE id = ${pe}`)).rows[0];
  assert(!s.FOLLOW_NAME && Math.hypot(at.X - b2.X, at.Y - b2.Y) < 40, 'jump: free again, from where it was');
  // and back into the match
  await db.exec('EXECUTE PROCEDURE set_spectator(0)');
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const back = (await db.query(`SELECT solid, takedamage, flags FROM ents WHERE id = ${pe}`)).rows[0];
  assert(s.SPECTATOR === 0 && back.SOLID === 3 && back.TAKEDAMAGE > 0 && (back.FLAGS & 64) === 0 && s.HEALTH === 125, 'joined again: a body, a target, 125 health');
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
}

// the page's predicted eye: passed through when it is the real one, clamped by a trace when it runs into a wall
{
  const e = (await db.query('SELECT ex, ey, ez, fx, fy FROM view_setup')).rows[0];
  const eyeOf = async (x, y, z) => (await db.query(`SELECT * FROM frame_all(0, 2147483647, 2147483647, 0, ${x}, ${y}, ${z}, 0, 0)`, [], { rowMode: 'array' })).rows.find((r) => r[0] === 10);
  const same = await eyeOf(e.EX, e.EY, e.EZ);
  assert(same && Math.hypot(same[6] - e.EX, same[7] - e.EY, same[8] - e.EZ) < 0.01, 'frame_all paints from the eye it is given');
  const far = [e.EX + e.FX * 4000, e.EY + e.FY * 4000, e.EZ];
  const clamped = await eyeOf(...far);
  const d = Math.hypot(clamped[6] - e.EX, clamped[7] - e.EY, clamped[8] - e.EZ);
  const cl = (await db.query(`SELECT cluster FROM leaves WHERE id = point_leaf(${clamped[6]}, ${clamped[7]}, ${clamped[8]})`)).rows[0].CLUSTER;
  assert(d < 3990 && cl >= 0, `an eye predicted through a wall stops inside the world (${d.toFixed(0)} of 4000 units, cluster ${cl})`);
  // the zoom: the page's field of view culls and projects (CG_CalcFov's cg_zoomFov)
  // (along the heading with the most to see: facing a wall close up, a narrow view keeps every face)
  let yaw = 0;
  const faces = async (mode, fov) => (await db.query(`SELECT * FROM frame_all(${mode}, 2147483647, 2147483647, 0, ${e.EX}, ${e.EY}, ${e.EZ}, ${yaw}, 0, ${fov})`, [], { rowMode: 'array' })).rows;
  const count = (rows) => rows.filter((r) => r[0] === 1).reduce((n, r) => n + r[16].split(',').length, 0);
  let best = 0, bestYaw = 0;
  for (yaw of [0, 90, 180, 270]) { const n = count(await faces(0, 90)); if (n > best) { best = n; bestYaw = yaw; } }
  yaw = bestYaw;
  const wide = count(await faces(0, 90)), narrow = count(await faces(0, 22.5));
  assert(narrow > 0 && narrow < wide, `zoomed to 22.5 degrees, fewer faces pass the frustum (${narrow} of ${wide}, heading ${yaw})`);
  // the same vertex, projected in SQL at both: about tan 45° / tan 11.25° = 5.03 times as far from the centre
  const w = (await db.query('SELECT w FROM viewcfg')).rows[0].W;
  const at = (rows) => new Map(rows.filter((r) => r[0] === 8 && r[6] > 16).map((r) => [`${r[1]}:${r[2]}`, r[9] - w / 2]));   // in front of the eye: the ones behind are left for the painter to clip
  const v90 = at(await faces(1, 90)), v22 = at(await faces(1, 22.5));
  const both = [...v22.keys()].filter((k) => v90.has(k) && Math.abs(v90.get(k)) > 2);
  const ratio = both.length ? v22.get(both[0]) / v90.get(both[0]) : 0;
  assert(both.length > 0 && Math.abs(ratio - 5.03) < 0.05, `the SQL projection zooms too: a vertex ${ratio.toFixed(2)} times as far from the centre`);
  // a rocket behind the eye still lights what is in view (R_AddLightToScene from the snapshot's entities): it
  // comes with the frame; an item at the same spot does not
  // (a heading whose spot 150 units behind is open and seen from the eye's cluster)
  let hy = 0, bx = 0, by = 0;
  const bz = e.EZ;
  for (hy of [0, 90, 180, 270]) {
    const r = (hy * Math.PI) / 180;
    bx = e.EX - Math.cos(r) * 150; by = e.EY - Math.sin(r) * 150;
    const [o] = (await db.query(`SELECT point_contents(${bx}, ${by}, ${bz}) c, (SELECT l.cluster FROM leaves l WHERE l.id = point_leaf(${bx}, ${by}, ${bz})) cl FROM rdb$database`)).rows;
    if (o.C === 0 && o.CL >= 0) break;
  }
  const rid = (await db.query(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN EXECUTE PROCEDURE spawn_ent('rocket', ${bx}, ${by}, ${bz}) RETURNING_VALUES :id; SUSPEND; END`)).rows[0]?.ID;
  const iid = (await db.query(`EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN EXECUTE PROCEDURE spawn_ent('item', ${bx}, ${by}, ${bz}) RETURNING_VALUES :id; SUSPEND; END`)).rows[0]?.ID;
  const md3 = (await db.query("SELECT FIRST 1 id FROM models WHERE kind = 'M'")).rows[0].ID;
  await db.exec(`UPDATE ents SET model_id = ${md3}, movetype = 9, effects = 16, solid = 2, vx = 900, vy = -12, vz = 3 WHERE id = ${rid}`);
  await db.exec(`UPDATE ents SET model_id = ${md3}, movetype = 0, effects = 0, solid = 1 WHERE id = ${iid}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${rid})`); await db.exec(`EXECUTE PROCEDURE link_ent(${iid})`);
  const back = (await db.query(`SELECT * FROM frame_all(0, 2147483647, 2147483647, 0, ${e.EX}, ${e.EY}, ${e.EZ}, ${hy}, 0, 90)`, [], { rowMode: 'array' })).rows.filter((r) => r[0] === 2).map((r) => r[1]);
  assert(back.includes(rid) && !back.includes(iid), `a rocket 150 units behind the eye comes with the frame for its light, an item there does not (${back.includes(rid)}, ${back.includes(iid)})`);
  // and it whooshes as it flies, from where it is (CG_Missile's missileSound), seen or not; the item makes no sound
  const flyRows = (await db.query(`SELECT * FROM frame_all(0, 2147483647, 2147483647, 0, ${e.EX}, ${e.EY}, ${e.EZ}, ${hy + 180}, 0, 90)`, [], { rowMode: 'array' })).rows.filter((r) => r[0] === 12);
  const fly = flyRows.find((r) => r[1] === rid);
  assert(fly && fly[15] === 'sound/weapons/rocket/rockfly.wav' && Math.abs(fly[6] - bx) < 1e-6 && !flyRows.some((r) => r[1] === iid)
    && fly[9] === 900 && fly[10] === -12 && fly[11] === 3,
    `the rocket is heard flying where it is (${fly ? fly[15] : 'no sound'}, ${fly ? fly[6].toFixed(1) : '-'} for ${bx.toFixed(1)}), with its velocity for the doppler (${fly ? fly.slice(9, 12).join(', ') : '-'}), the item is silent`);
  await db.exec(`DELETE FROM ents WHERE id IN (${rid}, ${iid})`);
}

// the dead player is its body until the respawn: the eye at DEAD_VIEWHEIGHT (-16), and where the body goes
{
  await db.exec("UPDATE ents SET flags = BIN_AND(flags, BIN_NOT(16)) WHERE id = player_ent()");
  const hp = (await db.query('SELECT health h FROM ents WHERE id = player_ent()')).rows[0].H;
  await db.exec("UPDATE ents SET armor = 0 WHERE id = player_ent()"); await db.exec("UPDATE player SET armor = 0 WHERE id = 1");
  await db.exec(`EXECUTE PROCEDURE t_damage(player_ent(), NULL, NULL, ${hp + 20}, 0, 8, 0)`);   // dead, not gibbed (the world: not halved)
  let d = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const body = (await db.query('SELECT id, x, y, z FROM ents WHERE classname = \'corpse\' AND body_of = player_ent()')).rows[0];
  if (d.DEAD && body) {
    await db.exec(`UPDATE ents SET x = x + 40, vx = 0, vy = 0, vz = 0 WHERE id = ${body.ID}`);
    d = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
    const b2 = (await db.query(`SELECT x, y, z FROM ents WHERE id = ${body.ID}`)).rows[0];
    assert(Math.abs(d.PX - b2.X) < 1e-6 && Math.abs(d.PY - b2.Y) < 1e-6 && Math.abs(d.VIEW_Z - (d.PZ - 16)) < 1e-6,
      `dead, the eye is 16 under the origin (${(d.VIEW_Z - d.PZ).toFixed(1)}) and goes with the body moved 40 (${(d.PX - body.X).toFixed(1)})`);
  } else assert(false, `the player died and left a body (dead ${d.DEAD}, body ${body?.ID}, health ${d.HEALTH}, ${JSON.stringify((await db.query("SELECT e.health, e.deadflag, e.flags, p.spectator, g.match_over, g.exit_kind FROM ents e, player p, game g WHERE e.id = p.ent_id")).rows[0])})`);
  await db.exec('EXECUTE PROCEDURE player_respawn');
  await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = player_ent()");
}

// the end of a match (CheckExitRules, BeginIntermission, CheckIntermissionExit)
{
  const said = async (name) => (await db.query(`SELECT COUNT(*) n FROM sound_events WHERE snd = '${name}'`)).rows[0].N;
  // the bots hold still (a frag of theirs would decide the match before the test does)
  await db.exec("UPDATE ents SET nextthink = 1e9 WHERE classname = 'bot'");
  // a six-minute limit, a moment before 60 s: the five-minute warning
  await db.exec(`UPDATE game SET timelimit = 6, time_warnings = 0, time_ = 59.93 WHERE id = 1`);
  await db.exec("UPDATE ents SET flags = BIN_OR(flags, 16) WHERE classname = 'player'");
  s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(await said('sound/feedback/5_minute.wav') === 1 && s.TIMELIMIT === 6, 'five minutes left: the announcer says so, once');
  // the clock runs out with the lead tied: sudden death, no end
  await db.exec("UPDATE player SET frags = 3 WHERE id = 1");
  await db.exec("UPDATE ents SET frags = IIF(id = (SELECT MIN(id) FROM ents WHERE classname = 'bot'), 3, 0) WHERE classname = 'bot'");
  await db.exec('UPDATE game SET time_ = 359.9 WHERE id = 1');
  for (let i = 0; i < 3; i++) s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.MATCH_OVER === 0 && await said('sound/feedback/1_minute.wav') === 1, 'time is up with the lead tied: play on');
  for (let i = 0; i < 25; i++) s = await tic([2, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert(s.MATCH_OVER === 0 && await said('sound/feedback/sudden_death.wav') === 1, 'two seconds on, still tied: "sudden death"');
  // the tie broken: we win, the view goes to the intermission point, the bots leave
  await db.exec('UPDATE player SET frags = 4 WHERE id = 1');
  s = await tic([1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const ip = (await db.query("SELECT FIRST 1 ox, oy, oz FROM map_ents WHERE classname = 'info_player_intermission' ORDER BY id")).rows[0];
  const ent = (await db.query('SELECT ex, ey, ez FROM view_setup')).rows[0];
  const shown = (await db.query("SELECT COUNT(*) n FROM ents WHERE classname = 'bot' AND alpha = 0")).rows[0].N;
  assert(s.MATCH_OVER === 1 && s.WINNER === 'You', `the frag that breaks the tie wins (${s.WINNER})`);
  assert(!ip || Math.hypot(ent.EX - ip.OX, ent.EY - ip.OY, ent.EZ - ip.OZ) < 1, 'the view is at the info_player_intermission');
  assert(shown === 0, 'the bots have left the arena');
  const rot = (await db.query('SELECT name FROM map_list ORDER BY ord')).rows.map((r) => r.NAME);
  const want = rot[(rot.indexOf(mapName) + 1) % rot.length];
  assert(s.NEXT_MAP === want, `the next arena of the rotation (${rot.join(' → ')}): ${s.NEXT_MAP}`);
  // fire before five seconds does nothing; after, it is time to go
  s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert(s.EXIT_KIND === 0, 'fire in the first five seconds of the intermission is ignored');
  await db.exec(`UPDATE game SET time_ = time_ + 6 WHERE id = 1`);
  s = await tic([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert(s.EXIT_KIND === 1, 'fire after five seconds: on to the next arena');
}

// the model played (ClientUserinfoChanged's model): at once, kept for the next arena, and its own sounds
{
  await db.exec("EXECUTE PROCEDURE set_player_model('major', 'daemia')");
  const pm = (await db.query("SELECT TRIM(pmodel) m, TRIM(pskin) s FROM ents WHERE id = player_ent()")).rows[0];
  await db.exec('EXECUTE PROCEDURE snd(player_ent(), 2, \'*jump1.wav\', 1, 1)');
  const jump = (await db.query('SELECT FIRST 1 TRIM(snd) s FROM sound_events ORDER BY id DESC')).rows[0].S;
  assert(pm.M === 'major' && pm.S === 'daemia' && jump === 'sound/player/major/jump1.wav', `the player plays major/daemia at once, with its sounds (${pm.M}/${pm.S}, ${jump})`);
}

// target_speaker's spawnflags (Use_Target_Speaker): 4 is heard everywhere at full volume (q3dm1's ominous sound),
// 8 is played on the activator (q3dm17's void scream comes from whoever fell)
{
  const [sp] = (await db.query("SELECT FIRST 1 id, targetname, spawnflags FROM ents WHERE classname = 'target_speaker' AND BIN_AND(spawnflags, 3) = 0 AND targetname IS NOT NULL ORDER BY id")).rows;
  const bot = (await db.query("SELECT FIRST 1 id FROM ents WHERE classname = 'bot' ORDER BY id")).rows[0]?.ID;
  if (sp && bot) {
    const tid = (await db.query("EXECUTE BLOCK RETURNS (id INTEGER) AS BEGIN EXECUTE PROCEDURE spawn_ent('test_trigger', 0, 0, 0) RETURNING_VALUES id; SUSPEND; END")).rows[0].ID;
    await db.exec(`UPDATE ents SET target = '${sp.TARGETNAME}' WHERE id = ${tid}`);
    const fire = async (sf) => {
      await db.exec(`UPDATE ents SET spawnflags = ${sf} WHERE id = ${sp.ID}`);
      await db.exec(`EXECUTE PROCEDURE use_targets(${tid}, ${bot})`);
      return (await db.query('SELECT FIRST 1 ent_id, attn FROM sound_events ORDER BY id DESC')).rows[0];
    };
    const g = await fire(4), a = await fire(8), n = await fire(0);
    await db.exec(`UPDATE ents SET spawnflags = ${sp.SPAWNFLAGS} WHERE id = ${sp.ID}`);
    await db.exec(`DELETE FROM ents WHERE id = ${tid}`);
    assert(g.ATTN === 0 && a.ENT_ID === bot && a.ATTN === 1 && n.ENT_ID === null && n.ATTN === 1,
      `a global speaker is heard everywhere (attenuation ${g.ATTN}), an activator one from the activator (${a.ENT_ID} = ${bot}), a plain one from where it stands`);
  } else console.log('(no triggered speaker here)');
}

// BotNearbyGoal: an item on the way to the long-term goal, under 1.5 s off, is a nearby goal; one that would
// take the bot further from the long-term goal, or one too far, is not (BotChooseNBGItem)
{
  const bot = (await db.query("SELECT FIRST 1 id FROM ents WHERE classname = 'bot' ORDER BY id")).rows[0]?.ID;
  const items = (await db.query(`SELECT g.id, g.x, g.y, g.z, bot_item_weight(${bot ?? 0}, g.item) w FROM ents g JOIN item_defs i ON i.cls = g.item
    WHERE g.classname = 'item' AND g.solid = 1 AND i.kind IN ('H', 'A', 'W') ORDER BY g.id`)).rows.filter((r) => r.W > 0);
  if (bot && items.length >= 2) {
    const [near, far] = items;
    const b0 = (await db.query(`SELECT x, y, z FROM ents WHERE id = ${bot}`)).rows[0];
    const put = (id, x, y, z) => db.exec(`UPDATE ents SET x = ${x}, y = ${y}, z = ${z} WHERE id = ${id}`);
    // far from the arena's other items: the bot, the item 200 ahead, the long-term goal 400 past it
    await put(bot, 9000, 9000, 9000); await put(near.ID, 9200, 9000, 9000); await put(far.ID, 9600, 9000, 9000);
    const nbg = async () => (await db.query(`SELECT bot_choose_nbg(${bot}, ${far.ID}, 1.5) n FROM rdb$database`)).rows[0].N;
    const onTheWay = await nbg();
    await put(far.ID, 8900, 9000, 9000);   // the long-term goal behind the bot now
    const behind = await nbg();
    await put(near.ID, 9700, 9000, 9000); await put(far.ID, 9600, 9000, 9000);   // ahead, but 700 away (2.3 s)
    const tooFar = await nbg();
    await put(bot, b0.X, b0.Y, b0.Z); await put(near.ID, near.X, near.Y, near.Z); await put(far.ID, far.X, far.Y, far.Z);
    assert(onTheWay === near.ID && behind !== near.ID && tooFar === null,
      `a nearby goal: the item on the way (${onTheWay} = ${near.ID}), not the one ahead when the goal is behind (${behind}), none 2.3 s off (${tooFar})`);
  } else console.log('(no bot or no wanted items for the nearby goal check)');
}

// the rail's colour (the "color1" userinfo): the trail and its mark carry the shooter's; the bots' are 4, red
{
  await db.exec('EXECUTE PROCEDURE set_player_color(2)');
  const fx0 = (await db.query('SELECT COALESCE(MAX(id), 0) m FROM fx_events')).rows[0].M;
  // straight down from a spawn point, which stands on a floor (the player may be over q3dm17's void by now)
  const sp = (await db.query("SELECT FIRST 1 x, y, z FROM ents WHERE classname = 'info_player_deathmatch' ORDER BY id")).rows[0];
  await db.exec(`EXECUTE PROCEDURE fire_rail(player_ent(), ${sp.X}, ${sp.Y}, ${sp.Z}, 0, 0, -1, 0)`);
  const rows = (await db.query(`SELECT kind, n FROM fx_events WHERE id > ${fx0} AND kind IN (4, 16) ORDER BY id`)).rows;
  const botc = (await db.query('SELECT MIN(color1) a, MAX(color1) b FROM ents WHERE classname = \'bot\'')).rows[0];
  assert(rows.find((r) => r.KIND === 4)?.N === 2 && rows.find((r) => r.KIND === 16)?.N === 66 && (botc.A ?? 4) === 4 && (botc.B ?? 4) === 4,
    `a rail fired after set_player_color(2) carries green, its mark too; the bots' stay red (${JSON.stringify(rows)}, bots ${botc.A}..${botc.B})`);
  await db.exec('EXECUTE PROCEDURE set_player_color(9)');
  const c = (await db.query('SELECT color1 c FROM ents WHERE id = player_ent()')).rows[0].C;
  assert(c === 7, `a colour out of 1..7 is white (CG_ColorFromString): ${c}`);
}

const snds = (await db.query('SELECT DISTINCT snd FROM sound_events')).rows.map((r) => r.SND);
const missing = snds.filter((n) => !pak.has(n));
assert(missing.length === 0, `all queued sounds exist in the pak (${missing.join(', ') || 'none missing'})`);

const msgs = (await db.query('SELECT msg FROM messages ORDER BY id')).rows.map((r) => r.MSG);
console.log('console:', msgs);
await db.close();
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
