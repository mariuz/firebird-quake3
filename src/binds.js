// binds.js – the keys: which key does what (Quake III's bind and its Controls menu). An action is one of Quake
// III's commands (+forward, +attack, weapon 5 …); each has the keys bound to it, two at most as the menu shows
// them, and a key does one thing. The page keeps what the player changed in its settings; main.js turns a key
// that goes down into its action and knows nothing of the keys themselves. Mouse buttons and the wheel are keys
// here as there: Mouse0, Mouse1, Mouse2, WheelUp, WheelDown.

/** The actions: [id, what it is in words, Quake III's command, the keys bound to it at first] */
export const ACTIONS = [
  ['forward', 'Walk forward', '+forward', ['KeyW', 'ArrowUp']],
  ['back', 'Backpedal', '+back', ['KeyS', 'ArrowDown']],
  ['moveleft', 'Step left', '+moveleft', ['KeyA', 'Comma']],
  ['moveright', 'Step right', '+moveright', ['KeyD', 'Period']],
  ['left', 'Turn left', '+left', ['ArrowLeft']],
  ['right', 'Turn right', '+right', ['ArrowRight']],
  ['lookup', 'Look up', '+lookup', ['PageUp']],
  ['lookdown', 'Look down', '+lookdown', ['PageDown']],
  ['moveup', 'Jump', '+moveup', ['Space', 'KeyE']],
  ['movedown', 'Crouch', '+movedown', ['KeyC']],
  ['speed', 'Walk', '+speed', ['ShiftLeft', 'ShiftRight']],
  ['attack', 'Attack', '+attack', ['Mouse0', 'ControlLeft']],
  ['zoom', 'Zoom view', '+zoom', ['Mouse2', 'KeyZ']],
  ['weapnext', 'Next weapon', 'weapnext', ['WheelDown', 'Slash']],
  ['weapprev', 'Previous weapon', 'weapprev', ['WheelUp']],
  ['weapon1', 'Gauntlet', 'weapon 1', ['Digit1']],
  ['weapon2', 'Machinegun', 'weapon 2', ['Digit2']],
  ['weapon3', 'Shotgun', 'weapon 3', ['Digit3']],
  ['weapon4', 'Grenade launcher', 'weapon 4', ['Digit4']],
  ['weapon5', 'Rocket launcher', 'weapon 5', ['Digit5']],
  ['weapon6', 'Lightning gun', 'weapon 6', ['Digit6']],
  ['weapon7', 'Railgun', 'weapon 7', ['Digit7']],
  ['weapon8', 'Plasma gun', 'weapon 8', ['Digit8']],
  ['weapon9', 'BFG', 'weapon 9', ['Digit9']],
  ['useitem', 'Use item', '+button2', ['Enter', 'KeyH']],
  ['scores', 'Show scores', '+scores', ['Tab']],
  ['chat', 'Say', 'messagemode', ['KeyT', 'KeyY']],
  ['pause', 'Pause', 'pause', ['KeyP', 'Pause']],
  ['give', 'Give all (a cheat)', 'give all', ['KeyG']],
];
// (more keys that did these before there was a choice: they go on doing so until bound to something else)
const EXTRA = { attack: ['ControlRight', 'KeyF'] };
const IDS = new Set(ACTIONS.map((a) => a[0]));
/** The keys that are never bound: they are the page's or the browser's */
const RESERVED = new Set(['Escape', 'F5', 'F9', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ContextMenu']);

/** Bindings: a Map of key code → action id. `saved` is what a player changed ({ action: [codes] }), or nothing */
export function makeBinds(saved = null) {
  const binds = new Map();
  for (const [id, , , keys] of ACTIONS) {
    const mine = Array.isArray(saved?.[id]) ? saved[id].filter((c) => typeof c === 'string' && !RESERVED.has(c)).slice(0, 2) : [...keys, ...(EXTRA[id] ?? [])];
    for (const code of mine) if (!binds.has(code)) binds.set(code, id);
  }
  return binds;
}

/** The keys of an action, in the order they were bound */
export const keysOf = (binds, action) => [...binds].filter(([, a]) => a === action).map(([code]) => code);

/** What the player changed, to keep: { action: [codes] } for the actions whose keys are not those of the start */
export function savedBinds(binds) {
  const fresh = makeBinds(), out = {};
  for (const [id] of ACTIONS) {
    const now = keysOf(binds, id), was = keysOf(fresh, id);
    if (now.length !== was.length || now.some((c, i) => c !== was[i])) out[id] = now;
  }
  return out;
}

/**
 * Bind a key to an action, as the Controls menu does: the key leaves whatever it did; an action that has two
 * keys already starts again with this one alone. Returns false for a key that cannot be bound or an action
 * there is not.
 */
export function bind(binds, action, code) {
  if (!IDS.has(action) || typeof code !== 'string' || !code || RESERVED.has(code)) return false;
  binds.delete(code);
  const mine = keysOf(binds, action);
  if (mine.length >= 2) for (const c of mine) binds.delete(c);
  binds.set(code, action);
  return true;
}

/** Take every key off an action (the menu's Backspace) */
export function unbind(binds, action) {
  for (const c of keysOf(binds, action)) binds.delete(c);
}

/** A key's name as the menu would show it: "W", "Up Arrow", "Left Ctrl", "Mouse 1", "Wheel Down" */
export function keyName(code) {
  const fixed = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', PageUp: 'Page Up', PageDown: 'Page Down', CapsLock: 'Caps Lock',
    WheelUp: 'Wheel Up', WheelDown: 'Wheel Down', Pause: 'Pause', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End' }[code];
  if (fixed) return fixed;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return `Keypad ${m[1]}`;
  if ((m = /^Arrow(Up|Down|Left|Right)$/.exec(code))) return `${m[1]} Arrow`;
  if ((m = /^(Control|Shift|Alt)(Left|Right)$/.exec(code))) return `${m[2]} ${m[1] === 'Control' ? 'Ctrl' : m[1]}`;
  // (Quake III's MOUSE2 is the right button, the browser's button 2; its MOUSE3 the middle one, button 1)
  if ((m = /^Mouse(\d)$/.exec(code))) return `Mouse ${{ 1: 3, 2: 2 }[m[1]] ?? Number(m[1]) + 1}`;
  return code;
}

/** The code of a mouse button or a turn of the wheel, as the keys' are */
export const mouseCode = (button) => `Mouse${button}`;
export const wheelCode = (deltaY) => (deltaY > 0 ? 'WheelDown' : 'WheelUp');
