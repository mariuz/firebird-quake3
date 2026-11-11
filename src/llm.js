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
