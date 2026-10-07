// botchat.js – Quake III's bot chat files, read as botlib reads them (be_ai_chat.c, be_ai_char.c):
//
//   botfiles/rnd.c            the random strings: NAME = { message; message; … }
//   botfiles/bots/NAME_t.c    a bot's chat lines: chat "name" { type "game_enter" { message; … } … }
//   botfiles/bots/NAME_c.c    its character: skill N { CHARACTERISTIC_CHAT_KILL 0.5 … } for some skills
//
// A message is pieces joined by commas: literal text, a number (a variable, filled by the game: the
// opponent's name, the weapon, the map's title…) or a name (a random string of rnd.c, which may hold
// more of both). Here a message becomes one template string, the variables written {0} … {7} and the
// random strings {r:NAME}; the SQL (BOT_SAY in sql/bots.sql) draws and fills them. Preprocessor lines
// (#include "teamplay.h", the team chats) are skipped: there are no teams.

function tokens(text) {
  const out = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|^[ \t]*#[^\n]*|"((?:[^"\\\n]|\\.)*)"|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|([{}();,=])/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) out.push({ s: m[1].replace(/\\(.)/g, '$1') });
    else if (m[2] !== undefined) out.push({ n: Number(m[2]) });
    else if (m[3] !== undefined) out.push({ id: m[3] });
    else if (m[4] !== undefined) out.push({ p: m[4] });
  }
  return out;
}

/** The messages of a { … } block from tokens[i] (just past the brace): [messages, index past the closing brace]. */
function messages(tk, i) {
  const out = [];
  let cur = '', parts = 0;
  const flush = () => { if (parts) out.push(cur); cur = ''; parts = 0; };
  for (; i < tk.length; i++) {
    const t = tk[i];
    if (t.p === '}') { flush(); return [out, i + 1]; }
    if (t.p === ';') { flush(); continue; }
    if (t.p === ',') continue;
    if (t.s !== undefined) { cur += t.s.replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')); parts++; }
    else if (t.n !== undefined) { cur += `{${t.n}}`; parts++; }
    else if (t.id !== undefined) { cur += `{r:${t.id}}`; parts++; }
  }
  flush();
  return [out, i];
}

/** rnd.c: Map name → [message] */
export function parseRandomStrings(text) {
  const tk = tokens(text), out = new Map();
  for (let i = 0; i < tk.length; i++) {
    if (tk[i].id && tk[i + 1]?.p === '=' && tk[i + 2]?.p === '{') {
      const [msgs, next] = messages(tk, i + 3);
      out.set(tk[i].id, msgs);
      i = next - 1;
    }
  }
  return out;
}

/** a bot's chat file: Map type → [message] */
export function parseChatFile(text) {
  const tk = tokens(text), out = new Map();
  for (let i = 0; i < tk.length; i++) {
    if (tk[i].id === 'type' && tk[i + 1]?.s !== undefined && tk[i + 2]?.p === '{') {
      const [msgs, next] = messages(tk, i + 3);
      out.set(tk[i + 1].s, [...(out.get(tk[i + 1].s) ?? []), ...msgs]);
      i = next - 1;
    }
  }
  return out;
}

/** a character file: Map skill → { KEY: value } */
export function parseCharacter(text) {
  const tk = tokens(text), out = new Map();
  for (let i = 0; i < tk.length; i++) {
    if (tk[i].id === 'skill' && tk[i + 1]?.n !== undefined && tk[i + 2]?.p === '{') {
      const block = {};
      let j = i + 3;
      for (; j < tk.length && tk[j].p !== '}'; j++) {
        if (tk[j].id && tk[j + 1] && (tk[j + 1].n !== undefined || tk[j + 1].s !== undefined)) { block[tk[j].id] = tk[j + 1].n ?? tk[j + 1].s; j++; }
      }
      out.set(tk[i + 1].n, block);
      i = j;
    }
  }
  return out;
}

/** The character at a skill: the block of that skill, else interpolated between the nearest defined
 *  ones below and above (BotInterpolateCharacters), else the nearest. */
export function characterAtSkill(blocks, skill) {
  if (blocks.has(skill)) return blocks.get(skill);
  const defined = [...blocks.keys()].sort((a, b) => a - b);
  if (!defined.length) return {};
  const lo = defined.filter((s) => s < skill).pop(), hi = defined.find((s) => s > skill);
  if (lo === undefined) return blocks.get(hi);
  if (hi === undefined) return blocks.get(lo);
  const a = blocks.get(lo), b = blocks.get(hi), f = (skill - lo) / (hi - lo), out = {};
  for (const k of Object.keys(a)) out[k] = typeof a[k] === 'number' && typeof b[k] === 'number' ? a[k] + (b[k] - a[k]) * f : a[k];
  return out;
}

const CHAT_KEYS = ['INSULT', 'MISC', 'STARTENDLEVEL', 'ENTEREXITGAME', 'KILL', 'DEATH', 'ENEMYSUICIDE', 'HITTALKING', 'HITNODEATH', 'HITNOKILL', 'RANDOM', 'REPLY', 'CPM'];

/** Everything the SQL needs for the bots of `bots` ([{ name }]): rows for BOT_RND, BOT_CHAT and BOT_CHATCHAR. */
export function loadBotChat(pak, bots) {
  const rnd = [], chat = [], chars = [];
  const text = (n) => { try { return pak.text(n); } catch { return null; } };
  const r = text('botfiles/rnd.c');
  if (r) for (const [name, msgs] of parseRandomStrings(r)) msgs.forEach((m, i) => rnd.push([name, i, m]));
  for (const b of bots) {
    const base = b.name.toLowerCase();
    const c = text(`botfiles/bots/${base}_c.c`);
    if (!c) continue;
    const blocks = parseCharacter(c);
    const any = blocks.values().next().value ?? {};
    const chatFile = text(`botfiles/${any.CHARACTERISTIC_CHAT_FILE ?? `bots/${base}_t.c`}`);
    if (chatFile) for (const [type, msgs] of parseChatFile(chatFile)) msgs.forEach((m, i) => chat.push([b.name, type, i, m]));
    for (let s = 1; s <= 5; s++) {
      const ch = characterAtSkill(blocks, s);
      for (const k of CHAT_KEYS) if (typeof ch[`CHARACTERISTIC_CHAT_${k}`] === 'number') chars.push([b.name, s, k.toLowerCase(), ch[`CHARACTERISTIC_CHAT_${k}`]]);
    }
  }
  return { rnd, chat, chars };
}
