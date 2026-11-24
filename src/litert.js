// litert.js – the bots' network run by LiteRT.js (Google's runtime for LiteRT, once TensorFlow Lite, models in the
// browser: XNNPACK compiled to WebAssembly, or WebGPU) instead of by the join in SQL (bot_nn_best). The network is
// the same one, src/botnn.js's rows of [layer, unit, input, weight]: it is written here as LiteRT.js's own tensor
// functions (fullyConnected, relu) and compiled by the runtime, so there is no .tflite file to keep in step with
// the weights. The page only does the arithmetic: the bots ask and choose in SQL (bot_nn_request, bot_nn_answer).
//
// The library is a file of its own (dist/litert-core.js, built by scripts/build.mjs) with its WebAssembly beside
// it (dist/litert/), fetched only by who turns this on.

/** The weights' rows as layers of a dense network: [{ n units, m inputs, W (n × m, row a unit), B (n) }] */
export function denseLayers(rows) {
  const layers = [];
  for (const [l, j, i] of rows) {
    const L = (layers[l - 1] ??= { n: 0, m: 0 });
    L.n = Math.max(L.n, j + 1); L.m = Math.max(L.m, i + 1);
  }
  for (const L of layers) { L.W = new Float32Array(L.n * L.m); L.B = new Float32Array(L.n); }
  for (const [l, j, i, w] of rows) { const L = layers[l - 1]; if (i < 0) L.B[j] = w; else L.W[j * L.m + i] = w; }
  return layers;
}

/** The network's forward pass written out (ReLU on the hidden layers): what LiteRT.js's answer is checked against */
export function forward(layers, x) {
  let h = x;
  layers.forEach((L, k) => {
    const o = new Array(L.n);
    for (let j = 0; j < L.n; j++) {
      let s = L.B[j];
      for (let i = 0; i < L.m; i++) s += L.W[j * L.m + i] * h[i];
      o[j] = k < layers.length - 1 ? Math.max(0, s) : s;
    }
    h = o;
  });
  return h;
}

/** How many bots' features go through the network at once (fewer are padded, more go in turns) */
export const NET_BATCH = 8;

/**
 * The bots' network on LiteRT.js. `load()` fetches the library and its WebAssembly, writes the network and compiles
 * it for NET_BATCH rows of features; `values(rows)` gives each row's outputs.
 */
export class BotNet {
  /** @param rows src/botnn.js's rows @param opts { lib: the library's module or its URL, wasm: the directory of its
   *  WebAssembly, accelerator: 'wasm' (the default: this network is far too small to be worth a trip to the
   *  graphics card) or 'webgpu' } */
  constructor(rows, opts = {}) {
    this.layers = denseLayers(rows);
    this.inputs = this.layers[0]?.m ?? 0;
    this.outputs = this.layers[this.layers.length - 1]?.n ?? 0;
    this.opts = opts;
    this.model = null;
    this.ms = 0;       // the last run's time
    this.runs = 0;
  }

  async load() {
    const o = this.opts;
    const lib = typeof o.lib === 'object' && o.lib ? o.lib : await import(/* @vite-ignore */ o.lib ?? new URL('./litert-core.js', import.meta.url).href);
    this.lib = lib;
    // (one runtime a page: a second load is refused)
    globalThis.__litert ??= lib.loadLiteRt(o.wasm ?? new URL('./litert/', import.meta.url).href);
    await globalThis.__litert;
    const consts = this.layers.map((L) => [new lib.Tensor(L.W, [L.n, L.m]), new lib.Tensor(L.B, [L.n])]);
    this.model = lib.author((x) => {
      let h = x;
      consts.forEach(([W, B], k) => { h = lib.fullyConnected(h, W, B); if (k < consts.length - 1) h = lib.relu(h); });
      return h;
    }, { accelerator: o.accelerator ?? 'wasm' });
    await this.model.compile({ shape: [NET_BATCH, this.inputs] });
    // the runtime's network against the pass written out, once: a wrong answer is no answer
    const probe = Array.from({ length: this.inputs }, (_, i) => ((i * 7) % 5) / 4);
    const [got] = await this.values([probe]), want = forward(this.layers, probe);
    this.error = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
    if (!(this.error < 1e-2)) throw new Error(`LiteRT.js gives another answer than the network written out (off by ${this.error})`);
    return this;
  }

  /** The network's outputs for each row of features (arrays of `inputs` numbers): arrays of `outputs` numbers */
  async values(rows) {
    const { lib, model, inputs, outputs } = this;
    const out = [], t0 = performance.now();
    for (let at = 0; at < rows.length; at += NET_BATCH) {
      const x = new Float32Array(NET_BATCH * inputs);
      const n = Math.min(NET_BATCH, rows.length - at);
      for (let b = 0; b < n; b++) for (let i = 0; i < inputs; i++) x[b * inputs + i] = Number(rows[at + b][i]) || 0;
      const input = new lib.Tensor(x, [NET_BATCH, inputs]);
      let res = await model.run(input);
      input.delete();
      if (Array.isArray(res)) res = res[0];
      const cpu = await res.moveTo('wasm');
      const y = cpu.toTypedArray();
      for (let b = 0; b < n; b++) out.push(Array.from(y.subarray(b * outputs, (b + 1) * outputs)));
      if (cpu !== res) res.delete?.();
      cpu.delete();
    }
    this.ms = performance.now() - t0;
    this.runs++;
    return out;
  }
}

/** The statements that hand the network's values for the bots that asked back to the game (bot_nn_answer), one a bot */
export function answerSql(asks, values) {
  const num = (v) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0');
  return asks.map((eid, i) => `EXECUTE PROCEDURE bot_nn_answer(${eid | 0}, ${values[i].map(num).join(', ')})`);
}
