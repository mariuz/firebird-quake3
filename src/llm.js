// llm.js – a language model as a bot's strategist (sql/chat.sql: bot_llm_state, bot_llm_apply). Every few seconds
// each bot the model leads has its situation, written by SQL as a few lines of text, sent to Claude with the
// player's own API key, and the answer (go for an item, hunt someone, wait in ambush, roam; a line to say) given
// back to SQL, which carries it out. The model is far too slow for a bot's hands: aiming, dodging and finding the
// way stay bot_think's. Nothing here decides anything: it passes text one way and five fields the other.
//
// The model remembers nothing from one question to the next, so the database does it for it: every decision and
// what followed is a row (bot_llm_log), what the model asks to have remembered is another (bot_llm_notes), and
// SQL writes both back into each question (bot_llm_memory). exportMemory and importMemory move those rows to
// and from the browser's storage, so a bot knows next week what it learned of an arena today.
//
// The key stays in this browser (the page keeps it in localStorage) and goes to api.anthropic.com alone.

/** The models offered, the first the default */
export const LLM_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
];

const SYSTEM = `You decide the strategy of one bot in a Quake III Arena deathmatch. The game runs in real time and you are asked again every few seconds, so each answer is one decision for the next few seconds, not a plan for the match.

The bot fights on its own: whenever an enemy is in sight it aims, dodges and fires without you, and it finds its own way through the arena. What you choose is where it goes and whom it goes after:
- get: go for an item. target is the item's class exactly as the items list gives it (for example weapon_rocketlauncher). Only an item that is there now can be fetched; one that is taken comes back when the list says.
- hunt: go after a player. target is the player's name exactly as the others list gives it.
- ambush: wait where the bot stands for an enemy to come by.
- roam: let the bot follow its own item goals. target is empty.

What wins a deathmatch: better guns than the machinegun it spawns with (rocket launcher, railgun, lightning gun, plasma gun, shotgun), armor and health before a fight and after one, the quad damage and other powerups when they are up, and fights picked when the bot is the stronger. A bot at low health with a machinegun should not go hunting. Distances are in game units: a player runs 320 a second, and a room is a few hundred across.

Your last decision is in the "doing" line; when it says an item was not there or a name was not found, choose something else. Staying with a decision that is still under way is fine: answer it again.

You have no memory of your own between these questions; the game keeps it for you and gives it back each time. "your last decisions" shows what followed each one, and "what your decisions have brought on this arena" totals every decision you made here, in earlier matches too. Use them: repeat what brought frags, drop what brought deaths. note is how you write to that memory: a lesson about this arena or these opponents that you would want to read in a later match, at most twenty words, such as where a fight went badly and why. A note is kept and shown to you in every later question, so write one only when you have learned something the totals do not already show, and leave it empty otherwise.

say is a line the bot says in the game's chat, in character as an arena fighter, at most twelve words. Leave it empty most of the time, and speak only when something worth a remark has just happened in the console lines.`;

const FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'hunt', 'ambush', 'roam'] },
      target: { type: 'string', description: 'the item class for get, the player name for hunt, empty otherwise' },
      say: { type: 'string', description: 'a chat line, usually empty' },
      note: { type: 'string', description: 'a lesson to keep in memory for later matches, usually empty' },
    },
    required: ['action', 'target', 'say', 'note'],
    additionalProperties: false,
  },
};

export class Strategist {
  /**
   * @param {object} o
   * @param {string} o.apiKey      the player's Anthropic API key
   * @param {string} [o.model]     one of LLM_MODELS
   * @param {number} [o.every]     seconds between two questions for one bot
   * @param {string} [o.baseURL]   another endpoint (the test's)
   * @param {(s: string) => void} [o.onStatus]
   */
  constructor({ apiKey, model = LLM_MODELS[0][0], every = 5, baseURL, onStatus = () => {} }) {
    this.apiKey = apiKey; this.model = model; this.every = every; this.baseURL = baseURL; this.onStatus = onStatus;
    this.client = null;
    this.due = new Map();        // bot ent id → when it is asked next (ms)
    this.look = 0;               // when the situations are read next: once a second at most
    this.busy = false;
    this.stopped = null;         // why it gave up, if it did
    this.decisions = 0; this.notes = 0; this.tokensIn = 0; this.tokensOut = 0;
    this.Anthropic = null;
  }

  async connect() {
    if (this.client) return;
    // the SDK is only wanted by who plays against the model: on the page it is a file of its own next to
    // main.js (scripts/build.mjs), fetched now; in Node, the package (a name the bundler leaves alone)
    const sdk = typeof document === 'undefined' ? '@anthropic-ai/sdk' : new URL('./anthropic-sdk.js', import.meta.url).href;
    const { default: Anthropic } = await import(sdk);
    this.Anthropic = Anthropic;
    // the key is the player's own, typed into their own browser, which is what this option is for
    this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 30_000, ...(this.baseURL ? { baseURL: this.baseURL } : {}) });
  }

  /** One question: the bot's situation and memory in, { action, target, say, note } out, or null when the model declined */
  async decide(situation) {
    await this.connect();
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: situation }],
      // a decision every few seconds: little thinking, and an answer that is the four fields and nothing else
      output_config: { effort: 'low', format: FORMAT },
      // should the model's safety classifiers decline (a game of frags is about fighting), the API's default
      // fallback model answers within the same call
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    this.tokensIn += response.usage?.input_tokens ?? 0;
    this.tokensOut += response.usage?.output_tokens ?? 0;
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    const d = JSON.parse(text);
    return { action: String(d.action ?? ''), target: String(d.target ?? ''), say: String(d.say ?? ''), note: String(d.note ?? '') };
  }

  /**
   * Ask for every led bot that is due, one after the other, and give SQL the answers. Called now and then by the
   * page's loop; returns at once while a round is under way.
   */
  async tick(db, now = performance.now()) {
    if (this.busy || this.stopped || now < this.look) return;
    this.look = now + Math.min(1000, this.every * 1000);
    this.busy = true;
    try {
      const { rows } = await db.query('SELECT eid, bot, txt FROM bot_llm_ask');
      for (const r of rows) {
        if ((this.due.get(r.EID) ?? 0) > now) continue;
        this.due.set(r.EID, now + this.every * 1000);
        let d;
        try { d = await this.decide(r.TXT); } catch (err) { this.failed(err, r.EID); if (this.stopped) return; continue; }
        if (!d) continue;
        // (only what a console line can carry)
        const plain = (s) => s.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 150);
        const say = plain(d.say), note = plain(d.note);
        const [a] = (await db.query('SELECT done FROM bot_llm_apply(?, ?, ?, ?, ?)', [r.EID, d.action.slice(0, 20), d.target.slice(0, 40), say, note])).rows;
        this.decisions++;
        if (note) this.notes++;
        this.onStatus(`${r.BOT.trim()}: ${a?.DONE?.trim() ?? '?'} · ${this.decisions} decision${this.decisions === 1 ? '' : 's'}${this.notes ? `, ${this.notes} note${this.notes === 1 ? '' : 's'}` : ''}, ${(this.tokensIn / 1000).toFixed(1)}k tokens in, ${(this.tokensOut / 1000).toFixed(1)}k out`);
      }
    } finally { this.busy = false; }
  }

  /** A failed call: a wrong key or a request the API will not take ends it, a limit or an outage waits */
  failed(err, eid) {
    const A = this.Anthropic;
    if (A && (err instanceof A.AuthenticationError || err instanceof A.PermissionDeniedError)) this.stopped = 'the API key was not accepted';
    else if (A && (err instanceof A.BadRequestError || err instanceof A.NotFoundError)) this.stopped = `the request was refused: ${err.message}`;
    else if (A && err instanceof A.RateLimitError) { this.due.set(eid, performance.now() + 30_000); this.onStatus('rate limited: waiting 30 s'); return; }
    else { this.due.set(eid, performance.now() + 15_000); this.onStatus(`no answer (${err?.message ?? err}): trying again in 15 s`); return; }
    this.onStatus(`stopped: ${this.stopped}`);
  }
}

// ── the memory's rows to and from the browser's storage ────────────────────────────────────────────────────────
const LOG_COLS = 'bot, map_name, action, arg, ok, hp0, armor0, frags0, deaths0, weapons0, hp1, armor1, frags1, deaths1, weapons1, secs';

/** What the led bots remember, as rows: their notes, and their decisions with what followed (the newest 400) */
export async function exportMemory(db) {
  const arr = { rowMode: 'array' };
  const notes = (await db.query('SELECT bot, map_name, note FROM bot_llm_notes ORDER BY id', [], arr)).rows;
  const log = (await db.query(`SELECT FIRST 400 ${LOG_COLS} FROM bot_llm_log WHERE hp1 IS NOT NULL OR ok = 0 ORDER BY id DESC`, [], arr)).rows.reverse();
  return { version: 1, notes, log };
}

/** The rows back in place of what is there: as decisions of earlier matches */
export async function importMemory(db, mem) {
  if (mem?.version !== 1 || !Array.isArray(mem.notes) || !Array.isArray(mem.log)) return 0;
  await db.exec('DELETE FROM bot_llm_notes');
  await db.exec('DELETE FROM bot_llm_log');
  const text = (v, n) => String(v ?? '').replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, n);
  const int = (v) => (v === null || v === undefined ? null : Math.trunc(Number(v)) || 0);
  for (const [bot, map, note] of mem.notes.slice(-200))
    await db.query('INSERT INTO bot_llm_notes (id, bot, map_name, note) VALUES (NEXT VALUE FOR llm_seq, ?, ?, ?)', [text(bot, 16), text(map, 32), text(note, 160)]);
  for (const r of mem.log.slice(-400)) {
    if (!Array.isArray(r) || r.length !== 16) continue;
    await db.query(`INSERT INTO bot_llm_log (id, time_, past, ${LOG_COLS}) VALUES (NEXT VALUE FOR llm_seq, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [text(r[0], 16), text(r[1], 32), text(r[2], 20), text(r[3], 40), ...r.slice(4, 15).map(int), r[15] === null ? null : Number(r[15]) || 0]);
  }
  return mem.notes.length + mem.log.length;
}

// ── an open model on the player's own machine, in Claude's place ───────────────────────────────────────────────
// Ollama, LM Studio, llama.cpp's server and the like serve a model on localhost behind OpenAI's chat-completions
// API. A model of that size (seven or eight billion parameters and up) can be asked what Claude is asked, the
// situation and the memory, and answer the same five fields, so only the call differs. No key, no bill; the page
// has to be allowed to reach the server (Ollama: OLLAMA_ORIGINS, LM Studio: its CORS switch).

/** Where such a server usually is, and a model to start with */
export const SERVER_DEFAULT = { url: 'http://localhost:11434', model: 'llama3.1:8b' };

export class ServerStrategist extends Strategist {
  /**
   * @param {object} o
   * @param {string} [o.url]    the server, without the /v1
   * @param {string} [o.model]  the model's name as the server knows it
   */
  constructor({ url = SERVER_DEFAULT.url, model = SERVER_DEFAULT.model, every = 5, onStatus = () => {} } = {}) {
    super({ apiKey: '', model, every, onStatus });
    this.url = url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    this.schema = true;   // (until the server says it does not take a JSON schema)
  }

  async connect() { /* nothing to load */ }

  async decide(situation) {
    const body = (schema) => JSON.stringify({
      model: this.model,
      messages: [{ role: 'system', content: `${SYSTEM}\n\nAnswer with one JSON object and nothing else: {"action": "get" | "hunt" | "ambush" | "roam", "target": "…", "say": "…", "note": "…"}.` },
        { role: 'user', content: situation }],
      max_tokens: 400, temperature: 0.2, stream: false,
      response_format: schema ? { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: FORMAT.schema } } : { type: 'json_object' },
    });
    const post = (schema) => fetch(`${this.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(schema), signal: AbortSignal.timeout(60_000) });
    let rsp = await post(this.schema);
    // (a server that does not know json_schema: the plainer JSON mode from now on)
    if (rsp.status === 400 && this.schema) { this.schema = false; rsp = await post(false); }
    if (!rsp.ok) throw Object.assign(new Error(`the server answered ${rsp.status}`), { status: rsp.status });
    const data = await rsp.json();
    this.tokensIn += data.usage?.prompt_tokens ?? 0;
    this.tokensOut += data.usage?.completion_tokens ?? 0;
    // (the object, whatever the model wrote around it)
    const text = String(data.choices?.[0]?.message?.content ?? '');
    const from = text.indexOf('{'), to = text.lastIndexOf('}');
    if (from < 0 || to < from) return null;
    let d;
    try { d = JSON.parse(text.slice(from, to + 1)); } catch { return null; }
    return { action: String(d.action ?? ''), target: String(d.target ?? ''), say: String(d.say ?? ''), note: String(d.note ?? '') };
  }

  /** A failed call: a model the server does not have ends it, a server that is not there is tried again */
  failed(err, eid) {
    if (err?.status === 404) { this.stopped = `the server has no model "${this.model}"`; this.onStatus(`stopped: ${this.stopped}`); return; }
    this.due.set(eid, performance.now() + 15_000);
    this.onStatus(err?.status ? `${err.message}: trying again in 15 s` : `no server at ${this.url} (is it running, and may this page reach it?): trying again in 15 s`);
  }
}

// ── a small open model in the browser, in Claude's place ───────────────────────────────────────────────────────
// No key, no bill and nothing to install: the model is downloaded once into the browser and runs on the player's
// GPU (Transformers.js on WebGPU, as the embedding model of chat.js does). It is an experiment, and by what was
// measured not a strategist: every model small enough to download, from 270 million parameters to Phi-4 mini's
// 3.8 billion, answered nearly the same whatever the bot's health and guns, asked for a number of a list, one of
// four words or one of two, with worked examples, at four bits or at full precision (docs/ARCHITECTURE.md has
// the numbers). So the question is as small as it can be and SQL does the rest: SQL finds the best move of each kind (bot_llm_offer) and the model answers one
// word, heal, arm, hunt or wait, after a few worked examples; SQL carries out the move kept under the word
// (bot_llm_pick). It writes no chat lines and no notes; its decisions go into the same memory.

/** The models offered: [id, label, dtype], the first the default */
export const LOCAL_MODELS = [
  ['onnx-community/Qwen2.5-0.5B-Instruct', 'Qwen 2.5 0.5B (0.8 GB)', 'q4'],
  ['onnx-community/gemma-3-1b-it-ONNX', 'Gemma 3 1B (0.9 GB)', 'q4'],
  ['onnx-community/Phi-4-mini-instruct-ONNX', 'Phi-4 mini (2.8 GB)', 'q4'],
];
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

const SMALL_SYSTEM = 'You advise a fighter in an arena deathmatch. Answer with one word: "heal" when the fighter is badly hurt, "arm" when it has no gun better than the Machinegun, "hunt" when it is healthy and well armed, "wait" otherwise.';
// (worked examples in the form bot_llm_offer writes; scripts/llm-test.mjs holds the two to each other)
const EXAMPLES = [
  ['Health 18, armor 0. Guns: Gauntlet, Machinegun (30), Railgun (8). Nearest enemy: 600 units away, in sight, holding the Shotgun.\nheal: the 25 Health, 300 units away\narm: the Rocket Launcher, 700 units away\nhunt: Sarge\nwait: in ambush here', 'heal arm hunt wait', 'heal'],
  ['Health 110, armor 25. Guns: Gauntlet, Machinegun (90). Nearest enemy: 900 units away, holding the Machinegun.\nheal: the Armor, 800 units away\narm: the Shotgun, 350 units away\nhunt: Visor\nwait: in ambush here', 'heal arm hunt wait', 'arm'],
  ['Health 140, armor 100. Guns: Gauntlet, Machinegun (50), Rocket Launcher (20), Plasma Gun (60). Nearest enemy: 500 units away, in sight, holding the Machinegun.\nheal: the Mega Health, 1200 units away\narm: the Railgun, 1500 units away\nhunt: Major\nwait: in ambush here', 'heal arm hunt wait', 'hunt'],
  ['Health 35, armor 5. Guns: Gauntlet, Machinegun (80). Nearest enemy: 400 units away, holding the Rocket Launcher.\nheal: the 50 Health, 250 units away\narm: the Plasma Gun, 900 units away\nhunt: Grunt\nwait: in ambush here', 'heal arm hunt wait', 'heal'],
  ['Health 125, armor 0. Guns: Gauntlet, Machinegun (100). Nearest enemy: 1300 units away, holding the Machinegun.\narm: the Rocket Launcher, 600 units away\nhunt: Daemia\nwait: in ambush here', 'arm hunt wait', 'arm'],
];
const question = (txt, words) => `${txt}\nOne word (${words.trim().split(/\s+/).join(', ').replace(/, ([^,]*)$/, ' or $1')}):`;

/** The chat a small model is given: the instruction, the worked examples, then the bot's brief and its words */
export function smallMessages(txt, words) {
  return [{ role: 'system', content: SMALL_SYSTEM },
    ...EXAMPLES.flatMap(([t, w, a]) => [{ role: 'user', content: question(t, w) }, { role: 'assistant', content: a }]),
    { role: 'user', content: question(txt, words) }];
}

/** The word of an answer: the first of those offered that it has, or '' (which lets the bot roam) */
export function smallWord(answer, words) {
  const offered = words.trim().split(/\s+/);
  return (String(answer).toLowerCase().match(/[a-z]+/g) ?? []).find((w) => offered.includes(w)) ?? '';
}

// The Worker the model runs in: it loads the library and the model when told, then answers each chat with the
// few tokens the model generates
const WORKER = `
let pipe = null;
onmessage = async ({ data }) => {
  try {
    if (data.load) {
      const { pipeline } = await import(data.lib);
      const seen = new Map();
      const progress_callback = (p) => {
        if (p.status !== 'progress' || !p.total) return;
        seen.set(p.file, [p.loaded, p.total]);
        let l = 0, t = 0;
        for (const [a, b] of seen.values()) { l += a; t += b; }
        postMessage({ progress: (l / 1e6).toFixed(0) + ' of ' + (t / 1e6).toFixed(0) + ' MB' });
      };
      pipe = await pipeline('text-generation', data.load, { device: 'webgpu', dtype: data.dtype, progress_callback });
      postMessage({ id: data.id, text: 'ready' });
    } else {
      const out = await pipe(data.messages, { max_new_tokens: 4, do_sample: false });
      postMessage({ id: data.id, text: out[0].generated_text.at(-1).content });
    }
  } catch (err) { postMessage({ id: data.id, error: String(err && err.message || err) }); }
};
`;

export class LocalStrategist {
  /**
   * @param {object} o
   * @param {string} [o.model]     one of LOCAL_MODELS
   * @param {number} [o.every]     seconds between two questions for one bot
   * @param {(messages: object[]) => Promise<string>} [o.generate]  the model, for a test that has none
   * @param {(s: string) => void} [o.onStatus]
   */
  constructor({ model = LOCAL_MODELS[0][0], every = 5, generate = null, onStatus = () => {} } = {}) {
    this.model = model; this.every = every; this.onStatus = onStatus;
    this.generate = generate;
    this.loading = null;
    this.due = new Map(); this.look = 0; this.busy = false; this.stopped = null;
    this.decisions = 0; this.ms = 0;
  }

  /**
   * Fetch the library and the model (once; the browser keeps them), in a Worker of their own: the model's work
   * between two of the GPU's answers is long enough to stall a frame, and the game's loop must not wait for it
   */
  connect() {
    if (this.generate) return Promise.resolve();
    this.loading ??= (async () => {
      const adapter = typeof navigator !== 'undefined' && navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
      if (!adapter) throw new Error('this browser has no WebGPU, which the model needs');
      const [, label, dtype] = LOCAL_MODELS.find(([id]) => id === this.model) ?? [null, this.model, 'q4'];
      const name = label.replace(/ \(.*/, '');
      this.onStatus('loading Transformers.js…');
      const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { type: 'module' });
      const waiting = new Map();
      let n = 0;
      const call = (msg) => new Promise((resolve, reject) => { waiting.set(++n, { resolve, reject }); worker.postMessage({ ...msg, id: n }); });
      worker.onmessage = ({ data }) => {
        if (data.progress) { this.onStatus(`${name}: ${data.progress}`); return; }
        const w = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.error) w?.reject(new Error(data.error)); else w?.resolve(data.text);
      };
      worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'the model\'s worker failed')); waiting.clear(); };
      await call({ load: this.model, dtype, lib: TRANSFORMERS });
      this.generate = (messages) => call({ messages });
      this.onStatus(`${name} ready`);
    })().catch((err) => { this.stopped = err?.message ?? String(err); this.onStatus(`stopped: ${this.stopped}`); });
    return this.loading;
  }

  /** As Strategist.tick: every led bot that is due is offered its moves, the model's word goes back to SQL */
  async tick(db, now = performance.now()) {
    if (this.busy || this.stopped || now < this.look) return;
    this.look = now + Math.min(1000, this.every * 1000);
    this.busy = true;
    try {
      await this.connect();
      if (this.stopped) return;
      const { rows } = await db.query('SELECT eid, bot, txt, words FROM bot_llm_offer');
      for (const r of rows) {
        if ((this.due.get(r.EID) ?? 0) > now) continue;
        this.due.set(r.EID, now + this.every * 1000);
        const t = performance.now();
        const answer = await this.generate(smallMessages(r.TXT, r.WORDS));
        this.ms += performance.now() - t;
        const [a] = (await db.query('SELECT done FROM bot_llm_pick(?, ?)', [r.EID, smallWord(answer, r.WORDS)])).rows;
        this.decisions++;
        this.onStatus(`${r.BOT.trim()}: ${a?.DONE?.trim() ?? '?'} · ${this.decisions} decision${this.decisions === 1 ? '' : 's'}, ${(this.ms / this.decisions).toFixed(0)} ms each`);
      }
    } finally { this.busy = false; }
  }
}
