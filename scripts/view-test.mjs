// view-test.mjs – the first-person view's offsets (src/scene.js firstPersonView), as Quake III's cgame
// has them: the kick away from a hit, the dip of a landing, the lean of the run, the bob of the steps;
// and the impact marks clipped to the world's faces (FrameState.impactMark).
// Pure JavaScript, no engine: rows shaped like Q3_TIC's.
//
//   node scripts/view-test.mjs

import fs from 'node:fs';
import { FrameState, firstPersonView, zoomedFov, fovY, mapTorsoToWeaponFrame, viewTorsoFrame, underwaterFov } from '../src/scene.js';
import { tagTransform } from '../src/renderer.js';
import { Md3, parseAnimationCfg } from '../src/md3.js';
import { Pk3 } from '../src/pk3.js';

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

// under water (CG_CalcFov): the view waves a degree either way at 0.4 Hz, only with the head under
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert(near(underwaterFov(90, 2, 0.625), 90) && near(underwaterFov(90, 3, 0.625), 91) && near(underwaterFov(90, 3, 1.875), 89) && near(underwaterFov(90, 3, 2.5), 90),
    'the head under a liquid: the field of view waves ±1 degree, 2.5 s a wave; waist-deep, nothing');
}
// the bubbles (CG_BubbleTrail): every 32 units, rising, gone after their second
{
  const st = new FrameState();
  st.bubbleTrail([0, 0, 0], [0, 0, -320], 32, 10);
  const up = st.bubbles.every((b) => b.v[2] >= 1 && b.v[2] <= 11 && Math.abs(b.v[0]) <= 5 && b.dur >= 1 && b.dur <= 1.25);
  assert(st.bubbles.length === 11 && up, `a 320-unit shot under water leaves 11 bubbles drifting up (${st.bubbles.length})`);
}

// the switch (CG_MapTorsoToWeaponFrame): sarge's torso frames onto the hand's
{
  const anims = []; anims[7] = { first: 130, count: 6, loop: 0, fps: 15 }; anims[8] = { first: 136, count: 6, loop: 0, fps: 15 };
  anims[9] = { first: 142, count: 5, loop: 0, fps: 20 }; anims[10] = { first: 147, count: 4, loop: 0, fps: 20 }; anims[11] = { first: 151, count: 1, loop: 0, fps: 15 };
  const m = (f) => mapTorsoToWeaponFrame(anims, f);
  assert(m(151) === 0 && m(130) === 1 && m(135) === 6 && m(136) === 1 && m(142) === 6 && m(146) === 10 && m(147) === 11 && m(150) === 14,
    'the torso maps onto the hand: stand 0, attack 1–6, drop 6–10, raise 11–14');
  const at = (state, wt, t, extra = {}) => viewTorsoFrame(anims, { WEAPONSTATE: state, WEAPON_TIME: wt, WEAPON: 2, ATTACK_START: 0, ...extra }, t);
  assert(at(2, 10.2, 10.01) === 142 && at(2, 10.2, 10.12) === 144 && at(2, 10.2, 10.17) === 145, 'dropping: the drop from its start, 20 frames a second');
  assert(at(3, 10.25, 10.01) === 147 && at(3, 10.25, 10.17) === 150 && at(3, 10.25, 10.24) === 150, 'raising: the raise, held on its last frame');
  assert(at(0, 0, 10) === 151 && at(0, 0, 10.05, { ATTACK_START: 10 }) === 130 && at(0, 0, 10.05, { ATTACK_START: 10, WEAPON: 1 }) === 136, 'at rest standing; firing the attack, the gauntlet its own');
}

// the marks (CG_ImpactMark): a wall at x = 0 facing +x, 256 square, of two faces split at y = 0; a floor
// facing up; a ceiling facing down. Faces as bsp.js builds them: a convex outline, its normal, a sphere
const face = (pts, normal) => {
  const verts = new Float32Array(pts.length * 10);
  pts.forEach((q, k) => verts.set(q, k * 10));
  const c = [0, 1, 2].map((i) => pts.reduce((a, q) => a + q[i], 0) / pts.length);
  return { type: 1, texture: 0, nverts: pts.length, verts, normal, center: c, radius: Math.max(...pts.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]))) };
};
const markBsp = {
  textures: [{ flags: 0 }],
  faces: [
    face([[0, -128, 0], [0, 0, 0], [0, 0, 256], [0, -128, 256]], [1, 0, 0]),
    face([[0, 0, 0], [0, 128, 0], [0, 128, 256], [0, 0, 256]], [1, 0, 0]),
    face([[0, -128, 0], [256, -128, 0], [256, 128, 0], [0, 128, 0]], [0, 0, 1]),
    face([[0, -128, 256], [0, 128, 256], [256, 128, 256], [256, -128, 256]], [0, 0, -1]),
  ],
  models: [{ firstFace: 0, numFaces: 4 }],
};
{
  const st = new FrameState();
  st.impactMark(markBsp, 'gfx/damage/bullet_mrk', [0, 50, 128], [1, 0, 0], 8, 10);
  assert(st.marks.length === 1 && st.marks[0].pts.every((v, i) => i % 3 !== 0 || Math.abs(v - 0.5) < 1e-6), 'a bullet in the middle of the wall: one mark, lifted half a unit off it');
  const m = st.marks[0];
  const span = Math.max(...Array.from(m.pts).filter((_, i) => i % 3 === 1)) - Math.min(...Array.from(m.pts).filter((_, i) => i % 3 === 1));
  assert(span > 15.9 && span <= 8 * 2 * Math.SQRT2 + 1e-6 && m.st.every((v) => v > -1e-6 && v < 1 + 1e-6), `its square is 16 across, turned, and its texture coordinates span 0 to 1 (${span.toFixed(1)} wide)`);
  st.marks = [];
  st.impactMark(markBsp, 'gfx/damage/burn_med_mrk', [0, 10, 20], [1, 0, 0], 64, 10);
  assert(st.marks.length === 2, `a rocket low on the wall, by the seam: a piece on each face, none on the floor at right angles to it (${st.marks.length})`);
  st.marks = [];
  st.impactMark(markBsp, 'gfx/damage/burn_med_mrk', [0, 10, 128], [1, 0, 0], 64, 10);
  assert(st.marks.length === 2, `a rocket in the middle of the wall: the floor and ceiling are out of reach (${st.marks.length})`);
  st.marks = [];
  st.impactMark(markBsp, 'gfx/damage/burn_med_mrk', [100, 0, 0], [0, 0, 1], 64, 10);
  assert(st.marks.length === 1, `a grenade on the floor: the floor only; the wall does not face it (${st.marks.length})`);
  st.marks = [];
  for (let i = 0; i < 300; i++) st.impactMark(markBsp, 'gfx/damage/bullet_mrk', [0, 50, 128], [1, 0, 0], 8, 10 + i * 0.01);
  assert(st.marks.length === 256 && st.marks[0].t0 > 10.4, `at most 256 pieces, the oldest go first (${st.marks.length})`);
}

// and the hand model really carries the gun down on those frames (with the pak, when it is there)
if (fs.existsSync('public/pak/pak0.pk3')) {
  const pak = new Pk3(fs.readFileSync('public/pak/pak0.pk3').buffer);
  const name = 'models/weapons2/machinegun/machinegun_hand.md3';
  const hand = new Md3(pak.buffer(name), name);
  const z = (f) => tagTransform(hand, f, 'tag_weapon', [0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1]).origin[2];
  const lowest = Math.min(...[6, 7, 8, 9, 10, 11, 12, 13, 14].map(z));
  assert(z(0) - lowest > 5, `the machinegun's hand lowers the gun while switching (${(z(0) - lowest).toFixed(1)} units at the bottom)`);
  const anims = parseAnimationCfg(pak.text('models/players/sarge/animation.cfg'));
  assert(anims[9].first + anims[9].count === anims[10].first && anims[9].count + anims[10].count === 9, 'sarge\'s drop and raise are the nine frames in a row the mapping expects');
}

console.log(failed ? `${failed} FAILED` : 'all good');
process.exit(failed ? 1 : 0);
