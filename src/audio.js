// audio.js – snd_dma.c, more or less: the SOUND_EVENTS rows become Web
// Audio buffers, attenuated and panned from where they happened (Quake's
// spatialisation: full volume within 80 units, then a linear fall-off
// scaled by the attenuation, attenuation 0 heard everywhere). The map's
// looped target_speakers play at their origins; the music is the file the
// worldspawn names when the pak has it (the demo has none), else a drone.

const SOUND_FULLVOLUME = 80;

export class Q3Audio {
  constructor() {
    this.ctx = null;
    this.pak = null;
    this.buffers = new Map();
    this.volume = 0.7;
    this.musicVolume = 0.4;
    this.channels = new Map();   // `${ent}:${chan}` → source, to cut
    this.speakers = [];          // looped target_speakers: { id, name, x, y, z, vol, attn, on, src, gain, pan }
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.musicMode = 'tracks';   // 'off' | 'tracks' | 'synth'
    this.music = null;
    this.track = null;
    this.loops = new Map();      // the weapon hums (lightning, railgun, gauntlet)
  }

  setPak(pak) { this.pak = pak; this.buffers.clear(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** Under water (or slime, or lava) the effects go dull: a low-pass eased in over a few tens of milliseconds. */
  setUnderwater(on) {
    if (!this.lowpass || this.underwater === on) return;
    this.underwater = on;
    this.lowpass.frequency.setTargetAtTime(on ? 700 : 20000, this.ctx.currentTime, 0.04);
  }
  setMusicVolume(v) { this.musicVolume = v; if (this.musicGain) this.musicGain.gain.value = v; }

  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      // the head under a liquid muffles the world (a low-pass; Quake III's mixer is told "inwater" and
      // does nothing with it): the effects go through it, the music does not
      this.lowpass = this.ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = 20000;
      this.master.connect(this.lowpass).connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.ctx.destination);
      this.startSpeakers();
      if (this.track !== null) this.playMusic(this.track);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  suspend(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend(); else this.ctx.resume();
  }

  async buffer(name) {
    if (this.buffers.has(name)) return this.buffers.get(name);
    const p = (async () => {
      if (!this.pak || !this.pak.has(name)) return null;
      try {
        return await this.ctx.decodeAudioData(this.pak.buffer(name));
      } catch { return null; }
    })();
    this.buffers.set(name, p);
    return p;
  }

  /** Volume and pan of a sound at (x, y, z) for the listener (S_Spatialize). */
  spatialize(x, y, z, attn) {
    const l = this.listener;
    if (x == null || !attn) return { gain: 1, pan: 0 };
    const dx = x - l.x, dy = y - l.y, dz = z - l.z;
    const dist = Math.max(0, Math.hypot(dx, dy, dz) - SOUND_FULLVOLUME) * attn * 0.0008;
    const gain = Math.max(0, 1 - dist);
    const yaw = (l.yaw * Math.PI) / 180;
    const rx = Math.sin(yaw), ry = -Math.cos(yaw);
    const d = Math.hypot(dx, dy) || 1;
    const pan = ((dx * rx + dy * ry) / d) * 0.8;
    return { gain, pan };
  }

  async playEvents(rows, listener) {
    this.listener = listener;
    if (!this.ctx) return;
    for (const [, , ent, chan, name, vol, attn, x, y, z] of rows) {
      const buf = await this.buffer(name);
      if (!buf) continue;
      const { gain, pan } = this.spatialize(x, y, z, attn);
      if (gain <= 0) continue;
      const key = `${ent}:${chan}`;
      if (ent != null && chan !== 0) {
        const old = this.channels.get(key);
        if (old) { try { old.stop(); } catch { /* ended */ } }
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = gain * vol;
      const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (p) { p.pan.value = pan; src.connect(g).connect(p).connect(this.master); } else src.connect(g).connect(this.master);
      src.start();
      if (ent != null && chan !== 0) this.channels.set(key, src);
    }
  }

  /** A looping sound that follows the player (the lightning gun's hum): on/off by key. */
  async setLoop(key, name, on) {
    if (!this.ctx) return;
    const cur = this.loops.get(key);
    if (!on) { if (cur) { try { cur.src.stop(); } catch { /* ended */ } this.loops.delete(key); } return; }
    if (cur && cur.name === name) return;
    if (cur) { try { cur.src.stop(); } catch { /* ended */ } this.loops.delete(key); }
    const buf = await this.buffer(name);
    if (!buf) return;
    const node = this.loop(buf, this.master);
    node.gain.gain.value = 0.5;
    this.loops.set(key, { name, ...node });
  }

  // ── looped speakers ───────────────────────────────────────────────────
  /** rows: [id, x, y, z, noise, vol, attn, on] for every looped target_speaker of the map. */
  setSpeakers(rows) {
    this.stopSpeakers();
    this.speakers = rows.map(([id, x, y, z, name, vol, attn, on]) => ({ id, x, y, z, name, vol: vol || 1, attn: attn < 0 ? 0 : attn, on: on === 1 }));
    if (this.ctx) this.startSpeakers();
  }

  setSpeakersOn(ids) {
    const on = new Set(ids);
    for (const s of this.speakers) s.on = on.has(s.id);
  }

  loop(buf, dest) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) src.connect(g).connect(p).connect(dest); else src.connect(g).connect(dest);
    src.start(0, Math.random() * buf.duration);
    return { src, gain: g, pan: p };
  }

  async startSpeakers() {
    if (!this.ctx) return;
    for (const s of this.speakers) {
      if (s.src) continue;
      const buf = await this.buffer(s.name);
      if (!buf) continue;
      Object.assign(s, this.loop(buf, this.master));
    }
  }

  stopSpeakers() {
    for (const s of this.speakers) { if (s.src) { try { s.src.stop(); } catch { /* ended */ } } s.src = null; }
    this.speakers = [];
  }

  /** Called every frame with the listener: the looped speakers follow the player. */
  update(listener) {
    this.listener = listener;
    for (const s of this.speakers) {
      if (!s.gain) continue;
      const { gain, pan } = this.spatialize(s.x, s.y, s.z, s.attn);
      s.gain.gain.value = s.on ? gain * s.vol * 0.5 : 0;
      if (s.pan) s.pan.pan.value = pan;
    }
  }

  // ── music ──────────────────────────────────────────────────────────────
  setMusicMode(mode) {
    this.musicMode = mode;
    this.stopMusic();
    if (this.track !== null && this.ctx) this.playMusic(this.track);
  }

  /** Start the map's music (worldspawn "music": a file in the pak, when it is there). */
  async playMusic(name) {
    this.track = name ?? '';
    if (!this.ctx || this.musicMode === 'off') { this.stopMusic(); return; }
    if (this.music && this.music.track === this.track) return;
    this.stopMusic();
    const token = { track: this.track };
    this.music = token;
    let buf = null;
    const file = (this.track || '').toLowerCase().replace(/\\/g, '/');
    if (this.musicMode === 'tracks' && file && this.pak && this.pak.has(file)) buf = await this.buffer(file);
    if (this.music !== token) return;
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.musicGain);
      src.start();
      token.src = src;
    } else token.stop = this.startDrone(file.length);
  }

  stopMusic() {
    if (!this.music) return;
    try { this.music.src?.stop(); } catch { /* ended */ }
    this.music.stop?.();
    this.music = null;
  }

  /** An industrial drone when the pak has no music: a low pulse, a filtered saw pad and machine noise. */
  startDrone(seed) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.musicGain);
    out.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 4);
    const root = 31 + ((seed * 7) % 5);
    const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 3;
    filter.connect(out);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    const nodes = [lfo];
    for (const [n, type, detune, g] of [[root, 'sawtooth', -5, 0.5], [root, 'square', 6, 0.25], [root + 7, 'sawtooth', 0, 0.2], [root - 12, 'sine', 0, 0.8]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(n);
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(filter);
      o.start();
      nodes.push(o);
    }
    const pulse = ctx.createOscillator();
    pulse.type = 'triangle';
    pulse.frequency.value = hz(root - 24);
    const pg = ctx.createGain();
    pg.gain.value = 0;
    pulse.connect(pg).connect(out);
    pulse.start();
    nodes.push(pulse);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.3;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 250;
    nf.Q.value = 1;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    noise.connect(nf).connect(ng).connect(out);
    noise.start();
    nodes.push(noise);
    let alive = true;
    const beat = () => {
      if (!alive) return;
      const t = ctx.currentTime;
      pg.gain.cancelScheduledValues(t);
      pg.gain.setValueAtTime(0.5, t);
      pg.gain.exponentialRampToValueAtTime(0.01, t + 0.6);
      setTimeout(beat, 1200);
    };
    beat();
    return () => {
      alive = false;
      out.gain.cancelScheduledValues(ctx.currentTime);
      out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
      out.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
      setTimeout(() => { for (const n of nodes) { try { n.stop(); } catch { /* ended */ } } out.disconnect(); }, 1600);
    };
  }
}
