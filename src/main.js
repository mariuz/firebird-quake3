// main.js – boot Firebird in a Worker, load the PK3 into it, run the loop.
//
// Per frame the browser does two queries:
//   SELECT * FROM q3_tic(...)         – advance the game by N tics
//   SELECT * FROM frame_all(...)      – the frame: the polygons on screen, the models in view,
//                                       what to play and where, the effects, the console
// and then paints. All game state lives in Firebird tables.

import { FirebirdBrowser } from 'firebird-wasm/browser';
import schemaSql from '../sql/schema.sql';
import physicsSql from '../sql/physics.sql';
import gameSql from '../sql/game.sql';
import playerSql from '../sql/player.sql';
import demoSql from '../sql/demo.sql';
import waypointsSql from '../sql/waypoints.sql';
import botsSql from '../sql/bots.sql';
import renderSql from '../sql/render.sql';
import saveSql from '../sql/save.sql';
import chatSql from '../sql/chat.sql';
import ctfSql from '../sql/ctf.sql';
import { Pk3, PakSet } from './pk3.js';
import { createSchema, loadResources, loadMap, buildWaypoints, setView, setRotation } from './loader.js';
import { loadShaders } from './shader.js';
import { Renderer } from './renderer.js';
import { GLRenderer } from './renderer-gl.js';
import { Hud, careerAfter, careerAwards } from './hud.js';
import { FrameState, drawScene, firstPersonView, zoomedFov, fovY, wideFov, screenShape, flyCamera, ZOOM_FOV, underwaterFov, findPortals, portalView, mirrorView, portalFade } from './scene.js';
import { Q3Audio, weaponLoop } from './audio.js';
import { exportDemo, importDemo, listDemos } from './demo.js';
import { exportSave, importSave, saveMap } from './save.js';
import { loadEmbedder, embedderReady, embed } from './chat.js';
import { loadBotQ } from './loader.js';
import { ACTIONS, makeBinds, savedBinds, keysOf, bind, unbind, keyName, mouseCode, wheelCode } from './binds.js';
import { BotNet, answerSql } from './litert.js';
import { BOT_NN } from './botnn.js';
import { Strategist, ServerStrategist, LocalStrategist, LLM_MODELS, LOCAL_MODELS, SERVER_DEFAULT, exportMemory, importMemory } from './llm.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const glCanvas = $('glscreen');
const overlayCanvas = $('overlay');
const wrap = $('screen-wrap');   // the mouse and touch act on the wrapper: whichever canvas is showing
const statusEl = $('status');
const statsEl = $('stats');
const TIC_MS = 50;

let db, pak, res, renderer, hud;
let map = null;          // { name, bsp, unlinked, portals }
const portalState = new FrameState();   // parses the portal camera's rows (FRAME_PORTAL)
let last = null;         // last Q3_TIC row
let prev = null;         // the one before: the frame between two tics is painted between the two states
let prevPose = null, curPose = null;   // the entities' and brush models' poses at those tics
let frameAt = 0;         // when the last frame was painted
let lastTics = 1;        // how many tics the last q3_tic call ran (the displacement prev → last covers them)
let duckChange = 0, duckTime = -1e9;   // the eye's last crouch or stand step, and when it happened
let running = false;
let paused = false;
let recording = false;     // a demo being recorded (sql/demo.sql: q3_tic keeps each snapshot)
let demoPlaying = false;   // a demo playing: demo_play gives the tic rows, the game does not run
let demoCam = null;        // a demo watched from a free camera: { x, y, z, yaw, pitch }, flown with the keys and the mouse
let saving = false;
let demoSpeed = 1;         // a demo's playback speed (timescale): the tics come that much faster or slower
let demoInfo = null;
// the career (UI_LogAwardData's counts, kept in the browser's storage): the frags before this match, logged
// once when it ends
const CAREER = 'firebird-quake3:career';
let careerFrags = null, careerLogged = false;
function readCareer() { try { return JSON.parse(localStorage.getItem(CAREER) ?? '{}') ?? {}; } catch { return null; } }       // the demo playing: { id, start: its first snapshot's time, seconds }        // a save game being written or read: the game waits (its tables are read or replaced)
let lastTic = 0;
let lastSoundId = 0;
let lastFxId = 0;
let frameNo = 0;
let scores = [];
const state = new FrameState();
const settings = { map: 'q3dm1', detail: 'medium', sfx: 70, music: 40, musicMode: 'tracks', skill: 2, bots: 3, fov: 90, renderer: 'gl', glres: 'native', aspect: '4:3', brightness: 4, predict: true, fraglimit: 20, timelimit: 10, rotate: true, name: 'Player', model: 'sarge/default', rail: 4, gametype: 'ffa', team: 'auto', botai: 0, botguns: 0, chatModel: false, llm: 0, llmModel: LLM_MODELS[0][0], llmUrl: SERVER_DEFAULT.url, llmName: SERVER_DEFAULT.model, binds: {} };
try { Object.assign(settings, JSON.parse(localStorage.getItem('firebird-quake3:settings') || '{}')); } catch { /* defaults */ }
const saveSettings = () => { try { localStorage.setItem('firebird-quake3:settings', JSON.stringify(settings)); } catch { /* ignore */ } };
const viewWidth = () => (settings.detail === 'high' ? 640 : settings.detail === 'low' ? 160 : 320);
// the picture's shape: the WebGL painter's is the page's Screen menu, the software ones' 4 by 3
const ASPECTS = { '4:3': 4 / 3, '16:10': 16 / 10, '16:9': 16 / 9, '21:9': 21 / 9 };
// (on the full screen it is the screen's own shape)
const fullScreen = () => document.fullscreenElement === wrap;
const viewAspect = () => (settings.renderer !== 'gl' ? 4 / 3 : fullScreen() ? screenShape(window.innerWidth, window.innerHeight) : ASPECTS[settings.aspect] ?? 4 / 3);
const viewHeight = () => Math.round(viewWidth() / viewAspect());
// cg_fov as the screen's shape shows it: the vertical view of 4 by 3 kept, more to the sides (wideFov)
const screenFov = (fov) => wideFov(fov, viewWidth(), viewHeight());
const audio = new Q3Audio();
audio.setVolume(settings.sfx / 100);
audio.setMusicVolume(settings.music / 100);
audio.musicMode = settings.musicMode;
for (const ev of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => audio.unlock(), { capture: true });
document.addEventListener('visibilitychange', () => audio.suspend(document.hidden));
const perf = { tic: 0, faces: 0, draw: 0, rows: 0, graph: 0 };

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !msg;
}

// ── input ────────────────────────────────────────────────────────────────
const keys = new Set();
let mouseYaw = 0, mousePitch = 0;
let fireClick = false;
let impulse = 0;
let scoreboard = false;
// +zoom (Z or the right mouse button): when it went down or up, and the field of view of the last frame
let zoomed = false, zoomAt = -1e9, curFov = 90;
const zoom = (on) => { if (on !== zoomed) { zoomed = on; zoomAt = performance.now(); } };
// the keys (src/binds.js: Quake III's bind): a key, a mouse button or a turn of the wheel that goes down is the
// action bound to it, and `keys` holds the actions that are down, not the keys
let binds = makeBinds(settings.binds);
let binding = null;   // the action the Keys panel is waiting for a key for
function actionDown(a) {
  keys.add(a);
  // a demo: jump leaves the player's eyes for a free camera, fire goes back to them (as a spectator's keys do)
  if (demoPlaying && a === 'moveup' && !demoCam) setDemoCam(true);
  else if (demoPlaying && a === 'attack' && demoCam) setDemoCam(false);
  if (a.startsWith('weapon')) impulse = Number(a.slice(6));
  else if (a === 'weapnext') impulse = 12;
  else if (a === 'weapprev') impulse = 14;
  else if (a === 'useitem') impulse = 13;
  else if (a === 'give') impulse = 99;
  else if (a === 'scores') scoreboard = true;
  else if (a === 'zoom') zoom(true);
  else if (a === 'pause') paused = !paused;
  else if (a === 'chat' && !demoPlaying) {
    keys.clear(); document.exitPointerLock?.();
    // (the line to type on is the page's, under the picture: off the full screen for it)
    if (fullScreen()) document.exitFullscreen().catch(() => {}).finally(() => $('chat').focus()); else $('chat').focus();
  }
}
function actionUp(a) {
  keys.delete(a);
  if (a === 'scores') scoreboard = false;
  else if (a === 'zoom') zoom(false);
}
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (!running || binding) return;
  const action = binds.get(e.code);
  if (action) { e.preventDefault(); if (!e.repeat || !['pause', 'chat', 'give', 'useitem'].includes(action)) actionDown(action); }
  if (demoPlaying && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && last) seekDemo(last.TIME_ - demoInfo.start + (e.code === 'ArrowLeft' ? -5 : 5)).catch((err) => console.error(err));
  // quick save and quick load (Quake II's F6 and F9 are F5 and F9 here), into the browser's storage
  if (e.code === 'F5' || e.code === 'F9') {
    e.preventDefault();
    if (e.code === 'F5') quickSave(); else quickLoad();
  }
});
window.addEventListener('keyup', (e) => { const action = binds.get(e.code); if (action) actionUp(action); });
window.addEventListener('blur', () => { keys.clear(); zoom(false); });
wrap.addEventListener('click', () => {
  if (running && document.pointerLockElement !== wrap) wrap.requestPointerLock?.()?.catch?.(() => {});
});
// the full screen (r_fullscreen; Alt+Enter as in the game, or the page's button): the picture takes the screen's
// own shape, and gives it back on the way out (Escape)
async function toggleFullScreen() {
  try {
    if (fullScreen()) await document.exitFullscreen();
    else { await wrap.requestFullscreen({ navigationUI: 'hide' }); if (running) wrap.requestPointerLock?.()?.catch?.(() => {}); }
  } catch (err) { setStatus(`No full screen: ${err.message}`, true); }
}
async function reshape() {
  renderer?.setAspect?.(viewAspect());
  if (db && renderer) await setView(db, viewWidth(), viewHeight(), screenFov(settings.fov));
}
document.addEventListener('fullscreenchange', () => { keys.clear(); reshape().catch((err) => console.error(err)); });
window.addEventListener('resize', () => { if (fullScreen()) reshape().catch((err) => console.error(err)); });
window.addEventListener('keydown', (e) => { if (e.code === 'Enter' && e.altKey && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); toggleFullScreen(); } }, true);
$('fullscreen').addEventListener('click', (e) => { e.target.blur(); toggleFullScreen(); });
wrap.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== wrap) return;
  const action = binds.get(mouseCode(e.button));
  if (action) actionDown(action);
});
window.addEventListener('mouseup', (e) => { const action = binds.get(mouseCode(e.button)); if (action) actionUp(action); });
wrap.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === wrap) {
    // zoomed, the mouse slows with the view (cg.zoomSensitivity = fov_y / 75)
    const sens = zoomed ? fovY(curFov, viewWidth(), viewHeight()) / 75 : 1;
    mouseYaw -= e.movementX * 0.15 * sens;
    mousePitch += e.movementY * 0.15 * sens;
  }
});
// (a turn of the wheel is a key that goes down and up at once)
window.addEventListener('wheel', (e) => {
  if (document.pointerLockElement !== wrap || !e.deltaY) return;
  const action = binds.get(wheelCode(e.deltaY));
  if (action) { actionDown(action); actionUp(action); }
});
// touch: left half moves, right half looks, tap fires
const touch = { move: null, look: null };
wrap.addEventListener('touchstart', (e) => {
  const r = wrap.getBoundingClientRect();
  for (const t of e.changedTouches) {
    const rec = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0, t: performance.now() };
    if (t.clientX - r.left < r.width / 2) touch.move = rec; else touch.look = rec;
  }
  e.preventDefault();
}, { passive: false });
wrap.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) for (const k of ['move', 'look']) {
    const rec = touch[k];
    if (rec && rec.id === t.identifier) {
      if (k === 'look') { mouseYaw -= (t.clientX - rec.x - rec.dx) * 0.4; mousePitch += (t.clientY - rec.y - rec.dy) * 0.4; }
      rec.dx = t.clientX - rec.x; rec.dy = t.clientY - rec.y;
    }
  }
  e.preventDefault();
}, { passive: false });
wrap.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) for (const k of ['move', 'look']) {
    const rec = touch[k];
    if (rec && rec.id === t.identifier) {
      if (k === 'look' && Math.abs(rec.dx) < 10 && Math.abs(rec.dy) < 10 && performance.now() - rec.t < 250) fireClick = 'tap';
      if (k === 'move' && Math.abs(rec.dx) < 10 && Math.abs(rec.dy) < 10 && performance.now() - rec.t < 250) keys.add('TapJump');
      touch[k] = null;
    }
  }
  e.preventDefault();
}, { passive: false });

function readInput(tics) {
  const k = (c) => keys.has(c);
  if (demoCam) { impulse = 0; return [tics, 0, 0, 0, 0, 0, 0, 1, 0]; }   // (the mouse and the keys are the camera's: flyDemoCam)
  let fwd = (k('forward') ? 1 : 0) - (k('back') ? 1 : 0);
  let side = (k('moveright') ? 1 : 0) - (k('moveleft') ? 1 : 0);
  const turnKeys = (k('left') ? 1 : 0) - (k('right') ? 1 : 0);
  const lookKeys = (k('lookdown') ? 1 : 0) - (k('lookup') ? 1 : 0);
  const run = k('speed') ? 0 : 1;     // always run; +speed walks
  if (touch.move) {
    fwd = Math.max(-1, Math.min(1, -touch.move.dy / 40));
    side = Math.max(-1, Math.min(1, touch.move.dx / 40));
  }
  const yaw = turnKeys * 7 * tics + mouseYaw;
  const pitch = lookKeys * 5 * tics + mousePitch;
  mouseYaw = 0; mousePitch = 0;
  const fire = k('attack') || fireClick ? 1 : 0;
  if (fireClick === 'tap') fireClick = false;
  // upmove, as Quake III has it: 1 jumps (+moveup), -1 crouches (+movedown)
  const jump = k('moveup') || k('TapJump') ? 1 : k('movedown') ? -1 : 0;
  keys.delete('TapJump');
  const imp = impulse;
  impulse = 0;
  return [tics, fwd, side, yaw, pitch, fire, jump, run, imp];
}

// ── maps ─────────────────────────────────────────────────────────────────
// The arenas: the base pak's, the map packs the site hosts (pak/maps/index.json: OpenArena's and the
// OpenArena Community Map-Pack's arenas, one small pk3 each, fetched when picked: scripts/fetch-maps.mjs)
// and the maps of the pk3s picked from disk. Each pk3 goes on top of the others (PakSet).
let catalog = [];          // [{ map, title, pack, file, bytes }] from pak/maps/index.json
const local = new Map();   // map → the pk3 file it came from (picked from disk)
let basePak = null;        // the game's pak (the demo's pak0.pk3)
let ctfPak = null;         // capture the flag's flags, icons and sounds (pak/ctf.pk3, from OpenArena), under the others
const baseLayers = () => (ctfPak ? [basePak, ctfPak] : [basePak]);
// an arena's game types as the packs' arena lists give them ("ffa tourney", "ctf" …): capture the flag is played
// on the arenas that have the flags, and an arena with nothing but the flags' spawn points only as that
const mapTypes = (name) => (catalog.find((m) => m.map === name)?.types ?? 'ffa tourney team').toLowerCase().split(/\s+/);
const isCtfMap = (name) => !!ctfPak && mapTypes(name).includes('ctf');
const gameTypeFor = (name) => (isCtfMap(name) && (settings.gametype === 'ctf' || !mapTypes(name).includes('ffa')) ? 4 : { team: 3, tourney: 1, ctf: 3 }[settings.gametype] ?? 0);
const localPaks = [];      // the pk3s picked from disk, in the order picked
const fetchedPaks = new Map();   // a hosted map pack's file → its Pk3, kept once fetched

/** The paks as a map needs them: the base, the picked ones, and the map's own pack on top (one hosted pack at
 *  a time, so one arena's shaders never dress another's). The shaders are read again (a later file wins) and
 *  the painters forget the pictures they have, which may be another pak's now. */
function stackPaks(top = null) {
  const layers = [...baseLayers(), ...localPaks, ...(top ? [top] : [])];
  if (layers.length === pak.paks.length && layers.every((p, i) => p === pak.paks[i])) return;
  pak.reset(layers);
  const shaders = loadShaders(pak);
  res.shaders.clear();
  for (const [k, v] of shaders) res.shaders.set(k, v);
  renderer?.resetCaches?.();
}

/** The Arena menu: the base pak's maps, then each pack's, then the picked files' */
function fillMapMenu() {
  const base = basePak.mapNames();
  const opt = (m, title) => `<option value="${m}">${title && title !== m ? `${m} – ${title}` : m}</option>`;
  const groups = [[basePak.label ?? 'pak0.pk3', base.map((m) => opt(m))]];
  const packs = new Map();
  for (const c of catalog) {
    // (the capture the flag arenas in a group of their own; without the flags' files they are not offered)
    const ctf = (c.types ?? '').split(/\s+/).includes('ctf');
    if (ctf && !ctfPak) continue;
    const g = ctf ? `${c.pack}: capture the flag` : c.pack;
    if (!packs.has(g)) packs.set(g, []);
    packs.get(g).push(opt(c.map, c.title));
  }
  for (const [p, opts] of packs) groups.push([`${p} (fetched when picked)`, opts]);
  if (local.size) groups.push(['Your pk3s', [...local.keys()].map((m) => opt(m))]);
  $('map').innerHTML = groups.map(([label, opts]) => `<optgroup label="${label.replace(/"/g, '')}">${opts.join('')}</optgroup>`).join('');
}

/** Have a map's files: a hosted pack's pk3 is fetched once and put on top; the rotation goes through the
 *  arenas of the same source */
async function ensureMap(name) {
  const c = basePak.has(`maps/${name}.bsp`) || local.has(name) ? null : catalog.find((m) => m.map === name) ?? null;
  let top = null;
  if (c) {
    top = fetchedPaks.get(c.file);
    if (!top) {
      setStatus(`Downloading ${name} (${c.pack}, ${(c.bytes / 1048576).toFixed(1)} MB)…`);
      const resp = await fetch(new URL(`./pak/maps/${c.file}`, location.href));
      if (!resp.ok) throw new Error(`could not fetch ${c.file} (${resp.status})`);
      top = new Pk3(await resp.arrayBuffer());
      top.label = c.pack;
      fetchedPaks.set(c.file, top);
    }
  }
  stackPaks(top);
  if (!pak.has(`maps/${name}.bsp`)) throw new Error(`no map ${name}`);
  // (the rotation: the arenas of the same source and the same kind, capture the flag's or the others)
  const rotation = c ? catalog.filter((m) => m.pack === c.pack && isCtfMap(m.map) === isCtfMap(name)).map((m) => m.map)
    : local.has(name) ? [...local.keys()] : basePak.mapNames();
  await setRotation(db, rotation);
}

async function startMap(name) {
  running = false;
  demoPlaying = false;
  setDemoCam(false);
  careerLogged = false; careerFrags = null;
  $('demobar').hidden = true;
  if (recording) { recording = false; $('record').textContent = 'Record'; }
  // capture the flag wants an arena with the flags: asked for on another, the first that has them is played
  if (settings.gametype === 'ctf' && !isCtfMap(name)) {
    const first = catalog.find((m) => isCtfMap(m.map));
    if (first) { name = first.map; settings.map = name; saveSettings(); $('map').value = name; }
    else setStatus('Capture the flag needs an arena with flags (npm run fetch-maps): team deathmatch here', true);
  }
  await ensureMap(name);
  setStatus(`Loading ${name} into Firebird…`);
  const t0 = performance.now();
  const bsp = await loadMap(db, pak, res, name, { skill: settings.skill, bots: settings.bots, link: false, fraglimit: settings.fraglimit, timelimit: settings.timelimit, warmup: 4,
    gametype: gameTypeFor(name), team: { red: 1, blue: 2 }[settings.team] ?? 0 });   // "prepare to fight", three, two, one, "fight!"
  map = { name, bsp, unlinked: 1, portals: findPortals(bsp, res.look) };
  await setPlayerName();
  fillModelMenu();
  await setPlayerModel();
  await setPlayerColor();
  await db.exec(`UPDATE game SET bot_rl = ${rlMode()}, bot_wsel = ${settings.botguns ? 1 : 0}`);
  await leadBots();
  renderer.setResources(res);
  renderer.particles = [];
  renderer.meshCache?.clear();
  state.explosions = []; state.beams = [];
  state.selfId = (await db.query('SELECT player_ent() pe FROM rdb$database')).rows[0].PE;   // whose lightning follows the view
  const g = (await db.query('SELECT sky, music FROM game')).rows[0];
  map.sky = g.SKY;
  renderer.setSky(g.SKY);
  // the looped target_speakers, and the movers' looping sounds (a mover's "noise"), at the middle of the brush
  const speakers = (await db.query(`SELECT id, x, y, z, noise1, speed, height, count_ FROM ents WHERE classname = 'target_speaker' AND BIN_AND(spawnflags, 3) <> 0 AND noise1 IS NOT NULL
    UNION ALL SELECT id, x + (minx + maxx) / 2, y + (miny + maxy) / 2, z + (minz + maxz) / 2, loop_sound, 1, 1, 1 FROM ents WHERE loop_sound IS NOT NULL`, [], arr)).rows;
  audio.setSpeakers(speakers);
  audio.playMusic(g.MUSIC);
  const { rows } = await db.query('SELECT MAX(id) m FROM sound_events');
  lastSoundId = rows[0].M ?? 0;
  lastFxId = 0;
  console.log(`[firebird-quake3] ${name} loaded in ${(performance.now() - t0).toFixed(0)} ms`);
  setStatus('');
  $('mapname').textContent = name;
  $('map').value = name;
  lastTic = performance.now() - TIC_MS;
  prev = null; prevPose = null; curPose = null; frameAt = 0;
  running = true;
  refreshBotMenus().catch((err) => console.error(err));
}

// ── the loop ─────────────────────────────────────────────────────────────
function nextFrame() {
  let done = false;
  const go = () => { if (!done) { done = true; frame(); } };
  requestAnimationFrame(go);
  setTimeout(go, 60);
}

const arr = { rowMode: 'array' };

// ── between two tics ─────────────────────────────────────────────────────
// The game runs at 20 Hz; the painter runs at the display's rate. A frame between two tics shows the
// world interpolated between the last two states (CG_CalcEntityLerpPositions), one tic behind, and the
// player predicted ahead of the last state (CG_PredictPlayerState, by extrapolation rather than by
// re-running the move: the move is SQL), with the view angles live from the mouse, so neither the
// look nor your own motion waits for a tic.
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => a + (((b - a + 540) % 360) - 180) * k;
const SNAP = 200;   // a jump this long in one tic is a teleport, not a move

/** The poses of a tic's frame: entity id → [x, y, z, pitch, yaw, roll]; brush models by their origin and angles. */
function poseOf(fr) {
  const ents = new Map(), brush = new Map(), rot = new Map();
  for (const e of fr.ents) ents.set(e.id, [e.x, e.y, e.z, e.pitch, e.yaw, e.roll]);
  for (const f of fr.faces) if (f[1] && !brush.has(f[1])) brush.set(f[1], [f[2], f[3], f[4]]);
  for (const [id, a] of state.brushAngles) rot.set(id, a);
  return { ents, brush, rot };
}

/** Move this frame's entities back toward where they were at the previous tic, by 1 − alpha. */
function interpolateFrame(fr, alpha) {
  if (!prevPose || alpha >= 1) return;
  for (const e of fr.ents) {
    const p = prevPose.ents.get(e.id);
    if (!p || Math.hypot(e.x - p[0], e.y - p[1], e.z - p[2]) > SNAP) continue;
    e.x = lerp(p[0], e.x, alpha); e.y = lerp(p[1], e.y, alpha); e.z = lerp(p[2], e.z, alpha);
    e.pitch = lerpAngle(p[3], e.pitch, alpha); e.yaw = lerpAngle(p[4], e.yaw, alpha); e.roll = lerpAngle(p[5], e.roll, alpha);
  }
  if (!fr.sqlProjected) for (const f of fr.faces) {
    const p = f[1] && prevPose.brush.get(f[1]);
    if (!p || Math.hypot(f[2] - p[0], f[3] - p[1], f[4] - p[2]) > SNAP) continue;
    f[2] = lerp(p[0], f[2], alpha); f[3] = lerp(p[1], f[3], alpha); f[4] = lerp(p[2], f[4], alpha);
  }
  for (const [id, a] of state.brushAngles) {
    const p = prevPose.rot.get(id);
    if (p) state.brushAngles.set(id, [lerpAngle(p[0], a[0], alpha), lerpAngle(p[1], a[1], alpha), lerpAngle(p[2], a[2], alpha)]);
  }
}

/** The tic row as the painter sees it this frame: the eye predicted `alpha` of a tic past the last
 *  state along the last tic's motion, the clock between the two tics, the angles live. The frame
 *  query clamps a predicted eye with a trace and returns the eye it used (row kind 10). */
// The free camera of a demo (the Demos bar's Camera, or jump and fire while one plays): it starts at the player's
// eye and is flown by the move keys, jump and crouch for up and down, and the mouse, every frame; the frame is
// then asked from where it is (frame_all's mode 2) and the player is seen from outside
function setDemoCam(on) {
  demoCam = on && demoPlaying && last ? { x: last.PX, y: last.PY, z: last.VIEW_Z, yaw: last.YAW, pitch: last.PITCH } : null;
  mouseYaw = 0; mousePitch = 0;
  $('democam').textContent = demoCam ? 'Camera: free' : 'Camera: player';
}
function flyDemoCam(dt) {
  const k = (c) => keys.has(c);
  flyCamera(demoCam, {
    fwd: (k('forward') ? 1 : 0) - (k('back') ? 1 : 0), side: (k('moveright') ? 1 : 0) - (k('moveleft') ? 1 : 0), up: (k('moveup') ? 1 : 0) - (k('movedown') ? 1 : 0),
    yaw: mouseYaw + ((k('left') ? 1 : 0) - (k('right') ? 1 : 0)) * 140 * dt, pitch: mousePitch + ((k('lookdown') ? 1 : 0) - (k('lookup') ? 1 : 0)) * 100 * dt,
  }, dt, map.bsp, k('speed') ? 150 : 400);
  mouseYaw = 0; mousePitch = 0;
}
function viewRow(alpha, now) {
  const k = (c) => keys.has(c);
  const frac = Math.min(1, (now - lastTic) / TIC_MS);
  const yawLive = mouseYaw + ((k('left') ? 1 : 0) - (k('right') ? 1 : 0)) * 7 * frac;
  const pitchLive = mousePitch + ((k('lookdown') ? 1 : 0) - (k('lookup') ? 1 : 0)) * 5 * frac;
  if (demoPlaying) {
    // a demo: the recorded view between the two snapshots (CG_InterpolatePlayerState), no live mouse, no prediction
    const v = { ...last };
    const between = prev && alpha < 1 && Math.hypot(last.PX - prev.PX, last.PY - prev.PY, last.PZ - prev.PZ) < SNAP;
    if (between) v.TIME_ = lerp(prev.TIME_, last.TIME_, alpha);
    if (demoCam) {
      // the free camera's eye: no kicks, not dead nor under water whatever the player is (the status bar stays the player's)
      return { ...v, PX: demoCam.x, PY: demoCam.y, PZ: demoCam.z - 26, VIEW_Z: demoCam.z, YAW: demoCam.yaw, PITCH: demoCam.pitch,
        VX: 0, VY: 0, VZ: 0, DEAD: 0, DUCKED: 0, WATERLEVEL: 0, PUNCH: 0 };
    }
    if (!between) return v;
    v.PX = lerp(prev.PX, last.PX, alpha); v.PY = lerp(prev.PY, last.PY, alpha); v.PZ = lerp(prev.PZ, last.PZ, alpha);
    v.VIEW_Z = lerp(prev.VIEW_Z, last.VIEW_Z, alpha);
    v.YAW = lerpAngle(prev.YAW, last.YAW, alpha); v.PITCH = lerpAngle(prev.PITCH, last.PITCH, alpha);
    return v;
  }
  if (last.MATCH_OVER || last.FOLLOW_NAME) return { ...last };   // the intermission camera and the eyes of the one followed do not turn with the mouse
  // (a turning mover under us turns the view on through the tic as it did through the last one)
  const v = { ...last, YAW: (last.YAW + yawLive + (last.MOVER_YAW || 0) * frac) % 360, PITCH: Math.max(-89, Math.min(89, last.PITCH + pitchLive)) };
  if (!prev || alpha >= 1 || Math.hypot(last.PX - prev.PX, last.PY - prev.PY, last.PZ - prev.PZ) >= SNAP) return v;
  v.TIME_ = lerp(prev.TIME_, last.TIME_, alpha);
  const duckLeft = Math.max(0, 1 - (now - duckTime) / 100);
  if (duckLeft > 0) v.VIEW_Z += duckChange * duckLeft;
  if (last.DEAD || !settings.predict) return v;
  // the displacement of one tic, carried on for alpha of the next; with no move key down on the
  // ground, friction is stopping us, so carry on half as far (an overshoot that snaps back is worse
  // than a little lag)
  const moving = touch.move || ['forward', 'back', 'moveleft', 'moveright'].some(k);
  const kk = (alpha / Math.max(1, lastTics)) * (moving || !last.ONGROUND ? 1 : 0.5);
  v.PX = last.PX + (last.PX - prev.PX) * kk;
  v.PY = last.PY + (last.PY - prev.PY) * kk;
  // up and down only in the air on both tics: a landing would otherwise sink the eye into the floor
  if (!last.ONGROUND && !prev.ONGROUND) {
    v.PZ = last.PZ + (last.PZ - prev.PZ) * kk;
    v.VIEW_Z += (last.PZ - prev.PZ) * kk;     // the body's motion, not the eye's (a crouch in the air moves the eye 14)
  }
  v.predicted = true;
  return v;
}

async function frame() {
  if (!running || paused || saving || document.hidden) {
    lastTic = performance.now();
    if (paused && renderer && last) { drawScene(renderer, hud, res, map.bsp, last, { faces: [], ents: [] }, { fov: screenFov(settings.fov), state, playerModel: settings.model.split('/')[0] }); hud.drawCenter('paused', 80, 16); renderer.present(); }
    nextFrame();
    return;
  }
  try {
    const now = performance.now();
    const dt = frameAt ? Math.min(0.1, (now - frameAt) / 1000) : 0.016;
    frameAt = now;
    let ticked = 0, t;
    const ticMs = demoPlaying ? TIC_MS / demoSpeed : TIC_MS;   // (a demo at its speed)
    if (now - lastTic >= ticMs) {
      const tics = Math.min(demoPlaying ? 8 : 2, Math.floor((now - lastTic) / ticMs));   // at most two tics a frame: better slow motion than a stall
      lastTic += tics * ticMs;
      if (now - lastTic > 200) lastTic = now;
      t = performance.now();
      prev = last;
      const input = readInput(tics);   // (read while a demo plays too: the mouse and keys move nothing then)
      last = demoPlaying
        ? (await db.query('SELECT * FROM demo_play(?)', [tics], { rowMode: 'object' })).rows[0] ?? { ...prev, EXIT_KIND: 3 }
        : (await db.query('SELECT * FROM q3_tic(?, ?, ?, ?, ?, ?, ?, ?, ?)', input, { rowMode: 'object' })).rows[0];
      perf.tic = performance.now() - t;
      ticked = tics;
      if (botNet && settings.botai === 4 && !demoPlaying) await answerBots();
      // the match over (not a demo's): its frags go into the career once, and the postgame medals see the count before
      if (last.MATCH_OVER && !demoPlaying && !careerLogged) {
        careerLogged = true;
        keepBotQ().catch((err) => console.error(err));
        keepLlmMemory().catch((err) => console.error(err));
        const c = readCareer();
        if (c) {
          careerFrags = Number(c.frags) || 0;
          try { localStorage.setItem(CAREER, JSON.stringify(careerAfter(c, last))); } catch { careerFrags = null; }
          showCareer();
        }
      }
      if (last.MATCH_OVER && careerFrags !== null && !demoPlaying) last.CAREER_FRAGS = careerFrags;
      lastTics = tics;
      if (prev && !last.DEAD && !prev.DEAD && last.DUCKED !== prev.DUCKED) {
        // the eye drops 14 units or rises 14: spread it over 100 ms, carrying what is left of the last one
        const left = Math.max(0, 1 - (now - duckTime) / 100) * duckChange;
        duckChange = (last.DUCKED ? 14 : -14) + left;
        duckTime = now;
      }
      if (last.EXIT_KIND === 1 || last.EXIT_KIND === 3) {
        // the intermission is over: the next arena of the rotation, or this one again
        await startMap(last.EXIT_KIND === 1 && settings.rotate && last.NEXT_MAP ? last.NEXT_MAP : map.name);
        nextFrame();
        return;
      }
    }
    const alpha = Math.max(0, Math.min(1, (now - lastTic) / ticMs));
    if (demoCam && !demoPlaying) setDemoCam(false);
    if (demoCam) flyDemoCam(dt);
    const view = viewRow(alpha, now);

    t = performance.now();
    // one round trip: every row is tagged with what it is (see FRAME_ALL in sql/render.sql); the view is this frame's
    const wantSpeakers = ++frameNo % 10 === 0;
    const narrowFov = last.MATCH_OVER || last.DEAD ? settings.fov : underwaterFov(zoomedFov(settings.fov, zoomed, now - zoomAt), view.WATERLEVEL, view.TIME_);
    curFov = screenFov(narrowFov);
    audio.setUnderwater(view.WATERLEVEL >= 3 && !last.MATCH_OVER);   // the head under: muffled
    const fpv = firstPersonView(view, state, dt, curFov);   // the kicks, the dips, the bob, the zoom: the view that is painted
    // (its values bound, not written into the text: one statement the engine prepares once and keeps)
    const rows = (await db.query('SELECT * FROM frame_all(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [(settings.renderer === 'sql' ? 1 : 0) | (demoCam ? 2 : 0), lastSoundId, lastFxId, wantSpeakers ? 1 : 0, fpv.x, fpv.y, fpv.z, fpv.yaw, fpv.pitch, curFov], arr)).rows;
    const fr = state.parse(rows);
    fr.sqlProjected = settings.renderer === 'sql';
    if (fr.eye) {
      // paint from the eye the faces were culled for (a prediction into a wall was clamped)
      const dz = fr.eye[2] - fpv.z;
      fpv.x = fr.eye[0]; fpv.y = fr.eye[1]; fpv.z = fr.eye[2];
      view.PX = fr.eye[0]; view.PY = fr.eye[1]; view.VIEW_Z += dz; view.PZ += dz;
    }
    if (ticked) { prevPose = curPose; curPose = poseOf(fr); }
    interpolateFrame(fr, alpha);
    if (fr.speakers) audio.setSpeakersOn(fr.speakers);
    if (fr.loopsAt.length) audio.moveSpeakers(fr.loopsAt);
    audio.setEntityLoops(fr.flying);
    perf.faces = performance.now() - t;
    perf.rows = fr.faces.length;
    const listener = { x: view.PX, y: view.PY, z: view.VIEW_Z, yaw: view.YAW };
    if (fr.sounds.length) { lastSoundId = fr.sounds[fr.sounds.length - 1][0]; audio.playEvents(fr.sounds, listener); }
    audio.update(listener);
    // CG_Player's flight loop while the flight powerup runs (the bots never take it)
    audio.setLoop('flight', 'sound/items/flight.wav', !last.DEAD && last.FLIGHT > 0);
    // CG_AddPlayerWeapon: the gun's firing sound while the trigger is held with ammunition (EF_FIRING: the lightning
    // gun's lg_hum, the gauntlet's fstrun), else its ready sound (the lightning gun's fsthum, the railgun's rg_hum,
    // the BFG's bfg_hum)
    audio.setLoop('weapon', weaponLoop(last.WEAPON, last.WEAPON_SOUND === 1), !last.DEAD && !last.MATCH_OVER && !!weaponLoop(last.WEAPON, last.WEAPON_SOUND === 1));
    if (fr.fx.length) { lastFxId = fr.fx[fr.fx.length - 1][0]; state.handleFx(renderer, fr.fx, view.TIME_, map.bsp); }
    if (ticked && (scoreboard || last.MATCH_OVER) && frameNo % 10 === 0) scores = (await db.query('SELECT * FROM scoreboard', [], arr)).rows;
    // the bots learn the arena while we play: a few grid columns, then a few nodes' edges, a tic (sql/waypoints.sql)
    // (the bots a language model leads: asked now and then, without the loop waiting for the answer)
    if (ticked && strategist && !demoPlaying && !saving && !last.MATCH_OVER) strategist.tick(db).catch((err) => console.error(err));
    if (ticked && map.unlinked > 0 && !demoPlaying && !saving) {
      t = performance.now();
      map.unlinked = await buildWaypoints(db, perf.graph > 40 ? 1 : 3, perf.graph > 40 ? 1 : 2);   // smaller bites when a chunk ran long (q3dm7's 500 nodes)
      perf.graph = performance.now() - t;
      if (map.unlinked === 0) console.log(`[firebird-quake3] waypoint graph built: ${(await db.query('SELECT (SELECT COUNT(*) FROM waypoints) n, COUNT(*) e FROM wp_edges')).rows.map((r) => `${r.N} nodes, ${r.E} edges`)[0]}`);
    }

    t = performance.now();
    // the gun is put away past half-way into the zoom: drawn with the zoomed view it would fill the screen
    const noWeapon = narrowFov < (settings.fov + ZOOM_FOV) / 2 || !!demoCam;   // (zoomed in; or a free camera, which holds no gun)
    const portal = await portalFrame(fr, fpv, view.TIME_);
    const tint = drawScene(renderer, hud, res, map.bsp, view, fr, { fov: curFov, sqlProjected: fr.sqlProjected, state, dt, scoreboard, scores, view: fpv, noWeapon, portal, playerModel: settings.model.split('/')[0] });
    renderer.present(tint);
    perf.draw = performance.now() - t;
    updateStats(ticked);
    if (ticked) { const sp = $('spectate'), label = last.SPECTATOR ? 'Join' : 'Spectate'; if (sp.textContent !== label) sp.textContent = label; }
    if (ticked && demoPlaying && demoInfo && document.activeElement !== $('demoseek')) $('demoseek').value = String(Math.max(0, last.TIME_ - demoInfo.start));
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
    running = false;
    return;
  }
  nextFrame();
}

let fpsT = performance.now(), fpsN = 0, fps = 0, ticN = 0, tps = 0;
function updateStats(ticked) {
  fpsN++; ticN += ticked;
  const now = performance.now();
  if (now - fpsT > 500) { fps = (fpsN * 1000) / (now - fpsT); tps = (ticN * 1000) / (now - fpsT); fpsT = now; fpsN = 0; ticN = 0; }
  statsEl.textContent = `${demoPlaying ? 'demo · ' : recording ? 'recording · ' : ''}${fps.toFixed(1)} fps · ${tps.toFixed(0)} tics/s · q3_tic ${perf.tic.toFixed(0)} ms · frame query ${perf.faces.toFixed(0)} ms (${perf.rows} faces) · paint ${perf.draw.toFixed(0)} ms${botNet && settings.botai === 4 ? ` · LiteRT.js ${(perf.net ?? 0).toFixed(2)} ms` : ''} · ${renderer.particles.length} particles${map?.unlinked > 0 ? ` · bots mapping the arena (${map.unlinked} to go, ${perf.graph.toFixed(0)} ms)` : ''}`;
}

/** A portal or a mirror on screen and near enough to see through: what its camera sees (FRAME_PORTAL), as drawScene takes it */
async function portalFrame(fr, fpv, time) {
  if (!map.portals?.length || settings.renderer === 'sql') return null;
  // the nearest on screen (one view a frame)
  const dist = (p) => { const c = p.center ?? p.origin; return Math.hypot(fpv.x - c[0], fpv.y - c[1], fpv.z - c[2]); };
  for (const p of [...map.portals].sort((a, b) => dist(a) - dist(b))) {
    if (!fr.faces.some((f) => p.faces.has(f[0]))) continue;
    const fade = portalFade(p, fpv);
    if (fade <= 0) return { faces: p.faces, fade: 0, frame: null };
    const v = (p.mirror ? mirrorView : portalView)(p, { ...fpv, fov: curFov }, time);
    const rows = (await db.query(`SELECT * FROM frame_portal(${v.x}, ${v.y}, ${v.z}, ${v.fwd.join(', ')}, ${v.right.join(', ')}, ${v.up.join(', ')}, ${curFov}, ${v.pvs.join(', ')}, ${(v.clip ?? [0, 0, 0, 0]).join(', ')})`, [], arr)).rows;
    const frame = portalState.parse(rows);
    return { faces: p.faces, fade, frame, view: v, brushAngles: portalState.brushAngles };
  }
  return null;
}

// ── SQL console ─────────────────────────────────────────────────────────
async function runConsole() {
  const sqlText = $('sql').value.trim();
  if (!sqlText || !db) return;
  const out = $('sql-out');
  const t0 = performance.now();
  try {
    const r = /^\s*(select|with|execute\s+block)/i.test(sqlText)
      ? await db.query(sqlText, [], { rowMode: 'object' })
      : { rows: [], exec: await db.exec(sqlText) };
    const ms = (performance.now() - t0).toFixed(1);
    if (!r.rows.length) { out.textContent = `OK (${ms} ms)`; return; }
    const cols = Object.keys(r.rows[0]);
    const lines = [cols.join('\t'), ...r.rows.slice(0, 200).map((row) => cols.map((c) => fmt(row[c])).join('\t'))];
    out.textContent = `${r.rows.length} row(s), ${ms} ms\n${lines.join('\n')}`;
  } catch (err) {
    out.textContent = err.message;
  }
}
const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));
$('run-sql').addEventListener('click', runConsole);
$('sql').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runConsole(); });
for (const b of document.querySelectorAll('[data-sql]')) b.addEventListener('click', () => { $('sql').value = b.dataset.sql; runConsole(); });

// ── boot ────────────────────────────────────────────────────────────────
async function openDatabase() {
  // (the engine is firebird-wasm's build without threads: it needs no SharedArrayBuffer, so no cross-origin
  // isolation and no reload to get it; a page built with FB_THREADS=1 loads the threaded one, which does)
  setStatus('Starting Firebird 6 (WebAssembly)…');
  const instance = new FirebirdBrowser('memory://quake3', {
    worker: new Worker(new URL('./firebird-engine-worker.js', import.meta.url)),
    multiTab: 'allow-unsafe',
    autoPersist: false,
  });
  const v = await instance.query("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS v FROM rdb$database");
  $('engine').textContent = `Firebird ${v.rows[0].V}`;
  setStatus('Creating the Quake III schema (PSQL)…');
  await createSchema(instance, { schema: schemaSql, physics: physicsSql, game: gameSql, waypoints: waypointsSql, player: playerSql, demo: demoSql, bots: botsSql, chat: chatSql, ctf: ctfSql, render: renderSql, save: saveSql });
  return instance;
}

// the painter: the software rasteriser, or the WebGL port of Quake III's renderer (the HUD then goes on the overlay canvas)
function makeRenderer() {
  const gl = settings.renderer === 'gl';
  try { renderer = gl ? new GLRenderer(glCanvas, res, overlayCanvas) : new Renderer(canvas, res); }
  catch (err) { setStatus(err.message, true); settings.renderer = 'fast'; $('renderer').value = 'fast'; renderer = new Renderer(canvas, res); }
  const isGl = renderer instanceof GLRenderer;
  overlayCanvas.hidden = !isGl; glCanvas.hidden = !isGl; canvas.hidden = isGl;
  renderer.setSize(viewWidth(), viewHeight());
  if (isGl) { renderer.setAspect(viewAspect()); renderer.setResolution(settings.glres); }
  if (db) setView(db, viewWidth(), viewHeight(), screenFov(settings.fov)).catch((err) => console.error(err));   // (the painters' shapes differ)
  overlayCanvas.style.imageRendering = 'auto';   // (the HUD's 640 by 480 is stretched over the picture smoothly, as Quake III scales its own)
  renderer.setBrightness(settings.brightness);
  renderer.setResources(res);
  if (map) renderer.setSky(map.sky);
  hud = new Hud(pak, renderer);
}

async function usePak(buffer, label) {
  running = false;
  setStatus(`Opening ${label}…`);
  basePak = new Pk3(buffer);
  basePak.label = label;
  pak = new PakSet(baseLayers());
  local.clear(); localPaks.length = 0;
  const maps = pak.mapNames();
  if (!maps.length) throw new Error(`${label} has no maps`);
  pak.inflateAll((n) => !/^(demos|video|vm|botfiles|menu|levelshots)\//.test(n) && !n.endsWith('.aas'));
  setStatus(`Copying ${label} models into Firebird…`);
  res = await loadResources(db, pak, { width: viewWidth(), height: viewHeight(), fov: screenFov(settings.fov) });
  if (settings.botai === 2) await restoreBotQ();   // (what the bots learned here before)
  await restoreLlmMemory();                        // (and what the bots a language model leads remember)
  makeRenderer();
  audio.setPak(pak);
  fillMapMenu();
  $('pakname').textContent = label;
  const first = maps.includes(settings.map) || catalog.some((c) => c.map === settings.map) ? settings.map : maps.includes('q3dm1') ? 'q3dm1' : maps[0];
  await startMap(first);
}

async function boot() {
  try {
    db = await openDatabase();
    window.quake3 = { db, audio, sql: (q, p) => db.query(q, p).then((r) => r.rows) };
    // the map packs the site hosts, if it does (none in a checkout without npm run fetch-maps)
    try {
      const ix = await fetch(new URL('./pak/maps/index.json', location.href));
      if (ix.ok) catalog = await ix.json();
    } catch { catalog = []; }
    try {
      // capture the flag's own files, when the site has them: under every other pak, read with the demo's
      const cf = await fetch(new URL('./pak/ctf.pk3', location.href));
      if (cf.ok) { ctfPak = new Pk3(await cf.arrayBuffer()); ctfPak.label = 'OpenArena'; }
    } catch { ctfPak = null; }
    setStatus('Downloading pak0.pk3 (the Quake III Arena demo, 45 MB)…');
    const resp = await fetch(new URL('./pak/pak0.pk3', location.href));
    if (!resp.ok) throw new Error(`could not fetch pak0.pk3 (${resp.status}); pick a PK3 file instead`);
    await usePak(await resp.arrayBuffer(), 'pak0.pk3');
    nextFrame();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

// pk3s from disk: a game's base pak (it has player models: the full game's pak0) replaces the demo; any other
// (map packs: OpenArena's, the Community Map-Pack, any Quake III map) goes on top and its maps join the menu
$('pakfile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length || !db) return;
  try {
    let firstNew = null;
    for (const f of files) {
      const pk3 = new Pk3(await f.arrayBuffer());
      pk3.label = f.name;
      if (pk3.list('models/players/').length && pk3.mapNames().length) { await usePak(await f.arrayBuffer(), f.name); continue; }
      localPaks.push(pk3);
      for (const m of pk3.mapNames()) { local.set(m, f.name); firstNew ??= m; }
    }
    stackPaks();
    $('pakname').textContent = localPaks.length ? `${basePak.label} + ${localPaks.length} of yours` : basePak.label;
    fillMapMenu();
    if (firstNew) { settings.map = firstNew; saveSettings(); await startMap(firstNew); }
  } catch (err) { setStatus(err.message, true); }
});
$('map').addEventListener('change', (e) => { settings.map = e.target.value; saveSettings(); startMap(e.target.value).catch((err) => setStatus(err.message, true)); });
$('detail').value = settings.detail;
$('detail').addEventListener('change', async (e) => {
  settings.detail = e.target.value; saveSettings();
  await setView(db, viewWidth(), viewHeight(), screenFov(settings.fov));
  renderer.setSize(viewWidth(), viewHeight());
});
// the picture's shape (the WebGL painter's): 4 by 3 as in 1999, or a wide screen's
$('aspect').value = ASPECTS[settings.aspect] ? settings.aspect : '4:3';
$('aspect').addEventListener('change', async (e) => {
  settings.aspect = e.target.value; saveSettings();
  await reshape();
});
// the WebGL picture's resolution (the software painters' is Detail)
$('glres').value = settings.glres;
$('glres').addEventListener('change', (e) => { settings.glres = e.target.value; saveSettings(); renderer?.setResolution?.(settings.glres); });
$('democam').addEventListener('click', (e) => { e.target.blur(); setDemoCam(!demoCam); });
$('renderer').value = settings.renderer;
$('renderer').addEventListener('change', (e) => {
  const wasGl = settings.renderer === 'gl';
  settings.renderer = e.target.value; saveSettings();
  if (res && (wasGl || settings.renderer === 'gl')) { renderer = null; makeRenderer(); }
});
$('brightness').value = String(settings.brightness);
$('brightness').addEventListener('change', (e) => { settings.brightness = Number(e.target.value); saveSettings(); if (renderer) renderer.setBrightness(settings.brightness); });
// demos (CL_Record, CL_PlayDemo; sql/demo.sql): record and stop, play one of this session's, save one to a file and
// load it back (src/demo.js)
async function refreshDemos() {
  if (!db) return;
  const list = await listDemos(db);
  $('demos').replaceChildren(new Option('Demos…', ''), ...list.map((d) => new Option(`${d.MAP_NAME.trim()}, ${d.SECONDS.toFixed(0)} s (${d.ID})`, String(d.ID))));
}
$('record').addEventListener('click', async () => {
  if (!db || !running || demoPlaying) return;
  try {
    if (!recording) await db.query('SELECT * FROM demo_record_start');
    else await db.exec('EXECUTE PROCEDURE demo_record_stop');
    recording = !recording;
    $('record').textContent = recording ? 'Stop' : 'Record';
    await refreshDemos();
  } catch (err) { console.error(err); }
});
async function playDemo(id) {
  const d = (await db.query('SELECT map_name, ent_id FROM demos WHERE id = ?', [id])).rows[0];
  if (!d) return;
  await startMap(d.MAP_NAME.trim());   // its arena (a recording running stops)
  running = false;
  await db.exec(`EXECUTE PROCEDURE demo_play_start(${id | 0})`);
  lastSoundId = (await db.query('SELECT COALESCE(MAX(id), 0) m FROM sound_events')).rows[0].M;
  lastFxId = (await db.query('SELECT COALESCE(MAX(id), 0) m FROM fx_events')).rows[0].M;
  state.selfId = d.ENT_ID;
  renderer.particles = []; state.explosions = []; state.beams = [];
  lastTic = performance.now() - TIC_MS;
  prev = null; prevPose = null; curPose = null; frameAt = 0;
  const [f] = (await db.query('SELECT MIN(time_) t0, MAX(time_) - MIN(time_) s FROM demo_frames WHERE demo_id = ?', [id])).rows;
  demoInfo = { id, start: f.T0, seconds: f.S };
  $('demoseek').max = String(f.S); $('demoseek').value = '0';
  $('demobar').hidden = false;
  demoPlaying = true;
  setDemoCam(false);
  running = true;
}
// seeking a demo (the slider, ← and →): to the snapshot at that time; the next tic shows it
async function seekDemo(seconds) {
  if (!demoPlaying || !demoInfo) return;
  const s = Math.max(0, Math.min(demoInfo.seconds, seconds));
  const [r] = (await db.query('SELECT MIN(n) n FROM demo_frames WHERE demo_id = ? AND time_ >= ?', [demoInfo.id, demoInfo.start + s - 1e-6])).rows;
  await db.exec(`EXECUTE PROCEDURE demo_seek(${r.N ?? 0})`);
  renderer.particles = []; state.explosions = []; state.beams = [];
  prev = null; prevPose = null; curPose = null;
  lastTic = performance.now() - TIC_MS / demoSpeed;
}
$('demoseek').addEventListener('input', (e) => seekDemo(Number(e.target.value)).catch((err) => console.error(err)));
$('demospeed').addEventListener('change', (e) => { demoSpeed = Number(e.target.value) || 1; });
$('demos').addEventListener('focus', () => refreshDemos().catch((err) => console.error(err)));
$('demos').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  e.target.value = '';
  if (id && db) playDemo(id).catch((err) => { console.error(err); setStatus(`Error: ${err.message}`, true); });
});
$('savedemo').addEventListener('click', async () => {
  if (!db) return;
  const [d] = await listDemos(db);
  if (!d) { setStatus('No demo recorded yet', true); setTimeout(() => setStatus(''), 2000); return; }
  const blob = new Blob([JSON.stringify(await exportDemo(db, d.ID))], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${d.MAP_NAME.trim()}-${d.ID}.q3demo.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('demofile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f || !db) return;
  try {
    const id = await importDemo(db, JSON.parse(await f.text()));
    await refreshDemos();
    await playDemo(id);
  } catch (err) { console.error(err); setStatus(`Error: ${err.message}`, true); }
});
// save games (sql/save.sql, src/save.js): the game as it stands to a file or the browser's storage, and back
const QUICKSAVE = 'firebird-quake3:quicksave';
const flash = (msg, bad = false) => { setStatus(msg, bad); setTimeout(() => setStatus(''), 1500); };
async function takeSave() {
  if (!db || !running || demoPlaying) return null;
  saving = true;
  try { return await exportSave(db); } finally { saving = false; }
}
async function loadGame(save) {
  const name = saveMap(save);
  await startMap(name);   // the arena fresh from the pak (a recording stops, a demo ends)
  running = false;
  saving = true;
  try {
    await importSave(db, save);
    state.selfId = (await db.query('SELECT player_ent() pe FROM rdb$database')).rows[0].PE;
    renderer.particles = []; state.explosions = []; state.beams = [];
    map.unlinked = 1;     // the graph's build goes on from where the save had it
    lastTic = performance.now() - TIC_MS;
    prev = null; last = null; prevPose = null; curPose = null; frameAt = 0;
  } finally { saving = false; running = true; }
  flash('Game loaded');
}
async function quickSave() {
  try {
    const s = await takeSave();
    if (!s) return;
    localStorage.setItem(QUICKSAVE, JSON.stringify(s));
    flash('Game saved (F9 loads it)');
  } catch (err) { console.error(err); flash(`Quick save failed: ${err.message}`, true); }
}
async function quickLoad() {
  let text = null;
  try { text = localStorage.getItem(QUICKSAVE); } catch { /* storage blocked */ }
  if (!text) { flash('No quick save yet (F5 saves)', true); return; }
  try { await loadGame(JSON.parse(text)); } catch (err) { console.error(err); setStatus(`Error: ${err.message}`, true); }
}
$('savegame').addEventListener('click', async () => {
  try {
    const s = await takeSave();
    if (!s) return;
    const blob = new Blob([JSON.stringify(s)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${s.map}-${Math.floor(s.time / 60)}m${String(Math.floor(s.time % 60)).padStart(2, '0')}s.q3save.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { console.error(err); flash(`Save failed: ${err.message}`, true); }
});
$('loadgame').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f || !db) return;
  try { await loadGame(JSON.parse(await f.text())); } catch (err) { console.error(err); setStatus(`Error: ${err.message}`, true); }
});
// talking to the bots (sql/chat.sql): T or Y opens the line, Enter says it. With EmbeddingGemma 2 loaded (the
// box beside it; src/chat.js) the line is matched by what it means, else a phrase has to be in it word for word
const chatEl = $('chat');
chatEl.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { chatEl.value = ''; chatEl.blur(); return; }
  if (e.key !== 'Enter') return;
  const text = chatEl.value.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 150);
  chatEl.value = '';
  chatEl.blur();
  if (!text || !db || !running || demoPlaying) return;
  try {
    const vec = embedderReady() ? await embed(text) : null;
    const [r] = (await db.query('SELECT * FROM player_say(?, ?)', [text, vec])).rows;
    $('chatinfo').textContent = r?.KIND ? `${r.KIND.trim()}${r.ARG ? ' ' + r.ARG.trim() : ''}${vec ? ` (${r.SCORE.toFixed(2)})` : ''}, ${r.HEARD} bot${r.HEARD === 1 ? '' : 's'}` : (vec ? 'small talk' : 'not understood (no model)');
  } catch (err) { console.error(err); }
});
const chatStatus = (s) => { $('chatinfo').textContent = s; };
function startEmbedder() {
  loadEmbedder(chatStatus).catch((err) => { console.error(err); chatStatus(`model failed: ${err.message}`); $('chatmodel').checked = false; settings.chatModel = false; saveSettings(); });
}
$('chatmodel').checked = settings.chatModel;
$('chatmodel').addEventListener('change', (e) => { settings.chatModel = e.target.checked; saveSettings(); if (e.target.checked) startEmbedder(); });
if (settings.chatModel) startEmbedder();
// the bots' fight moves: Quake III's, the network's (sql/bots.sql bot_rl_move and bot_nn_best, the weights of
// src/botnn.js), the table's (src/botq.js), or the table's and learning on while we play (the table then kept in
// the browser's storage when a match ends)
// With "the network on LiteRT.js" (4) the same network is run by LiteRT.js on the page (src/litert.js): the bots
// that are about to choose leave their features (bot_nn_ask), the page runs them all at once after the tic and
// hands the values back (bot_nn_answer). Until the library is there, and if it does not come, it is the pass in SQL
let botNet = null, botNetLoading = null;
const rlMode = () => (settings.botai === 4 ? (botNet ? 4 : 3) : settings.botai | 0);
function startBotNet() {
  botNetLoading ??= new BotNet(BOT_NN).load().then((net) => {
    botNet = net;
    console.log(`LiteRT.js runs the bots' network (within ${net.error.toExponential(1)} of the pass written out)`);
    if (db && running) return db.exec(`UPDATE game SET bot_rl = ${rlMode()}`);
  }).catch((err) => { console.error(err); setStatus(`LiteRT.js did not start (${err.message}): the network runs in SQL`, true); });
}
async function answerBots() {
  const asks = (await db.query('SELECT a.eid, a.f0, a.f1, a.f2, a.f3, a.f4, a.f5, a.f6, a.f7, a.f8, a.f9, a.f10, a.f11 FROM bot_nn_ask a', [], arr)).rows;
  if (!asks.length) return;
  const values = await botNet.values(asks.map((r) => r.slice(1)));
  perf.net = botNet.ms;
  for (const s of answerSql(asks.map((r) => r[0]), values)) await db.exec(s);
}
$('botai').value = String(settings.botai);
if (settings.botai === 4) startBotNet();
$('botai').addEventListener('change', (e) => {
  settings.botai = Number(e.target.value); saveSettings();
  if (settings.botai === 4) startBotNet();
  if (db && running) db.exec(`UPDATE game SET bot_rl = ${rlMode()}`).catch((err) => console.error(err));
});
// the gun a bot fights with: its character's favourite, or by the distance as measured (bot_pick_weapon)
$('botguns').value = String(settings.botguns ? 1 : 0);
$('botguns').addEventListener('change', (e) => {
  settings.botguns = Number(e.target.value); saveSettings();
  if (db && running) db.exec(`UPDATE game SET bot_wsel = ${settings.botguns ? 1 : 0}`).catch((err) => console.error(err));
});
async function keepBotQ() {
  if (settings.botai !== 2) return;
  const rows = (await db.query('SELECT s, a, q, n FROM bot_q', [], arr)).rows;
  try { localStorage.setItem('firebird-quake3:botq', JSON.stringify(rows)); } catch { /* storage blocked or full */ }
}
async function restoreBotQ() {
  let rows = null;
  try { rows = JSON.parse(localStorage.getItem('firebird-quake3:botq') ?? 'null'); } catch { /* none */ }
  if (Array.isArray(rows) && rows.length) await loadBotQ(db, rows);
}
// a language model as a bot's strategist (src/llm.js; sql/chat.sql bot_llm_state, bot_llm_apply): which bots it
// leads, the model, and the player's API key, which is kept in this browser and nowhere else
const LLM_KEY = 'firebird-quake3:anthropic-key';
let strategist = null;
const llmKey = () => { try { return localStorage.getItem(LLM_KEY) ?? ''; } catch { return ''; } };
const LLM_MEMORY = 'firebird-quake3:llm-memory';
let llmKept = -1e9;
// (the memory is kept in the browser as decisions are made, every ten seconds at most, and at a match's end)
const llmStatus = (s) => { $('llminfo').textContent = s; if (performance.now() - llmKept > 10_000) keepLlmMemory().catch((err) => console.error(err)); };
async function keepLlmMemory() {
  if (!db || !strategist?.decisions) return;
  llmKept = performance.now();
  const mem = await exportMemory(db);
  try { localStorage.setItem(LLM_MEMORY, JSON.stringify(mem)); } catch { /* storage blocked or full */ }
}
async function restoreLlmMemory() {
  let mem = null;
  try { mem = JSON.parse(localStorage.getItem(LLM_MEMORY) ?? 'null'); } catch { /* none */ }
  if (mem) await importMemory(db, mem);
}
async function leadBots() {
  const key = llmKey(), kind = llmKind();
  strategist = !settings.llm ? null
    : kind === 'server' ? new ServerStrategist({ url: settings.llmUrl, model: settings.llmName, onStatus: llmStatus })
      : kind === 'local' ? new LocalStrategist({ model: settings.llmModel, onStatus: llmStatus })
        : key ? new Strategist({ apiKey: key, model: settings.llmModel, onStatus: llmStatus }) : null;
  llmStatus(settings.llm && !strategist ? 'needs an API key' : '');
  if (db && map) await db.exec(`EXECUTE PROCEDURE bot_llm_lead(${strategist ? settings.llm | 0 : 0})`);
}
// (which kind of model the menu is on: Claude's API, the player's own server, or a model in this browser)
const LLM_SERVER = 'server';
const llmKind = () => (settings.llmModel === LLM_SERVER ? 'server' : LOCAL_MODELS.some(([id]) => id === settings.llmModel) ? 'local' : 'claude');
const llmFields = () => { const k = llmKind(); $('llmkey').hidden = k !== 'claude'; $('llmurl').hidden = $('llmname').hidden = k !== 'server'; };
for (const [title, list] of [['Claude (your API key)', LLM_MODELS], ['Your own server', [[LLM_SERVER, 'Ollama, LM Studio…']]], ['In this browser (experimental)', LOCAL_MODELS]]) {
  const group = document.createElement('optgroup');
  group.label = title;
  for (const [id, label] of list) group.append(new Option(label, id));
  $('llmmodel').append(group);
}
if (![...LLM_MODELS, ...LOCAL_MODELS, [LLM_SERVER]].some(([id]) => id === settings.llmModel)) settings.llmModel = LLM_MODELS[0][0];
$('llmurl').value = settings.llmUrl;
$('llmname').value = settings.llmName;
llmFields();
$('llmmodel').value = settings.llmModel;
$('llmbots').value = String(settings.llm);
$('llmkey').value = llmKey();
const llmChanged = () => { saveSettings(); leadBots().catch((err) => console.error(err)); };
$('llmbots').addEventListener('change', (e) => { settings.llm = Number(e.target.value); llmChanged(); });
$('llmmodel').addEventListener('change', (e) => { settings.llmModel = e.target.value; llmFields(); llmChanged(); });
$('llmurl').addEventListener('change', (e) => { settings.llmUrl = e.target.value.trim() || SERVER_DEFAULT.url; llmChanged(); });
$('llmname').addEventListener('change', (e) => { settings.llmName = e.target.value.trim() || SERVER_DEFAULT.model; llmChanged(); });
$('llmkey').addEventListener('change', (e) => {
  try { if (e.target.value.trim()) localStorage.setItem(LLM_KEY, e.target.value.trim()); else localStorage.removeItem(LLM_KEY); } catch { /* storage blocked */ }
  llmChanged();
});
// the career's awards (UI_SPLevelMenu's row of medals with their counts), as kept in the browser's storage
function showCareer() {
  const c = readCareer() ?? {};
  const awards = careerAwards(c);
  $('career').textContent = awards.length ? awards.map(([a, n]) => (n ? `${a} ${n}` : a)).join(' · ') : '';
  $('career').title = `Your career's awards over ${Number(c.matches) || 0} match${Number(c.matches) === 1 ? '' : 'es'} (kept in this browser): one accuracy for each match at 50% or better, the impressives, excellents and gauntlet frags counted, the frags in hundreds, one perfect for each win without a death`;
}
showCareer();
// the Keys panel (the Controls menu): every action with its keys; a click on one and the next key, mouse button or
// turn of the wheel is bound to it (Escape leaves it as it is, Backspace takes its keys off)
function showBinds() {
  const rows = $('keyrows');
  rows.textContent = '';
  for (const [id, label, command] of ACTIONS) {
    const tr = document.createElement('tr'), name = document.createElement('td'), cell = document.createElement('td'), btn = document.createElement('button');
    name.textContent = label;
    name.title = command;
    btn.type = 'button';
    btn.dataset.action = id;
    btn.textContent = binding === id ? 'press a key…' : keysOf(binds, id).map(keyName).join(' or ') || '—';
    btn.addEventListener('click', () => { binding = binding === id ? null : id; showBinds(); });
    cell.append(btn);
    tr.append(name, cell);
    rows.append(tr);
  }
}
function bound(code) {
  if (!binding) return false;
  if (code === 'Backspace' || code === 'Delete') unbind(binds, binding);
  else if (code !== 'Escape' && !bind(binds, binding, code)) return true;   // (a key that cannot be bound: still waiting)
  binding = null;
  settings.binds = savedBinds(binds);
  saveSettings();
  keys.clear();
  showBinds();
  return true;
}
window.addEventListener('keydown', (e) => { if (bound(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
$('keys').addEventListener('mousedown', (e) => { if (binding && !(e.target instanceof HTMLButtonElement) && bound(mouseCode(e.button))) e.preventDefault(); });
$('keys').addEventListener('contextmenu', (e) => { if (binding) e.preventDefault(); });
$('keys').addEventListener('wheel', (e) => { if (binding && e.deltaY && bound(wheelCode(e.deltaY))) e.preventDefault(); }, { passive: false });
$('keysreset').addEventListener('click', () => { binds = makeBinds(); binding = null; settings.binds = {}; saveSettings(); showBinds(); });
showBinds();
// spectating: out of the match and back (SetTeam)
$('spectate').addEventListener('click', () => {
  if (!db || !running || !last) return;
  db.exec(`EXECUTE PROCEDURE set_spectator(${last.SPECTATOR ? 0 : 1})`).catch((err) => console.error(err));
});
// bots joining and leaving mid-game (G_AddBot, clientkick): the menus offer the roster's absent ones and
// those in the arena
async function refreshBotMenus() {
  if (!db) return;
  const roster = (await db.query('SELECT name FROM bot_defs ORDER BY name')).rows.map((r) => r.NAME.trim());
  const here = new Set((await db.query("SELECT bot FROM ents WHERE classname = 'bot'")).rows.map((r) => r.BOT.trim()));
  const fill = (sel, label, names) => sel.replaceChildren(new Option(label, ''), ...names.map((n) => new Option(n, n)));
  fill($('addbot'), 'Add bot…', roster.filter((n) => !here.has(n)));
  fill($('kickbot'), 'Remove bot…', roster.filter((n) => here.has(n)));
}
const botMenu = (id, sql) => {
  $(id).addEventListener('focus', () => refreshBotMenus().catch((err) => console.error(err)));
  $(id).addEventListener('change', async (e) => {
    const n = e.target.value;
    e.target.value = '';
    if (!n || !db || !running) return;
    try { await db.exec(sql(n)); } catch (err) { console.error(err); }
    await refreshBotMenus();
  });
};
botMenu('addbot', (n) => `EXECUTE PROCEDURE add_bot('${n}', ${settings.skill | 0})`);
botMenu('kickbot', (n) => `EXECUTE PROCEDURE kick_bot('${n}')`);
// the name the bots call you by
const cleanName = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/'/g, '').trim().slice(0, 15) || 'Player';
async function setPlayerName() { if (db) await db.exec(`UPDATE player SET name = '${cleanName(settings.name)}' WHERE id = 1`); }
$('pname').value = settings.name;
// the model played (the "model" userinfo, model/skin): the pak's player models and their own skins, not the team ones
function fillModelMenu() {
  const opts = [];
  for (const [pm, p] of [...res.players].sort(([a], [b]) => a.localeCompare(b))) {
    for (const sk of [...p.skins.keys()].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))) {
      if (sk !== 'red' && sk !== 'blue') opts.push(`${pm}/${sk}`);
    }
  }
  if (!opts.includes(settings.model)) settings.model = opts.includes('sarge/default') ? 'sarge/default' : opts[0] ?? 'sarge/default';
  $('pmodel').replaceChildren(...opts.map((o) => new Option(o.endsWith('/default') ? o.slice(0, -8) : o, o)));
  $('pmodel').value = settings.model;
}
async function setPlayerModel() {
  const [m, s] = settings.model.split('/');
  if (db) await db.exec(`EXECUTE PROCEDURE set_player_model('${m.replace(/[^a-z0-9_]/gi, '')}', '${(s ?? 'default').replace(/[^a-z0-9_]/gi, '')}')`);
}
// the rail's colour (the "color1" userinfo), as the setup menu orders them (uitogamecode)
const RAIL_COLORS = [[4, 'red'], [6, 'yellow'], [2, 'green'], [3, 'teal'], [1, 'blue'], [5, 'magenta'], [7, 'white']];
$('prail').replaceChildren(...RAIL_COLORS.map(([v, n]) => new Option(n, String(v))));
if (!RAIL_COLORS.some(([v]) => v === Number(settings.rail))) settings.rail = 4;
$('prail').value = String(settings.rail);
async function setPlayerColor() {
  if (db) await db.exec(`EXECUTE PROCEDURE set_player_color(${Number(settings.rail) | 0})`);
}
$('prail').addEventListener('change', (e) => { settings.rail = Number(e.target.value); saveSettings(); setPlayerColor().catch((err) => console.error(err)); });
$('pmodel').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(); setPlayerModel().catch((err) => console.error(err)); });
$('pname').addEventListener('change', (e) => { settings.name = cleanName(e.target.value); e.target.value = settings.name; saveSettings(); setPlayerName().catch((err) => console.error(err)); });
// the limits apply at once, as Quake III's fraglimit and timelimit cvars do
const setLimit = (key, col) => (e) => {
  settings[key] = Number(e.target.value); saveSettings();
  if (db && running) db.exec(`UPDATE game SET ${col} = ${settings[key] | 0} WHERE id = 1`).catch((err) => console.error(err));
};
$('fraglimit').value = String(settings.fraglimit);
$('fraglimit').addEventListener('change', setLimit('fraglimit', 'fraglimit'));
$('timelimit').value = String(settings.timelimit);
$('timelimit').addEventListener('change', setLimit('timelimit', 'timelimit'));
$('rotate').checked = settings.rotate;
$('rotate').addEventListener('change', (e) => { settings.rotate = e.target.checked; saveSettings(); });
$('predict').checked = settings.predict;
$('predict').addEventListener('change', (e) => { settings.predict = e.target.checked; saveSettings(); });
$('skill').value = String(settings.skill);
$('skill').addEventListener('change', (e) => { settings.skill = Number(e.target.value); saveSettings(); });
$('gametype').value = settings.gametype;
$('gametype').addEventListener('change', (e) => { settings.gametype = e.target.value; saveSettings(); });
$('team').value = settings.team;
$('team').addEventListener('change', (e) => { settings.team = e.target.value; saveSettings(); });
$('bots').value = String(settings.bots);
$('bots').addEventListener('change', (e) => { settings.bots = Number(e.target.value); saveSettings(); });
$('sfxvol').value = settings.sfx;
$('sfxvol').addEventListener('input', () => { settings.sfx = Number($('sfxvol').value); saveSettings(); audio.unlock(); audio.setVolume(settings.sfx / 100); });
$('music').value = settings.musicMode;
$('music').addEventListener('change', (e) => { settings.musicMode = e.target.value; saveSettings(); audio.unlock(); audio.setMusicMode(settings.musicMode); });
$('musicvol').value = settings.music;
$('musicvol').addEventListener('input', () => { settings.music = Number($('musicvol').value); saveSettings(); audio.setMusicVolume(settings.music / 100); });

boot();
