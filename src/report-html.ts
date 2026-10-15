// Standalone HTML report: the web UI with the result baked in (no server, no compiler needed
// to view it). Good for attaching to an audit or a CI artifact.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Xray } from './analyze.ts';
import { explain } from './explain.ts';

export function renderHtml(x: Xray & { source: string }): string {
  const page = readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const data = JSON.stringify({ ...x, plain: explain(x) }).replace(/</g, '\\u003c');
  return page.replace('<script>', `<script>window.__XRAY__ = ${data};</script>\n<script>`);
}
