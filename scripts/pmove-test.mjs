// pmove-test.mjs – the player's movement side by side with Quake III's (bg_pmove.c): a JavaScript
// reference of the open-ground part of Pmove (PM_GroundTrace, PM_CheckJump, PM_Friction, PM_CmdScale,
// PM_Accelerate, the trapezoid gravity of PM_SlideMove) run at 8 ms a frame, as pmove_fixed does, beside
// the SQL's PLAYER_THINK at its 20 Hz, on the same inputs, on open floor (q3dm17's big platform):
// starting to run, stopping, a standing jump, a running jump, a strafe-jump's arc.
//
//   node scripts/pmove-test.mjs            the table, and the checks
//   node scripts/pmove-test.mjs --ref-only the reference alone (no engine)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };

// ── the reference ────────────────────────────────────────────────────────
// a flat floor at h = 0 (h: how far the bottom of the box is above it), the commands as Quake III's
// usercmd_t has them (forwardmove, rightmove, upmove: -127..127), yaw in degrees
const G = 800, SPEED = 320, JUMP = 270, FRICTION = 6, STOPSPEED = 100, ACCEL = 10, AIRACCEL = 1;
export function refFrame(st, cmd, msec) {
  const dt = msec / 1000;
  st.yaw += cmd.yawRate * dt;
  // PM_GroundTrace: on the floor unless moving up off it
  let walking = st.h <= 0.25 && !(st.vz > 10);
  if (walking && st.vz < 0) st.vz = 0;
  // PM_CheckJump (only when walking): not again until the key comes up
  let up = cmd.up;
  if (walking) {
    if (up < 10) st.jumpHeld = false;
    else if (st.jumpHeld) up = 0;                   // "clear upmove so cmdscale doesn't lower running speed"
    else { st.jumpHeld = true; st.vz = JUMP; walking = false; }
  }
  // PM_Friction: walking only, on the horizontal speed, stopspeed's control below 100; not while knocked
  const knocked = st.t < (st.knockUntil ?? 0);
  if (walking && !knocked) {
    const speed = Math.hypot(st.vx, st.vy);
    if (speed < 1) { st.vx = 0; st.vy = 0; } else {
      const drop = Math.max(speed, STOPSPEED) * FRICTION * dt;
      const k = Math.max(0, speed - drop) / speed;
      st.vx *= k; st.vy *= k;
    }
  }
  // PM_CmdScale (the up key counts) and PM_Accelerate
  const f = cmd.fwd * 127, r = cmd.side * 127, u = up;
  const max = Math.max(Math.abs(f), Math.abs(r), Math.abs(u));
  const scale = max ? (SPEED * max) / (127 * Math.hypot(f, r, u)) : 0;
  const yr = (st.yaw * Math.PI) / 180, fx = Math.cos(yr), fy = Math.sin(yr), rx = Math.sin(yr), ry = -Math.cos(yr);
  let wx = fx * f + rx * r, wy = fy * f + ry * r;
  const wl = Math.hypot(wx, wy);
  if (wl > 0) {
    wx /= wl; wy /= wl;
    // (crouched and walking: a quarter of the speed at most, pm_duckScale; the crouch key is upmove -127)
    const wishspeed = walking && cmd.up < 0 ? Math.min(wl * scale, SPEED * 0.25) : wl * scale;
    const add = wishspeed - (st.vx * wx + st.vy * wy);
    if (add > 0) {
      const acc = Math.min(add, (walking && !knocked ? ACCEL : AIRACCEL) * dt * wishspeed);
      st.vx += acc * wx; st.vy += acc * wy;
    }
  }
  // the move: gravity over the frame by its average (PM_SlideMove's endVelocity), the landing
  st.x += st.vx * dt; st.y += st.vy * dt;
  if (!walking) {
    const vz1 = st.vz - G * dt;
    st.h += ((st.vz + vz1) / 2) * dt;
    st.vz = vz1;
    if (st.h <= 0) { st.h = 0; st.vz = 0; }
  }
  st.walking = st.h <= 0.25 && !(st.vz > 10);
  st.t += dt;
}
/** a run of tics (50 ms of the same command each) on the reference, in frames of `msec` */
export function refRun(st, tics, msec = 8) {
  const out = [];
  for (const cmd of tics) {
    if (cmd.knock) st.knockUntil = st.t + cmd.knock;
    let left = 50;
    while (left > 1e-9) { const m = Math.min(msec, left); refFrame(st, cmd, m); left -= m; }
    out.push({ t: st.t, x: st.x, y: st.y, h: st.h, speed: Math.hypot(st.vx, st.vy), walking: st.walking });
  }
  return out;
}

// ── the scenarios, as tics of { fwd, side, up (-127..127), yawRate (degrees a second) } ──
const n = (k, c) => Array.from({ length: k }, () => ({ fwd: 0, side: 0, up: 0, yawRate: 0, ...c }));
// a jump pressed on the first tic it can work and released at once (the key comes up in the air)
const SCENARIOS = {
  accel: n(10, { fwd: 1 }),                                                      // 0.5 s from rest
  stop: [...n(12, { fwd: 1 }), ...n(12, {})],                                    // 0.6 s running, then nothing
  standjump: [{ fwd: 0, side: 0, up: 127, yawRate: 0 }, ...n(20, {})],
  runjump: [...n(10, { fwd: 1 }), { fwd: 1, side: 0, up: 127, yawRate: 0 }, ...n(20, { fwd: 1 })],
  strafejump: [...n(10, { fwd: 1 }), { fwd: 1, side: 1, up: 127, yawRate: -120 }, ...n(20, { fwd: 1, side: 1, yawRate: -120 })],
  // the same with the jump key held all the way (PM_CmdScale counts it: less air control)
  heldjump: [...n(10, { fwd: 1 }), ...n(21, { fwd: 1, side: 1, up: 127, yawRate: -120 })],
  // crouching from rest for a second
  crouchwalk: n(20, { fwd: 1, up: -127 }),
  // running, then a knock (200 ms without friction: PMF_TIME_KNOCKBACK) as the keys come up
  knockstop: [...n(12, { fwd: 1 }), { fwd: 0, side: 0, up: 0, yawRate: 0, knock: 0.2 }, ...n(11, {})],
};
function measure(name, rows, t0 = 0) {
  const r = rows;
  if (name === 'crouchwalk') return { 'distance in 1 s': Math.hypot(r[19].x - r[0].x, r[19].y - r[0].y), 'speed at 1 s': r[19].speed };
  if (name === 'accel') return { 'speed 0.1 s': r[1].speed, 'speed 0.25 s': r[4].speed, 'speed 0.5 s': r[9].speed };
  if (name === 'stop' || name === 'knockstop') {
    const from = r[11], stopped = r.findIndex((p, i) => i > 11 && p.speed < 1);
    const end = r[stopped < 0 ? r.length - 1 : stopped];
    return { 'run speed': from.speed, 'stop distance': Math.hypot(end.x - from.x, end.y - from.y), 'stop time': stopped < 0 ? NaN : (stopped - 11) * 0.05 };
  }
  // (the landing by height: the SQL says "on the ground" from the next tic's ground trace)
  if (name === 'standjump') {
    const land = r.findIndex((p, i) => i > 0 && p.h <= 0.25);
    return { apex: Math.max(...r.map((p) => p.h)), 'air time': land < 0 ? NaN : land * 0.05 };
  }
  if (name === 'runjump' || name === 'strafejump' || name === 'heldjump') {
    // (the speed at the last tic in the air: the tic of the landing has the ground's friction in it, a
    // different share of it at 8 ms and at 50 ms)
    const take = r[10], land = r.findIndex((p, i) => i > 10 && p.h <= 0.25);
    const end = r[land < 0 ? r.length - 1 : land], air = r[land < 0 ? r.length - 1 : land - 1];
    return { apex: Math.max(...r.slice(10).map((p) => p.h)), 'jump distance': Math.hypot(end.x - take.x, end.y - take.y), 'takeoff speed': take.speed, 'speed in the air': air.speed };
  }
  return {};
}

// ── the SQL, on q3dm17's platform ────────────────────────────────────────
const SPOT = { x: 352, y: -720, floor: 328.03125, room: 200 };   // 200 units of flat floor every way
async function sqlRuns() {
  const { FirebirdBrowser, DirectTransport } = await import('firebird-wasm/browser');
  const { Pk3 } = await import('../src/pk3.js');
  const { createSchema, loadResources, loadMap, SQL_FILES } = await import('../src/loader.js');
  const sql = Object.fromEntries(SQL_FILES.map((m) => [m, fs.readFileSync(path.join(root, `sql/${m}.sql`), 'utf8')]));
  const db = new FirebirdBrowser('memory://quake3', { transport: new DirectTransport() });
  await createSchema(db, sql);
  const pak = new Pk3(fs.readFileSync(process.env.PAK ?? path.join(root, 'public/pak/pak0.pk3')).buffer);
  const res = await loadResources(db, pak);
  await loadMap(db, pak, res, 'q3dm17', { skill: 2, bots: 0, link: false });
  const q = async (s) => (await db.query(s)).rows;
  const pe = (await q('SELECT ent_id e FROM player'))[0].E;
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
  const floor = (await q(`SELECT ez FROM trace_move(NULL, 0,0,0,0,0,0, ${SPOT.x}, ${SPOT.y}, ${SPOT.floor + 40}, ${SPOT.x}, ${SPOT.y}, ${SPOT.floor - 40}, 1)`))[0].EZ;
  assert(Math.abs(floor - SPOT.floor) < 0.5, `the open floor is where it should be (${floor.toFixed(2)})`);
  const tic = (c) => db.query('SELECT * FROM q3_tic(1, ?, ?, ?, 0, 0, ?, 1, 0)', [c.fwd, c.side, c.yawRate * 0.05, c.up > 0 ? 1 : c.up < 0 ? -1 : 0]).then((x) => x.rows[0]);
  const out = {};
  for (const [name, tics] of Object.entries(SCENARIOS)) {
    // start a little back from the middle, facing across it, still, on the floor, the jump key up
    const yaw = 0, back = name === 'standjump' ? 0 : name === 'accel' ? 60 : 170;
    await db.exec(`UPDATE ents SET x = ${SPOT.x - back}, y = ${SPOT.y}, z = ${SPOT.floor + 24.25}, vx = 0, vy = 0, vz = 0, yaw = ${yaw} WHERE id = ${pe}`);
    await db.exec('UPDATE player SET pitch = 0, jump_released = 1, knockback_until = 0 WHERE id = 1');
    await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
    for (let i = 0; i < 4; i++) await tic({ fwd: 0, side: 0, up: 0, yawRate: 0 });
    const rows = [];
    for (const c of tics) {
      // (the tic's own time is the game's next: a knock in it lasts from there)
      if (c.knock) await db.exec(`UPDATE player SET knockback_until = (SELECT time_ FROM game) + 0.05 + ${c.knock} WHERE id = 1`);
      const s = await tic(c);
      rows.push({ x: s.PX, y: s.PY, h: s.PZ - (SPOT.floor + 24), speed: Math.hypot(s.VX, s.VY), walking: s.ONGROUND === 1 });
    }
    out[name] = rows;
  }
  // the falls (PM_CrashLand): from rest at a height h the contact is at sqrt(2 g h), delta = 0.16 h
  out.falls = [];
  for (const [h, crouched] of [[30, 0], [100, 0], [300, 0], [450, 0], [150, 1]]) {
    await db.exec(`UPDATE ents SET x = ${SPOT.x}, y = ${SPOT.y}, z = ${SPOT.floor + 24 + h}, vx = 0, vy = 0, vz = 0, health = 100, flags = BIN_AND(flags, BIN_NOT(512 + 16)), maxz = 32 WHERE id = ${pe}`);
    await db.exec('UPDATE player SET armor = 0, ducked = 0, pain_finished = 0, land_change = 0 WHERE id = 1');
    await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
    const s0 = (await q('SELECT COALESCE(MAX(id), 0) m FROM sound_events'))[0].M;
    let s;
    for (let i = 0; i < 60; i++) { s = await tic({ fwd: 0, side: 0, up: crouched ? -127 : 0, yawRate: 0 }); if (s.ONGROUND === 1) break; }
    const snd = (await q(`SELECT snd FROM sound_events WHERE id > ${s0} ORDER BY id`)).map((r) => r.SND.trim());
    out.falls.push({ h, crouched, damage: 100 - s.HEALTH, dip: s.LAND_CHANGE, sounds: snd });
  }
  await db.exec(`UPDATE ents SET flags = BIN_OR(flags, 16), health = 100 WHERE id = ${pe}`);

  // the ramp (PM_WalkMove on a slope): q3dm17's at x -312, beside its jump pad, its normal (0, 0.447,
  // 0.894), from the floor at 600 (y 600 on) up to 672 (y 444), rising toward -y. Run onto it from the
  // flat at the full run, and down it from its middle at the full run along it, the key held
  const floorAt = async (x, y, top) => {
    for (let z = top; ; z -= 2) {   // from the first height clear of the brushes over it
      const r = (await q(`SELECT ez, startsolid s FROM trace_move(${pe}, -15,-15,-24,15,15,32, ${x}, ${y}, ${z}, ${x}, ${y}, 450, 33619969)`))[0];
      if (!r.S) return r.EZ;
    }
  };
  out.ramp = {};
  for (const [dir, y0, top, yaw, v] of [['up', 690, 640, -90, [0, -320, 0]], ['down', 470, 692, 90, [0, 320 * 0.894, -320 * 0.447]]]) {
    await db.exec(`UPDATE ents SET x = -312, y = ${y0}, z = ${await floorAt(-312, y0, top)}, vx = ${v[0]}, vy = ${v[1]}, vz = ${v[2]}, yaw = ${yaw}, flags = BIN_OR(flags, 512 + 16) WHERE id = ${pe}`);
    await db.exec('UPDATE player SET pitch = 0, jump_released = 1, knockback_until = 0, onground = 1 WHERE id = 1');
    await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
    let a = (await q(`SELECT y, z FROM ents WHERE id = ${pe}`))[0];
    const on = [];
    for (let i = 0; i < 16; i++) {
      const r = await tic({ fwd: 1, side: 0, up: 0, yawRate: 0 });
      // the tics wholly on the slope (the box's near edge on it, its far edge short of the top)
      if (Math.min(a.Y, r.PY) > 460 && Math.max(a.Y, r.PY) < 575)
        on.push({ speed: Math.hypot(r.PY - a.Y, r.PZ - a.Z) / 0.05, horiz: Math.abs(r.PY - a.Y) / 0.05, ground: r.ONGROUND === 1 });
      a = { Y: r.PY, Z: r.PZ };
    }
    out.ramp[dir] = on;
  }

  // a turning platform (G_MoverPush with an amove): q3dm17 has none, so one is made here, a brush
  // 128 x 128 x 16 in a leaf of its own, a model whose head is that leaf, a func_rotating over the open
  // floor with its top at 344. Stand on it 40 from its axis and let it turn 90 degrees a second
  const P = { x: SPOT.x, y: SPOT.y, z: SPOT.floor + 16 };
  const nid = async (t) => (await q(`SELECT COALESCE(MAX(id), 0) + 1 n FROM ${t}`))[0].N;
  const side0 = await nid('brushsides'), brush = await nid('brushes'), lb = await nid('leafbrushes'), leaf = await nid('leaves'), model = await nid('models');
  const sides = [[1, 0, 0, 64], [-1, 0, 0, 64], [0, 1, 0, 64], [0, -1, 0, 64], [0, 0, 1, 0], [0, 0, -1, 16]];
  for (const [k, [nx, ny, nz, d]] of sides.entries()) await db.exec(`INSERT INTO brushsides (id, nx, ny, nz, dist) VALUES (${side0 + k}, ${nx}, ${ny}, ${nz}, ${d})`);
  await db.exec(`INSERT INTO brushes (id, contents, first_side, num_sides, minx, miny, minz, maxx, maxy, maxz) VALUES (${brush}, 1, ${side0}, 6, -64, -64, -16, 64, 64, 0)`);
  await db.exec(`INSERT INTO leafbrushes (id, brush) VALUES (${lb}, ${brush})`);
  await db.exec(`INSERT INTO leaves (id, contents, cluster, minx, miny, minz, maxx, maxy, maxz, first_lf, num_lf, first_lb, num_lb, pvs) VALUES (${leaf}, 1, -1, -64, -64, -16, 64, 64, 0, 0, 0, ${lb}, 1, '')`);
  await db.exec(`INSERT INTO models (id, name, kind, minx, miny, minz, maxx, maxy, maxz, headnode, first_face, num_faces) VALUES (${model}, '*turntable', 'B', -64, -64, -16, 64, 64, 0, ${-(leaf + 1)}, 0, 0)`);
  const plat = (await q(`SELECT id FROM spawn_ent('func_rotating', ${P.x}, ${P.y}, ${P.z})`))[0].ID;
  await db.exec(`UPDATE ents SET model_id = ${model}, solid = 4, movetype = 7, minx = -64, miny = -64, minz = -16, maxx = 64, maxy = 64, maxz = 0, avel_yaw = 0, dmg = 2 WHERE id = ${plat}`);
  await db.exec(`EXECUTE PROCEDURE link_ent(${plat})`);
  const place = async (x, y, z, yaw) => {
    await db.exec(`UPDATE ents SET x = ${x}, y = ${y}, z = ${z}, vx = 0, vy = 0, vz = 0, yaw = ${yaw}, flags = BIN_OR(flags, 16) WHERE id = ${pe}`);
    await db.exec('UPDATE player SET pitch = 0, jump_released = 1, knockback_until = 0 WHERE id = 1');
    await db.exec(`EXECUTE PROCEDURE link_ent(${pe})`);
    for (let i = 0; i < 4; i++) await tic({ fwd: 0, side: 0, up: 0, yawRate: 0 });
  };
  const idle = () => tic({ fwd: 0, side: 0, up: 0, yawRate: 0 });
  await place(P.x + 40, P.y, P.z + 24.25, 0);
  const on0 = await idle();
  await db.exec(`UPDATE ents SET avel_yaw = 90 WHERE id = ${plat}`);
  const turns = [];
  let r;
  for (let i = 0; i < 20; i++) { r = await idle(); turns.push(r.MOVER_YAW); }
  out.turntable = { start: { x: on0.PX, y: on0.PY, z: on0.PZ, yaw: on0.YAW, ground: on0.ONGROUND }, end: { x: r.PX, y: r.PY, z: r.PZ, yaw: r.YAW, ground: r.ONGROUND }, turns,
                    plat: (await q(`SELECT yaw FROM ents WHERE id = ${plat}`))[0].YAW };
  // beside it on the floor, where its corners sweep (90.5 from the axis): swept round, never inside it
  await db.exec(`UPDATE ents SET avel_yaw = 0, yaw = 0 WHERE id = ${plat}`);
  await place(P.x + 82, P.y, SPOT.floor + 24.25, 0);
  const b0 = await idle();
  await db.exec(`UPDATE ents SET avel_yaw = 90 WHERE id = ${plat}`);
  for (let i = 0; i < 10; i++) r = await idle();
  out.turntable.beside = { moved: Math.hypot(r.PX - b0.PX, r.PY - b0.PY), stuck: (await q(`SELECT test_position(${pe}, ${r.PX}, ${r.PY}, ${r.PZ}) s FROM rdb$database`))[0].S,
                           plat: (await q(`SELECT yaw FROM ents WHERE id = ${plat}`))[0].YAW };
  await db.exec(`UPDATE ents SET avel_yaw = 0 WHERE id = ${plat}`);
  await db.close();
  return out;
}

// ── the table ────────────────────────────────────────────────────────────
const fresh = () => ({ x: 0, y: 0, h: 0, vx: 0, vy: 0, vz: 0, yaw: 0, t: 0, jumpHeld: false, walking: true });
const ref8 = {}, ref50 = {};
for (const [name, tics] of Object.entries(SCENARIOS)) { ref8[name] = measure(name, refRun(fresh(), tics, 8)); ref50[name] = measure(name, refRun(fresh(), tics, 50)); }
const refOnly = process.argv.includes('--ref-only');
const sqlRows = refOnly ? null : await sqlRuns();
const falls = refOnly ? [] : sqlRows.falls;
const ramp = refOnly ? null : sqlRows.ramp;
const turntable = refOnly ? null : sqlRows.turntable;
if (!refOnly) { delete sqlRows.falls; delete sqlRows.ramp; delete sqlRows.turntable; }
const sqlM = refOnly ? {} : Object.fromEntries(Object.entries(sqlRows).map(([k, r]) => [k, measure(k, r)]));
console.log('\n' + ['scenario', 'quantity', 'Q3 8 ms', 'Q3 50 ms', 'SQL 50 ms'].map((s) => s.padEnd(16)).join(''));
for (const name of Object.keys(SCENARIOS)) {
  for (const k of Object.keys(ref8[name])) {
    const f = (v) => (v === undefined ? '' : Number.isNaN(v) ? 'never' : v.toFixed(2));
    console.log([name, k, f(ref8[name][k]), f(ref50[name][k]), f(sqlM[name]?.[k])].map((s) => String(s).padEnd(16)).join(''));
  }
}
console.log('');

// ── the checks: the SQL as close to Quake III at 8 ms as a 20 Hz tic allows ──
if (!refOnly) {
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const R = ref8, S = sqlM;
  assert(near(S.standjump.apex, R.standjump.apex, 1), `a jump peaks at Quake III's height (${S.standjump.apex.toFixed(1)}, Q3 ${R.standjump.apex.toFixed(1)})`);
  assert(near(S.standjump['air time'], R.standjump['air time'], 0.051), `and lasts as long (${S.standjump['air time'].toFixed(2)} s, Q3 ${R.standjump['air time'].toFixed(2)} s)`);
  assert(near(S.accel['speed 0.1 s'], R.accel['speed 0.1 s'], 5) && near(S.accel['speed 0.5 s'], 320, 2), `running starts as Quake III's does (${S.accel['speed 0.1 s'].toFixed(0)} at 0.1 s, Q3 ${R.accel['speed 0.1 s'].toFixed(0)}; 320 by 0.5 s)`);
  assert(near(S.crouchwalk['distance in 1 s'], R.crouchwalk['distance in 1 s'], 3) && near(S.crouchwalk['speed at 1 s'], 80, 1), `crouch-walking: 80 at most, as far in a second (${S.crouchwalk['distance in 1 s'].toFixed(1)}, Q3 ${R.crouchwalk['distance in 1 s'].toFixed(1)})`);
  assert(near(S.stop['stop distance'], R.stop['stop distance'], 2), `and stops in the same distance (${S.stop['stop distance'].toFixed(1)}, Q3 ${R.stop['stop distance'].toFixed(1)})`);
  assert(near(S.runjump['jump distance'], R.runjump['jump distance'], 4), `a running jump carries as far (${S.runjump['jump distance'].toFixed(0)}, Q3 ${R.runjump['jump distance'].toFixed(0)})`);
  const gainS = S.strafejump['speed in the air'] - S.strafejump['takeoff speed'], gainR = R.strafejump['speed in the air'] - R.strafejump['takeoff speed'];
  assert(gainR > 0 && near(gainS, gainR, 3), `a strafe-jump gains as much speed in the air (+${gainS.toFixed(1)}, Q3 +${gainR.toFixed(1)})`);
  const heldS = S.heldjump['speed in the air'] - S.heldjump['takeoff speed'], heldR = R.heldjump['speed in the air'] - R.heldjump['takeoff speed'];
  assert(heldR < gainR && near(heldS, heldR, 3), `holding jump in the air takes air control away, as PM_CmdScale does (+${heldS.toFixed(1)}, Q3 +${heldR.toFixed(1)})`);
  assert(near(S.knockstop['stop distance'], R.knockstop['stop distance'], 3) && S.knockstop['stop distance'] > S.stop['stop distance'] + 40, `a knock carries 200 ms without friction (${S.knockstop['stop distance'].toFixed(1)}, Q3 ${R.knockstop['stop distance'].toFixed(1)})`);
  // the ramp: along it at the full 320 (PM_WalkMove keeps the speed, along the plane), its horizontal
  // share cos(26.6°) = the normal's z, never off it
  for (const dir of ['up', 'down']) {
    const on = ramp[dir], n = on.length;
    const sp = on.reduce((a, r) => a + r.speed, 0) / n, hz = on.reduce((a, r) => a + r.horiz, 0) / n;
    assert(n >= 3 && near(sp, 320, 1.5) && near(hz, 320 * 0.894, 1.5) && on.every((r) => r.ground),
      `running ${dir} the ramp: ${sp.toFixed(1)} along it, ${hz.toFixed(1)} across the ground, on the ground all the way (Q3: 320, ${(320 * 0.894).toFixed(1)}; ${n} tics)`);
  }
  // the turntable: a second at 90 degrees a second carries us a quarter round its axis, the view
  // turned with it, on it all the while; beside it, its corners push us round rather than through us
  {
    const T = turntable, a = T.start, b = T.end;
    const ang = (Math.atan2(b.y - SPOT.y, b.x - SPOT.x) - Math.atan2(a.y - SPOT.y, a.x - SPOT.x)) * 180 / Math.PI;
    const dyaw = ((b.yaw - a.yaw) % 360 + 360) % 360;
    assert(a.ground && b.ground && near(ang, 90, 0.5) && near(Math.hypot(b.x - SPOT.x, b.y - SPOT.y), 40, 0.5) && near(dyaw, 90, 0.5) && near(b.z, a.z, 0.1) && near(T.plat, 90, 0.01),
      `riding a turning platform: carried ${ang.toFixed(1)} degrees round its axis, the view ${dyaw.toFixed(1)}, ${Math.hypot(b.x - SPOT.x, b.y - SPOT.y).toFixed(1)} from it (Q3: 90, 90, 40)`);
    assert(T.turns.every((t) => near(t, 4.5, 0.01)), `the tic says how far the mover turned us, for the view between tics (${T.turns[0].toFixed(2)} a tic)`);
    assert(T.beside.moved > 10 && T.beside.stuck === 0 && near(T.beside.plat, 45, 0.01),
      `beside it, its corners push us round (${T.beside.moved.toFixed(1)} units), never inside it, and it keeps turning (${T.beside.plat.toFixed(1)} degrees)`);
  }
  // the falls: what PM_CrashLand's delta (0.16 h from rest, doubled crouched) makes of each
  for (const f of falls) {
    const delta = 0.16 * f.h * (f.crouched ? 2 : 1);
    const want = delta > 60 ? { damage: 10, dip: -24, sound: '/fall1.wav' } : delta > 40 ? { damage: 5, dip: -16, sound: '/pain100_1.wav' }
      : delta > 7 ? { damage: 0, dip: -8, sound: 'sound/player/land1.wav' } : { damage: 0, dip: 0, sound: 'footsteps/step' };
    const heard = f.sounds.some((n) => n.includes(want.sound));
    const pain = f.sounds.some((n) => /\/pain(25|50|75|100)_1\.wav$/.test(n)) && want.sound !== '/pain100_1.wav';
    assert(f.damage === want.damage && f.dip === want.dip && heard && !pain,
      `a fall of ${f.h}${f.crouched ? ' crouched' : ''} (delta ${delta.toFixed(1)}): ${f.damage} damage, the ${f.dip} dip, ${f.sounds.filter((n) => !n.includes('talk')).join(' ') || 'silence'}`);
  }
}
console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
