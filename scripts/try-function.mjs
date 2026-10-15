// Exercise the Vercel function locally with a fake request/response (needs vendor/compactc.bin).
//   node scripts/try-function.mjs examples/private-bid.compact [--deep]
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? 'examples/private-bid.compact';
const { default: handler } = await import('../api/xray.mjs');

function call(method, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; },
      end() { resolve({ status: this.statusCode }); return this; },
    };
    handler({ method, headers: { 'x-forwarded-for': '1.2.3.4' }, body }, res);
  });
}

console.log('GET  ->', (await call('GET')).status);
console.log('empty->', (await call('POST', { source: '' })).status);
const t = Date.now();
const r = await call('POST', { name: path.basename(file), source: readFileSync(file, 'utf8'), deep: process.argv.includes('--deep') });
const x = r.body;
console.log(`POST -> ${r.status} in ${Date.now() - t}ms: compiler ${x.compiler}, ${x.leaks?.length} disclosures, ${x.plain?.length} sentences, error=${x.error ?? 'none'}`);
