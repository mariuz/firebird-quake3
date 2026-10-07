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
import waypointsSql from '../sql/waypoints.sql';
import botsSql from '../sql/bots.sql';
import renderSql from '../sql/render.sql';
import { Pk3 } from './pk3.js';
import { createSchema, loadResources, loadMap, buildWaypoints, setView } from './loader.js';
import { Renderer } from './renderer.js';
import { GLRenderer } from './renderer-gl.js';
import { Hud } from './hud.js';
import { FrameState, drawScene } from './scene.js';
import { Q3Audio } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const glCanvas = $('glscreen');
const overlayCanvas = $('overlay');
const wrap = $('screen-wrap');   // the mouse and touch act on the wrapper: whichever canvas is showing
const statusEl = $('status');
const statsEl = $('stats');
const TIC_MS = 50;

let db, pak, res, renderer, hud;
let map = null;          // { name, bsp }
let last = null;         // last Q3_TIC row
let prev = null;         // the one before: the frame between two tics is painted between the two states
let prevPose = null, curPose = null;   // the entities' and brush models' poses at those tics
let frameAt = 0;         // when the last frame was painted
let running = false;
let paused = false;
let lastTic = 0;
let lastSoundId = 0;
let lastFxId = 0;
let frameNo = 0;
let scores = [];
const state = new FrameState();
const settings = { map: 'q3dm1', detail: 'medium', sfx: 70, music: 40, musicMode: 'tracks', skill: 2, bots: 3, fov: 90, renderer: 'fast', brightness: 4 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('firebird-quake3:settings') || '{}')); } catch { /* defaults */ }
const saveSettings = () => { try { localStorage.setItem('firebird-quake3:settings', JSON.stringify(settings)); } catch { /* ignore */ } };
const viewWidth = () => (settings.detail === 'high' ? 640 : settings.detail === 'low' ? 160 : 320);
const viewHeight = () => (settings.detail === 'high' ? 480 : settings.detail === 'low' ? 120 : 240);
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
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE',
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'Tab', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7',
  'Digit8', 'Digit9', 'Digit0', 'KeyF', 'KeyG', 'Comma', 'Period', 'PageUp', 'PageDown', 'Slash', 'Enter', 'KeyH']);
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (!running) return;
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code.startsWith('Digit')) { const n = Number(e.code.slice(5)); if (n >= 1 && n <= 9) impulse = n; }
  if (e.code === 'Slash') impulse = 12;
  if (e.code === 'KeyG') impulse = 99;
  if (e.code === 'Enter' || e.code === 'KeyH') impulse = 13;
  if (e.code === 'Tab') scoreboard = true;
  if (e.code === 'KeyP' || e.code === 'Pause') paused = !paused;
});
window.addEventListener('keyup', (e) => { keys.delete(e.code); if (e.code === 'Tab') scoreboard = false; });
window.addEventListener('blur', () => keys.clear());
wrap.addEventListener('click', () => {
  if (running && document.pointerLockElement !== wrap) wrap.requestPointerLock?.()?.catch?.(() => {});
});
wrap.addEventListener('mousedown', (e) => { if (document.pointerLockElement === wrap && e.button === 0) fireClick = true; });
window.addEventListener('mouseup', () => { fireClick = false; });
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === wrap) {
    mouseYaw -= e.movementX * 0.15;
    mousePitch += e.movementY * 0.15;
  }
});
window.addEventListener('wheel', (e) => { if (document.pointerLockElement === wrap) impulse = e.deltaY > 0 ? 12 : 14; });
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
  let fwd = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
  let side = (k('KeyD') || k('Period') ? 1 : 0) - (k('KeyA') || k('Comma') ? 1 : 0);
  const turnKeys = (k('ArrowLeft') ? 1 : 0) - (k('ArrowRight') ? 1 : 0);
  const lookKeys = (k('PageDown') ? 1 : 0) - (k('PageUp') ? 1 : 0);
  const run = k('ShiftLeft') || k('ShiftRight') ? 0 : 1;     // always run; shift walks
  if (touch.move) {
    fwd = Math.max(-1, Math.min(1, -touch.move.dy / 40));
    side = Math.max(-1, Math.min(1, touch.move.dx / 40));
  }
  const yaw = turnKeys * 7 * tics + mouseYaw;
  const pitch = lookKeys * 5 * tics + mousePitch;
  mouseYaw = 0; mousePitch = 0;
  const fire = k('ControlLeft') || k('ControlRight') || k('KeyF') || fireClick ? 1 : 0;
  if (fireClick === 'tap') fireClick = false;
  const jump = k('Space') || k('KeyE') || k('TapJump') ? 1 : 0;
  keys.delete('TapJump');
  const imp = impulse;
  impulse = 0;
  return [tics, fwd, side, yaw, pitch, fire, jump, run, imp];
}

// ── maps ─────────────────────────────────────────────────────────────────
async function startMap(name) {
  running = false;
  setStatus(`Loading ${name} into Firebird…`);
  const t0 = performance.now();
  const bsp = await loadMap(db, pak, res, name, { skill: settings.skill, bots: settings.bots, link: false });
  map = { name, bsp, unlinked: 1 };
  renderer.setResources(res);
  renderer.particles = [];
  renderer.meshCache?.clear();
  state.explosions = []; state.beams = [];
  const g = (await db.query('SELECT sky, music FROM game')).rows[0];
  map.sky = g.SKY;
  renderer.setSky(g.SKY);
  const speakers = (await db.query("SELECT id, x, y, z, noise1, speed, height, count_ FROM ents WHERE classname = 'target_speaker' AND BIN_AND(spawnflags, 3) <> 0 AND noise1 IS NOT NULL", [], arr)).rows;
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
// world interpolated between the last two states (CG_CalcEntityLerpPositions), one tic behind, with the
// view angles live from the mouse so the look never waits for a tic.
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

/** The tic row as the painter sees it this frame: the position between the two tics, the angles live. */
function viewRow(alpha, now) {
  const k = (c) => keys.has(c);
  const frac = Math.min(1, (now - lastTic) / TIC_MS);
  const yawLive = mouseYaw + ((k('ArrowLeft') ? 1 : 0) - (k('ArrowRight') ? 1 : 0)) * 7 * frac;
  const pitchLive = mousePitch + ((k('PageDown') ? 1 : 0) - (k('PageUp') ? 1 : 0)) * 5 * frac;
  const v = { ...last, YAW: (last.YAW + yawLive) % 360, PITCH: Math.max(-89, Math.min(89, last.PITCH + pitchLive)) };
  if (prev && alpha < 1 && Math.hypot(last.PX - prev.PX, last.PY - prev.PY, last.PZ - prev.PZ) < SNAP) {
    v.PX = lerp(prev.PX, last.PX, alpha); v.PY = lerp(prev.PY, last.PY, alpha); v.PZ = lerp(prev.PZ, last.PZ, alpha);
    v.VIEW_Z = lerp(prev.VIEW_Z, last.VIEW_Z, alpha);
    v.TIME_ = lerp(prev.TIME_, last.TIME_, alpha);
  }
  return v;
}

async function frame() {
  if (!running || paused || document.hidden) {
    lastTic = performance.now();
    if (paused && renderer && last) { drawScene(renderer, hud, res, map.bsp, last, { faces: [], ents: [] }, { fov: settings.fov, state }); hud.drawCenter('paused', 80, 16); renderer.present(); }
    nextFrame();
    return;
  }
  try {
    const now = performance.now();
    const dt = frameAt ? Math.min(0.1, (now - frameAt) / 1000) : 0.016;
    frameAt = now;
    let ticked = 0, t;
    if (now - lastTic >= TIC_MS) {
      const tics = Math.min(2, Math.floor((now - lastTic) / TIC_MS));   // at most two tics a frame: better slow motion than a stall
      lastTic += tics * TIC_MS;
      if (now - lastTic > 200) lastTic = now;
      t = performance.now();
      prev = last;
      last = (await db.query('SELECT * FROM q3_tic(?, ?, ?, ?, ?, ?, ?, ?, ?)', readInput(tics), { rowMode: 'object' })).rows[0];
      perf.tic = performance.now() - t;
      ticked = tics;
      if (last.EXIT_KIND === 3) {
        await startMap(map.name);
        nextFrame();
        return;
      }
    }
    const alpha = Math.max(0, Math.min(1, (now - lastTic) / TIC_MS));
    const view = viewRow(alpha, now);

    t = performance.now();
    // one round trip: every row is tagged with what it is (see FRAME_ALL in sql/render.sql); the view is this frame's
    const wantSpeakers = ++frameNo % 10 === 0;
    const rows = (await db.query(`SELECT * FROM frame_all(${settings.renderer === 'sql' ? 1 : 0}, ${lastSoundId}, ${lastFxId}, ${wantSpeakers ? 1 : 0}, ${view.PX}, ${view.PY}, ${view.VIEW_Z}, ${view.YAW}, ${view.PITCH})`, [], arr)).rows;
    const fr = state.parse(rows);
    fr.sqlProjected = settings.renderer === 'sql';
    if (ticked) { prevPose = curPose; curPose = poseOf(fr); }
    interpolateFrame(fr, alpha);
    if (fr.speakers) audio.setSpeakersOn(fr.speakers);
    perf.faces = performance.now() - t;
    perf.rows = fr.faces.length;
    const listener = { x: view.PX, y: view.PY, z: view.VIEW_Z, yaw: view.YAW };
    if (fr.sounds.length) { lastSoundId = fr.sounds[fr.sounds.length - 1][0]; audio.playEvents(fr.sounds, listener); }
    audio.update(listener);
    audio.setLoop('weapon', last.WEAPON === 32 ? 'sound/weapons/lightning/lg_hum.wav' : last.WEAPON === 64 ? 'sound/weapons/railgun/rg_hum.wav' : null, !last.DEAD && (last.WEAPON === 32 || last.WEAPON === 64));
    if (fr.fx.length) { lastFxId = fr.fx[fr.fx.length - 1][0]; state.handleFx(renderer, fr.fx, view.TIME_); }
    if (ticked && (scoreboard || last.MATCH_OVER) && frameNo % 10 === 0) scores = (await db.query('SELECT * FROM scoreboard', [], arr)).rows;
    // the bots learn the arena while we play: a few grid columns, then a few nodes' edges, a tic (sql/waypoints.sql)
    if (ticked && map.unlinked > 0) {
      t = performance.now();
      map.unlinked = await buildWaypoints(db, perf.graph > 40 ? 1 : 3, perf.graph > 40 ? 1 : 2);   // smaller bites when a chunk ran long (q3dm7's 500 nodes)
      perf.graph = performance.now() - t;
      if (map.unlinked === 0) console.log(`[firebird-quake3] waypoint graph built: ${(await db.query('SELECT (SELECT COUNT(*) FROM waypoints) n, COUNT(*) e FROM wp_edges')).rows.map((r) => `${r.N} nodes, ${r.E} edges`)[0]}`);
    }

    t = performance.now();
    const tint = drawScene(renderer, hud, res, map.bsp, view, fr, { fov: settings.fov, sqlProjected: fr.sqlProjected, state, dt, scoreboard, scores });
    renderer.present(tint);
    perf.draw = performance.now() - t;
    updateStats(ticked);
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
  statsEl.textContent = `${fps.toFixed(1)} fps · ${tps.toFixed(0)} tics/s · q3_tic ${perf.tic.toFixed(0)} ms · frame query ${perf.faces.toFixed(0)} ms (${perf.rows} faces) · paint ${perf.draw.toFixed(0)} ms · ${renderer.particles.length} particles${map?.unlinked > 0 ? ` · bots mapping the arena (${map.unlinked} to go, ${perf.graph.toFixed(0)} ms)` : ''}`;
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
  if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator &&
      Number(sessionStorage.getItem('firebird-quake:coi-reloads') || '0') < 2) {
    setStatus('Enabling cross-origin isolation for Firebird WASM (one-time reload)…');
    return new Promise(() => {});
  }
  if (!window.crossOriginIsolated) {
    throw new Error('This page is not cross-origin isolated, so Firebird WASM cannot start. Reload once (the service worker enables it), and use HTTPS or localhost.');
  }
  setStatus('Starting Firebird 6 (WebAssembly)…');
  const instance = new FirebirdBrowser('memory://quake3', {
    worker: new Worker(new URL('./firebird-engine-worker.js', import.meta.url)),
    multiTab: 'allow-unsafe',
    autoPersist: false,
  });
  const v = await instance.query("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS v FROM rdb$database");
  $('engine').textContent = `Firebird ${v.rows[0].V}`;
  setStatus('Creating the Quake III schema (PSQL)…');
  await createSchema(instance, { schema: schemaSql, physics: physicsSql, game: gameSql, waypoints: waypointsSql, player: playerSql, bots: botsSql, render: renderSql });
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
  renderer.setBrightness(settings.brightness);
  renderer.setResources(res);
  if (map) renderer.setSky(map.sky);
  hud = new Hud(pak, renderer);
}

async function usePak(buffer, label) {
  running = false;
  setStatus(`Opening ${label}…`);
  pak = new Pk3(buffer);
  const maps = pak.mapNames();
  if (!maps.length) throw new Error(`${label} has no maps`);
  pak.inflateAll((n) => !/^(demos|video|vm|botfiles|menu|levelshots)\//.test(n) && !n.endsWith('.aas'));
  setStatus(`Copying ${label} models into Firebird…`);
  res = await loadResources(db, pak, { width: viewWidth(), height: viewHeight(), fov: settings.fov });
  makeRenderer();
  audio.setPak(pak);
  $('map').innerHTML = maps.map((m) => `<option>${m}</option>`).join('');
  $('pakname').textContent = label;
  const first = maps.includes(settings.map) ? settings.map : maps.includes('q3dm1') ? 'q3dm1' : maps[0];
  await startMap(first);
}

async function boot() {
  try {
    db = await openDatabase();
    window.quake3 = { db, audio, sql: (q, p) => db.query(q, p).then((r) => r.rows) };
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

$('pakfile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !db) return;
  try { await usePak(await f.arrayBuffer(), f.name); } catch (err) { setStatus(err.message, true); }
});
$('map').addEventListener('change', (e) => { settings.map = e.target.value; saveSettings(); startMap(e.target.value).catch((err) => setStatus(err.message, true)); });
$('detail').value = settings.detail;
$('detail').addEventListener('change', async (e) => {
  settings.detail = e.target.value; saveSettings();
  await setView(db, viewWidth(), viewHeight(), settings.fov);
  renderer.setSize(viewWidth(), viewHeight());
});
$('renderer').value = settings.renderer;
$('renderer').addEventListener('change', (e) => {
  const wasGl = settings.renderer === 'gl';
  settings.renderer = e.target.value; saveSettings();
  if (res && (wasGl || settings.renderer === 'gl')) { renderer = null; makeRenderer(); }
});
$('brightness').value = String(settings.brightness);
$('brightness').addEventListener('change', (e) => { settings.brightness = Number(e.target.value); saveSettings(); if (renderer) renderer.setBrightness(settings.brightness); });
$('skill').value = String(settings.skill);
$('skill').addEventListener('change', (e) => { settings.skill = Number(e.target.value); saveSettings(); });
$('bots').value = String(settings.bots);
$('bots').addEventListener('change', (e) => { settings.bots = Number(e.target.value); saveSettings(); });
$('sfxvol').value = settings.sfx;
$('sfxvol').addEventListener('input', () => { settings.sfx = Number($('sfxvol').value); saveSettings(); audio.unlock(); audio.setVolume(settings.sfx / 100); });
$('music').value = settings.musicMode;
$('music').addEventListener('change', (e) => { settings.musicMode = e.target.value; saveSettings(); audio.unlock(); audio.setMusicMode(settings.musicMode); });
$('musicvol').value = settings.music;
$('musicvol').addEventListener('input', () => { settings.music = Number($('musicvol').value); saveSettings(); audio.setMusicVolume(settings.music / 100); });

boot();
