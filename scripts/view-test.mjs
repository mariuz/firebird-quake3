// view-test.mjs – the first-person view's offsets (src/scene.js firstPersonView), as Quake III's cgame
// has them: the kick away from a hit, the dip of a landing, the lean of the run, the bob of the steps.
// Pure JavaScript, no engine: rows shaped like Q3_TIC's.
//
//   node scripts/view-test.mjs

import { FrameState, firstPersonView, zoomedFov, fovY } from '../src/scene.js';

let failed = 0;
const assert = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); failed++; } else console.log(`ok   ${m}`); };
const row = (o = {}) => ({
  TIME_: 10, PX: 0, PY: 0, PZ: 0, VIEW_Z: 26, YAW: 0, PITCH: 0, HEALTH: 100, DEAD: 0, MATCH_OVER: 0, ONGROUND: 1, DUCKED: 0,
  VX: 0, VY: 0, DMG_TIME: -10, DMG_TAKE: 0, DMG_SAVE: 0, DMG_X: 0, DMG_Y: 0, DMG_Z: 0, DMG_WORLD: 1, LAND_TIME: -10, LAND_CHANGE: -8, ...o,
});
// at the peak of a kick (100 ms after the hit), from a fresh state that has seen the quiet row first
const kickAt = (hit) => {
  const st = new FrameState();
  firstPersonView(row(), st);
  firstPersonView(row({ ...hit, TIME_: 10 }), st);
  return firstPersonView(row({ ...hit, TIME_: 10.1 }), st);
};

// facing +x; a hit from in front pitches the view up (negative pitch), one from the left rolls it
const front = kickAt({ DMG_TIME: 10, DMG_TAKE: 20, DMG_X: 500, DMG_Y: 0, DMG_Z: 26, DMG_WORLD: 0 });
assert(front.pitch < -4.9 && Math.abs(front.roll) < 0.01, `a hit from the front kicks the view up (pitch ${front.pitch.toFixed(2)})`);
const left = kickAt({ DMG_TIME: 10, DMG_TAKE: 20, DMG_X: 0, DMG_Y: 500, DMG_Z: 26, DMG_WORLD: 0 });
assert(left.roll > 4.9 && Math.abs(left.pitch) < 0.01, `a hit from the left rolls it (roll ${left.roll.toFixed(2)})`);
const behind = kickAt({ DMG_TIME: 10, DMG_TAKE: 20, DMG_X: -500, DMG_Y: 0, DMG_Z: 26, DMG_WORLD: 0 });
assert(behind.pitch > 4.9, `a hit from behind kicks it down (pitch ${behind.pitch.toFixed(2)})`);
const world = kickAt({ DMG_TIME: 10, DMG_TAKE: 10, DMG_WORLD: 1 });
assert(world.pitch < -4.9 && world.roll === 0, `a fall or lava kicks straight up (pitch ${world.pitch.toFixed(2)})`);
// harder the lower the health, between 5 and 10 degrees
const weak = kickAt({ DMG_TIME: 10, DMG_TAKE: 20, DMG_WORLD: 1, HEALTH: 20 });
const strong = kickAt({ DMG_TIME: 10, DMG_TAKE: 200, DMG_WORLD: 1, HEALTH: 20 });
assert(weak.pitch <= -9.9 && strong.pitch >= -10.01, `low on health the kick is the most, and never more than 10 (${weak.pitch.toFixed(1)}, ${strong.pitch.toFixed(1)})`);
// and it is gone half a second later
{
  const st = new FrameState();
  firstPersonView(row(), st);
  const hit = { DMG_TIME: 10, DMG_TAKE: 20, DMG_WORLD: 1 };
  firstPersonView(row({ ...hit, TIME_: 10 }), st);
  const after = firstPersonView(row({ ...hit, TIME_: 10.55 }), st);
  assert(Math.abs(after.pitch) < 0.01, `the kick has returned after half a second (pitch ${after.pitch.toFixed(3)})`);
}

// the landing: the view dips by the fall's size at 150 ms, and is back by 450
{
  const st = new FrameState();
  const at = (t) => firstPersonView(row({ TIME_: t, LAND_TIME: 10, LAND_CHANGE: -24 }), st);
  const dip = at(10.15), back = at(10.46);
  assert(Math.abs(dip.z - (26 - 24)) < 0.01 && Math.abs(back.z - 26) < 0.01, `a far fall dips the view 24 units and brings it back (${dip.z.toFixed(1)}, ${back.z.toFixed(1)})`);
  assert(Math.abs(dip.gun.z - -6) < 0.01, `the gun drops a quarter as far (${dip.gun.z.toFixed(1)})`);
}

// the run: strafing left at 320 rolls the view, running forward pitches it
{
  const st = new FrameState();
  const strafe = firstPersonView(row({ VX: 0, VY: 320, ONGROUND: 0 }), st);
  assert(Math.abs(strafe.roll - -1.6) < 0.01, `strafing left at full speed leans the view 1.6 degrees (roll ${strafe.roll.toFixed(2)})`);
  const run = firstPersonView(row({ VX: 320, VY: 0, ONGROUND: 0 }), st);
  assert(Math.abs(run.pitch - 0.64) < 0.2, `running forward tips it forward (pitch ${run.pitch.toFixed(2)})`);
}

// the bob: up and down with the steps, rolling the other way each step; nothing standing still
{
  const st = new FrameState();
  let maxZ = 0, rolls = new Set();
  for (let i = 0; i < 40; i++) {
    const v = firstPersonView(row({ TIME_: 10 + i * 0.05, VX: 320, VY: 0 }), st, 0.05);
    maxZ = Math.max(maxZ, v.z - 26);
    if (Math.abs(v.roll) > 0.2) rolls.add(Math.sign(v.roll));
  }
  assert(maxZ > 1 && maxZ <= 6, `the eye bobs with the run (up to ${maxZ.toFixed(2)} units)`);
  assert(rolls.size === 2, 'the roll swings to both sides with the steps');
  const still = firstPersonView(row({ TIME_: 13 }), st, 0.05);
  assert(still.z === 26 && Math.abs(still.roll) < 1e-9, 'standing still: no bob');
}

// the dead and the intermission are not kicked
{
  const st = new FrameState();
  const dead = firstPersonView(row({ DEAD: 1, DMG_TIME: 10, DMG_TAKE: 50, DMG_WORLD: 1 }), st);
  assert(dead.roll === 40 && dead.pitch === 0, 'the dead lie on their side, unkicked');
  const over = firstPersonView(row({ MATCH_OVER: 1, VX: 320 }), st);
  assert(over.roll === 0 && over.pitch === 0 && over.z === 26, 'the intermission camera holds still');
}

// the zoom (CG_CalcFov): 90 → 22.5 in 150 ms while held, back as fast once released
{
  const near = (a, b) => Math.abs(a - b) < 0.01;
  assert(near(zoomedFov(90, false, 1e9), 90) && near(zoomedFov(90, true, 0), 90) && near(zoomedFov(90, true, 75), 56.25) && near(zoomedFov(90, true, 150), 22.5) && near(zoomedFov(90, true, 5000), 22.5),
    'zooming in: 90, half-way at 75 ms, 22.5 from 150 ms on');
  assert(near(zoomedFov(90, false, 0), 22.5) && near(zoomedFov(90, false, 75), 56.25) && near(zoomedFov(90, false, 150), 90), 'and out again');
  const y = fovY(22.5, 640, 480);
  assert(Math.abs(y - 16.97) < 0.05 && Math.abs(y / 75 - 0.226) < 0.002, `zoomed on 4:3, fov_y ${y.toFixed(2)}, the mouse at ${(y / 75).toFixed(3)} of its speed`);
  assert(Math.abs(fovY(90, 640, 480) - 73.74) < 0.05, 'fov_y of 90 on 4:3 is 73.74');
}

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
