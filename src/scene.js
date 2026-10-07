// scene.js – from FRAME_ALL's rows to a painted frame. Shared by the page
// (src/main.js) and the headless screenshots (scripts/screenshot.mjs).
//
// FrameState keeps what outlives a frame: explosions and beams in
// flight, the pose of rotating brush models, the console lines.

import { angleMatrix, yawAxis, anglesAxis, tagTransform, animFrame } from './renderer.js';
import { ITEMS, WEAPONS } from './gamedata.js';

const WEAPON_DIR = { 1: 'gauntlet', 2: 'machinegun', 4: 'shotgun', 8: 'grenadel', 16: 'rocketl', 32: 'lightning', 64: 'railgun', 128: 'plasma', 256: 'bfg' };
const RLBOOM = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `models/weaphits/rlboom/rlboom_${i}.jpg`);
const BLOOD = [201, 202, 203, 204, 205].map((i) => `models/weaphits/blood${i}.tga`);

export class FrameState {
  constructor() {
    this.brushAngles = new Map();
    this.explosions = [];     // { x, y, z, t0, frames, size, dur, blend }
    this.beams = [];          // { a, b, until, img, width, scroll }
    this.messages = [];       // [{ id, time, text }]
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

/** The whole picture of one frame into the renderer (not yet presented). Returns the screen tint. */
export function drawScene(renderer, hud, res, bsp, last, frame, opts = {}) {
  const r = renderer;
  const time = last.TIME_;
  const state = opts.state ?? (opts.state = new FrameState());
  const view = { x: last.PX, y: last.PY, z: last.VIEW_Z, yaw: last.YAW, pitch: last.PITCH, roll: last.DEAD ? 40 : 0, fov: opts.fov ?? 90 };
  // the view bobs with the run (CG_OffsetFirstPersonView)
  if (!last.DEAD && last.ONGROUND && last.MOVE_SPEED > 50) {
    const cycle = time * 12;
    view.z += Math.abs(Math.sin(cycle)) * Math.min(1, last.MOVE_SPEED / 320) * 2;
    view.roll = Math.sin(cycle) * 0.6;
  }
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
  if (!last.DEAD && last.WEAPON && !opts.noWeapon) drawViewWeapon(r, res, bsp, last, time);

  // 2D
  if (hud) hud.draw(r, last, time, state.messages, opts);
  return screenTint(last, time);
}

function drawViewWeapon(r, res, bsp, last, time) {
  const dir = WEAPON_DIR[last.WEAPON];
  if (!dir) return;
  const handId = res.byName.get(`models/weapons2/${dir}/${dir}_hand.md3`);
  const gunId = res.byName.get(`models/weapons2/${dir}/${dir}.md3`);
  if (!gunId) return;
  const gun = res.models.get(gunId).mdl;
  const hand = handId ? res.models.get(handId).mdl : null;
  // the hand sits at the eye, facing the view; the switch animation lowers it
  const sw = last.WEAPONSTATE === 2 ? Math.min(1, (0.2 - (last.WEAPON_TIME - time)) / 0.2) : last.WEAPONSTATE === 3 ? Math.max(0, (last.WEAPON_TIME - time) / 0.25) : 0;
  const bob = last.ONGROUND && last.MOVE_SPEED > 50 ? Math.sin(time * 12) * 0.7 : 0;
  const axis = anglesAxis(last.PITCH, last.YAW, 0);
  const gx = 4, gz = -sw * 20 + bob;   // cg_gun_x: a little forward; the switch lowers it
  const org = [last.PX + axis[0] * gx + axis[6] * gz, last.PY + axis[1] * gx + axis[7] * gz, last.VIEW_Z + axis[2] * gx + axis[8] * gz + last.PUNCH * 0.5];
  const light = bsp.lightGrid(last.PX, last.PY, last.PZ);
  light.ambient = light.ambient.map((v) => Math.max(v, 96));   // RF_MINLIGHT: the gun is never black
  let gunOrigin = org, gunAxis = axis;
  if (hand) {
    // the hand's frames follow the torso attack animation (TORSO_ATTACK is 6 frames at 15 fps)
    const p = res.players.get('sarge') ?? res.players.values().next().value;
    let frame = 0;
    if (p) {
      const atk = p.anims[last.WEAPON === 1 ? 8 : 7];
      const idle = p.anims[11];
      const firing = time - last.ATTACK_START < 0.4 && last.ATTACK_START > 0;
      frame = firing ? animFrame(p.anims, last.WEAPON === 1 ? 8 : 7, time - last.ATTACK_START) : idle ? idle.first : 0;
      if (frame >= hand.numFrames) frame = Math.min(hand.numFrames - 1, frame - atk.first);
    }
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
