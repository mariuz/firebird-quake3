// itemweights.js – the bots' item and weapon weights, read as botlib reads them (be_ai_weight.c, ReadWeightConfig):
//
//   botfiles/bots/NAME_c.c    the character: CHARACTERISTIC_ITEMWEIGHTS "bots/NAME_i.c",
//                             CHARACTERISTIC_WEAPONWEIGHTS "bots/NAME_w.c"
//   botfiles/bots/NAME_i.c    the bot's scales (FS_HEALTH, FS_ARMOR, W_*, GWW_*), then #include "fw_items.c"
//   botfiles/bots/NAME_w.c    its gun weights (W_SHOTGUN …), then #include "fw_weap.c"
//   botfiles/fw_items.c       weight "item_…" { switch (INVENTORY_…) { case N: return …; default: … } }
//   botfiles/fw_weap.c        weight "Rocket Launcher" { … } (the gun held, its ammunition, for the lightning
//                             gun the enemy's distance)
//
// A weight is a number or a switch on one inventory value; botlib takes the first `case N` the inventory is
// under (in the file's order), `default` when none is. `balance(w, min, max)` is the weight w (the other two
// bound the interbreeding of the fuzzy weights, which the game never does). Switches nest three deep at most
// in the pak's files. Here each weight becomes rows [cls, o1, v1, b1, o2, v2, b2, o3, v3, b3, w] (o: the case's
// place in its switch, v: the inventory name, b: the case's bound, 1e9 for default; v null below the last
// level), which BOT_ITEM_WEIGHT in sql/bots.sql evaluates against the bot's inventory. A gun's weight is
// stored under the class 'weapon:BIT' (BIT its WP bit).

const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\\n]|\\.)*)"|(\d+(?:\.\d+)?)|(\$?[A-Za-z_][A-Za-z_0-9]*)|(\?|:|<|[-+*/(){},;])/g;

function tokenize(text) {
  const out = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m[1] !== undefined) out.push({ s: m[1] });
    else if (m[2] !== undefined) out.push({ n: Number(m[2]) });
    else if (m[3] !== undefined) out.push({ id: m[3] });
    else if (m[4] !== undefined) out.push({ p: m[4] });
  }
  return out;
}

/** The preprocessor: #include (through `read`), #define (object and function-like), #ifdef/#ifndef/#else/#endif. */
function preprocess(text, read, defines, depth = 0) {
  const out = [];
  const stack = [];   // [active?] per open #if
  const active = () => stack.every(Boolean);
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    const d = line.match(/^\s*#\s*(\w+)\s*(.*)$/);
    if (!d) { if (active()) out.push(line); continue; }
    const [, dir, rest] = d;
    if (dir === 'ifdef') stack.push(defines.has(rest.trim()));
    else if (dir === 'ifndef') stack.push(!defines.has(rest.trim()));
    else if (dir === 'else') stack.push(!stack.pop());
    else if (dir === 'endif') stack.pop();
    else if (!active()) continue;
    else if (dir === 'include' && depth < 4) {
      const name = rest.match(/"([^"]+)"/)?.[1];
      const inc = name ? read(name) : null;
      if (inc) out.push(preprocess(inc, read, defines, depth + 1));
    } else if (dir === 'define') {
      const fm = rest.match(/^(\w+)\(([^)]*)\)\s*(.*)$/);
      if (fm) defines.set(fm[1], { params: fm[2].split(',').map((p) => p.trim()), body: tokenize(fm[3]) });
      else {
        const om = rest.match(/^(\w+)\s*(.*)$/);
        if (om) defines.set(om[1], { body: tokenize(om[2]) });
      }
    }
  }
  return out.join('\n');
}

/** Macros expanded in a token list (object-like and function-like, a few levels deep). */
function expand(tk, defines, depth = 0) {
  if (depth > 8) return tk;
  const out = [];
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i], def = t.id && defines.get(t.id);
    if (!def) { out.push(t); continue; }
    if (!def.params) { out.push(...expand(def.body, defines, depth + 1)); continue; }
    if (tk[i + 1]?.p !== '(') { out.push(t); continue; }
    // the arguments, split at the top level's commas
    const args = [[]];
    let level = 0, j = i + 2;
    for (; j < tk.length; j++) {
      const a = tk[j];
      if (a.p === '(') level++;
      else if (a.p === ')') { if (level === 0) break; level--; }
      else if (a.p === ',' && level === 0) { args.push([]); continue; }
      args[args.length - 1].push(a);
    }
    const body = def.body.flatMap((b) => {
      const k = b.id ? def.params.indexOf(b.id) : -1;
      return k >= 0 ? [{ p: '(' }, ...(args[k] ?? []), { p: ')' }] : [b];
    });
    out.push(...expand(body, defines, depth + 1));
    i = j;
  }
  return out;
}

/** An expression's value: numbers, + - * /, <, ?:, parentheses, balance(w, …) = w and $evalfloat(x) = x. */
function evaluate(tk) {
  let i = 0;
  const peek = () => tk[i], next = () => tk[i++];
  const primary = () => {
    const t = next();
    if (!t) return 0;
    if (t.n !== undefined) return t.n;
    if (t.p === '-') return -primary();
    if (t.p === '(') { const v = ternary(); if (peek()?.p === ')') i++; return v; }
    if (t.id && peek()?.p === '(') {
      i++;
      const args = [ternary()];
      while (peek()?.p === ',') { i++; args.push(ternary()); }
      if (peek()?.p === ')') i++;
      return args[0];      // balance(w, min, max) and $evalfloat(x)
    }
    return 0;              // an unknown name
  };
  const mul = () => { let v = primary(); while (peek()?.p === '*' || peek()?.p === '/') v = next().p === '*' ? v * primary() : v / primary(); return v; };
  const add = () => { let v = mul(); while (peek()?.p === '+' || peek()?.p === '-') v = next().p === '+' ? v + mul() : v - mul(); return v; };
  const cmp = () => { const v = add(); if (peek()?.p === '<') { i++; return v < add() ? 1 : 0; } return v; };
  const ternary = () => { const c = cmp(); if (peek()?.p !== '?') return c; i++; const a = ternary(); if (peek()?.p === ':') i++; const b = ternary(); return c ? a : b; };
  return ternary();
}

/** The weights of a preprocessed file: Map cls → node (a number, or { v, cases: [[bound, node]] } with 1e9 for default). */
export function parseWeights(text, defines) {
  const tk = tokenize(text);
  let i = 0;
  const stmt = () => {
    const t = tk[i];
    if (t?.p === '{') { i++; const s = stmt(); while (tk[i] && tk[i].p !== '}') i++; i++; return s; }
    if (t?.id === 'return') {
      i++;
      const start = i;
      while (tk[i] && tk[i].p !== ';') i++;
      const v = evaluate(expand(tk.slice(start, i), defines));
      i++;
      return v;
    }
    if (t?.id === 'switch') {
      i += 2;              // switch (
      const v = tk[i++].id;
      i += 2;              // ) {
      const cases = [];
      while (tk[i] && tk[i].p !== '}') {
        if (tk[i].id === 'case') { const b = tk[i + 1].n; i += 3; cases.push([b, stmt()]); }
        else if (tk[i].id === 'default') { i += 2; cases.push([1e9, stmt()]); }
        else i++;
      }
      i++;
      return { v, cases };
    }
    i++;
    return 0;
  };
  const out = new Map();
  while (i < tk.length) {
    if (tk[i].id === 'weight' && tk[i + 1]?.s !== undefined) {
      const cls = tk[i + 1].s;
      i += 2;
      out.set(cls, stmt());
    } else i++;
  }
  return out;
}

/** A weight node as rows [o1, v1, b1, o2, v2, b2, o3, v3, b3, w], three levels (deeper switches weigh 0). */
function rowsOf(node) {
  const out = [];
  const walk = (n, path) => {
    if (typeof n === 'number' || path.length >= 3) {
      const levels = [...path];
      while (levels.length < 3) levels.push([0, null, 1e9]);
      out.push([...levels.flat(), typeof n === 'number' ? n : 0]);
      return;
    }
    n.cases.forEach(([b, sub], o) => walk(sub, [...path, [o, n.v, b]]));
  };
  walk(node, []);
  return out;
}

// fw_weap.c's weight names and the guns' WP bits
const WEAPON_BITS = { Gauntlet: 1, Machinegun: 2, Shotgun: 4, 'Grenade Launcher': 8, 'Rocket Launcher': 16, 'Lightning Gun': 32, Railgun: 64, 'Plasma Gun': 128, BFG10K: 256 };

/** Every bot's item and weapon weights: rows [bot, cls, o1, v1, b1, o2, v2, b2, o3, v3, b3, w]. */
export function loadItemWeights(pak, bots) {
  const read = (n) => { try { return pak.text(`botfiles/${n}`); } catch { return null; } };
  const out = [];
  for (const b of bots) {
    const base = b.name.toLowerCase();
    const ch = read(`bots/${base}_c.c`) ?? '';
    for (const [key, fallback, weapons] of [['ITEMWEIGHTS', `bots/${base}_i.c`, false], ['WEAPONWEIGHTS', `bots/${base}_w.c`, true]]) {
      const file = ch.match(new RegExp(`CHARACTERISTIC_${key}\\s+"([^"]+)"`))?.[1] ?? fallback;
      const text = read(file);
      if (!text) continue;
      const defines = new Map();
      const weights = parseWeights(preprocess(text, read, defines), defines);
      for (const [name, node] of weights) {
        const cls = weapons ? (WEAPON_BITS[name] ? `weapon:${WEAPON_BITS[name]}` : null) : name;
        if (cls) for (const r of rowsOf(node)) out.push([b.name, cls, ...r]);
      }
    }
  }
  return out;
}

/** A node's weight for an inventory (botlib's FuzzyWeight_r), for the tests. */
export function weightOf(node, inv) {
  if (typeof node === 'number') return node;
  for (const [b, sub] of node.cases) if ((inv[node.v] ?? 0) < b) return weightOf(sub, inv);
  return 0;
}

export { preprocess };
