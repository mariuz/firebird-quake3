// sql-check.mjs – compile every SQL file into a fresh engine and report the
// first error tersely (statement head + Firebird's message).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirebirdBrowser, DirectTransport } from 'firebird-wasm/browser';
import { loaderSql, SQL_FILES } from '../src/loader.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new FirebirdBrowser('memory://check', { transport: new DirectTransport() });
for (const f of SQL_FILES) {
  const text = f === 'schema' ? fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8') + '\n' + loaderSql() : fs.readFileSync(path.join(root, `sql/${f}.sql`), 'utf8');
  const t0 = performance.now();
  try {
    await db.exec(text);
    console.log(`ok   ${f}.sql (${(performance.now() - t0).toFixed(0)} ms)`);
  } catch (e) {
    const m = e.message;
    const head = m.split('\n')[0].slice(0, 300);
    const detail = m.split('\n').filter((l) => l.startsWith('-')).join('\n');
    console.log(`FAIL ${f}.sql\n${head}\n${detail}`);
    process.exit(1);
  }
}
await db.close();
process.exit(0);
