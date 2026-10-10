// renderer-gl.js – the other painter: Quake III's own way of drawing, on
// WebGL. tr_bsp.c keeps the world's vertices on the card and tr_shade.c
// multiplies the texture by the lightmap, adds the glow stages, scrolls and
// ripples the texture coordinates per shader stage; here the same happens
// in two small GLSL programs, fed by the very same FRAME_ALL rows the
// software painter takes: Firebird still decides which faces are on screen,
// the card only fills them. MD3 models are lit from the light grid in the
// vertex shader; the player parts hang on their tags as before. The HUD is
// drawn by the software painter onto a transparent canvas laid over this one.

import { Renderer, yawAxis, anglesAxis, tagTransform, animFrame, autospriteQuads, fogDefs } from './renderer.js';
import { loadImage, powerOfTwo } from './image.js';
import { shellMesh, eyeInModel, stageBrightness } from './shader.js';

const LIGHTMAP_SIZE = 128;

const WORLD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aSt;
layout(location=2) in vec2 aLm;
layout(location=3) in vec3 aColor;
layout(location=4) in vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform float uTime;
uniform int uDefN;        // deformVertexes: how many (up to 2)
uniform vec4 uDefA[2];    // kind (1 wave, 2 move), spread, func, base
uniform vec4 uDefB[2];    // amp, phase, freq
uniform vec3 uDefMove[2];
out vec2 vSt;
out vec2 vLm;
out vec3 vColor;
out vec3 vWorld;
// EvalWaveForm: sin, triangle, square, sawtooth, inverse sawtooth over one period per unit
float wave(float func, float base, float amp, float x) {
  x = fract(x);
  float v = func < 0.5 ? sin(x * 6.2831853) : func < 1.5 ? (x < 0.25 ? x * 4.0 : x < 0.75 ? 2.0 - x * 4.0 : x * 4.0 - 4.0)
          : func < 2.5 ? (x < 0.5 ? 1.0 : -1.0) : func < 3.5 ? x : 1.0 - x;
  return base + amp * v;
}
void main() {
  vec3 p = aPos;
  for (int i = 0; i < 2; i++) {
    if (i >= uDefN) break;
    vec4 a = uDefA[i], b = uDefB[i];
    if (a.x < 1.5) p += aNormal * wave(a.z, a.w, b.x, b.y + (aPos.x + aPos.y + aPos.z) * a.y + uTime * b.z);
    else p += uDefMove[i] * wave(a.z, a.w, b.x, b.y + uTime * b.z);
  }
  vec4 w = uModel * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = uProj * uView * w;
  vSt = aSt; vLm = aLm; vColor = aColor;
}`;

const PORTAL_VIEW_LOOK = { name: '*portal', blend: 'opaque' };

const WORLD_FS = `#version 300 es
precision highp float;
in vec2 vSt;
in vec2 vLm;
in vec3 vColor;
in vec3 vWorld;
uniform sampler2D uTex;
uniform sampler2D uLightmap;
uniform int uMode;        // 0 texture × lightmap, 1 texture × flat, 2 sky clouds, 3 the view through a portal,
                          // 4 one stage of a shader, 5 the dynamic lights' pass, 6 the fog's pass
uniform vec3 uRgb;        // a stage's colour (rgbGen identity or wave)
uniform int uVColor;      // a stage's rgbGen vertex: times the vertex light
uniform int uStageTc;     // a stage's coordinates: 0 the texture's, 1 tcGen environment, 2 the lightmap's
uniform float uRotate;    // tcMod rotate, degrees a second
uniform float uLightScale;
uniform sampler2D uPortal;
uniform vec2 uScreen;
uniform float uPortalK;
uniform float uFlat;
uniform vec2 uScroll;
uniform vec2 uScale;
uniform float uTurb;
uniform float uTime;
uniform int uAlphaTest;
uniform vec3 uEye;
uniform sampler2D uSky2;
uniform int uSkyLayers;
uniform vec4 uSkyScroll;  // layer 1 xy, layer 2 zw
uniform vec2 uSkyScale;
uniform int uEnvMode;     // tcGen environment: 1 the picture itself, 2 a chrome under it, 3 a chrome added
uniform sampler2D uEnv;
uniform int uFogOn;       // in a fog volume: RB_FogPass by R_FogFactor
uniform vec3 uFogColor;
uniform vec4 uFogPlane;   // the fog's surface (normal, dist); w unused when uFogHasPlane is 0
uniform int uFogHasPlane;
uniform float uFogOpaque;
uniform vec3 uFwd;
uniform int uDlCount;     // the dynamic lights on this surface (0 for the translucent ones)
uniform vec4 uDlPos[8];   // xyz, radius
uniform vec3 uDlColor[8];
out vec4 fragColor;
// ProjectDlightTexture: dst × (1 + light), the light the dlight image (4000 / d² of 255 for d texels from the
// middle of 16 spread over the radius, nothing under 75) by the offset in the surface's plane, times full up to
// half the radius off the plane and down to nothing at the radius
vec3 dlights() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uDlCount) break;
    vec3 d = vWorld - uDlPos[i].xyz;
    float r = uDlPos[i].w, dn = abs(dot(d, n));
    if (dn >= r) continue;
    float m = dn < r * 0.5 ? 1.0 : 2.0 * (r - dn) / r;
    vec3 p = d - n * dot(d, n);
    float t = length(p) * 16.0 / r;
    if (t >= 7.8) continue;
    float b = t < 3.96 ? 1.0 : 15.686 / (t * t);
    if (t > 6.8) b *= 7.8 - t;
    sum += uDlColor[i] * b * m;
  }
  return sum;
}
// RB_CalcEnvironmentTexCoords: the view reflected in the surface (the face's normal, towards the eye)
vec2 envCoords() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 viewer = normalize(uEye - vWorld);
  if (dot(n, viewer) < 0.0) n = -n;
  vec3 r = n * 2.0 * dot(n, viewer) - viewer;
  return vec2(0.5 + r.y * 0.5, 0.5 - r.z * 0.5);
}
// RB_CalcFogTexCoords and R_FogFactor: the depth along the view over the distance to opaque, times the share
// of the sight line under the fog's surface; the fog table is the square root
float fogAmount() {
  float s = dot(vWorld - uEye, uFwd) / uFogOpaque, t = 31.0 / 32.0;
  if (uFogHasPlane == 1) {
    float tP = uFogPlane.w - dot(vWorld, uFogPlane.xyz), tE = uFogPlane.w - dot(uEye, uFogPlane.xyz);
    if (tE < 0.0) t = tP < 1.0 ? 1.0 / 32.0 : 1.0 / 32.0 + 30.0 / 32.0 * tP / (tP - tE);
    else t = tP < 0.0 ? 1.0 / 32.0 : 31.0 / 32.0;
  }
  float f = 0.0;
  if (t > 1.0 / 32.0 + 1e-6 && s > 0.0) { if (t < 31.0 / 32.0) s *= (t - 1.0 / 32.0) / (30.0 / 32.0); f = sqrt(min(1.0, s)); }
  return f;
}
void main() {
  if (uMode == 5) { fragColor = vec4(dlights(), 1.0); return; }
  if (uMode == 6) { fragColor = vec4(uFogColor, fogAmount()); return; }
  if (uMode == 4) {
    // a shader's stage (RB_IterateStagesGeneric): its coordinates through scale, rotate (about the middle) and
    // scroll, its picture times its colour; alphaFunc GE128 (1), GT0 (2), LT128 (3)
    vec2 tc;
    if (uStageTc == 2) tc = vLm;
    else if (uStageTc == 1) tc = envCoords();
    else {
      tc = vSt * uScale;
      if (uRotate != 0.0) {
        float a = radians(-uRotate * uTime), cs = cos(a), sn = sin(a);
        tc = vec2(cs * (tc.x - 0.5) - sn * (tc.y - 0.5), sn * (tc.x - 0.5) + cs * (tc.y - 0.5)) + 0.5;
      }
      tc += uScroll;
      if (uTurb > 0.0) tc += vec2(sin(vSt.y * 12.0 + uTime * 2.0), sin(vSt.x * 12.0 + uTime * 2.0)) * 0.015;
    }
    vec4 c = texture(uTex, tc);
    if ((uAlphaTest == 1 && c.a < 0.5) || (uAlphaTest == 2 && c.a <= 0.0) || (uAlphaTest == 3 && c.a >= 0.5)) discard;
    vec3 rgb = c.rgb * uRgb;
    if (uVColor == 1) rgb *= min(vColor * uLightScale / 255.0, vec3(1.0));
    fragColor = vec4(min(rgb, 1.0), c.a);
    return;
  }
  if (uMode == 3) { fragColor = vec4(texture(uPortal, gl_FragCoord.xy / uScreen).rgb * uPortalK, 1.0); return; }
  if (uMode == 2) {
    vec3 d = normalize(vWorld - uEye);
    float nz = max(0.12, abs(d.z));
    vec2 p = d.xy / nz;
    vec3 c = texture(uTex, p * uSkyScale.x + uSkyScroll.xy).rgb;
    if (uSkyLayers > 1) c += texture(uSky2, p * uSkyScale.y + uSkyScroll.zw).rgb;
    fragColor = vec4(min(c, 1.0), 1.0);
    return;
  }
  vec2 st = vSt * uScale + uScroll;
  if (uTurb > 0.0) st += vec2(sin(vSt.y * 12.0 + uTime * 2.0), sin(vSt.x * 12.0 + uTime * 2.0)) * 0.015;
  // RB_CalcEnvironmentTexCoords: the view reflected in the surface (the face's normal, towards the eye)
  vec2 envSt = uEnvMode > 0 ? envCoords() : vec2(0.0);
  vec4 c = texture(uTex, uEnvMode == 1 ? envSt : st);
  // over a chrome the lightmap stage is GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA: the frame's alpha after the picture
  // blended over the opaque chrome is a² + 1 - a, so a - a² of the unlit colour shows through the shadow
  float shine = 0.0;
  if (uEnvMode == 2) { shine = c.a - c.a * c.a; c = vec4(mix(texture(uEnv, envSt).rgb, c.rgb, c.a), 1.0); }
  else if (uEnvMode == 3) c.rgb += texture(uEnv, envSt).rgb;
  if (uAlphaTest == 1 && c.a < 0.5) discard;
  vec3 lit = uMode == 0 ? c.rgb * (texture(uLightmap, vLm).rgb + shine) : c.rgb * uFlat;
  if (uDlCount > 0) lit *= 1.0 + dlights();
  if (uFogOn == 1) lit = mix(lit, uFogColor, fogAmount());
  fragColor = vec4(min(lit, 1.0), c.a);
}`;

const MODEL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aSt;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform vec3 uAmbient;
uniform vec3 uDirected;
uniform vec3 uLightDir;
out vec2 vSt;
out vec3 vLight;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  gl_Position = uProj * uView * w;
  vec3 n = normalize(mat3(uModel) * aNormal);
  vLight = min(uAmbient + uDirected * max(0.0, dot(n, uLightDir)), vec3(1.0));
  vSt = aSt;
}`;

const MODEL_FS = `#version 300 es
precision highp float;
in vec2 vSt;
in vec3 vLight;
uniform sampler2D uTex;
uniform vec3 uTint;
uniform int uAlphaTest;
out vec4 fragColor;
void main() {
  vec4 c = texture(uTex, vSt);
  if (uAlphaTest == 1 && c.a < 0.5) discard;
  fragColor = vec4(c.rgb * vLight * uTint, c.a);
}`;

const SPRITE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aSt;
layout(location=2) in vec4 aColor;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uPointSize;
out vec2 vSt;
out vec4 vColor;
void main() {
  gl_Position = uProj * uView * vec4(aPos, 1.0);
  gl_PointSize = uPointSize * 300.0 / max(1.0, gl_Position.w);
  vSt = aSt; vColor = aColor;
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vSt;
in vec4 vColor;
uniform sampler2D uTex;
uniform int uUseTex;
out vec4 fragColor;
void main() {
  vec4 c = uUseTex == 1 ? texture(uTex, vSt) : vec4(1.0);
  fragColor = c * vColor;
}`;

function compile(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

export class GLRenderer {
  constructor(canvas, res, overlayCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL 2 is not available in this browser');
    this.gl = gl;
    this.res = res;
    this.pak = res.pak;
    this.overlay = new Renderer(overlayCanvas, res, { alpha: true });   // the HUD painter, on the transparent canvas above
    this.world = compile(gl, WORLD_VS, WORLD_FS);
    this.model = compile(gl, MODEL_VS, MODEL_FS);
    this.sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.textures = new Map();       // image name → { tex, w, h, hasAlpha }
    this.lightmapTex = new Map();    // bsp → [WebGLTexture]
    this.looks = new Map();
    this.faceInfo = new Map();
    this.lightScale = 4;
    this.modelLight = 1;
    this.particles = [];
    this.time = 0;
    this.skyLook = null;
    this.meshCache = new Map();      // `${model}:${surface}:${frame}` → Float32Array pos+normal+st
    this.proj = new Float32Array(16);
    this.viewM = new Float32Array(16);
    this.identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    this.modelM = new Float32Array(16);
    this.dynVbo = gl.createBuffer();
    this.dynIbo = gl.createBuffer();
    this.white = this.makeTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, false);
    this.alphaGroups = [];
    this.zb = { fill: () => { gl.clear(gl.DEPTH_BUFFER_BIT); } };   // the view weapon's depth hack
    this.setSize(320, 240);
  }

  get w() { return this.overlay.w; }
  get h() { return this.overlay.h; }

  setSize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.overlay.setSize(w, h);
    this.gl.viewport(0, 0, w, h);
  }

  setBrightness(scale) {
    this.lightScale = scale;
    this.overlay.lightScale = scale;
    const gl = this.gl;
    for (const pages of this.lightmapTex.values()) for (const t of pages) if (t) gl.deleteTexture(t);
    this.lightmapTex.clear();
  }

  setSky(name) {
    this.skyLook = name ? this.look(name) : null;
    if (this.skyLook && !this.skyLook.sky) this.skyLook = null;
  }

  look(name) {
    let l = this.looks.get(name);
    if (!l) { l = this.res.look(name); this.looks.set(name, l); }
    return l;
  }

  /** The world's vertices go onto the card once: every face of every model of the BSP, in model space. */
  setResources(res) {
    this.res = res;
    this.overlay.setResources(res);
    this.faceInfo.clear();
    const gl = this.gl;
    let bsp = null;
    for (const m of res.models.values()) if (m.kind === 'B' && m.sub === 0) bsp = m.bsp;
    if (!bsp) return;
    this.bsp = bsp;
    let total = 0;
    for (const f of bsp.faces) total += f.nverts;
    const vb = new Float32Array(total * 13);
    let base = 0;
    const indexOf = [];
    bsp.faces.forEach((f, i) => {
      const tex = bsp.textures[f.texture];
      const look = this.look(tex?.name ?? '');
      for (let k = 0; k < f.nverts; k++) {
        vb.set(f.verts.subarray(k * 10, k * 10 + 10), (base + k) * 13);
        if (f.norms) vb.set(f.norms.subarray(k * 3, k * 3 + 3), (base + k) * 13 + 10);
      }
      let idx;
      if (f.fan) { idx = new Uint32Array(Math.max(0, (f.nverts - 2) * 3)); for (let k = 0; k < f.nverts - 2; k++) { idx[k * 3] = base; idx[k * 3 + 1] = base + k + 1; idx[k * 3 + 2] = base + k + 2; } }
      else if (f.tris) { idx = new Uint32Array(f.tris.length); for (let k = 0; k < f.tris.length; k++) idx[k] = base + f.tris[k]; }
      else idx = new Uint32Array(0);
      let sum = 0;
      for (let k = 0; k < f.nverts; k++) sum += f.verts[k * 10 + 7] + f.verts[k * 10 + 8] + f.verts[k * 10 + 9];
      this.faceInfo.set(i, { f, look, idx, lm: f.lmIndex, flat: f.nverts ? sum / (3 * f.nverts) : 255, fog: f.effect });
      indexOf.push(idx);
      base += f.nverts;
    });
    this.fogs = fogDefs(bsp, res);
    if (this.worldVbo) gl.deleteBuffer(this.worldVbo);
    this.worldVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.worldVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vb, gl.STATIC_DRAW);
    this.worldIbo = this.worldIbo ?? gl.createBuffer();
    this.frameIdx = new Uint32Array(1 << 18);
  }

  makeTexture(rgba, w, h, mip, repeat = true) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t;
  }

  texture(name) {
    let t = this.textures.get(name);
    if (t !== undefined) return t;
    const file = this.pak.imageName(name);
    let img = null;
    if (file) { try { img = powerOfTwo(loadImage(this.pak.get(file), file)); } catch { img = null; } }
    if (!img) {
      const data = new Uint32Array(64 * 64);
      for (let i = 0; i < 64 * 64; i++) data[i] = ((i >> 3) + (i >> 9)) & 1 ? 0xff606060 : 0xff303030;
      img = { w: 64, h: 64, data, hasAlpha: false };
    }
    t = { tex: this.makeTexture(new Uint8Array(img.data.buffer, img.data.byteOffset, img.w * img.h * 4), img.w, img.h, true), w: img.w, h: img.h, hasAlpha: img.hasAlpha };
    this.textures.set(name, t);
    return t;
  }

  /** The lightmap pages with the overbright shift of R_ColorShiftLightingBytes, as textures. */
  lightmap(bsp, index) {
    let pages = this.lightmapTex.get(bsp);
    if (!pages) { pages = []; this.lightmapTex.set(bsp, pages); }
    if (pages[index]) return pages[index];
    const n = LIGHTMAP_SIZE * LIGHTMAP_SIZE;
    const src = bsp.lightmaps.subarray(index * n * 3, index * n * 3 + n * 3);
    const rgba = new Uint8Array(n * 4);
    const scale = this.lightScale;
    for (let i = 0; i < n; i++) {
      let r = src[i * 3] * scale, g = src[i * 3 + 1] * scale, b = src[i * 3 + 2] * scale;
      const max = Math.max(r, g, b);
      if (max > 255) { const k = 255 / max; r *= k; g *= k; b *= k; }
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    pages[index] = this.makeTexture(rgba, LIGHTMAP_SIZE, LIGHTMAP_SIZE, false, false);
    return pages[index];
  }

  animImage(image, anim, fps) {
    if (!anim || !anim.length) return image;
    return anim[Math.floor(this.time * fps) % anim.length];
  }

  // ── a frame ─────────────────────────────────────────────────────────────
  beginFrame(view) {
    this.view = view;
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const yaw = (view.yaw * Math.PI) / 180, pitch = (view.pitch * Math.PI) / 180;
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    view.fwd = [cp * cy, cp * sy, -sp];
    view.right = [sy, -cy, 0];
    view.up = [sp * cy, sp * sy, cp];
    if (view.roll) {
      const r = (view.roll * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r);
      const R = view.right, U = view.up;
      view.right = [R[0] * cr + U[0] * sr, R[1] * cr + U[1] * sr, R[2] * cr + U[2] * sr];
      view.up = [-R[0] * sr + U[0] * cr, -R[1] * sr + U[1] * cr, -R[2] * sr + U[2] * cr];
    }
    view.scale = (w / 2) / Math.tan((view.fov * Math.PI) / 360);
    view.cx = w / 2; view.cy = h / 2;
    // the view matrix: columns are the world axes expressed in (right, up, -forward)
    const f = view.fwd, r = view.right, u = view.up;
    const vm = this.viewM;
    vm[0] = r[0]; vm[4] = r[1]; vm[8] = r[2]; vm[12] = -(r[0] * view.x + r[1] * view.y + r[2] * view.z);
    vm[1] = u[0]; vm[5] = u[1]; vm[9] = u[2]; vm[13] = -(u[0] * view.x + u[1] * view.y + u[2] * view.z);
    vm[2] = -f[0]; vm[6] = -f[1]; vm[10] = -f[2]; vm[14] = f[0] * view.x + f[1] * view.y + f[2] * view.z;
    vm[3] = 0; vm[7] = 0; vm[11] = 0; vm[15] = 1;
    this.setProjection(4, 16384);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);        // Quake III's triangles are clockwise seen from the front
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.alphaGroups = [];
    this.autosprites = [];
    this.overlay.fb.fill(0);
    this.overlay.view = view;
  }

  setProjection(near, far) {
    const w = this.canvas.width, h = this.canvas.height;
    const t = Math.tan((this.view.fov * Math.PI) / 360);
    const p = this.proj;
    p.fill(0);
    p[0] = 1 / t; p[5] = (w / h) / t;
    p[10] = -(far + near) / (far - near); p[11] = -1;
    p[14] = -(2 * far * near) / (far - near);
  }

  modelMatrix(origin, axis) {
    const m = this.modelM;
    // columns: the model's forward, left, up axes; world = origin + x·fwd + y·left + z·up
    m[0] = axis[0]; m[1] = axis[1]; m[2] = axis[2]; m[3] = 0;
    m[4] = axis[3]; m[5] = axis[4]; m[6] = axis[5]; m[7] = 0;
    m[8] = axis[6]; m[9] = axis[7]; m[10] = axis[8]; m[11] = 0;
    m[12] = origin[0]; m[13] = origin[1]; m[14] = origin[2]; m[15] = 1;
    return m;
  }

  /** FRAME_ALL's face rows [face, ent, ox, oy, oz]: grouped by shader and lightmap, one draw call each. */
  drawFaceList(rows, time, entAngles = new Map()) {
    this.time = time;
    const groups = new Map();   // key → { info, lm, ent, origin, angles, faces: [] }
    for (const row of rows) {
      const info = this.faceInfo.get(row[0]);
      if (!info || info.look.nodraw || !info.idx.length) continue;
      if (info.look.autosprite) { this.autosprites.push(...autospriteQuads(info.f, info.look, row[2], row[3], row[4])); continue; }
      const ent = row[1];
      if (this.portalFaces?.has(row[0])) {
        // the view through the portal, drawn opaque under the portal's own stages
        let pg = groups.get('*portal');
        if (!pg) { pg = { look: PORTAL_VIEW_LOOK, lm: -1, ent: 0, fog: -1, origin: [0, 0, 0], angles: null, faces: [], count: 0, flat: 0, portalView: true }; groups.set('*portal', pg); }
        pg.faces.push(info.idx); pg.count += info.idx.length;
      }
      const fog = info.fog >= 0 && this.fogs?.[info.fog] ? info.fog : -1;
      const key = `${info.look.name}|${info.lm}|${ent}|${fog}`;
      let g = groups.get(key);
      if (!g) { g = { look: info.look, lm: info.lm, ent, fog, origin: [row[2], row[3], row[4]], angles: ent ? entAngles.get(ent) : null, faces: [], count: 0, flat: 0 }; groups.set(key, g); }
      g.faces.push(info.idx);
      g.count += info.idx.length;
      g.flat += info.flat;
    }
    // one index buffer for the frame
    let total = 0;
    for (const g of groups.values()) total += g.count;
    if (this.frameIdx.length < total) this.frameIdx = new Uint32Array(total * 2);
    let off = 0;
    const idx = this.frameIdx;
    for (const g of groups.values()) {
      g.first = off;
      for (const a of g.faces) { idx.set(a, off); off += a.length; }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.worldIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, total), gl.DYNAMIC_DRAW);
    this.bindWorld();
    for (const g of groups.values()) {
      if ((g.look.stages ? !g.look.stagesOpaque : g.look.blend !== 'opaque') && !g.look.sky) { this.alphaGroups.push(g); continue; }
      this.drawGroup(g);
    }
  }

  /** The SQL-projected rows carry no origins: draw the faces the usual way. */
  drawFaces(rows, time) {
    const seen = new Map();
    for (const r of rows) if (!seen.has(r[0])) seen.set(r[0], [r[0], r[11] ?? 0, 0, 0, 0]);
    this.drawFaceList([...seen.values()], time);
  }

  bindWorld() {
    const gl = this.gl;
    gl.useProgram(this.world.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.worldVbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.worldIbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 52, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 52, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 52, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 52, 28);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 52, 40);
    const u = this.world.u;
    gl.uniformMatrix4fv(u.uProj, false, this.proj);
    gl.uniformMatrix4fv(u.uView, false, this.viewM);
    gl.uniform1i(u.uTex, 0); gl.uniform1i(u.uLightmap, 1); gl.uniform1i(u.uSky2, 2); gl.uniform1i(u.uEnv, 3); gl.uniform1i(u.uPortal, 4);
    gl.uniform2f(u.uScreen, this.canvas.width, this.canvas.height);
    gl.uniform3f(u.uEye, this.view.x, this.view.y, this.view.z);
    gl.uniform3f(u.uFwd, this.view.fwd[0], this.view.fwd[1], this.view.fwd[2]);
    gl.uniform1f(u.uTime, this.time);
    const dl = this.dlights ?? [];
    if (dl.length) {
      const pos = new Float32Array(32), col = new Float32Array(24);
      dl.forEach((l, i) => { pos.set([l.x, l.y, l.z, l.radius], i * 4); col.set(l.color, i * 3); });
      gl.uniform4fv(u['uDlPos[0]'], pos); gl.uniform3fv(u['uDlColor[0]'], col);
    }
  }

  /** The view through a portal is painted into a texture of the canvas's size (R_MirrorViewBySurface's view) */
  beginPortalView() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (!this.portalFb || this.portalW !== w || this.portalH !== h) {
      if (this.portalFb) { gl.deleteFramebuffer(this.portalFb); gl.deleteTexture(this.portalTex); gl.deleteRenderbuffer(this.portalDepth); }
      this.portalTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.portalTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.portalDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.portalDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      this.portalFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.portalFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.portalTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.portalDepth);
      this.portalW = w; this.portalH = h;
    }
    // nothing may read the texture being drawn into (WebGL refuses the draws): the portal's own faces in its
    // view, and the unit the world shader samples it from, still bound from the last frame
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.portalFb);
    this.portalFaces = null;
  }
  endPortalView(k, faces) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.portalK = k; this.portalFaces = faces;
  }

  /** The frame's dynamic lights: [{ x, y, z, radius, color: [r, g, b] }], at most 8 */
  setDlights(lights) { this.dlights = (lights ?? []).slice(0, 8); }

  drawGroup(g) {
    const gl = this.gl, u = this.world.u, look = g.look;
    if (g.portalView) {
      gl.uniformMatrix4fv(u.uModel, false, this.identity);
      gl.uniform1i(u.uDefN, 0);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.portalTex ?? null);
      gl.uniform1i(u.uMode, 3);
      gl.uniform1f(u.uPortalK, this.portalTex ? this.portalK ?? 0 : 0);
      gl.disable(gl.CULL_FACE);
      this.setBlend('opaque');
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
      return;
    }
    const axis = g.angles ? anglesAxis(g.angles[0], g.angles[1], g.angles[2]) : null;
    gl.uniformMatrix4fv(u.uModel, false, g.ent ? this.modelMatrix(g.origin, axis ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]) : this.identity);
    const defs = look.deforms ?? [];
    gl.uniform1i(u.uDefN, defs.length);
    if (defs.length) {
      const A = new Float32Array(8), B = new Float32Array(8), M = new Float32Array(6);
      defs.forEach((d, i) => { A.set([d.kind, d.spread, d.func, d.base], i * 4); B.set([d.amp, d.phase, d.freq, 0], i * 4); M.set(d.move, i * 3); });
      gl.uniform4fv(u['uDefA[0]'], A); gl.uniform4fv(u['uDefB[0]'], B); gl.uniform3fv(u['uDefMove[0]'], M);
    }
    if (look.stages) { this.drawStages(g); return; }
    const envMode = look.tcGen === 'environment' ? 1 : look.env?.mode === 'under' ? 2 : look.env?.mode === 'add' ? 3 : 0;
    gl.uniform1i(u.uEnvMode, envMode);
    if (envMode > 1) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.texture(look.env.image).tex); }
    gl.disable(gl.CULL_FACE);
    if (!look.twoSided && look.name && !look.sky) gl.enable(gl.CULL_FACE);
    if (look.sky) {
      const layers = look.sky.layers;
      const t0 = this.texture(layers[0]?.image ?? ''), t1 = layers[1] ? this.texture(layers[1].image) : null;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t0.tex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, (t1 ?? t0).tex);
      gl.uniform1i(u.uMode, 2);
      gl.uniform1i(u.uSkyLayers, layers.length);
      const sc = (l) => (l?.scale ? l.scale[0] * 0.25 : 0.25);
      gl.uniform2f(u.uSkyScale, sc(layers[0]), sc(layers[1]));
      const s0 = layers[0]?.scroll ?? [0, 0], s1 = layers[1]?.scroll ?? [0, 0];
      gl.uniform4f(u.uSkyScroll, s0[0] * this.time, s0[1] * this.time, s1[0] * this.time, s1[1] * this.time);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
      return;
    }
    const tex = this.texture(this.animImage(look.image, look.anim, look.animFps));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    const lit = look.lightmapped && g.lm >= 0 && g.lm < this.bsp.numLightmaps;
    if (lit) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lightmap(this.bsp, g.lm)); }
    gl.uniform1i(u.uMode, lit ? 0 : 1);
    // vertex-lit surfaces: the average vertex colour of the group's faces (q3map's vertex light)
    let flat = 1;
    if (!lit && look.lightmapped && look.blend === 'opaque' && !look.vertexColor) flat = Math.min(1, (g.flat / g.faces.length) * this.lightScale / 255);
    gl.uniform1f(u.uFlat, flat);
    gl.uniform2f(u.uScroll, look.scroll ? look.scroll[0] * this.time : 0, look.scroll ? look.scroll[1] * this.time : 0);
    gl.uniform2f(u.uScale, look.scale ? look.scale[0] : 1, look.scale ? look.scale[1] : 1);
    gl.uniform1f(u.uTurb, look.turb ? 1 : 0);
    gl.uniform1i(u.uAlphaTest, look.alphaTest ? 1 : 0);
    gl.uniform1i(u.uDlCount, look.blend === 'opaque' ? (this.dlights?.length ?? 0) : 0);
    const fog = g.fog >= 0 && look.blend === 'opaque' ? this.fogs[g.fog] : null;
    gl.uniform1i(u.uFogOn, fog ? 1 : 0);
    if (fog) {
      gl.uniform3f(u.uFogColor, fog.color[0], fog.color[1], fog.color[2]);
      gl.uniform1f(u.uFogOpaque, fog.opaque);
      gl.uniform1i(u.uFogHasPlane, fog.plane ? 1 : 0);
      if (fog.plane) gl.uniform4f(u.uFogPlane, fog.plane.nx, fog.plane.ny, fog.plane.nz, fog.plane.dist);
    }
    this.setBlend(look.blend);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
    if (look.add && look.blend === 'opaque') {
      const at = this.texture(this.animImage(look.add.image, look.add.anim, look.add.animFps));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, at.tex);
      gl.uniform1i(u.uMode, 1);
      gl.uniform1f(u.uFlat, 0.75 + 0.25 * Math.sin(this.time * 2));
      gl.uniform2f(u.uScroll, look.add.scroll ? look.add.scroll[0] * this.time : 0, look.add.scroll ? look.add.scroll[1] * this.time : 0);
      gl.uniform2f(u.uScale, look.add.scale ? look.add.scale[0] : 1, look.add.scale ? look.add.scale[1] : 1);
      gl.uniform1i(u.uAlphaTest, 0);
      gl.uniform1i(u.uDlCount, 0);
      gl.uniform1i(u.uEnvMode, 0);
      gl.uniform1i(u.uFogOn, 0);
      this.setBlend('add');
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  /**
   * A shader drawn stage by stage (RB_StageIteratorGeneric): each stage a pass with its own picture, colour,
   * coordinates and blend factors; on an opaque shader then the dynamic lights (ProjectDlightTexture: the
   * frame times one plus the light) and the fog (RB_FogPass) as passes of their own.
   */
  drawStages(g) {
    const gl = this.gl, u = this.world.u, look = g.look;
    gl.disable(gl.CULL_FACE);
    if (!look.twoSided) gl.enable(gl.CULL_FACE);
    const lit = g.lm >= 0 && g.lm < this.bsp.numLightmaps;
    gl.uniform1i(u.uEnvMode, 0); gl.uniform1i(u.uFogOn, 0); gl.uniform1i(u.uDlCount, 0);
    gl.uniform1f(u.uLightScale, this.lightScale);
    gl.uniform1i(u.uMode, 4);
    gl.activeTexture(gl.TEXTURE0);
    look.stages.forEach((s, i) => {
      let rgb = stageBrightness(s.rgb, this.time);
      if (s.lightmap) {
        gl.bindTexture(gl.TEXTURE_2D, lit ? this.lightmap(this.bsp, g.lm) : this.white());
        // a surface q3map lit by its vertices instead: the average of its faces' vertex light
        if (!lit) rgb *= Math.min(1, (g.flat / g.faces.length) * this.lightScale / 255);
      } else gl.bindTexture(gl.TEXTURE_2D, this.texture(this.animImage(s.image, s.anim, s.animFps)).tex);
      gl.uniform1i(u.uStageTc, s.lightmap ? (lit ? 2 : 0) : s.tcGen === 'environment' ? 1 : 0);
      gl.uniform3f(u.uRgb, rgb, rgb, rgb);
      gl.uniform1i(u.uVColor, s.rgb.kind === 'vertex' ? 1 : 0);
      gl.uniform2f(u.uScroll, s.scroll ? s.scroll[0] * this.time : 0, s.scroll ? s.scroll[1] * this.time : 0);
      gl.uniform2f(u.uScale, s.scale ? s.scale[0] : 1, s.scale ? s.scale[1] : 1);
      gl.uniform1f(u.uRotate, s.rotate || 0);
      gl.uniform1f(u.uTurb, s.turb ? 1 : 0);
      gl.uniform1i(u.uAlphaTest, s.alphaFunc === 'GE128' ? 1 : s.alphaFunc === 'GT0' ? 2 : s.alphaFunc === 'LT128' ? 3 : 0);
      if (s.src === 'GL_ONE' && s.dst === 'GL_ZERO') gl.disable(gl.BLEND);
      else { gl.enable(gl.BLEND); gl.blendFunc(this.factor(s.src), this.factor(s.dst)); }
      gl.depthMask((i === 0 && look.stagesOpaque) || !!s.depthWrite);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
    });
    gl.uniform1f(u.uRotate, 0);
    if (look.stagesOpaque) {
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      const dl = this.dlights?.length ?? 0;
      if (dl) {
        gl.uniform1i(u.uDlCount, dl);
        gl.uniform1i(u.uMode, 5);
        gl.blendFunc(gl.DST_COLOR, gl.ONE);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
        gl.uniform1i(u.uDlCount, 0);
      }
      const fog = g.fog >= 0 ? this.fogs[g.fog] : null;
      if (fog) {
        gl.uniform1i(u.uMode, 6);
        gl.uniform3f(u.uFogColor, fog.color[0], fog.color[1], fog.color[2]);
        gl.uniform1f(u.uFogOpaque, fog.opaque);
        gl.uniform1i(u.uFogHasPlane, fog.plane ? 1 : 0);
        if (fog.plane) gl.uniform4f(u.uFogPlane, fog.plane.nx, fog.plane.ny, fog.plane.nz, fog.plane.dist);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.first * 4);
      }
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  /** A blendFunc factor's name (GL_DST_COLOR …) as the WebGL constant */
  factor(name) {
    const gl = this.gl;
    return {
      GL_ONE: gl.ONE, GL_ZERO: gl.ZERO, GL_DST_COLOR: gl.DST_COLOR, GL_ONE_MINUS_DST_COLOR: gl.ONE_MINUS_DST_COLOR, GL_SRC_ALPHA: gl.SRC_ALPHA,
      GL_ONE_MINUS_SRC_ALPHA: gl.ONE_MINUS_SRC_ALPHA, GL_SRC_COLOR: gl.SRC_COLOR, GL_ONE_MINUS_SRC_COLOR: gl.ONE_MINUS_SRC_COLOR,
      GL_DST_ALPHA: gl.DST_ALPHA, GL_ONE_MINUS_DST_ALPHA: gl.ONE_MINUS_DST_ALPHA, GL_SRC_ALPHA_SATURATE: gl.SRC_ALPHA_SATURATE,
    }[name] ?? gl.ONE;
  }

  /** A 1×1 white texture (a lightmap stage on a surface without a lightmap: the colour does the lighting) */
  white() {
    if (!this.whiteTex) this.whiteTex = this.makeTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, false);
    return this.whiteTex;
  }

  setBlend(mode) {
    const gl = this.gl;
    if (mode === 'opaque') { gl.disable(gl.BLEND); gl.depthMask(true); return; }
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'filter') gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    else if (mode === 'subtract') gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  drawAlphaPolys() {
    for (const s of this.autosprites ?? []) this.drawSprite(s.image, s.center, s.size, s.blend);
    this.autosprites = [];
    if (!this.alphaGroups.length) return;
    this.bindWorld();
    for (const g of this.alphaGroups) this.drawGroup(g);
    this.alphaGroups = [];
    this.gl.disable(this.gl.BLEND);
    this.gl.depthMask(true);
  }

  // ── MD3 models ──────────────────────────────────────────────────────────
  mesh(mdl, si, frame) {
    const key = `${mdl.name}:${si}:${frame}`;
    let m = this.meshCache.get(key);
    if (m) return m;
    const surf = mdl.surfaces[si];
    const nv = surf.numVerts;
    const out = new Float32Array(nv * 8);
    const base = frame * nv * 4;
    for (let i = 0; i < nv; i++) {
      const p = base + i * 4, o = i * 8;
      out[o] = surf.xyz[p] / 64; out[o + 1] = surf.xyz[p + 1] / 64; out[o + 2] = surf.xyz[p + 2] / 64;
      const packed = surf.xyz[p + 3] & 0xffff;
      const lat = ((packed >> 8) & 255) * (2 * Math.PI / 255), lng = (packed & 255) * (2 * Math.PI / 255);
      out[o + 3] = Math.cos(lat) * Math.sin(lng); out[o + 4] = Math.sin(lat) * Math.sin(lng); out[o + 5] = Math.cos(lng);
      out[o + 6] = surf.st[i * 2]; out[o + 7] = surf.st[i * 2 + 1];
    }
    if (this.meshCache.size > 4000) this.meshCache.clear();
    this.meshCache.set(key, out);
    return out;
  }

  /** A powerup's shell as the model program's vertices: the moved positions, an up normal (it is drawn full
   *  bright), the reflected texture coordinates */
  shellBuffer(surf, fr, eye, shell) {
    const { xyz, st } = shellMesh(surf, fr, eye, shell.look, shell.time);
    const out = new Float32Array(surf.numVerts * 8);
    for (let i = 0; i < surf.numVerts; i++) {
      const o = i * 8;
      out[o] = xyz[i * 3]; out[o + 1] = xyz[i * 3 + 1]; out[o + 2] = xyz[i * 3 + 2];
      out[o + 5] = 1; out[o + 6] = st[i * 2]; out[o + 7] = st[i * 2 + 1];
    }
    return out;
  }

  drawMd3(mdl, frame, origin, axis, skin, light, opts = {}) {
    const gl = this.gl, u = this.model.u;
    const fr = Math.min(Math.max(frame | 0, 0), mdl.numFrames - 1);
    gl.useProgram(this.model.p);
    gl.uniformMatrix4fv(u.uProj, false, this.proj);
    gl.uniformMatrix4fv(u.uView, false, this.viewM);
    gl.uniformMatrix4fv(u.uModel, false, this.modelMatrix(origin, axis));
    const ls = this.lightScale * this.modelLight / 255;
    if (light) {
      const amb = light.ambient.map((v) => Math.max(24 / 255, Math.min(1, v * ls)));
      gl.uniform3f(u.uAmbient, amb[0], amb[1], amb[2]);
      gl.uniform3f(u.uDirected, Math.min(1, light.directed[0] * ls), Math.min(1, light.directed[1] * ls), Math.min(1, light.directed[2] * ls));
      gl.uniform3f(u.uLightDir, light.dir[0], light.dir[1], light.dir[2]);
    } else {
      gl.uniform3f(u.uAmbient, 1, 1, 1); gl.uniform3f(u.uDirected, 0, 0, 0); gl.uniform3f(u.uLightDir, 0, 0, 1);
    }
    const tint = opts.tint ?? [1, 1, 1];
    gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1i(u.uTex, 0);
    const blend = opts.blend ?? 'opaque';
    this.setBlend(blend);
    if (opts.twoSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    gl.disableVertexAttribArray(3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.dynIbo);
    const shell = opts.shell ?? null, eye = shell ? eyeInModel(this.view, origin, axis) : null;
    mdl.surfaces.forEach((surf, si) => {
      const img = skin ? skin(surf) : null;
      if (img === false) return;
      const tex = this.texture(shell ? shell.look.image : img ?? (surf.shaders[0] || ''));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.uniform1i(u.uAlphaTest, tex.hasAlpha && blend === 'opaque' ? 1 : 0);
      gl.bufferData(gl.ARRAY_BUFFER, shell ? this.shellBuffer(surf, fr, eye, shell) : this.mesh(mdl, si, fr), gl.DYNAMIC_DRAW);
      if (!surf.tris32) surf.tris32 = new Uint32Array(surf.tris);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, surf.tris32, gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, surf.numTris * 3, gl.UNSIGNED_INT, 0);
    });
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    return false;
  }

  // ── sprites, beams, particles (one dynamic buffer each) ─────────────────
  bindSprite() {
    const gl = this.gl, u = this.sprite.u;
    gl.useProgram(this.sprite.p);
    gl.uniformMatrix4fv(u.uProj, false, this.proj);
    gl.uniformMatrix4fv(u.uView, false, this.viewM);
    gl.uniform1i(u.uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 36, 20);
    gl.disableVertexAttribArray(3);
    gl.disable(gl.CULL_FACE);
  }

  quad(p0, p1, p2, p3, uv0, uv1, color) {
    const q = this.quadBuf ?? (this.quadBuf = new Float32Array(6 * 9));
    const put = (i, p, s, t) => { const o = i * 9; q[o] = p[0]; q[o + 1] = p[1]; q[o + 2] = p[2]; q[o + 3] = s; q[o + 4] = t; q[o + 5] = color[0]; q[o + 6] = color[1]; q[o + 7] = color[2]; q[o + 8] = color[3]; };
    put(0, p0, uv0[0], uv0[1]); put(1, p1, uv1[0], uv0[1]); put(2, p2, uv1[0], uv1[1]);
    put(3, p0, uv0[0], uv0[1]); put(4, p2, uv1[0], uv1[1]); put(5, p3, uv0[0], uv1[1]);
    return q;
  }

  drawSprite(img, origin, size, blend = 'add', light = 255, alpha = 1) {
    const gl = this.gl, v = this.view;
    const hs = size / 2, r = v.right, up = v.up;
    const p = (a, b) => [origin[0] + r[0] * a + up[0] * b, origin[1] + r[1] * a + up[1] * b, origin[2] + r[2] * a + up[2] * b];
    const tex = this.texture(img);
    this.bindSprite();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.uniform1i(this.sprite.u.uUseTex, 1);
    this.setBlend(blend);
    const l = light / 255;
    gl.bufferData(gl.ARRAY_BUFFER, this.quad(p(-hs, hs), p(hs, hs), p(hs, -hs), p(-hs, -hs), [0, 0], [1, 1], [l, l, l, alpha]), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND); gl.depthMask(true);
  }

  /** A mark on the world: a polygon of n points with texture coordinates, a fan, pulled towards the eye in
   *  depth (the mark shaders' polygonOffset). */
  drawMark(pts, st, n, img, blend, color) {
    const gl = this.gl;
    const buf = new Float32Array((n - 2) * 3 * 9);
    let o = 0;
    const put = (k) => { buf.set([pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2], st[k * 2], st[k * 2 + 1], color[0], color[1], color[2], color[3]], o); o += 9; };
    for (let k = 1; k + 1 < n; k++) { put(0); put(k); put(k + 1); }
    const tex = this.texture(img);
    this.bindSprite();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.uniform1i(this.sprite.u.uUseTex, 1);
    this.setBlend(blend);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -2);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, (n - 2) * 3);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND); gl.depthMask(true);
  }

  drawBeam(a, b, img, width, blend = 'add', scroll = 0) {
    const gl = this.gl, v = this.view;
    // the ribbon faces the camera: the perpendicular to the beam within the view plane
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const toEye = [v.x - a[0], v.y - a[1], v.z - a[2]];
    let n = [d[1] * toEye[2] - d[2] * toEye[1], d[2] * toEye[0] - d[0] * toEye[2], d[0] * toEye[1] - d[1] * toEye[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((x) => (x / len) * width / 2);
    const tex = this.texture(img);
    const tl = Math.hypot(d[0], d[1], d[2]) / 64;
    this.bindSprite();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.uniform1i(this.sprite.u.uUseTex, 1);
    this.setBlend(blend);
    gl.bufferData(gl.ARRAY_BUFFER, this.quad([a[0] + n[0], a[1] + n[1], a[2] + n[2]], [b[0] + n[0], b[1] + n[1], b[2] + n[2]], [b[0] - n[0], b[1] - n[1], b[2] - n[2]], [a[0] - n[0], a[1] - n[1], a[2] - n[2]], [scroll, 0], [scroll + tl, 1], [1, 1, 1, 1]), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND); gl.depthMask(true);
  }

  drawParticles() {
    const ps = this.particles;
    if (!ps.length) return;
    const gl = this.gl;
    const buf = new Float32Array(ps.length * 9);
    ps.forEach((p, i) => {
      const o = i * 9;
      buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z; buf[o + 3] = 0; buf[o + 4] = 0;
      buf[o + 5] = (p.color & 255) / 255; buf[o + 6] = ((p.color >> 8) & 255) / 255; buf[o + 7] = ((p.color >> 16) & 255) / 255; buf[o + 8] = 1;
    });
    this.bindSprite();
    gl.uniform1i(this.sprite.u.uUseTex, 0);
    gl.uniform1f(this.sprite.u.uPointSize, 2.5 * this.canvas.width / 320);
    gl.depthMask(false);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, ps.length);
    gl.depthMask(true);
  }

  // ── 2D: the overlay ──────────────────────────────────────────────────────
  drawPic(...a) { this.overlay.drawPic(...a); }
  drawChar(...a) { this.overlay.drawChar(...a); }
  drawString(...a) { this.overlay.drawString(...a); }
  fillRect(...a) { this.overlay.fillRect(...a); }

  /** The overlay goes up with the screen tint; the GL canvas is already drawn. */
  present(tint = null) {
    const o = this.overlay;
    if (tint && tint[3] > 0) {
      const fb = o.fb, a = tint[3], ia = 1 - a, tr = tint[0] * a, tg = tint[1] * a, tb = tint[2] * a, ta = Math.round(a * 255);
      for (let i = 0; i < fb.length; i++) {
        const c = fb[i];
        if ((c >>> 24) === 0) { fb[i] = ((ta << 24) | (tint[2] << 16) | (tint[1] << 8) | tint[0]) >>> 0; continue; }
        fb[i] = ((c & 0xff000000) | ((((c >> 16) & 255) * ia + tb) << 16) | ((((c >> 8) & 255) * ia + tg) << 8) | ((c & 255) * ia + tr)) >>> 0;
      }
    }
    o.ctx.putImageData(o.image, 0, 0);
  }
}

// the player parts, the weapon models and the particle bookkeeping are the software painter's
for (const m of ['drawPlayer', 'drawMd3Powered', 'weaponModel', 'spawnParticles', 'runParticles']) GLRenderer.prototype[m] = Renderer.prototype[m];

export { yawAxis, anglesAxis, tagTransform, animFrame };
