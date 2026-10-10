// view-test.mjs – the first-person view's offsets (src/scene.js firstPersonView), as Quake III's cgame
// has them: the kick away from a hit, the dip of a landing, the lean of the run, the bob of the steps;
// and the impact marks clipped to the world's faces (FrameState.impactMark).
// Pure JavaScript, no engine: rows shaped like Q3_TIC's.
//
//   node scripts/view-test.mjs

import fs from 'node:fs';
import { FrameState, firstPersonView, zoomedFov, fovY, mapTorsoToWeaponFrame, viewTorsoFrame, underwaterFov, sceneLights, litByDlights, MAX_DLIGHTS, drawRail, drawBolt, findPortals, portalView, portalFade, perpendicular, floorBelow, drawShadows } from '../src/scene.js';
import { Renderer, tagTransform, autospriteQuads, fogST, fogFactor } from '../src/renderer.js';
import { parseDeform, waveValue, deformVertex, envTexCoords, parseShaderScript, surfaceLook, shellMesh, eyeInModel } from '../src/shader.js';
import { Md3, parseAnimationCfg } from '../src/md3.js';
import { postgameMedals } from '../src/hud.js';
import { parseWeights, preprocess, weightOf } from '../src/itemweights.js';
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

// the rocket's trail: a puff every 50 ms of flight wherever the frames fall, none twice or skipped
{
  const st = new FrameState();
  let t = 0;
  for (const dt of [0.016, 0.017, 0.033, 0.05, 0.004, 0.08, 0.016, 0.034, 0.1]) { t += dt; st.missileTrail(7, [t * 900, 0, 0], t, 2, 64); }
  const times = st.puffs.map((p) => Math.round(p.t0 * 1000));
  assert(times.join(',') === '50,100,150,200,250,300,350', `a rocket's puffs fall every 50 ms (${times.join(',')})`);
  assert(st.puffs.every((p) => Math.abs(p.p[0] - p.t0 * 900) < 1e-6), 'each puff is where the rocket was at its time');
}
// the shells fall on a floor at z = 0 and lie there, never through it
{
  const st = new FrameState();
  const floor = { pointContents: (x, y, z) => (z < 0 ? 1 : 0) };
  for (let i = 0; i < 20; i++) st.ejectBrass(0, 0, 0, i * 18, i % 2 ? 2 : 4, 10);
  for (let i = 0; i < 120; i++) st.moveBrass(floor, 0.016);
  assert(st.brass.length === 30 && st.brass.every((b) => b.rest && b.p[2] >= 0 && b.p[2] < 4), `30 shells from 10 bullets and 10 shotgun blasts all lie on the floor (${st.brass.filter((b) => b.rest).length} at rest)`);
}

// the dynamic lights: a rocket's explosion at 300 for the first half of the explosion, fading to nothing by its
// end; a rocket in flight at 200; the muzzle flash while firing; the nearest 8 when there are more
{
  const st = new FrameState();
  st.handleFx({ spawnParticles() {} }, [[0, 2, 100, 0, 0, -1, 0, 0, 0]], 10);
  const quiet = row({ WEAPON: 2, ATTACK_START: 0, QUAD: 0, SPECTATOR: 0 });
  const view = { x: 0, y: 0, z: 26, yaw: 0, pitch: 0 };
  const at = (t, ents = []) => sceneLights(st, { ents }, quiet, view, t);
  assert(at(10.1).length === 1 && at(10.1)[0].radius === 300 && at(10.1)[0].color.join() === '1,0.75,0', 'an explosion lights at 300, orange');
  assert(Math.abs(at(10.45)[0].radius - 150) < 1e-6 && at(10.59)[0].radius < 12, `it fades in the second half (${at(10.45)[0].radius.toFixed(0)} at three quarters)`);
  const rockets = Array.from({ length: 12 }, (_, i) => ({ x: 1000 - i * 50, y: 0, z: 0, effects: 16 }));
  const many = at(20, rockets);
  assert(many.length === MAX_DLIGHTS && many[0].x === 450 && many.every((l) => l.radius === 200), `twelve rockets: the ${MAX_DLIGHTS} nearest, at 200`);
  const firing = sceneLights(st, { ents: [] }, row({ WEAPON: 64, ATTACK_START: 19.95, TIME_: 20 }), view, 20);
  assert(firing.length === 1 && firing[0].radius >= 300 && firing[0].color.join() === '1,0.5,0', 'the railgun\'s muzzle flash lights orange at 300 and more');
  // a bot firing (its torso's attack animation restarted under a tenth of a second ago): its gun's light ahead
  // of it; not later, not a corpse
  const bot = (torso, tt, cls = 'bot') => ({ pmodel: 'sarge/default', anims: `15,${torso},100,${cls}`, torsoTime: tt, weapon: 16, effects: 0, x: 500, y: 0, z: 0, yaw: 90 });
  const shot = at(20, [bot(7, 19.95)]);
  assert(shot.length === 1 && shot[0].color.join() === '1,0.75,0' && Math.abs(shot[0].y - 24) < 1e-6 && shot[0].radius >= 300
    && at(20, [bot(7, 19.85)]).length === 0 && at(20, [bot(11, 19.95)]).length === 0 && at(20, [bot(7, 19.95, 'corpse')]).length === 0,
    `a bot's rocket launcher flashes orange at 300 ahead of it, for a tenth of a second (${shot.map((l) => l.radius.toFixed(0)).join()})`);
  const grid = { ambient: [20, 20, 20], directed: [10, 10, 10], dir: [0, 0, 1] };
  const lit = litByDlights(grid, 0, 0, 0, [{ x: 100, y: 0, z: 0, radius: 200, color: [1, 0.75, 0] }]);
  assert(Math.abs(lit.directed[0] - 10 - 64) < 1e-6 && Math.abs(lit.directed[1] - 10 - 48) < 1e-6 && lit.dir[0] > 0.9, `a model 100 units from a 200 light: 16 r² / d² = 64 more directed light, from its side (${lit.directed.map((v) => v.toFixed(0)).join(' ')})`);
}

// the shader features: deformVertexes wave and move, tcGen environment, autosprite, chrome under a picture
{
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert(near(waveValue(0, 0, 3, 0, 0.5, 1), 0) && near(waveValue(0, 0, 3, 0.25, 0, 0), 3) && near(waveValue(1, 1, 2, 0.5, 0, 0), 1) && near(waveValue(3, 0, 1, 0.75, 0, 0), 0.75),
    'the wave forms: sin, triangle and sawtooth over a period');
  const wave = parseDeform(['wave', '100', 'sin', '0', '3', '0', '.7']);
  assert(wave.kind === 1 && near(wave.spread, 0.01) && wave.amp === 3 && wave.freq === 0.7, 'deformVertexes wave 100 sin 0 3 0 .7: spread 1/100');
  const p = deformVertex([wave], 25, 0, 0, 0, 1, 0, 0);   // phase 0.25 from x + y + z = 25: the sine's top
  assert(near(p[0], 25) && near(p[1], 3) && near(p[2], 0), `a vertex waves along its normal by the amplitude (${p.map((v) => v.toFixed(2)).join(' ')})`);
  const move = parseDeform(['move', '0', '0', '3', 'sin', '0', '5', '0', '0.1']);
  const q = deformVertex([move], 0, 0, 0, 1, 0, 0, 2.5);   // a quarter period in: 5 × 3 up
  assert(move.kind === 2 && near(q[2], 15) && near(q[0], 0), `deformVertexes move 0 0 3 sin 0 5 0 0.1 lifts by 15 at its top (${q[2].toFixed(2)})`);
  const head = envTexCoords(0, 0, 0, 0, -1, 0, 0, -100, 0);
  const side = envTexCoords(0, 0, 0, 0, -1, 0, 0, -100, 100);
  assert(near(head[0], 0) && near(head[1], 0.5) && side[1] > head[1], `tcGen environment: head-on the reflection is the picture's edge, from above it moves (${side.map((v) => v.toFixed(2)).join(' ')})`);
  const quad = { nverts: 4, verts: new Float32Array(40) };
  [[0, -8, -8], [0, 8, -8], [0, 8, 8], [0, -8, 8]].forEach((v, i) => quad.verts.set(v, i * 10));
  const spr = autospriteQuads(quad, { image: 'flare', blend: 'add' }, 100, 0, 0);
  assert(spr.length === 1 && near(spr[0].center[0], 100) && Math.abs(spr[0].size - 16) < 0.01, `an autosprite quad 16 across becomes a sprite 16 across at its middle (${spr[0].size.toFixed(2)})`);
  const shaders = parseShaderScript(`textures/x/shiny { { map textures/fx/tin.tga tcGen environment } { map textures/x/shiny.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA } { map $lightmap blendFunc GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA } }
    textures/x/flag { cull disable deformVertexes wave 30 sin 0 3 0 .2 deformVertexes wave 100 sin 0 3 0 .7 { map textures/x/flag.tga } }`);
  const shiny = surfaceLook(shaders, 'textures/x/shiny'), flag = surfaceLook(shaders, 'textures/x/flag');
  assert(shiny.image === 'textures/x/shiny.tga' && shiny.env?.image === 'textures/fx/tin.tga' && shiny.env.mode === 'under' && shiny.blend === 'opaque' && shiny.lightmapped,
    'a picture over a chrome: the picture on top, the chrome under it, opaque and lightmapped');
  assert(flag.deforms?.length === 2 && near(flag.deforms[0].spread, 1 / 30), 'both of a banner\'s waves are kept');
}

// fog volumes (RB_CalcFogTexCoords, R_FogFactor): a fog with its surface at z = 0, opaque at 400
{
  const fogShaders = parseShaderScript(`textures/x/fog { surfaceparm fog fogparms ( .75 .38 0 ) 400 }
    textures/x/hellfog { surfaceparm fog fogparms ( .5 .1 .1 ) 128 { map textures/x/cloud.tga blendfunc gl_dst_color gl_zero } }`);
  const fogSh = fogShaders.get('textures/x/fog');
  assert(fogSh.fog && fogSh.fog.opaque === 400 && fogSh.fog.color.join() === '0.75,0.38,0', 'fogparms ( .75 .38 0 ) 400 parsed');
  assert(surfaceLook(fogShaders, 'textures/x/fog').nodraw && !surfaceLook(fogShaders, 'textures/x/hellfog').nodraw, 'a fog surface with no stages draws nothing; one with clouds draws them');
  const fog = { color: [0.75, 0.38, 0], opaque: 400, plane: { nx: 0, ny: 0, nz: 1, dist: 0 } };
  const at = (eye, p) => { const [s, t] = fogST(fog, p[0], p[1], p[2], { x: eye[0], y: eye[1], z: eye[2], fwd: [1, 0, 0] }); return fogFactor(s, t); };
  assert(at([0, 0, -10], [100, 0, -10]) > 0.49 && at([0, 0, -10], [100, 0, -10]) < 0.51, 'inside the fog, a point a quarter of the way to opaque is half fogged (the square root)');
  assert(at([0, 0, -10], [800, 0, -10]) === 1 && at([0, 0, -10], [100, 0, 50]) === 0, 'past opaque it is all fog; above the surface none');
  const half = at([0, 0, 100], [400, 0, -100]);
  assert(Math.abs(half - Math.sqrt(0.5)) < 1e-6, `from above, a point as deep under the surface as the eye is over it gets half the depth's fog (${half.toFixed(3)})`);
}

// a portal (R_GetPortalOrientations, R_MirrorViewBySurface): a surface in the plane y = 0 seen from y > 0, a camera
// at (1000, 0, 0) looking at (1000, -100, 0); looking into the surface is looking where the camera looks
{
  const v = (k) => Array.from(perpendicular(k)).map((x) => Math.round(x * 1000) / 1000).join();
  assert(v([0, 1, 0]) === '1,0,0' && v([0, 0, 1]) === '1,0,0' && v([1, 0, 0]) === '0,1,0', 'PerpendicularVector: the axis the vector leans on least');
  const face = { type: 1, texture: 0, nverts: 4, verts: new Float32Array(40), tris: new Uint16Array([0, 1, 2, 0, 2, 3]), center: [0, 0, 0], radius: 40 };
  [[-32, 0, -32], [32, 0, -32], [32, 0, 32], [-32, 0, 32]].forEach((p, i) => face.verts.set(p, i * 10));
  const bsp = {
    faces: [face], textures: [{ name: 'portal' }],
    entities: [
      { classname: 'misc_portal_surface', origin: '0 0 0', target: 'cam' },
      { classname: 'misc_portal_camera', targetname: 'cam', target: 'aim', origin: '1000 0 0' },
      { classname: 'target_position', targetname: 'aim', origin: '1000 -100 0' },
    ],
  };
  const portals = findPortals(bsp, (n) => ({ portal: n === 'portal' }));
  assert(portals.length === 1 && portals[0].faces.has(0), 'the portal surface finds its camera and its face');
  const pv = portalView(portals[0], { x: 0, y: 100, z: 0, yaw: 270, pitch: 0, fov: 90 });
  assert(pv.x === 1000 && Math.abs(pv.fwd[1] + 1) < 1e-6 && Math.abs(pv.up[2] - 1) < 1e-6, `looking into the portal looks where the camera does, upright (forward ${pv.fwd.map((x) => x.toFixed(2)).join(' ')})`);
  const turned = portalView(portals[0], { x: 0, y: 100, z: 0, yaw: 300, pitch: 0, fov: 90 });
  assert(turned.yaw > pv.yaw + 25 && turned.yaw < pv.yaw + 35, `turning 30 degrees turns the view through the portal 30 (${(turned.yaw - pv.yaw).toFixed(1)})`);
  assert(Math.abs(portalFade(portals[0], { x: 0, y: 128, z: 0 }) - 0.5) < 1e-6 && portalFade(portals[0], { x: 0, y: 300, z: 0 }) === 0, 'alphaGen portal 256: half the view at 128 units, none past 256');
  const rolled = findPortals({ ...bsp, entities: bsp.entities.map((e) => (e.classname === 'misc_portal_camera' ? { ...e, roll: '180' } : e)) }, (n) => ({ portal: n === 'portal' }));
  const upside = portalView(rolled[0], { x: 0, y: 100, z: 0, yaw: 270, pitch: 0, fov: 90 });
  assert(Math.abs(upside.up[2] + 1) < 1e-6 && Math.abs(Math.abs(upside.roll) - 180) < 1e-6, 'a camera rolled 180 turns the view over');
}

// the blob shadows (CG_PlayerShadow): the floor found within 128 units, the shadow darker the nearer it is
{
  const floor = { pointContents: (x, y, z) => (z < 0 ? 1 : 0) };
  assert(Math.abs(floorBelow(floor, 0, 0, 24) - 0) <= 1 && floorBelow(floor, 0, 0, 200) === null && floorBelow(floor, 0, 0, -5) === null,
    'the floor 24 units down is found to the unit; none past 128, none from inside a brush');
  const st = new FrameState();
  const drawn = [];
  const r = { drawMark: (pts, stc, n, img, blend, color) => drawn.push({ img, blend, k: color[0] }) };
  st.markBsp = { models: [] }; st.markFaces = [{ type: 1, nverts: 4, verts: Float32Array.from([-64, -64, 0, 0, 0, 0, 0, 0, 0, 0, 64, -64, 0, 0, 0, 0, 0, 0, 0, 0, 64, 64, 0, 0, 0, 0, 0, 0, 0, 0, -64, 64, 0, 0, 0, 0, 0, 0, 0, 0]), normal: [0, 0, 1], center: [0, 0, 0], radius: 91 }];
  const bsp = { ...floor, ...st.markBsp };
  st.markBsp = bsp;
  drawShadows(r, st, bsp, { ents: [{ pmodel: 'sarge/default', x: 0, y: 0, z: 24, yaw: 0, effects: 0 }, { pmodel: 'sarge/default', x: 20, y: 0, z: 88, yaw: 0, effects: 0 }] }, { DEAD: 1 }, 10);
  assert(drawn.length === 2 && drawn.every((d) => d.img === 'gfx/damage/shadow' && d.blend === 'subtract') && drawn[0].k > drawn[1].k && Math.abs(drawn[0].k - (1 - 24 / 128)) < 0.02,
    `a shadow under each player, darker for the one on the ground (${drawn.map((d) => d.k.toFixed(2)).join(', ')})`);
  assert(st.marks.length === 0, 'and they are not kept as marks');
}

// the rail (cg_oldRail 1: RB_SurfaceRailCore and the rings of DoRailDiscs) and the lightning (four ribbons, two stages)
{
  const st = new FrameState();
  const calls = [];
  const r = { drawMark: (pts, stc, n, img, blend, color) => calls.push({ img, blend, k: color[0] }), spawnParticles() {} };
  st.handleFx(r, [[0, 4, 0, 0, 40, 320, 0, 40, 0], [0, 12, 0, 50, 40, 200, 50, 40, 0]], 10);
  const [rail, bolt] = st.beams;
  assert(rail.kind === 'rail' && bolt.kind === 'bolt' && rail.a[2] === 32 && Math.abs(rail.until - 10.4) < 1e-6, 'a rail shot lasts 0.4 s, nudged 8 down; a lightning beam its tic');
  const view = { x: 0, y: -200, z: 40 };
  drawRail(r, view, rail, 10);
  const discs = calls.filter((c) => c.img === 'gfx/misc/raildisc_mono2').length, cores = calls.filter((c) => c.img === 'gfx/misc/railcorethin_mono');
  assert(cores.length === 1 && discs === 320 / 32 - 1 && calls.every((c) => c.blend === 'add'), `a 320-unit rail: its core and a ring every 32 units but the last (${discs})`);
  calls.length = 0; drawRail(r, view, rail, 10.3);
  assert(Math.abs(calls[0].k - 0.375 * 0.25) < 1e-6, `three quarters through, a quarter of its colour is left (${calls[0].k.toFixed(3)})`);
  calls.length = 0; drawBolt(r, view, bolt, 10);
  assert(calls.length === 8 && calls.every((c) => c.img === 'gfx/misc/lightning3'), 'the lightning: four ribbons, each in two stages');
}

// the powerups' shells (CG_AddRefEntityWithPowerups): powerups/quad pushes a vertex 3 out along its normal, its
// texture the eye reflected in it, turned 30 degrees a second and scrolled (1, 0.1) a second
{
  const look = surfaceLook(parseShaderScript(`powerups/quad
{
  deformVertexes wave 100 sin 3 0 0 0
  {
    map textures/effects/quadmap2.tga
    blendfunc GL_ONE GL_ONE
    tcGen environment
    tcmod rotate 30
    tcmod scroll 1 .1
  }
}`), 'powerups/quad');
  // one vertex at z = 10 with its normal up (latitude and longitude 0), the eye straight above
  const surf = { numVerts: 1, xyz: Int16Array.of(0, 0, 640, 0) };
  const eye = eyeInModel({ x: 100, y: 0, z: 100 }, [100, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const a = shellMesh(surf, 0, eye, look, 0), b = shellMesh(surf, 0, eye, look, 1);
  const near = (x, y) => Math.abs(x - y) < 1e-4;
  assert(look.blend === 'add' && near(a.xyz[2], 13) && near(a.st[0], 0.5) && near(a.st[1], 0),
    `the quad's shell: 3 out (z ${a.xyz[2]}), the eye's reflection at (0.5, 0) (${a.st[0].toFixed(2)}, ${a.st[1].toFixed(2)})`);
  assert(near(b.st[0], 0.25) && near(b.st[1], 0.1 + 0.5 - 0.5 * Math.cos(Math.PI / 6)), `a second later, turned 30 degrees and scrolled (${b.st[0].toFixed(3)}, ${b.st[1].toFixed(3)})`);
  // which passes each powerup draws, on a body and on a gun
  const passes = (pw, time, gun, opts = {}) => {
    const r = Object.create(Renderer.prototype), out = [];
    r.look = (name) => ({ image: name });
    r.drawMd3 = (m, f, o, ax, sk, light, opts) => out.push(opts.shell ? opts.shell.look.image.replace('powerups/', '') : 'model');
    r.drawMd3Powered(null, 0, [0, 0, 0], null, null, null, opts, pw, time, gun);
    return out.join(' ');
  };
  assert(passes(256, 10, false) === 'invisibility' && passes(256, 10, true) === 'invisibility', `invisible: the shell alone (${passes(256, 10, false)})`);
  assert(passes(512 | 4096, 10, false) === 'model quad battleSuit' && passes(512 | 4096, 10, true) === 'model quadWeapon battleWeapon', `the quad and the battle suit over the model (${passes(512 | 4096, 10, true)} on a gun)`);
  assert(passes(512, 10, false, { red: true }) === 'model blueflag' && passes(512, 10, true, { red: true }) === 'model quadWeapon',
    `the red team's quad is redQuadShader, "powerups/blueflag" (${passes(512, 10, false, { red: true })}); its gun keeps the quad's`);
  assert(passes(1024, 10.15, false) === 'model regen' && passes(1024, 10.25, false) === 'model' && passes(1024, 10.15, true) === 'model', 'regeneration flashes a tenth of each second, not on the gun');
  // the haste's smoke: a puff every 100 ms under the feet
  const st = new FrameState();
  for (const t of [10, 10.05, 10.1, 10.15, 10.2]) st.hasteTrail(7, [0, 0, 24], t);
  // (CG_HasteTrail's trailTime starts at the first frame's time, so the second frame puffs too)
  const at = st.puffs.map((p) => p.t0).join(',');
  assert(at === '10,10.05,10.1,10.2' && st.puffs.every((p) => p.p[2] === 8 && p.dur === 0.5 && p.alpha === 1), `the haste: a puff every 100 ms, 16 under the origin (at ${at})`);
}

// the end of the match (UI_SPPostgameMenu): the accuracy, the awards earned, the frags, perfect for a win
// without dying
{
  const m = postgameMedals({ ACC_SHOTS: 30, ACC_HITS: 11, N_IMPRESSIVE: 2, N_EXCELLENT: 0, N_GAUNTLET: 1, FRAGS: 20, WINNER: 'You', DEATHS: 0 });
  assert(m.map((x) => x.join(' ')).join(', ') === 'accuracy 36%, impressive 2, gauntlet 1, frags 20, victory Perfect', `the postgame medals (${m.map((x) => x.join(' ')).join(', ')})`);
  const lost = postgameMedals({ ACC_SHOTS: 0, ACC_HITS: 0, N_IMPRESSIVE: 0, N_EXCELLENT: 0, N_GAUNTLET: 0, FRAGS: 3, WINNER: 'Sarge', DEATHS: 0 });
  assert(lost.length === 1 && lost[0][0] === 'frags', 'no shots, no accuracy; no win, no perfect');
}

// the bots' item weights (be_ai_weight.c's switches, botfiles/fw_items.c): the first case the inventory is
// under, two levels deep, balance() its first value, the macros of the bot's own file
{
  const defines = new Map();
  const text = preprocess(`#define FS_HEALTH 2
#define W_RL 120
#define SCALE(v) balance($evalfloat(MZ(FS_HEALTH*v)), 0, 0)
#define MZ(value) (value) < 0 ? 0 : (value)
weight "item_health" { switch(INVENTORY_HEALTH) { case 50: return SCALE(40); case 100: return SCALE(10); default: return 0; } }
weight "weapon_rl" { switch(INVENTORY_RL) { case 1: return W_RL; default: {
#ifdef WEAPONS_STAY
  return 99;
#else
  switch(INVENTORY_ROCKETS) { case 10: return 30; default: return 1; }
#endif
} } }
weight "item_quad" { return 400; }`, () => null, defines);
  const ws = parseWeights(text, defines);
  const h = ws.get('item_health'), rl = ws.get('weapon_rl');
  assert(weightOf(h, { INVENTORY_HEALTH: 30 }) === 80 && weightOf(h, { INVENTORY_HEALTH: 70 }) === 20 && weightOf(h, { INVENTORY_HEALTH: 125 }) === 0,
    'a health weight by the health: under 50 twice 40, under 100 twice 10, else nothing');
  assert(weightOf(rl, { INVENTORY_RL: 0 }) === 120 && weightOf(rl, { INVENTORY_RL: 1, INVENTORY_ROCKETS: 5 }) === 30 && weightOf(rl, { INVENTORY_RL: 1, INVENTORY_ROCKETS: 50 }) === 1
    && ws.get('item_quad') === 400, 'a gun: its weight when not held; held, by its ammunition (the #else); a constant');
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
