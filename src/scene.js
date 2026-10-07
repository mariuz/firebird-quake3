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

export class FrameState {
  constructor() {
    this.brushAngles = new Map();
    this.explosions = [];     // { x, y, z, t0, frames, size, dur, blend }
    this.beams = [];          // { a, b, until, img, width, scroll }
    this.messages = [];       // [{ id, time, text }]
    this.kick = { dmgSeen: null, at: -1e9, pitch: 0, roll: 0, bob: 0 };   // the first-person view's state
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

  /** The temp entities of a tic become sprites, beams and particles. */
  handleFx(renderer, rows, time) {
    for (const [, kind, x, y, z, x2, y2, z2, n] of rows) {
      switch (kind) {
        case 1: renderer.spawnParticles('gunshot', x, y, z, 6, [x2, y2, z2], 0xff60c0ff); break;
        case 11: renderer.spawnParticles('gunshot', x, y, z, 3, [x2, y2, z2], 0xff60c0ff); break;
        case 7: renderer.spawnParticles('gunshot', x, y, z, 10, [x2, y2, z2], 0xffffe0a0); break;
        case 2: case 9: renderer.spawnParticles('explosion', x, y, z, 0); this.explosions.push({ x, y, z, t0: time, frames: RLBOOM, size: kind === 2 ? 72 : 56, dur: 0.6, blend: 'add' }); break;
        case 8: renderer.spawnParticles('explosion', x, y, z, 0); this.explosions.push({ x, y, z, t0: time, frames: RLBOOM, size: 120, dur: 0.8, blend: 'add' }); break;
        case 3: renderer.spawnParticles('blood', x, y, z, Math.min(n, 30), [0, 0, 0], 0xff1010c0); this.explosions.push({ x, y, z, t0: time, frames: BLOOD, size: 24, dur: 0.4, blend: 'blend' }); break;
        case 4: renderer.spawnParticles('rail', x, y, z, 0, [x2, y2, z2]); this.beams.push({ a: [x, y, z], b: [x2, y2, z2], until: time + 0.8, img: 'gfx/misc/railcorethin_mono', width: 4, scroll: 0 }); break;
        case 5: renderer.spawnParticles('teleport', x, y, z, 0); this.explosions.push({ x, y, z, t0: time, frames: ['gfx/misc/teleportEffect2'], size: 48, dur: 0.5, blend: 'add' }); break;
        case 6: this.explosions.push({ x, y, z, t0: time, frames: ['models/weaphits/plasmaboom'], size: 24, dur: 0.25, blend: 'add' }); break;
        case 12: this.beams.push({ a: [x, y, z], b: [x2, y2, z2], until: time + 0.07, img: 'gfx/misc/lightning3', width: 10, scroll: -time * 5, owner: n }); break;
        case 13: renderer.spawnParticles('blood', x, y, z, 40, [0, 0, 1], 0xff1010c0); break;
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
  r.beginFrame(view);
  if (frame.faces.length) {
    if (opts.sqlProjected) r.drawFaces(frame.faces, time);
    else r.drawFaceList(frame.faces, time, state.brushAngles);
  }

  // the models
  for (const e of frame.ents) {
    const light = bsp.lightGrid(e.x, e.y, e.z + 24);
    if (e.pmodel) {
      const [pm, skin] = e.pmodel.split('/');
      const [legs, torso, hp, cls] = e.anims.split(',');
      const isCorpse = cls === 'corpse';
      r.drawPlayer(pm, skin, +legs, e.legsTime, +torso, e.torsoTime, isCorpse ? 0 : e.weapon, [e.x, e.y, e.z], e.yaw, time, light);
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
    if (e.effects & 16) r.spawnParticles('gunshot', e.x, e.y, e.z, 2, [0, 0, 0], 0xff808080);   // rocket smoke
  }

  // effects in flight
  state.explosions = state.explosions.filter((x) => time - x.t0 < x.dur);
  for (const x of state.explosions) {
    const k = Math.min(x.frames.length - 1, Math.floor(((time - x.t0) / x.dur) * x.frames.length));
    r.drawSprite(x.frames[k], [x.x, x.y, x.z], x.size * (0.6 + 0.6 * (time - x.t0) / x.dur), x.blend);
  }
  state.beams = state.beams.filter((b) => b.until > time);
  for (const b of state.beams) r.drawBeam(b.a, b.b, b.img, b.width, 'add', b.scroll);
  r.runParticles(opts.dt ?? 0.05, time);
  r.drawParticles();
  r.drawAlphaPolys();

  // the weapon in hand: the hand model at the eye, the gun on its tag (CG_AddViewWeapon)
  if (!last.DEAD && !last.MATCH_OVER && last.WEAPON && !opts.noWeapon) drawViewWeapon(r, res, bsp, last, time, view);

  // 2D
  if (hud) hud.draw(r, last, time, state.messages, opts);
  return screenTint(last, time);
}

function drawViewWeapon(r, res, bsp, last, time, view) {
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
  const light = bsp.lightGrid(last.PX, last.PY, last.PZ);
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
  r.drawMd3(gun, 0, gunOrigin, gunAxis, null, light, { near: 1 });
  // the barrel of the machinegun and the extra parts (rocketl_1, …) hang on tag_barrel / tag_weapon of the gun
  for (const part of ['_barrel', '_1', '_2']) {
    const pid = res.byName.get(`models/weapons2/${dir}/${dir}${part}.md3`);
    if (!pid) continue;
    const tag = part === '_barrel' ? 'tag_barrel' : 'tag_weapon';
    const t = tagTransform(gun, 0, tag, gunOrigin, gunAxis);
    if (t) r.drawMd3(res.models.get(pid).mdl, 0, t.origin, t.axis, null, light, { near: 1 });
  }
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
