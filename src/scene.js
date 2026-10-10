// scene.js – from FRAME_ALL's rows to a painted frame. Shared by the page
// (src/main.js) and the headless screenshots (scripts/screenshot.mjs).
//
// FrameState keeps what outlives a frame: explosions and beams in
// flight, the pose of rotating brush models, the console lines.

import { angleMatrix, yawAxis, anglesAxis, tagTransform, animFrame } from './renderer.js';
import { ITEMS, WEAPONS, PLAYER_MODEL } from './gamedata.js';

const WEAPON_DIR = { 1: 'gauntlet', 2: 'machinegun', 4: 'shotgun', 8: 'grenadel', 16: 'rocketl', 32: 'lightning', 64: 'railgun', 128: 'plasma', 256: 'bfg' };
const RLBOOM = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `models/weaphits/rlboom/rlboom_${i}.jpg`);
const BLOOD = [201, 202, 203, 204, 205].map((i) => `models/weaphits/blood${i}.tga`);

// CG_RocketTrail's step, cg_brassTime, the trajectory's gravity, the shells' bounce (LEBS_BRASS)
const TRAIL_STEP = 0.05, MAX_PUFFS = 400, BRASS_TIME = 2.5, BRASS_GRAVITY = 800, BRASS_BOUNCE = 0.4, MAX_BRASS = 64;
const ROCKET_TRAIL = { dur: 2, radius: 64 }, GRENADE_TRAIL = { dur: 0.7, radius: 32 };

// ── portals (misc_portal_surface → misc_portal_camera, R_GetPortalOrientations) ──
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** PerpendicularVector: the axis src leans on least, projected off src */
export function perpendicular(src) {
  let pos = 0, min = 1;
  for (let i = 0; i < 3; i++) if (Math.abs(src[i]) < min) { pos = i; min = Math.abs(src[i]); }
  const t = [0, 0, 0];
  t[pos] = 1;
  const d = dot3(t, src);
  return norm3([t[0] - d * src[0], t[1] - d * src[1], t[2] - d * src[2]]);
}
/** RotatePointAroundVector by degrees (Rodrigues) */
function rotateAround(dir, p, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = dot3(dir, p) * (1 - c), x = cross3(dir, p);
  return [p[0] * c + x[0] * s + dir[0] * k, p[1] * c + x[1] * s + dir[1] * k, p[2] * c + x[2] * s + dir[2] * k];
}
const parseVec3 = (s) => (s ?? '0 0 0').trim().split(/\s+/).map(Number);

/**
 * The map's portals: each misc_portal_surface, the camera it targets (looking at its own target, rolled by
 * "roll") and the faces whose shader is a portal within 64 units of the surface's plane. { faces: Set,
 * origin, plane: [n, d] (unoriented), camera: { origin, axis: [fwd, left, up] } }
 */
export function findPortals(bsp, look) {
  const ents = bsp.entities ?? [], out = [];
  const portalFaces = [];
  bsp.faces.forEach((f, i) => {
    if (!f.nverts || !look(bsp.textures[f.texture]?.name ?? '').portal) return;
    const V = f.verts, T = f.tris ?? [0, 1, 2];
    const at = (k) => [V[k * 10], V[k * 10 + 1], V[k * 10 + 2]];
    const a = at(T[0]), b = at(T[1]), c = at(T[2]);
    const n = norm3(cross3(sub3(c, a), sub3(b, a)));   // PlaneFromPoints
    portalFaces.push({ i, n, d: dot3(n, a), center: f.center });
  });
  for (const s of ents) {
    if (s.classname !== 'misc_portal_surface' || !s.target) continue;
    const cam = ents.find((e) => e.classname === 'misc_portal_camera' && e.targetname === s.target);
    if (!cam) continue;   // a mirror (no camera): not drawn
    const o = parseVec3(s.origin), co = parseVec3(cam.origin);
    const tgt = cam.target ? ents.find((e) => e.targetname === cam.target) : null;
    let dir;
    if (tgt) dir = norm3(sub3(parseVec3(tgt.origin), co));
    else { const y = ((Number(cam.angle) || 0) * Math.PI) / 180; dir = [Math.cos(y), Math.sin(y), 0]; }
    // the camera entity's axis (CG_Misc portal: the direction, its perpendicular negated, their cross), then
    // R_GetPortalOrientations turns it about the vertical (forward and left negated) and rolls it
    const e1 = perpendicular(dir).map((v) => -v), e2 = cross3(dir, e1);
    const fwd = dir.map((v) => -v);
    let left = e1.map((v) => -v), up = e2;
    const roll = Number(cam.roll) || 0;
    if (roll) { left = rotateAround(fwd, left, roll); up = cross3(fwd, left); }
    const faces = portalFaces.filter((p) => Math.abs(dot3(p.n, o) - p.d) <= 64);
    if (!faces.length) continue;
    out.push({ faces: new Set(faces.map((p) => p.i)), origin: o, plane: [faces[0].n, faces[0].d], center: faces[0].center, camera: { origin: co, axis: [fwd, left, up] } });
  }
  return out;
}

/**
 * R_MirrorViewBySurface for a portal: the viewer's axes carried from the surface's frame to the camera's.
 * The eye stays at the camera (Quake III moves it behind the camera by the viewer's offset and clips what
 * is behind the camera's plane; there is no clip plane here). Returns the view as the painters take it.
 */
export function portalView(portal, view) {
  let [n, d] = portal.plane;
  const eye = [view.x, view.y, view.z];
  if (dot3(n, eye) - d < 0) { n = n.map((v) => -v); d = -d; }   // the side the viewer is on is the front
  const s1 = perpendicular(n), s2 = cross3(n, s1), S = [n, s1, s2], C = portal.camera.axis;
  const carry = (v) => [0, 1, 2].map((k) => dot3(v, S[0]) * C[0][k] + dot3(v, S[1]) * C[1][k] + dot3(v, S[2]) * C[2][k]);
  const yaw = (view.yaw * Math.PI) / 180, pitch = (view.pitch * Math.PI) / 180;
  const f = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
  const left = [-Math.sin(yaw), Math.cos(yaw), 0], up = cross3(f, left);
  const F = norm3(carry(f)), L = norm3(carry(left)), U = norm3(carry(up));
  // as yaw, pitch and roll (beginFrame builds right = R0 cos r + U0 sin r from them)
  const py = Math.atan2(F[1], F[0]), pp = -Math.asin(Math.max(-1, Math.min(1, F[2])));
  const R0 = [Math.sin(py), -Math.cos(py), 0], U0 = [Math.sin(pp) * Math.cos(py), Math.sin(pp) * Math.sin(py), Math.cos(pp)];
  const right = L.map((v) => -v);
  const roll = Math.atan2(dot3(right, U0), dot3(right, R0));
  const [x, y, z] = portal.camera.origin;
  return { x, y, z, yaw: (py * 180) / Math.PI, pitch: (pp * 180) / Math.PI, roll: (roll * 180) / Math.PI, fov: view.fov, fwd: F, right, up: U };
}

/** How much of the portal's view shows through: alphaGen portal 256 fogs it over in 256 units */
export const PORTAL_RANGE = 256;
export function portalFade(portal, view) {
  const c = portal.center ?? portal.origin;
  return Math.max(0, 1 - Math.hypot(view.x - c[0], view.y - c[1], view.z - c[2]) / PORTAL_RANGE);
}

// The dynamic lights (trap_R_AddLightToScene): radius and colour. A rocket and a BFG ball in flight (CG_Missile's
// missileDlight), a rocket's or a grenade's explosion (CG_MissileHitWall: 300, fading in the second half of the
// explosion), the quad's carrier (CG_PlayerPowerups), the muzzle flash (300 + rand & 31 in the weapon's
// flashDlightColor). The renderer keeps 8 (Quake III 32), the nearest the eye.
const DL_ROCKET = [200, 1, 0.75, 0], DL_BFG = [200, 1, 0.7, 1], DL_QUAD = [200, 0.2, 0.2, 1], DL_BOOM = [300, 1, 0.75, 0];
const FLASH_DLIGHT = { 1: [0.6, 0.6, 1], 2: [1, 1, 0], 4: [1, 1, 0], 8: [1, 0.7, 0], 16: [1, 0.75, 0], 32: [0.6, 0.6, 1], 64: [1, 0.5, 0], 128: [0.6, 0.6, 1], 256: [1, 0.7, 1] };
export const MAX_DLIGHTS = 8;

/** The frame's dynamic lights, nearest the eye first: [{ x, y, z, radius, color }] */
/** Whether a player model fired within the last tenth of a second: its torso's attack animation (7, the
 *  gauntlet's 8) restarts at each shot (set_anims), alive. */
export function firing(e, time) {
  if (!e.pmodel) return false;
  const [, torso, hp, cls] = e.anims.split(',');
  return (torso === '7' || torso === '8') && +hp > 0 && cls !== 'corpse' && time - e.torsoTime < 0.1;
}

export function sceneLights(state, frame, last, view, time) {
  const out = [];
  const add = (x, y, z, d, k = 1) => { if (d[0] * k > 0) out.push({ x, y, z, radius: d[0] * k, color: [d[1], d[2], d[3]] }); };
  for (const e of frame.ents) {
    // a bot's muzzle flash (CG_AddPlayerWeapon: 300 + rand & 31 of the gun's colour), ahead of it at the gun
    const fc = firing(e, time) && FLASH_DLIGHT[e.weapon];
    if (fc && !(e.effects & 256)) {
      const yaw = (e.yaw * Math.PI) / 180;
      add(e.x + Math.cos(yaw) * 24, e.y + Math.sin(yaw) * 24, e.z + 16, [300 + Math.random() * 32, ...fc]);
    }
    if (e.effects & 16) add(e.x, e.y, e.z, DL_ROCKET);
    else if (e.effects & 64) add(e.x, e.y, e.z, DL_BFG);
    if (e.effects & 512 && e.pmodel) add(e.x, e.y, e.z, [200 + Math.random() * 32, 0.2, 0.2, 1]);
  }
  for (const x of state.explosions) {
    if (!x.light) continue;
    const f = (time - x.t0) / x.dur;
    add(x.x, x.y, x.z, x.light, f < 0.5 ? 1 : Math.max(0, 1 - (f - 0.5) * 2));
  }
  if (!last.DEAD && !last.SPECTATOR) {
    if (last.QUAD > 0) add(last.PX, last.PY, last.PZ, [DL_QUAD[0] + Math.random() * 32, DL_QUAD[1], DL_QUAD[2], DL_QUAD[3]]);
    const c = FLASH_DLIGHT[last.WEAPON];
    if (c && last.ATTACK_START > 0 && time - last.ATTACK_START < 0.1) {
      const yaw = (view.yaw * Math.PI) / 180, pitch = (view.pitch * Math.PI) / 180;
      add(view.x + Math.cos(yaw) * Math.cos(pitch) * 24, view.y + Math.sin(yaw) * Math.cos(pitch) * 24, view.z - Math.sin(pitch) * 24 - 4, [300 + Math.random() * 32, ...c]);
    }
  }
  const d2 = (l) => (l.x - view.x) ** 2 + (l.y - view.y) ** 2 + (l.z - view.z) ** 2;
  return out.sort((a, b) => d2(a) - d2(b)).slice(0, MAX_DLIGHTS);
}

/** R_SetupEntityLighting's dynamic lights on a model: each adds 16 r² / d² (d at least 16) of its colour to the
 *  directed light, from its direction */
export function litByDlights(light, x, y, z, lights) {
  if (!lights.length) return light;
  const dir = light.dir.map((v) => v * (light.directed[0] + light.directed[1] + light.directed[2]) / 3);
  const directed = light.directed.slice();
  for (const l of lights) {
    let dx = l.x - x, dy = l.y - y, dz = l.z - z;
    let d = Math.hypot(dx, dy, dz);
    if (d > 0) { dx /= d; dy /= d; dz /= d; }
    d = Math.max(d, 16);
    const power = (16 * l.radius * l.radius) / (d * d);
    for (let i = 0; i < 3; i++) directed[i] += power * l.color[i];
    dir[0] += power * dx; dir[1] += power * dy; dir[2] += power * dz;
  }
  const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return { ...light, directed, dir: [dir[0] / n, dir[1] / n, dir[2] / n] };
}

// ── the rail and the lightning (tr_surface.c: RB_SurfaceRailCore, RB_SurfaceRailRings, RB_SurfaceLightningBolt) ──
// cg_railTrailTime 400; r_railCoreWidth 6, r_railWidth 16, r_railSegmentLength 32; the colour is the shooter's
// color1 times 0.75 in Quake III (one colour for all here), fading to nothing (LE_FADE_RGB)
const RAIL_TIME = 0.4, RAIL_CORE_WIDTH = 6, RAIL_WIDTH = 16, RAIL_SEGMENT = 32, RAIL_COLOR = [0.375, 0.56, 0.75];
// the EF bits of the powerups drawn as shells: 256 invisible, 512 quad, 1024 regeneration, 4096 battle suit
const POWERUP_BITS = 256 | 512 | 1024 | 4096;
const quadSt = (t0, t1) => Float32Array.of(t0, 0, t0, 1, t1, 1, t1, 0);
/** DoRailCore: a ribbon from a to b spanWidth either side along `right`, its texture t = length / 256 long */
function railCore(a, b, right, w) {
  return Float32Array.of(a[0] + right[0] * w, a[1] + right[1] * w, a[2] + right[2] * w, a[0] - right[0] * w, a[1] - right[1] * w, a[2] - right[2] * w,
    b[0] - right[0] * w, b[1] - right[1] * w, b[2] - right[2] * w, b[0] + right[0] * w, b[1] + right[1] * w, b[2] + right[2] * w);
}
/** the side that faces the eye: the cross of the eye's lines to both ends */
function beamRight(view, a, b) {
  const v1 = norm3(sub3(a, [view.x, view.y, view.z])), v2 = norm3(sub3(b, [view.x, view.y, view.z]));
  return norm3(cross3(v1, v2));
}
export function drawRail(r, view, b, time) {
  const k = Math.max(0, 1 - (time - b.t0) / RAIL_TIME), col = [RAIL_COLOR[0] * k, RAIL_COLOR[1] * k, RAIL_COLOR[2] * k, 1];
  const d = sub3(b.b, b.a), len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 0) || k <= 0) return;
  const dir = [d[0] / len, d[1] / len, d[2] / len];
  // the core: railCore, scrolling once a second
  const s0 = time * 1;
  r.drawMark(railCore(b.a, b.b, beamRight(view, b.a, b.b), RAIL_CORE_WIDTH), quadSt(s0, s0 + len / 256), 4, 'gfx/misc/railcorethin_mono', 'add', col);
  // the rings (DoRailDiscs): a disc every 32 units, its four corners at 45 + 90 i degrees, 4 out (a quarter of
  // r_railWidth), the first a segment in on a long shot; railDisc's texture turning 30 degrees a second
  let segs = Math.floor(len / RAIL_SEGMENT);
  if (segs > 1) segs--;
  if (!segs) return;
  // MakeNormalVectors
  let right = [dir[2], -dir[0], dir[1]];
  const dd = dot3(right, dir);
  right = norm3([right[0] - dd * dir[0], right[1] - dd * dir[1], right[2] - dd * dir[2]]);
  const up = cross3(right, dir);
  const step = dir.map((v) => v * RAIL_SEGMENT), radius = RAIL_WIDTH * 0.25;
  const corners = [0, 1, 2, 3].map((i) => {
    const a = ((45 + i * 90) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [0, 1, 2].map((k2) => b.a[k2] + (right[k2] * c + up[k2] * s) * radius + (segs > 1 ? step[k2] : 0));
  });
  const ang = (-30 * time * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const rot = (s, t) => [0.5 + (s - 0.5) * ca - (t - 0.5) * sa, 0.5 + (s - 0.5) * sa + (t - 0.5) * ca];
  const st = Float32Array.from([[1, 0], [1, 1], [0, 1], [0, 0]].flatMap(([s, t]) => rot(s, t)));
  for (let i = 0; i < segs; i++) {
    const pts = new Float32Array(12);
    corners.forEach((p, j) => pts.set([p[0] + step[0] * i, p[1] + step[1] * i, p[2] + step[2] * i], j * 3));
    r.drawMark(pts, st, 4, 'gfx/misc/raildisc_mono2', 'add', col);
  }
}
/** RB_SurfaceLightningBolt: four ribbons 8 either side, the first facing the eye, each turned 45 degrees about
 *  the beam; lightningBolt's two stages (scrolling at 5 and 7.2, pulsing at 7.1 and 8.1 a second) */
export function drawBolt(r, view, b, time) {
  const d = sub3(b.b, b.a), len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 0)) return;
  const dir = [d[0] / len, d[1] / len, d[2] / len];
  let right = beamRight(view, b.a, b.b);
  const t = len / 256;
  const wave = (amp, freq) => Math.min(1, 1 + amp * Math.sin(time * freq * 2 * Math.PI));
  const g1 = wave(0.5, 7.1), g2 = wave(0.8, 8.1);
  const st1 = Float32Array.of(-5 * time, 0, -5 * time, 1, t * 2 - 5 * time, 1, t * 2 - 5 * time, 0);
  const st2 = Float32Array.of(-7.2 * time, 0, -7.2 * time, -1, -1.3 * t - 7.2 * time, -1, -1.3 * t - 7.2 * time, 0);
  for (let i = 0; i < 4; i++) {
    const pts = railCore(b.a, b.b, right, 8);
    r.drawMark(pts, st1, 4, 'gfx/misc/lightning3', 'add', [g1, g1, g1, 1]);
    r.drawMark(pts, st2, 4, 'gfx/misc/lightning3', 'add', [g2, g2, g2, 1]);
    right = rotateAround(dir, right, 45);
  }
}

// CG_PlayerShadow: the trace down is 128 units, against what stops a player
const SHADOW_DISTANCE = 128, SHADOW_MASK = 1 | 0x10000;

// cg_marks.c: at most 256 pieces, each 10 s, the last second fading out
const MAX_MARK_POLYS = 256, MARK_TOTAL_TIME = 10, MARK_FADE_TIME = 1;
const SURF_SKY = 0x4, SURF_NOMARKS = 0x20, SURF_NODRAW = 0x80;

/** A polygon's part on the positive side of a plane given as a distance function (Sutherland–Hodgman). */
function clipPoly(poly, dist) {
  const out = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], da = dist(a), db = dist(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** The floor under a point, within `reach` (CG_PlayerShadow's trace down, a point stepped through the brushes
 *  rather than its 30-unit box): its height, or null when nothing solid is that close */
export function floorBelow(bsp, x, y, z, reach = SHADOW_DISTANCE) {
  if (!bsp?.pointContents || bsp.pointContents(x, y, z) & SHADOW_MASK) return null;   // startsolid: no shadow
  let lo = 0;
  for (let d = 8; d <= reach; d += 8) {
    if (bsp.pointContents(x, y, z - d) & SHADOW_MASK) {
      let hi = d;   // the floor is between lo (open) and hi (solid): halve it down to a unit
      while (hi - lo > 1) { const m = (lo + hi) / 2; if (bsp.pointContents(x, y, z - m) & SHADOW_MASK) hi = m; else lo = m; }
      return z - lo;
    }
    lo = d;
  }
  return null;
}

/** CG_PlayerShadow (cg_shadows 1): a 24-unit markShadow under each player model, and under the player, turned
 *  with the legs and darker the nearer the floor (1 - the trace's fraction); a mark of this frame only */
export function drawShadows(r, state, bsp, frame, last, time) {
  const list = [];
  const shadow = (x, y, z, yaw) => {
    const floor = floorBelow(bsp, x, y, z);
    if (floor === null) return;
    const k = 1 - (z - floor) / SHADOW_DISTANCE;
    const from = list.length;
    state.impactMark(bsp, 'gfx/damage/shadow', [x, y, floor], [0, 0, 1], 24, time, 'subtract', [k, k, k], false, list, yaw);
    for (let i = from; i < list.length; i++) list[i].k = k;
  };
  for (const e of frame.ents) if (e.pmodel && !(e.effects & 256)) shadow(e.x, e.y, e.z, e.yaw);
  if (!last.DEAD && !last.SPECTATOR && !last.MATCH_OVER && !(last.INVIS > 0)) shadow(last.PX, last.PY, last.PZ, last.YAW);
  for (const m of list) r.drawMark(m.pts, m.st, m.n, m.img, m.blend, [m.k, m.k, m.k, 1]);
  return list.length;
}

/** CG_AddMarks: the marks still on, faded by age; energy marks glow and go dark in their first 3 s */
function drawMarks(r, state, time) {
  state.marks = state.marks.filter((m) => time - m.t0 < MARK_TOTAL_TIME && time >= m.t0 - 0.1);
  for (const m of state.marks) {
    const age = Math.max(0, time - m.t0);
    let k = 1, alpha = 1;
    if (m.energy) k = Math.max(0, Math.min(1, (450 - 450 * (age / 3)) / 255));
    const left = MARK_TOTAL_TIME - age;
    if (left < MARK_FADE_TIME) { if (m.blend === 'blend') alpha = left / MARK_FADE_TIME; else k *= left / MARK_FADE_TIME; }
    r.drawMark(m.pts, m.st, m.n, m.img, m.blend, [m.color[0] * k, m.color[1] * k, m.color[2] * k, alpha]);
  }
}

export class FrameState {
  constructor() {
    this.brushAngles = new Map();
    this.explosions = [];     // { x, y, z, t0, frames, size, dur, blend }
    this.beams = [];          // { kind: 'rail' | 'bolt', a, b, t0, until, owner }
    this.messages = [];       // [{ id, time, text }]
    this.kick = { dmgSeen: null, at: -1e9, pitch: 0, roll: 0, bob: 0 };   // the first-person view's state
    this.bubbles = [];        // { p: [x, y, z], v: [vx, vy, vz], t0, dur } (CG_BubbleTrail's local entities)
    this.lastPos = new Map(); // a missile's position and time at the last frame: its trail starts there
    this.puffs = [];          // { p: [x, y, z], t0, dur, radius, alpha } (CG_SmokePuff's LE_SCALE_FADE)
    this.hasteTime = new Map();   // entity → its next haste puff (centity_t's trailTime)
    this.brass = [];          // { p, v, angles, t0, end, model, rest } (the shells' LE_FRAGMENT)
    this.marks = [];          // { pts, st, n, img, blend, color, t0, energy } (cg_marks.c's mark polys)
    this.markFaces = null;    // the world faces a mark can land on, for this.markBsp
    this.markBsp = null;
    this.extraModels = new Map();   // item model name → the other models of the item
    for (const it of ITEMS) {
      const ms = it.models.split(',');
      if (ms.length > 1) this.extraModels.set(ms[0], ms.slice(1));
    }
  }

  /** rows of FRAME_ALL (array mode): r = [kind, i1, i2, i3, i4, i5, d1..d9, s, lst] */
  parse(rows) {
    const faces = [], ents = [], sounds = [], fx = [];
    let speakers = null, eye = null;
    const messages = [];
    this.brushAngles.clear();
    for (const r of rows) {
      switch (r[0]) {
        case 1: { const ent = r[2], ox = r[6], oy = r[7], oz = r[8]; for (const id of r[16].split(',')) faces.push([+id, ent, ox, oy, oz]); break; }
        case 8: faces.push([r[1], r[2], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[3]]); break;
        case 2: ents.push({ id: r[1], model: r[2], frame: r[3], weapon: r[4], effects: r[5], x: r[6], y: r[7], z: r[8], pitch: r[9], yaw: r[10], roll: r[11], legsTime: r[12], torsoTime: r[13], pmodel: r[15], anims: r[16] }); break;
        case 4: sounds.push([r[1], 0, r[2], r[3], r[15], r[6], r[7], r[8], r[9], r[10]]); break;
        case 5: fx.push([r[1], r[2], r[6], r[7], r[8], r[9], r[10], r[11], r[3]]); break;
        case 6: if (r[6] || r[7] || r[8]) this.brushAngles.set(r[1], [r[6], r[7], r[8]]); break;
        case 7: speakers = r[16] ? r[16].split(',').map(Number) : []; break;
        case 9: messages.push({ id: r[1], time: r[6], text: r[15] }); break;
        case 10: eye = [r[6], r[7], r[8]]; break;
        default: break;
      }
    }
    this.messages = messages;
    return { faces, ents, sounds, fx, speakers, messages, eye };
  }

  /** CG_BubbleTrail: a bubble every `spacing` units from a to b, drifting up with a little jitter, a second
   *  or so each (at most 600 alive) */
  bubbleTrail(a, b, spacing, time) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0)) return;
    const n = Math.min(64, Math.floor(len / spacing) + 1), crand = () => Math.random() * 2 - 1;
    for (let i = 0; i < n; i++) {
      const k = (i * spacing) / len;
      this.bubbles.push({ p: [a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k], v: [crand() * 5, crand() * 5, crand() * 5 + 6], t0: time, dur: 1 + Math.random() * 0.25 });
    }
    if (this.bubbles.length > 600) this.bubbles.splice(0, this.bubbles.length - 600);
  }

  /** The world faces a mark may land on (R_MarkFragments walks the world's surfaces, not the brush models'):
   *  polygons and patches, not sky, nomarks or nodraw ones */
  markSurfaces(bsp) {
    if (this.markBsp === bsp) return this.markFaces;
    this.markBsp = bsp; this.marks = [];
    const world = bsp.models[0], out = [];
    for (let i = world.firstFace; i < world.firstFace + world.numFaces; i++) {
      const f = bsp.faces[i];
      if ((f.type !== 1 && f.type !== 2) || !f.nverts) continue;
      if ((bsp.textures[f.texture]?.flags ?? 0) & (SURF_SKY | SURF_NOMARKS | SURF_NODRAW)) continue;
      out.push(f);
    }
    return (this.markFaces = out);
  }

  /** CG_ImpactMark: a square of `radius` round `o`, turned by a random angle, projected along the hit
   *  normal `dir` onto the world faces in reach and clipped to them (R_MarkFragments); each piece is
   *  a mark polygon for MARK_TOTAL_TIME. blend 'subtract' darkens (GL_ZERO GL_ONE_MINUS_SRC_COLOR), 'blend'
   *  is alpha-blended; energy marks glow and darken in their first three seconds */
  impactMark(bsp, img, o, dir, radius, time, blend = 'subtract', color = [1, 1, 1], energy = false, list = null, angle = null) {
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    if (!bsp || !(dl > 0) || !(radius > 0)) return;
    const n = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    // two axes in the plane (PerpendicularVector, CrossProduct), turned by the mark's angle
    const p = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    let a1 = [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
    const l1 = Math.hypot(a1[0], a1[1], a1[2]);
    a1 = [a1[0] / l1, a1[1] / l1, a1[2] / l1];
    let a2 = [n[1] * a1[2] - n[2] * a1[1], n[2] * a1[0] - n[0] * a1[2], n[0] * a1[1] - n[1] * a1[0]];
    const ang = angle === null ? Math.random() * 2 * Math.PI : (angle * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
    [a1, a2] = [[a1[0] * c + a2[0] * s, a1[1] * c + a2[1] * s, a1[2] * c + a2[2] * s], [a2[0] * c - a1[0] * s, a2[1] * c - a1[1] * s, a2[2] * c - a1[2] * s]];
    // the box the mark covers: the square's four sides, 32 units either side of its plane plus the
    // projection's 20 behind (R_MarkFragments' near and far planes)
    const planes = [
      [a1, -radius], [[-a1[0], -a1[1], -a1[2]], -radius], [a2, -radius], [[-a2[0], -a2[1], -a2[2]], -radius],
      [n, -52], [[-n[0], -n[1], -n[2]], -32],
    ];
    const reach = radius * 1.5 + 52, scale = 0.5 / radius;
    const add = (poly, fn) => {
      for (const [pn, pd] of planes) {
        poly = clipPoly(poly, (q) => (q[0] - o[0]) * pn[0] + (q[1] - o[1]) * pn[1] + (q[2] - o[2]) * pn[2] - pd);
        if (poly.length < 3) return;
      }
      if (!list && this.marks.length >= MAX_MARK_POLYS) this.marks.shift();
      const pts = new Float32Array(poly.length * 3), st = new Float32Array(poly.length * 2);
      poly.forEach((q, k) => {
        // lifted off the surface a little along its normal (the shader's polygonOffset)
        pts[k * 3] = q[0] + fn[0] * 0.5; pts[k * 3 + 1] = q[1] + fn[1] * 0.5; pts[k * 3 + 2] = q[2] + fn[2] * 0.5;
        const dx = q[0] - o[0], dy = q[1] - o[1], dz = q[2] - o[2];
        st[k * 2] = 0.5 + (dx * a1[0] + dy * a1[1] + dz * a1[2]) * scale;
        st[k * 2 + 1] = 0.5 + (dx * a2[0] + dy * a2[1] + dz * a2[2]) * scale;
      });
      (list ?? this.marks).push({ pts, st, n: poly.length, img, blend, color, t0: time, energy });
    };
    for (const f of this.markSurfaces(bsp)) {
      const ce = f.center;
      if (Math.hypot(ce[0] - o[0], ce[1] - o[1], ce[2] - o[2]) > f.radius + reach) continue;
      const V = f.verts;
      const at = (k) => [V[k * 10], V[k * 10 + 1], V[k * 10 + 2]];
      if (f.type === 1) {
        // a polygon facing the shot (its convex outline in vertex order)
        if (f.normal[0] * n[0] + f.normal[1] * n[1] + f.normal[2] * n[2] < 0.5) continue;
        const poly = [];
        for (let k = 0; k < f.nverts; k++) poly.push(at(k));
        add(poly, f.normal);
      } else {
        // a patch: each triangle of its tessellation that faces the shot
        const T = f.tris;
        for (let k = 0; k + 2 < T.length; k += 3) {
          const A = at(T[k]), B = at(T[k + 1]), C = at(T[k + 2]);
          if (Math.max(Math.abs(A[0] - o[0]), Math.abs(A[1] - o[1]), Math.abs(A[2] - o[2])) > reach + 64) continue;
          const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
          let fn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const fl = Math.hypot(fn[0], fn[1], fn[2]);
          if (!(fl > 0)) continue;
          fn = [fn[0] / fl, fn[1] / fl, fn[2] / fl];
          let dot = fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2];
          if (dot < 0) { fn = [-fn[0], -fn[1], -fn[2]]; dot = -dot; }   // patches are drawn from both sides
          if (dot < 0.1) continue;
          add([A, B, C], fn);
        }
      }
    }
  }

  /** CG_RocketTrail (the grenade's too): a puff of smoke every 50 ms of the missile's flight, at where it
   *  was then, from where the last frame left it to where it is now */
  missileTrail(id, p, time, dur, radius) {
    const last = this.lastPos.get(id);
    this.lastPos.set(id, [p[0], p[1], p[2], time]);
    if (!last || !(time > last[3])) return;
    // whole steps by index, so rounding neither skips a boundary nor puts one in twice
    for (let i = Math.floor(last[3] / TRAIL_STEP + 1e-6) + 1, end = Math.floor(time / TRAIL_STEP + 1e-6); i <= end; i++) {
      const t = i * TRAIL_STEP, k = Math.max(0, Math.min(1, (t - last[3]) / (time - last[3])));
      this.puffs.push({ p: [last[0] + (p[0] - last[0]) * k, last[1] + (p[1] - last[1]) * k, last[2] + (p[2] - last[2]) * k], t0: t, dur, radius });
    }
    if (this.puffs.length > MAX_PUFFS) this.puffs.splice(0, this.puffs.length - MAX_PUFFS);
  }

  /** CG_HasteTrail: a runner with the haste drops a puff under its feet every 100 ms (16 below the origin,
   *  radius 8, half a second, hasteSmokePuff: smokepuff3 at full alpha) */
  hasteTrail(id, p, time) {
    let t = this.hasteTime.get(id) ?? 0;
    if (t > time) return;
    t += 0.1;
    if (t < time) t = time;
    this.hasteTime.set(id, t);
    this.puffs.push({ p: [p[0], p[1], p[2] - 16], t0: time, dur: 0.5, radius: 8, alpha: 1 });
    if (this.puffs.length > MAX_PUFFS) this.puffs.splice(0, this.puffs.length - MAX_PUFFS);
  }

  /** CG_MachineGunEjectBrass and CG_ShotgunEjectBrass: shells thrown out of the shooter's right side
   *  (one for the machinegun, two for the shotgun), tumbling, bouncing, gone after cg_brassTime */
  ejectBrass(x, y, z, yaw, weapon, time) {
    const a = (yaw * Math.PI) / 180, f = [Math.cos(a), Math.sin(a)], l = [-Math.sin(a), Math.cos(a)];
    const crand = () => Math.random() * 2 - 1;
    const local = (o, dx, dy, dz) => [o[0] + f[0] * dx + l[0] * dy, o[1] + f[1] * dx + l[1] * dy, (o[2] ?? 0) + dz];
    const shell = (off, vel, model, life) => this.brass.push({
      p: local([x, y, z], off[0], off[1], off[2]), v: local([0, 0], vel[0], vel[1], vel[2]),
      angles: [Math.random() * 32, Math.random() * 32, Math.random() * 32], t0: time, end: time + life, model, rest: false,
    });
    if (weapon === 2) shell([8, -4, 24], [0, -50 + 40 * crand(), 100 + 50 * crand()], 'm', BRASS_TIME + (BRASS_TIME / 4) * Math.random());
    else for (let i = 0; i < 2; i++) shell([8, 0, 24], [60 + 60 * crand(), (i === 0 ? 40 : -40) + 10 * crand(), 100 + 50 * crand()], 's', BRASS_TIME * 3 + BRASS_TIME * Math.random());
    if (this.brass.length > MAX_BRASS) this.brass.splice(0, this.brass.length - MAX_BRASS);
  }

  /** The shells fly under gravity; one that would enter a solid bounces off the side it hit (the axis
   *  whose step alone goes in), at 0.4 of its speed, and lies still once a floor holds it (CG_AddFragment,
   *  CG_ReflectVelocity) */
  moveBrass(bsp, dt) {
    for (const b of this.brass) {
      if (b.rest) continue;
      b.v[2] -= BRASS_GRAVITY * dt;
      b.angles[0] += 2 * dt; b.angles[1] += dt;
      // in steps of at most 4 units, so a thin floor is not jumped over
      const steps = Math.max(1, Math.ceil((Math.hypot(b.v[0], b.v[1], b.v[2]) * dt) / 4)), h = dt / steps;
      for (let s = 0; s < steps && !b.rest; s++) {
        const n = [b.p[0] + b.v[0] * h, b.p[1] + b.v[1] * h, b.p[2] + b.v[2] * h];
        if (!bsp || !(bsp.pointContents(n[0], n[1], n[2]) & 1)) { b.p = n; continue; }
        let hitFloor = false, hit = false;
        for (let i = 0; i < 3; i++) {
          const q = [b.p[0], b.p[1], b.p[2]];
          q[i] = n[i];
          if (bsp.pointContents(q[0], q[1], q[2]) & 1) { hit = true; if (i === 2 && b.v[2] < 0) hitFloor = true; b.v[i] = -b.v[i]; }
        }
        if (!hit) b.v = b.v.map((v) => -v);   // an edge only the diagonal step meets: straight back
        b.v = b.v.map((v) => v * BRASS_BOUNCE);
        if (hitFloor && b.v[2] < 40) b.rest = true;
      }
    }
  }

  /** The temp entities of a tic become sprites, beams, particles and marks. */
  handleFx(renderer, rows, time, bsp = null) {
    for (const [, kind, x, y, z, x2, y2, z2, n] of rows) {
      const mark = (img, radius, blend, color, energy) => this.impactMark(bsp, img, [x, y, z], [x2, y2, z2], radius, time, blend, color, energy);
      switch (kind) {
        case 1: renderer.spawnParticles('gunshot', x, y, z, 6, [x2, y2, z2], 0xff60c0ff); mark('gfx/damage/bullet_mrk', 8); break;
        case 11: renderer.spawnParticles('gunshot', x, y, z, 3, [x2, y2, z2], 0xff60c0ff); mark('gfx/damage/bullet_mrk', 4); break;
        case 7: renderer.spawnParticles('gunshot', x, y, z, 10, [x2, y2, z2], 0xffffe0a0); mark('gfx/damage/hole_lg_mrk', 12); break;
        case 2: case 9: renderer.spawnParticles('explosion', x, y, z, 0); this.explosions.push({ x, y, z, t0: time, frames: RLBOOM, size: kind === 2 ? 72 : 56, dur: 0.6, blend: 'add', light: DL_BOOM }); mark('gfx/damage/burn_med_mrk', 64); break;
        case 8: renderer.spawnParticles('explosion', x, y, z, 0); this.explosions.push({ x, y, z, t0: time, frames: RLBOOM, size: 120, dur: 0.8, blend: 'add' }); mark('gfx/damage/burn_med_mrk', 32); break;
        case 3: renderer.spawnParticles('blood', x, y, z, Math.min(n, 30), [0, 0, 0], 0xff1010c0); this.explosions.push({ x, y, z, t0: time, frames: BLOOD, size: 24, dur: 0.4, blend: 'blend' }); break;
        // CG_RailTrail (cg_oldRail 1): the core and the rings, nudged 8 down, fading for cg_railTrailTime
        case 4: this.beams.push({ kind: 'rail', a: [x, y, z - 8], b: [x2, y2, z2 - 8], t0: time, until: time + RAIL_TIME }); break;
        case 5: renderer.spawnParticles('teleport', x, y, z, 0); this.explosions.push({ x, y, z, t0: time, frames: ['gfx/misc/teleportEffect2'], size: 48, dur: 0.5, blend: 'add' }); break;
        case 6: this.explosions.push({ x, y, z, t0: time, frames: ['models/weaphits/plasmaboom'], size: 24, dur: 0.25, blend: 'add' }); mark('gfx/damage/plasma_mrk', 16, 'blend', [1, 1, 1], true); break;
        // a mark alone: the rail's (the energy mark in the rail's colour), a gib's blood (16 to 47 across)
        case 16: if (n === 64) mark('gfx/damage/plasma_mrk', 24, 'blend', [0.5, 0.75, 1], true); else mark('gfx/damage/blood_stain', 16 + Math.random() * 32, 'blend', [1, 1, 1]); break;
        case 12: this.beams.push({ kind: 'bolt', a: [x, y, z], b: [x2, y2, z2], t0: time, until: time + 0.07, owner: n }); break;
        case 13: renderer.spawnParticles('blood', x, y, z, 40, [0, 0, 1], 0xff1010c0); break;
        case 15: this.bubbleTrail([x, y, z], [x2, y2, z2], 32, time); break;
        case 17: this.ejectBrass(x, y, z, x2, n, time); break;
        case 14: renderer.spawnParticles('gunshot', x, y, z, 12, [0, 0, 3], 0xff80ffd0); break;
        default: break;
      }
    }
  }
}

// ── the first-person view (CG_OffsetFirstPersonView, CG_DamageFeedback, CG_CalculateWeaponPosition) ──
// What the view does on top of where the player is: the kick away from a hit, the dip of a landing, the
// lean of the run, the bob of the steps; and the gun's sway with them. Cosmetic, so it lives here; the
// tic row says when and from where. The page calls it before the frame query, so the faces are culled
// for the view that is painted.
const DAMAGE_DEFLECT = 0.1, DAMAGE_RETURN = 0.4, LAND_DEFLECT = 0.15, LAND_RETURN = 0.3;

export function firstPersonView(last, state, dt = 0.05, fov = 90) {
  const time = last.TIME_;
  const view = { x: last.PX, y: last.PY, z: last.VIEW_Z, yaw: last.YAW, pitch: last.PITCH, roll: 0, fov, gun: { pitch: 0, yaw: 0, roll: 0, z: 0 } };
  if (last.MATCH_OVER) return view;
  if (last.DEAD) { view.roll = 40; return view; }
  const k = state.kick;
  const axis = anglesAxis(view.pitch, view.yaw, 0);   // forward 0..2, left 3..5, up 6..8

  // a new hit: the view swings away from where it came from, harder the lower the health
  if (last.DMG_TIME !== k.dmgSeen) {
    k.dmgSeen = last.DMG_TIME;
    const dmg = (last.DMG_TAKE ?? 0) + (last.DMG_SAVE ?? 0);
    if (dmg > 0) {
      const scale = last.HEALTH < 40 ? 1 : 40 / last.HEALTH;
      const kick = Math.max(5, Math.min(10, dmg * scale));
      if (last.DMG_WORLD) { k.pitch = -kick; k.roll = 0; }
      else {
        let dx = last.DMG_X - last.PX, dy = last.DMG_Y - last.PY, dz = (last.DMG_Z ?? last.VIEW_Z) - last.VIEW_Z;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        const front = dx * axis[0] + dy * axis[1] + dz * axis[2];
        const left = dx * axis[3] + dy * axis[4] + dz * axis[5];
        k.roll = kick * left;
        k.pitch = -kick * front;
      }
      k.at = time;
    }
  }
  const since = Math.max(0, time - k.at);
  const kr = since < DAMAGE_DEFLECT ? since / DAMAGE_DEFLECT : 1 - (since - DAMAGE_DEFLECT) / DAMAGE_RETURN;
  if (kr > 0) { view.pitch += kr * k.pitch; view.roll += kr * k.roll; }

  // the lean of the run: pitch with the forward speed, roll against the sideways one
  const vx = last.VX ?? 0, vy = last.VY ?? 0;
  view.pitch += (vx * axis[0] + vy * axis[1]) * 0.002;   // cg_runpitch
  view.roll -= (vx * axis[3] + vy * axis[4]) * 0.005;    // cg_runroll

  // the bob: a cycle per pair of steps, as PM_Footsteps counts them (bobmove 0.4 running, 0.3 walking,
  // 0.5 crouched; 128 to a step), still in the air, reset when standing
  const speed = Math.hypot(vx, vy);
  if (speed < 5) k.bob = 0;
  else if (last.ONGROUND) k.bob += dt * (last.DUCKED ? 0.5 : speed > 200 ? 0.4 : 0.3) * 1000 / 128;
  const fracsin = Math.abs(Math.sin(k.bob * Math.PI));
  const odd = Math.floor(k.bob) & 1;
  let delta = fracsin * 0.002 * Math.max(speed, 200) * (last.DUCKED ? 3 : 1);   // cg_bobpitch, cg_bobroll
  view.pitch += delta;
  view.roll += odd ? -delta : delta;
  view.z += Math.min(6, fracsin * speed * 0.005);                                    // cg_bobup

  // the landing: down by the fall's size in 150 ms, back in 300
  const sinceLand = time - (last.LAND_TIME ?? -10);
  const change = last.LAND_CHANGE ?? -8;
  let land = 0;
  if (sinceLand >= 0 && sinceLand < LAND_DEFLECT) land = sinceLand / LAND_DEFLECT;
  else if (sinceLand >= LAND_DEFLECT && sinceLand < LAND_DEFLECT + LAND_RETURN) land = 1 - (sinceLand - LAND_DEFLECT) / LAND_RETURN;
  view.z += change * land;

  // the gun sways with the steps and drifts at rest, and drops a quarter as far on landing
  const g = view.gun, sway = speed + 40, drift = Math.sin(time);
  g.roll = sway * fracsin * 0.005 + sway * drift * 0.01;
  g.yaw = sway * fracsin * 0.01 + sway * drift * 0.01;
  g.pitch = speed * fracsin * 0.005 + sway * drift * 0.01;
  g.z = change * 0.25 * land;
  return view;
}

// CG_CalcFov under water (or slime, or lava: the eye in it, waterlevel 3): the view waves a degree either
// way, 0.4 times a second (WAVE_AMPLITUDE, WAVE_FREQUENCY)
export const underwaterFov = (fov, waterlevel, seconds) => (waterlevel >= 3 ? fov + Math.sin(seconds * 0.4 * 2 * Math.PI) : fov);

// CG_CalcFov's zoom: to cg_zoomFov (22.5) in 150 ms from when +zoom went down, and back as fast from
// when it came up (from wherever the other half-way zoom had got to: Quake III's jump included)
export const ZOOM_FOV = 22.5, ZOOM_TIME = 150;
export function zoomedFov(fov, zoomed, sinceMs, zoomFov = ZOOM_FOV) {
  const f = sinceMs / ZOOM_TIME;
  if (zoomed) return f >= 1 ? zoomFov : fov + f * (zoomFov - fov);
  return f >= 1 ? fov : zoomFov + f * (fov - zoomFov);
}

/** The vertical field of view of a horizontal one on a w×h screen (CG_CalcFov's fov_y). */
export const fovY = (fovX, w, h) => (Math.atan2(h, w / Math.tan((fovX * Math.PI) / 360)) * 360) / Math.PI;

// CG_MapTorsoToWeaponFrame: the view's hand model has 16 frames of its own, played from the torso's
// animation: 0 at rest, 1 to 6 the attack (TORSO_ATTACK, or ATTACK2 for the gauntlet), 6 to 14 the switch
// (TORSO_DROP and TORSO_RAISE, nine frames in a row); its tag_weapon carries the gun down and up again
export function mapTorsoToWeaponFrame(anims, frame) {
  const drop = anims[9], atk = anims[7], atk2 = anims[8];
  if (drop && frame >= drop.first && frame < drop.first + 9) return frame - drop.first + 6;
  if (atk && frame >= atk.first && frame < atk.first + 6) return 1 + frame - atk.first;
  if (atk2 && frame >= atk2.first && frame < atk2.first + 6) return 1 + frame - atk2.first;
  return 0;
}

/** The torso frame of the player's own model (PM_TorsoAnimation, PM_BeginWeaponChange, PM_FinishWeaponChange):
 *  the drop for the 0.2 s the old weapon goes down, the raise for the 0.25 s the new one comes up, the attack, or standing. */
export function viewTorsoFrame(anims, last, time) {
  if (last.WEAPONSTATE === 2) return animFrame(anims, 9, time - (last.WEAPON_TIME - 0.2));
  if (last.WEAPONSTATE === 3) return animFrame(anims, 10, time - (last.WEAPON_TIME - 0.25));
  if (last.ATTACK_START > 0 && time - last.ATTACK_START < 0.4) return animFrame(anims, last.WEAPON === 1 ? 8 : 7, time - last.ATTACK_START);
  return anims[11]?.first ?? 0;
}

/** The whole picture of one frame into the renderer (not yet presented). Returns the screen tint. */
export function drawScene(renderer, hud, res, bsp, last, frame, opts = {}) {
  const r = renderer;
  const time = last.TIME_;
  const state = opts.state ?? (opts.state = new FrameState());
  const view = opts.view ?? firstPersonView(last, state, opts.dt ?? 0.05, opts.fov ?? 90);
  if (opts.portal && r.beginPortalView) {
    // the view through the portal first, painted off screen; the portal's faces show it (R_MirrorViewBySurface)
    const p = opts.portal;
    r.setDlights([]);
    r.beginPortalView();
    if (p.frame) {
      r.beginFrame({ ...p.view });
      r.drawFaceList(p.frame.faces, time, p.brushAngles ?? new Map());
      for (const e of p.frame.ents) {
        const light = bsp.lightGrid(e.x, e.y, e.z + 24);
        if (e.pmodel) {
          const [pm, skin] = e.pmodel.split('/');
          const [legs, torso, , cls] = e.anims.split(',');
          r.drawPlayer(pm, skin, +legs, e.legsTime, +torso, e.torsoTime, cls === 'corpse' ? 0 : e.weapon, [e.x, e.y, e.z], e.yaw, time, light, { powerups: e.effects & POWERUP_BITS, flash: firing(e, time) });
          continue;
        }
        const m = res.models.get(e.model);
        if (!m?.mdl) continue;
        r.drawMd3(m.mdl, e.frame, [e.x, e.y, e.z], e.effects & 1 ? yawAxis((time * 88) % 360) : anglesAxis(-e.pitch, e.yaw, e.roll), null, light);
      }
      r.drawAlphaPolys();
    }
    r.endPortalView(p.frame ? p.fade : 0, p.faces);
  } else r.endPortalView?.(0, null);
  r.beginFrame(view);
  const lights = opts.dlights === false ? [] : sceneLights(state, frame, last, view, time);
  r.setDlights(lights);
  const lightAt = (x, y, z) => litByDlights(bsp.lightGrid(x, y, z), x, y, z, lights);
  if (frame.faces.length) {
    if (opts.sqlProjected) r.drawFaces(frame.faces, time);
    else r.drawFaceList(frame.faces, time, state.brushAngles);
  }
  if (state.marks.length) drawMarks(r, state, time);
  if (opts.shadows !== false) drawShadows(r, state, bsp, frame, last, time);

  // the models
  for (const e of frame.ents) {
    const light = lightAt(e.x, e.y, e.z + 24);
    if (e.pmodel) {
      const [pm, skin] = e.pmodel.split('/');
      const [legs, torso, hp, cls] = e.anims.split(',');
      const isCorpse = cls === 'corpse';
      r.drawPlayer(pm, skin, +legs, e.legsTime, +torso, e.torsoTime, isCorpse ? 0 : e.weapon, [e.x, e.y, e.z], e.yaw, time, light, { powerups: e.effects & POWERUP_BITS, flash: firing(e, time) });
      // CG_PlayerPowerups: the haste's smoke behind a runner (LEGS_RUN, LEGS_BACK)
      if (e.effects & 2048 && (+legs === 15 || +legs === 16)) state.hasteTrail(e.id, [e.x, e.y, e.z], time);
      // a fresh reward floats over the head (CG_PlayerSprites, CG_PlayerFloatSprite)
      const medal = e.effects & 8192 ? 'excellent' : e.effects & 32768 ? 'impressive' : e.effects & 16384 ? 'gauntlet' : null;
      if (medal && !isCorpse) r.drawSprite(`menu/medals/medal_${medal}`, [e.x, e.y, e.z + 48], 20, 'blend');
      continue;
    }
    const m = res.models.get(e.model);
    if (!m) continue;
    if (m.kind === 'S') {
      r.drawSprite(m.name, [e.x, e.y, e.z], m.size ?? 24, 'add');
      continue;
    }
    if (!m.mdl) continue;
    if (e.effects & 1) {
      // an item: it bobs and turns (CG_Item)
      const yaw = (time * 88) % 360;
      const z = e.z + 4 + Math.cos(time * 5 + 5) * 4;
      r.drawMd3(m.mdl, 0, [e.x, e.y, z], yawAxis(yaw), null, light);
      const extra = state.extraModels.get(m.name);
      if (extra) for (const name of extra) {
        const id = res.byName.get(name);
        if (id) r.drawMd3(res.models.get(id).mdl, 0, [e.x, e.y, z], yawAxis(-yaw * 0.5), null, light, { blend: name.includes('ring') || name.includes('sphere') ? 'add' : 'opaque' });
      }
      continue;
    }
    const axis = anglesAxis(-e.pitch, e.yaw, e.roll);
    r.drawMd3(m.mdl, e.frame, [e.x, e.y, e.z], axis, null, e.effects & (16 | 64) ? null : light);
    if (e.effects & 65536 && e.effects & (16 | 32)) {
      // in water a rocket or a grenade leaves bubbles, not smoke (CG_RocketTrail, CG_GrenadeTrail)
      const from = state.lastPos.get(e.id) ?? [e.x, e.y, e.z];
      state.bubbleTrail(from, [e.x, e.y, e.z], 8, time);
      state.lastPos.set(e.id, [e.x, e.y, e.z, time]);
    } else if (e.effects & (16 | 32)) {
      const trail = e.effects & 16 ? ROCKET_TRAIL : GRENADE_TRAIL;
      state.missileTrail(e.id, [e.x, e.y, e.z], time, trail.dur, trail.radius);
    }
  }

  // our own haste's smoke, running on the ground
  if (last.HASTE > 0 && last.ONGROUND && !last.DEAD && Math.hypot(last.VX ?? 0, last.VY ?? 0) > 50) state.hasteTrail(-1, [last.PX, last.PY, last.PZ], time);

  // the bubbles: radius 3, rising, gone after their second (LE_MOVE_SCALE_FADE, LEF_PUFF_DONT_SCALE)
  if (state.bubbles.length) {
    state.bubbles = state.bubbles.filter((b) => time - b.t0 < b.dur && time >= b.t0 - 0.1);
    for (const b of state.bubbles) {
      const age = Math.max(0, time - b.t0);
      r.drawSprite('sprites/bubble', [b.p[0] + b.v[0] * age, b.p[1] + b.v[1] * age, b.p[2] + b.v[2] * age], 6, 'blend');
    }
  }
  if (state.lastPos.size > 64) state.lastPos.clear();

  // the shells (LE_FRAGMENT): lit by the grid where they are
  if (state.brass.length) {
    state.moveBrass(bsp, Math.min(0.1, opts.dt ?? 0.05));
    state.brass = state.brass.filter((b) => time < b.end && time >= b.t0 - 0.1);
    for (const b of state.brass) {
      const id = res.byName.get(`models/weapons2/shells/${b.model}_shell.md3`);
      if (id) r.drawMd3(res.models.get(id).mdl, 0, b.p, anglesAxis(b.angles[0], b.angles[1], b.angles[2]), null, lightAt(b.p[0], b.p[1], b.p[2]));
    }
  }

  // the smoke: each puff grows from 8 to its radius + 8 as it fades from a third (LE_SCALE_FADE), and
  // goes when the eye is inside it
  if (state.puffs.length) {
    state.puffs = state.puffs.filter((p) => time - p.t0 < p.dur && time >= p.t0 - 0.1);
    for (const p of state.puffs) {
      const c = 1 - Math.max(0, time - p.t0) / p.dur;
      const radius = p.radius * (1 - c) + 8;
      const d = (p.p[0] - view.x) * r.view.fwd[0] + (p.p[1] - view.y) * r.view.fwd[1] + (p.p[2] - view.z) * r.view.fwd[2];
      if (d < radius) continue;
      r.drawSprite('gfx/misc/smokepuff3', p.p, radius * 2, 'blend', 255, (p.alpha ?? 0.33) * c);   // the smokePuff shader
    }
  }
  // effects in flight
  state.explosions = state.explosions.filter((x) => time - x.t0 < x.dur);
  for (const x of state.explosions) {
    const k = Math.min(x.frames.length - 1, Math.floor(((time - x.t0) / x.dur) * x.frames.length));
    r.drawSprite(x.frames[k], [x.x, x.y, x.z], x.size * (0.6 + 0.6 * (time - x.t0) / x.dur), x.blend);
  }
  state.beams = state.beams.filter((b) => b.until > time && time >= b.t0 - 0.1);
  for (const b of state.beams) (b.kind === 'rail' ? drawRail : drawBolt)(r, view, b, time);
  r.runParticles(opts.dt ?? 0.05, time);
  r.drawParticles();
  r.drawAlphaPolys();

  // the weapon in hand: the hand model at the eye, the gun on its tag (CG_AddViewWeapon)
  if (!last.DEAD && !last.MATCH_OVER && !(last.SPECTATOR && !last.FOLLOW_NAME) && last.WEAPON && !opts.noWeapon) drawViewWeapon(r, res, bsp, last, time, view, lights);

  // 2D
  if (hud) hud.draw(r, last, time, state.messages, opts);
  return screenTint(last, time);
}

function drawViewWeapon(r, res, bsp, last, time, view, lights = []) {
  const dir = WEAPON_DIR[last.WEAPON];
  if (!dir) return;
  const handId = res.byName.get(`models/weapons2/${dir}/${dir}_hand.md3`);
  const gunId = res.byName.get(`models/weapons2/${dir}/${dir}.md3`);
  if (!gunId) return;
  const gun = res.models.get(gunId).mdl;
  const hand = handId ? res.models.get(handId).mdl : null;
  // the hand sits at the eye, facing the view, and follows it, kicks and all, with the gun's own sway on
  // top (CG_CalculateWeaponPosition); its animation does the switching. Without a hand model the gun
  // is slid down instead
  const sw = last.WEAPONSTATE === 2 ? Math.min(1, (0.2 - (last.WEAPON_TIME - time)) / 0.2) : last.WEAPONSTATE === 3 ? Math.max(0, (last.WEAPON_TIME - time) / 0.25) : 0;
  const g = view.gun;
  const axis = anglesAxis(view.pitch + g.pitch, view.yaw + g.yaw, view.roll + g.roll);
  const gx = 4, gz = hand ? 0 : -sw * 20;   // cg_gun_x: a little forward
  const org = [view.x + axis[0] * gx + axis[6] * gz, view.y + axis[1] * gx + axis[7] * gz, view.z + g.z + axis[2] * gx + axis[8] * gz + last.PUNCH * 0.5];
  const light = litByDlights(bsp.lightGrid(last.PX, last.PY, last.PZ), last.PX, last.PY, last.PZ, lights);
  light.ambient = light.ambient.map((v) => Math.max(v, 96));   // RF_MINLIGHT: the gun is never black
  let gunOrigin = org, gunAxis = axis;
  if (hand) {
    const p = res.players.get(PLAYER_MODEL) ?? res.players.values().next().value;
    const frame = p ? Math.min(hand.numFrames - 1, mapTorsoToWeaponFrame(p.anims, viewTorsoFrame(p.anims, last, time))) : 0;
    const t = tagTransform(hand, frame, 'tag_weapon', org, axis);
    if (t) { gunOrigin = t.origin; gunAxis = t.axis; }
  } else {
    // no hand model: hang the gun low and to the right of the eye
    gunOrigin = [org[0] + axis[0] * 10 - axis[3] * 6 - axis[6] * 6, org[1] + axis[1] * 10 - axis[4] * 6 - axis[7] * 6, org[2] + axis[2] * 10 - axis[5] * 6 - axis[8] * 6];
  }
  r.zb.fill(0);
  // CG_AddWeaponWithPowerups: our own powerups on the gun
  const pw = (last.INVIS > 0 ? 256 : 0) | (last.QUAD > 0 ? 512 : 0) | (last.ENVIRO > 0 ? 4096 : 0);
  r.drawMd3Powered(gun, 0, gunOrigin, gunAxis, null, light, { near: 1 }, pw, time, true);
  // the barrel (the machinegun's, the gauntlet's) hangs on the gun's tag_barrel (CG_AddPlayerWeapon). The
  // gun's _1 and _2 are not parts but its lower levels of detail (machinegun_2 is a rough box)
  const pid = res.byName.get(`models/weapons2/${dir}/${dir}_barrel.md3`);
  const bt = pid && tagTransform(gun, 0, 'tag_barrel', gunOrigin, gunAxis);
  if (bt) r.drawMd3Powered(res.models.get(pid).mdl, 0, bt.origin, bt.axis, null, light, { near: 1 }, pw, time, true);
  // the muzzle flash for a tenth of a second
  if (last.ATTACK_START > 0 && time - last.ATTACK_START < 0.1 && last.WEAPON !== 1 && last.WEAPON !== 64) {
    const fid = res.byName.get(`models/weapons2/${dir}/${dir}_flash.md3`);
    const t = tagTransform(gun, 0, 'tag_flash', gunOrigin, gunAxis);
    if (fid && t) r.drawMd3(res.models.get(fid).mdl, 0, t.origin, t.axis, null, null, { near: 1, blend: 'add', twoSided: true });
  }
}

/** The palette blend: damage, pickups, powerups, water (CG_DrawFlash) */
export function screenTint(last, time) {
  const since = time - last.DMG_TIME;
  if (since >= 0 && since < 0.5 && (last.DMG_TAKE || last.DMG_SAVE)) {
    const a = Math.min(0.6, (last.DMG_TAKE * 0.025 + last.DMG_SAVE * 0.01) * (1 - since / 0.5) + 0.1);
    return [255, 0, 0, a];
  }
  if (time - last.BONUS_TIME >= 0 && time - last.BONUS_TIME < 0.3) return [255, 255, 255, 0.15 * (1 - (time - last.BONUS_TIME) / 0.3)];
  if (last.WATERLEVEL >= 3) return last.WATERTYPE & 8 ? [255, 80, 0, 0.6] : last.WATERTYPE & 16 ? [0, 60, 10, 0.5] : [20, 60, 120, 0.35];
  if (last.QUAD > 0) return [40, 80, 255, 0.12];
  if (last.ENVIRO > 0) return [255, 200, 40, 0.12];
  return null;
}

export { WEAPONS };
