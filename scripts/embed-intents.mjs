// embed-intents.mjs – the phrases of src/intents.js embedded with EmbeddingGemma 2 (the model the page loads for
// what the player types: onnx-community/embeddinggemma-2-ONNX, its text model alone, 4-bit) into
// src/intentvecs.js, and a set of test lines with their embeddings into scripts/say-fixtures.json for
// scripts/chat-test.mjs (which runs without the model).
//
//   npm i --no-save @huggingface/transformers@4.3.2     (not a dependency: 175 MB of model come with the first run)
//   node scripts/embed-intents.mjs [dir with node_modules/@huggingface/transformers]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTENTS, EMBED_PREFIX, EMBED_DIMS, EMBED_MODEL } from '../src/intents.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(path.resolve(process.argv[2] ?? root), 'x.js'));
const { AutoConfig, AutoModel, AutoTokenizer } = await import(pathToFileURL(req.resolve('@huggingface/transformers')).href);
const config = await AutoConfig.from_pretrained(EMBED_MODEL);
config.vision_config = config.audio_config = null;   // the text model alone
const model = await AutoModel.from_pretrained(EMBED_MODEL, { config, device: 'cpu', dtype: 'q4' });
const tok = await AutoTokenizer.from_pretrained(EMBED_MODEL);
const embed = async (texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const { sentence_embedding } = await model(await tok(texts.slice(i, i + 16).map((t) => EMBED_PREFIX + t), { padding: true }));
    for (const v of sentence_embedding.tolist()) {
      const u = v.slice(0, EMBED_DIMS), n = Math.hypot(...u);
      out.push(u.map((x) => Math.round((x / n) * 1e6) / 1e6));
    }
  }
  return out;
};
const vecs = await embed(INTENTS.flatMap((it) => it.phrases));
const head = fs.readFileSync(path.join(root, 'src/intentvecs.js'), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 1).join('\n');
fs.writeFileSync(path.join(root, 'src/intentvecs.js'),
  `${head}\n// EmbeddingGemma 2, 4-bit, the leading ${EMBED_DIMS} dimensions normalized). Generated\nexport const INTENT_VECS = [\n${vecs.map((v) => `  [${v.join(',')}],`).join('\n')}\n];\n`);

// what a player might type, none of it a phrase of the list, and what should be understood
const TESTS = [
  ['Sarge, follow me please', 'accompany'], ['everyone on me', 'accompany'], ['venez avec moi', 'accompany'], ['Grunt stick with me', 'accompany'],
  ['guard this room', 'camp'], ['Major camp right here', 'camp'],
  ['ok you can leave now', 'dismiss'], ['stop', 'dismiss'],
  ['kill Daemia', 'kill'], ['go frag Grunt', 'kill'],
  ['where r u', 'whereareyou'], ['Sarge where are you now', 'whereareyou'],
  ['whatcha doing Grunt?', 'whatareyoudoing'],
  ['hey', 'hello'], ['you are bad at this', 'taunt'], ['nice one!', 'praise'],
  ['somebody grab the rail', 'get', 'weapon_railgun'], ['go get the red armour', 'get', 'item_armor_body'], ['need quad', 'get', 'item_quad'],
  ['take the plasma', 'get', 'weapon_plasmagun'], ['i need health', 'get', 'item_health'], ['Sarge fetch the rocket launcher', 'get', 'weapon_rocketlauncher'],
  ['my cat sat on the keyboard', null], ['it is raining outside', null], ['brb', null],
];
const tv = await embed(TESTS.map((t) => t[0]));
fs.writeFileSync(path.join(root, 'scripts/say-fixtures.json'), JSON.stringify(TESTS.map(([text, kind, arg], i) => ({ text, kind, arg: arg ?? null, vec: tv[i] }))));
console.log(`${vecs.length} phrases of ${INTENTS.length} intents → src/intentvecs.js; ${TESTS.length} test lines → scripts/say-fixtures.json`);
process.exit(0);
