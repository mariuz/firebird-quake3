// rl-deep.mjs – the bots' fight moves learned by a network, offline, from the moves logged in self-play
// (scripts/rl-train.mjs with LOG=1 writes them: the features of the fight, the move, its reward, the move that
// followed). The game makes about five such moves a second, so the learning has to reuse each many times:
//
//   Double DQN (van Hasselt et al. 2016): the target for Q(s, a) is r + γ Q_target(s′, argmax_a′ Q(s′, a′)), the
//     online network choosing the next move and a slowly following copy rating it, which keeps plain DQN's
//     overestimates down;
//   a conservative penalty (CQL, Kumar et al. 2020): α (log Σ_a exp Q(s, a) − Q(s, a_logged)), which pushes down
//     the values of moves the log has little of in a state: with a fixed log, an untried move is otherwise
//     rated by guesswork and chosen for it;
//   Huber loss, Adam, minibatches drawn again and again from the whole log (experience replay).
//
// The network is a perceptron, 12 → 48 → 48 → 6, small enough to run in SQL (bot_nn_best in sql/bots.sql). No
// library: forward and backward passes below.
//
//   node scripts/rl-deep.mjs <out.json> a.log.json b.log.json …     (WRITE=1: also into src/botnn.js)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [out, ...files] = process.argv.slice(2);
const NF = 12, NA = 6, H = Number(process.env.HIDDEN) || 48, GAMMA = 0.8, RS = 25;   // (rewards in units of 25 health)
const STEPS = Number(process.env.STEPS) || 40000, BATCH = 128, LR = 1e-3, SYNC = 500, CQL = Number(process.env.CQL ?? 0.5);

// the transitions: [x, a, r, x′ or null]
const data = [];
for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  const byId = new Map(rows.map((r) => [r[0], r]));
  for (const r of rows) {
    const nxt = r[15] === null ? null : byId.get(r[15]);
    if (r[15] !== null && !nxt) continue;   // (the move that followed was still running when the log was written)
    data.push([r.slice(1, 13), r[13], r[14] / RS, nxt ? nxt.slice(1, 13) : null]);
  }
}
let seed = 12345;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
for (let i = data.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [data[i], data[j]] = [data[j], data[i]]; }
const nVal = Math.floor(data.length / 10), val = data.slice(0, nVal), train = data.slice(nVal);
console.log(`${data.length} moves (${data.filter((d) => d[3] === null).length} ending a fight), by move ${Array.from({ length: NA }, (_, a) => data.filter((d) => d[1] === a).length).join(' ')}; mean reward ${(data.reduce((s, d) => s + d[2], 0) / data.length * RS).toFixed(2)} health`);

// the network: layers of { w: out × in, b: out }
const sizes = [NF, H, H, NA];
const make = () => sizes.slice(1).map((n, l) => ({ n, m: sizes[l], w: Float64Array.from({ length: n * sizes[l] }, () => gauss() * Math.sqrt(2 / sizes[l])), b: new Float64Array(n) }));
const copy = (net) => net.map((L) => ({ ...L, w: L.w.slice(), b: L.b.slice() }));
const forward = (net, x) => {
  const acts = [x];
  let a = x;
  net.forEach((L, l) => {
    const o = new Float64Array(L.n);
    for (let j = 0; j < L.n; j++) { let s = L.b[j]; const row = j * L.m; for (let i = 0; i < L.m; i++) s += L.w[row + i] * a[i]; o[j] = l < net.length - 1 && s < 0 ? 0 : s; }
    acts.push(o); a = o;
  });
  return acts;
};
const net = make();
let target = copy(net);
const adam = net.map((L) => ({ mw: new Float64Array(L.w.length), vw: new Float64Array(L.w.length), mb: new Float64Array(L.n), vb: new Float64Array(L.n) }));
const argmax = (v) => { let k = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i; return k; };
const tdTarget = ([, , r, x2]) => {
  if (!x2) return r;
  const on = forward(net, x2).at(-1), tg = forward(target, x2).at(-1);
  return r + GAMMA * tg[argmax(on)];
};
let step = 0;
for (; step < STEPS; step++) {
  const gw = net.map((L) => new Float64Array(L.w.length)), gb = net.map((L) => new Float64Array(L.n));
  for (let k = 0; k < BATCH; k++) {
    const tr = train[Math.floor(rnd() * train.length)];
    const acts = forward(net, tr[0]), q = acts.at(-1);
    // the output's gradient: the Huber loss on the logged move, the conservative penalty on all
    const g = new Float64Array(NA);
    const e = q[tr[1]] - tdTarget(tr);
    g[tr[1]] = Math.max(-1, Math.min(1, e));
    if (CQL > 0) {
      const mx = Math.max(...q); let z = 0;
      for (let a = 0; a < NA; a++) z += Math.exp(q[a] - mx);
      for (let a = 0; a < NA; a++) g[a] += CQL * (Math.exp(q[a] - mx) / z - (a === tr[1] ? 1 : 0));
    }
    // back through the layers
    let d = g;
    for (let l = net.length - 1; l >= 0; l--) {
      const L = net[l], inp = acts[l], prev = new Float64Array(L.m);
      for (let j = 0; j < L.n; j++) {
        const dj = d[j];
        if (dj === 0) continue;
        gb[l][j] += dj;
        const row = j * L.m;
        for (let i = 0; i < L.m; i++) { gw[l][row + i] += dj * inp[i]; prev[i] += dj * L.w[row + i]; }
      }
      if (l > 0) for (let i = 0; i < L.m; i++) if (inp[i] <= 0) prev[i] = 0;   // (ReLU)
      d = prev;
    }
  }
  const t = step + 1, c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
  net.forEach((L, l) => {
    const A = adam[l];
    for (let i = 0; i < L.w.length; i++) { const gi = gw[l][i] / BATCH; A.mw[i] = 0.9 * A.mw[i] + 0.1 * gi; A.vw[i] = 0.999 * A.vw[i] + 0.001 * gi * gi; L.w[i] -= LR * (A.mw[i] / c1) / (Math.sqrt(A.vw[i] / c2) + 1e-8); }
    for (let i = 0; i < L.n; i++) { const gi = gb[l][i] / BATCH; A.mb[i] = 0.9 * A.mb[i] + 0.1 * gi; A.vb[i] = 0.999 * A.vb[i] + 0.001 * gi * gi; L.b[i] -= LR * (A.mb[i] / c1) / (Math.sqrt(A.vb[i] / c2) + 1e-8); }
  });
  if (t % SYNC === 0) target = copy(net);
  if (t % 5000 === 0) {
    const td = val.reduce((s, tr) => s + Math.abs(forward(net, tr[0]).at(-1)[tr[1]] - tdTarget(tr)), 0) / val.length;
    console.log(`step ${t}: held-out TD error ${(td * RS).toFixed(2)} health`);
  }
}

// what it would do in the logged states: Quake III's move unless another is 3 health or more above it
const picks = new Array(NA).fill(0);
for (const tr of data) {
  const q = forward(net, tr[0]).at(-1);
  let best = 5;
  for (let a = 0; a < 5; a++) if (q[a] * RS >= q[5] * RS + 3 && (best === 5 || q[a] > q[best])) best = a;
  picks[best]++;
}
console.log(`in the logged states it would advance ${picks[0]}, strafe ${picks[1]} + ${picks[2]}, back off ${picks[3]}, hold ${picks[4]}, keep Quake III's move ${picks[5]} (${(picks[5] * 100 / data.length).toFixed(0)}%)`);

// rows of [layer, unit, input (-1: the bias), weight], the output in health points
const rows = [];
net.forEach((L, l) => {
  const k = l === net.length - 1 ? RS : 1;
  for (let j = 0; j < L.n; j++) {
    rows.push([l + 1, j, -1, Math.round(L.b[j] * k * 1e6) / 1e6]);
    for (let i = 0; i < L.m; i++) rows.push([l + 1, j, i, Math.round(L.w[j * L.m + i] * k * 1e6) / 1e6]);
  }
});
fs.writeFileSync(out, JSON.stringify(rows));
if (process.env.WRITE === '1') {
  const file = path.join(root, 'src/botnn.js');
  const head = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n');
  fs.writeFileSync(file, `${head}\nexport const BOT_NN = ${JSON.stringify(rows).replace(/\],\[/g, '],\n[')};\n`);
}
console.log(`${rows.length} weights → ${out}`);
