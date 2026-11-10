// chat.js – the embedding of what the player types to the bots (sql/chat.sql matches it to an intent by
// meaning): EmbeddingGemma 2, its text model alone at 4 bits (175 MB, kept by the browser after the first
// time), run by Transformers.js on WebGPU, which it needs. Both are fetched only when
// the player asks for it; without them a phrase has to be typed word for word. Nothing here decides what a
// line means: it turns the text into numbers and hands them on.
import { EMBED_PREFIX, EMBED_DIMS, EMBED_MODEL } from './intents.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
let model = null, tok = null, loading = null;

export const embedderReady = () => model !== null;

/** Fetch the library and the model (once); onStatus gets a line of progress */
export function loadEmbedder(onStatus = () => {}) {
  loading ??= (async () => {
    onStatus('loading Transformers.js…');
    const url = LIB;   // (a URL the bundler leaves alone)
    const { AutoConfig, AutoModel, AutoTokenizer } = await import(url);
    const config = await AutoConfig.from_pretrained(EMBED_MODEL);
    config.vision_config = config.audio_config = null;   // the text model alone
    const seen = new Map();
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      seen.set(p.file, [p.loaded, p.total]);
      let l = 0, t = 0;
      for (const [a, b] of seen.values()) { l += a; t += b; }
      onStatus(`EmbeddingGemma 2: ${(l / 1e6).toFixed(0)} of ${(t / 1e6).toFixed(0)} MB`);
    };
    // WebGPU it has to be: the model's 4-bit and 8-bit builds keep the embedding table quantized, for which
    // onnxruntime's WebAssembly backend has no kernel (and the full-precision build is 1 GB). A browser can have
    // the API and no adapter, so ask for one
    const adapter = typeof navigator !== 'undefined' && navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (!adapter) throw new Error('this browser has no WebGPU, which the model needs');
    const m = await AutoModel.from_pretrained(EMBED_MODEL, { config, device: 'webgpu', dtype: 'q4', progress_callback });
    tok = await AutoTokenizer.from_pretrained(EMBED_MODEL);
    model = m;
    onStatus('EmbeddingGemma 2 ready');
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

/** The text's embedding as player_say takes it: the leading dimensions, normalized, separated by commas */
export async function embed(text) {
  const { sentence_embedding } = await model(await tok([EMBED_PREFIX + text]));
  const v = Array.from(sentence_embedding.tolist()[0].slice(0, EMBED_DIMS));
  const n = Math.hypot(...v) || 1;
  return v.map((x) => (x / n).toFixed(6)).join(',');
}
