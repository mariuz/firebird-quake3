// shader.js – the scripts/*.shader files, as much of them as a software
// painter needs: which picture a surface shows (the first stage that is not
// the lightmap), whether it blends additively or by alpha, animates, scrolls
// or ripples, is two-sided, and for a sky which cloud layers to draw.

const BLEND = {
  'GL_ONE,GL_ZERO': 'opaque', 'GL_ONE,GL_ONE': 'add', 'GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA': 'blend', 'GL_DST_COLOR,GL_ZERO': 'filter',
  'GL_ZERO,GL_SRC_COLOR': 'filter', 'GL_ZERO,GL_ONE_MINUS_SRC_COLOR': 'filterinv', 'GL_SRC_ALPHA,GL_ONE': 'add', 'GL_DST_COLOR,GL_SRC_ALPHA': 'filter',
  'GL_DST_COLOR,GL_ONE': 'filteradd', 'GL_ONE,GL_ONE_MINUS_SRC_ALPHA': 'premul',
};

function tokenize(text) {
  const out = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"([^"]*)"|[{}]|[^\s{}"]+/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('//') || m[0].startsWith('/*')) continue;
    out.push(m[1] !== undefined ? m[1] : m[0]);
  }
  return out;
}

/** Parse one script into shaders: name → { stages, surfaceparms, sky, cull, ... } */
export function parseShaderScript(text, into = new Map()) {
  const t = tokenize(text);
  let i = 0;
  while (i < t.length) {
    const name = t[i++].toLowerCase();
    if (t[i] !== '{') continue;
    i++;
    const sh = { name, stages: [], parms: new Set(), cull: 'front', sky: null, sort: 0, deform: null, deforms: [], nopicmip: false };
    while (i < t.length && t[i] !== '}') {
      if (t[i] === '{') {
        i++;
        const st = { map: null, anim: null, animFps: 0, blend: 'opaque', alphaFunc: null, scroll: null, scale: null, turb: null, rotate: 0, clamp: false, lightmap: false, rgbGen: null, depthWrite: false, tcGen: null };
        while (i < t.length && t[i] !== '}') {
          const key = t[i++].toLowerCase();
          const args = [];
          while (i < t.length && t[i] !== '}' && t[i] !== '{' && !isStageKeyword(t[i])) args.push(t[i++]);
          switch (key) {
            case 'map': case 'clampmap': {
              const m = (args[0] ?? '').toLowerCase().replace(/\\/g, '/');
              if (m === '$lightmap') st.lightmap = true; else if (m !== '$whiteimage') st.map = m;
              if (key === 'clampmap') st.clamp = true;
              break;
            }
            case 'animmap': st.animFps = Number(args[0]) || 10; st.anim = args.slice(1).map((a) => a.toLowerCase().replace(/\\/g, '/')); if (!st.map) st.map = st.anim[0]; break;
            case 'blendfunc': {
              const a = args.map((x) => x.toUpperCase());
              if (a.length === 1) st.blend = a[0] === 'ADD' ? 'add' : a[0] === 'FILTER' ? 'filter' : a[0] === 'BLEND' ? 'blend' : 'opaque';
              else st.blend = BLEND[`${a[0]},${a[1]}`] ?? (a[1] === 'GL_ONE' ? 'add' : 'blend');
              break;
            }
            case 'alphafunc': st.alphaFunc = (args[0] ?? '').toUpperCase(); break;
            case 'tcmod': {
              const k = (args[0] ?? '').toLowerCase();
              if (k === 'scroll') st.scroll = [Number(args[1]) || 0, Number(args[2]) || 0];
              else if (k === 'scale') st.scale = [Number(args[1]) || 1, Number(args[2]) || 1];
              else if (k === 'turb') st.turb = [Number(args[1]) || 0, Number(args[2]) || 0, Number(args[3]) || 0, Number(args[4]) || 0];
              else if (k === 'rotate') st.rotate = Number(args[1]) || 0;
              break;
            }
            case 'tcgen': st.tcGen = (args[0] ?? '').toLowerCase(); break;
            case 'rgbgen': st.rgbGen = args.map((x) => x.toLowerCase()); break;
            case 'depthwrite': st.depthWrite = true; break;
            default: break;
          }
        }
        i++;
        sh.stages.push(st);
        continue;
      }
      const key = t[i++].toLowerCase();
      const args = [];
      while (i < t.length && t[i] !== '}' && t[i] !== '{' && !isShaderKeyword(t[i])) args.push(t[i++]);
      switch (key) {
        case 'surfaceparm': sh.parms.add((args[0] ?? '').toLowerCase()); break;
        case 'cull': { const c = (args[0] ?? 'front').toLowerCase(); sh.cull = c === 'none' || c === 'disable' || c === 'twosided' ? 'none' : c === 'back' || c === 'backside' || c === 'backsided' ? 'back' : 'front'; break; }
        case 'skyparms': sh.sky = { box: args[0] && args[0] !== '-' ? args[0].toLowerCase() : null, height: Number(args[1]) || 512 }; break;
        case 'sort': sh.sort = args[0]; break;
        case 'deformvertexes': sh.deform = args.map((x) => x.toLowerCase()); sh.deforms.push(sh.deform); break;
        case 'fogparms': { const n = args.filter((a) => a !== '(' && a !== ')').map(Number); if (n.length >= 4) sh.fog = { color: n.slice(0, 3), opaque: n[3] || 1 }; break; }
        case 'nopicmip': case 'nomipmaps': sh.nopicmip = true; break;
        case 'portal': sh.portal = true; break;
        default: break;
      }
    }
    i++;
    into.set(name, sh);
  }
  return into;
}

const STAGE_KEYS = new Set(['map', 'clampmap', 'animmap', 'blendfunc', 'alphafunc', 'tcmod', 'tcgen', 'rgbgen', 'alphagen', 'depthwrite', 'depthfunc', 'detail', 'videomap']);
const SHADER_KEYS = new Set(['fogparms', 'surfaceparm', 'cull', 'skyparms', 'sort', 'deformvertexes', 'nopicmip', 'nomipmaps', 'polygonoffset', 'entitymergable', 'fogparms', 'light', 'tesssize', 'q3map_sun', 'q3map_surfacelight', 'qer_editorimage', 'qer_trans', 'qer_nocarve', 'q3map_lightimage', 'q3map_globaltexture', 'q3map_lightsubdivide', 'cloudparms', 'sky', 'portal', 'fogonly', 'q3map_backshader', 'q3map_flare', 'q3map_tessSize', 'q3map_backsplash', 'q3map_lightmapsamplesize', 'q3map_novertexshadows', 'q3map_forcesunlight', 'q3map_vertexshadows', 'q3map_tesssize', 'lightning', 'entitymergable']);
const isStageKeyword = (s) => STAGE_KEYS.has(s.toLowerCase());
const isShaderKeyword = (s) => SHADER_KEYS.has(s.toLowerCase());

/**
 * deformVertexes wave <div> <func> <base> <amp> <phase> <freq> (along the normal, the phase spread over the
 * vertex's x + y + z by 1 / div) and move <x> <y> <z> <func> <base> <amp> <phase> <freq> (along the vector),
 * as RB_DeformTessGeometry has them; the others are not drawn
 */
const WAVE_FUNCS = { sin: 0, triangle: 1, square: 2, sawtooth: 3, inversesawtooth: 4 };
export function parseDeform(d) {
  const num = (k) => Number(d[k]) || 0;
  if (d[0] === 'wave' && d.length >= 7 && d[2] in WAVE_FUNCS) {
    const div = num(1);
    return { kind: 1, spread: div ? 1 / div : 100, func: WAVE_FUNCS[d[2]], base: num(3), amp: num(4), phase: num(5), freq: num(6), move: [0, 0, 0] };
  }
  if (d[0] === 'move' && d.length >= 9 && d[4] in WAVE_FUNCS) {
    return { kind: 2, spread: 0, func: WAVE_FUNCS[d[4]], base: num(5), amp: num(6), phase: num(7), freq: num(8), move: [num(1), num(2), num(3)] };
  }
  return null;
}

/** EvalWaveForm: base + amp × the function's value at phase + time × freq (one period per unit) */
export function waveValue(func, base, amp, phase, freq, time) {
  let x = phase + time * freq;
  x -= Math.floor(x);
  const v = func === 0 ? Math.sin(x * 2 * Math.PI) : func === 1 ? (x < 0.25 ? x * 4 : x < 0.75 ? 2 - x * 4 : x * 4 - 4) : func === 2 ? (x < 0.5 ? 1 : -1) : func === 3 ? x : 1 - x;
  return base + amp * v;
}

/** A vertex moved by a look's deforms at a time: [x, y, z] from [x, y, z] and its normal */
export function deformVertex(deforms, x, y, z, nx, ny, nz, time) {
  for (const d of deforms) {
    if (d.kind === 1) {
      const s = waveValue(d.func, d.base, d.amp, d.phase + (x + y + z) * d.spread, d.freq, time);
      x += nx * s; y += ny * s; z += nz * s;
    } else {
      const s = waveValue(d.func, d.base, d.amp, d.phase, d.freq, time);
      x += d.move[0] * s; y += d.move[1] * s; z += d.move[2] * s;
    }
  }
  return [x, y, z];
}

/** RB_CalcEnvironmentTexCoords: the view reflected in the surface, its y and z as s and t */
export function envTexCoords(px, py, pz, nx, ny, nz, ex, ey, ez) {
  let vx = ex - px, vy = ey - py, vz = ez - pz;
  const l = Math.hypot(vx, vy, vz) || 1;
  vx /= l; vy /= l; vz /= l;
  const d = nx * vx + ny * vy + nz * vz;
  return [0.5 + (ny * 2 * d - vy) * 0.5, 0.5 - (nz * 2 * d - vz) * 0.5];
}

/** Every scripts/*.shader of the pak, parsed. */
export function loadShaders(pak) {
  const shaders = new Map();
  for (const f of pak.list('scripts/', '.shader')) {
    try { parseShaderScript(pak.text(f), shaders); } catch (e) { console.warn(`${f}: ${e.message}`); }
  }
  return shaders;
}

/**
 * What to draw for a texture name: the picture, blend mode and animation of
 * the stage that carries the surface's colour. Without a script the texture
 * is the picture of the same name, lightmapped.
 */
export function surfaceLook(shaders, name) {
  const sh = shaders.get(name.toLowerCase());
  const look = { name, image: null, anim: null, animFps: 0, blend: 'opaque', lightmapped: true, scroll: null, scale: null, turb: null, twoSided: false, sky: null, alphaTest: false, nodraw: false, rotate: 0, tcGen: null, vertexColor: false, add: null, env: null, autosprite: false, deforms: null };
  if (!sh) { look.image = name; return look; }
  look.autosprite = sh.deforms.some((d) => d[0] === 'autosprite' || d[0] === 'autosprite2');
  look.portal = !!sh.portal;
  const deforms = sh.deforms.map(parseDeform).filter(Boolean);
  if (deforms.length) look.deforms = deforms.slice(0, 2);
  look.twoSided = sh.cull === 'none';
  // a fog volume's surface with no stages of its own shows only the fog of what is under it
  look.nodraw = sh.parms.has('nodraw') || (sh.parms.has('fog') && !sh.stages.some((s) => s.map));
  if (sh.parms.has('sky') || sh.sky) {
    look.sky = { box: sh.sky?.box ?? null, layers: sh.stages.filter((s) => s.map).map((s) => ({ image: s.map, scroll: s.scroll, scale: s.scale, blend: s.blend })) };
    look.lightmapped = false;
    return look;
  }
  const hasLightmap = sh.stages.some((s) => s.lightmap);
  // the colour stage: the first stage with a picture that is not purely a filter over the lightmap; the
  // stages after it that add (glowing lights) are remembered as the `add` layer
  let main = null;
  for (const s of sh.stages) {
    if (!s.map) continue;
    if (!main) { main = s; continue; }
    // a chrome stage (tcGen environment) the main picture is blended over: the picture is the one on top
    // and the chrome shows where its alpha is low (pewter_shiney)
    if (main.tcGen === 'environment' && !look.env && s.blend === 'blend') { look.env = { image: main.map, mode: 'under' }; main = s; continue; }
    // a chrome stage added over the picture (largerblock3blood's tinfx3)
    if (!look.env && s.tcGen === 'environment' && (s.blend === 'add' || s.blend === 'filteradd')) { look.env = { image: s.map, mode: 'add' }; continue; }
    if (!look.add && (s.blend === 'add' || s.blend === 'filteradd') && s.map && !s.tcGen) look.add = { image: s.map, anim: s.anim, animFps: s.animFps, scroll: s.scroll, scale: s.scale, rotate: s.rotate };
  }
  if (!main) { look.image = sh.stages.length ? null : name; look.lightmapped = hasLightmap || !sh.parms.has('nolightmap'); if (!look.image && !hasLightmap) look.nodraw = look.nodraw || sh.stages.length === 0 ? look.nodraw : false; return look; }
  look.image = main.map;
  look.anim = main.anim; look.animFps = main.animFps;
  look.scroll = main.scroll; look.scale = main.scale; look.turb = main.turb; look.rotate = main.rotate; look.tcGen = main.tcGen;
  look.alphaTest = !!main.alphaFunc;
  look.vertexColor = !!(main.rgbGen && (main.rgbGen[0] === 'vertex' || main.rgbGen[0] === 'exactvertex'));
  // lit by the lightmap when a $lightmap stage multiplies it, or when the shader never said nolightmap
  look.lightmapped = hasLightmap || (!sh.parms.has('nolightmap') && main.blend === 'opaque' && !look.vertexColor);
  const firstIsLightmap = sh.stages[0]?.lightmap;
  if (main.blend === 'filter' && (firstIsLightmap || hasLightmap)) look.blend = 'opaque';
  else if (main.blend === 'add' && !firstIsLightmap) look.blend = 'add';
  else if (main.blend === 'blend' || main.blend === 'premul') look.blend = 'blend';
  else if (main.blend === 'filter' || main.blend === 'filterinv') look.blend = 'filter';
  else look.blend = 'opaque';
  if (sh.parms.has('trans') && look.blend === 'opaque' && main.alphaFunc) look.blend = 'opaque';
  if (look.env?.mode === 'under') look.blend = 'opaque';   // the chrome fills what the picture's alpha leaves
  return look;
}
