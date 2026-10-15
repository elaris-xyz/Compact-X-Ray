// Local web UI: paste a contract, get the x-ray. No dependencies beyond Node.
//   npx tsx src/server.ts [--port 4400] [--host 127.0.0.1]
// The compiler runs on this machine, so the server binds to localhost by default.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { xrayProject, type Upload } from './project.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const PORT = Number(arg('port', '4400'));
const HOST = arg('host', '127.0.0.1');
const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const EXAMPLES = path.join(ROOT, 'examples');
const MAX_SOURCE = 256 * 1024;

// Cross-origin use (the GitHub Pages site calling this API): XRAY_CORS=https://owner.github.io
const CORS = process.env['XRAY_CORS'] ?? '';

function send(res: ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...(CORS ? { 'access-control-allow-origin': CORS, 'access-control-allow-headers': 'content-type', 'vary': 'origin' } : {}),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_SOURCE) throw new Error('contract too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listExamples(): { name: string; file: string }[] {
  // A *.compact file is a one-file example; a folder is a multi-file one (main = folder name).
  try {
    return readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((d) => (d.isFile() && d.name.endsWith('.compact')) || d.isDirectory())
      .map((d) => ({ name: d.name.replace(/\.compact$/, ''), file: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// Per-client limit for a public deployment: XRAY_RATE requests per minute (0 = off, the default
// for the localhost UI). Keyed by the first X-Forwarded-For hop when behind a proxy.
const RATE = Number(process.env['XRAY_RATE'] ?? 0);
const hits = new Map<string, number[]>();
function limited(req: IncomingMessage): boolean {
  if (!RATE) return false;
  const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim();
  const now = Date.now();
  const recent = (hits.get(who) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(who, recent);
  return recent.length > RATE;
}

// One compile at a time: the compiler is CPU-heavy and the UI is single-user.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}


const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, readFileSync(path.join(WEB, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && /^\/out\/[\w.-]+\.html$/.test(url.pathname)) {
      // Generated standalone reports (compact-xray … --format html --out out/x.html).
      const f = path.join(ROOT, 'out', path.basename(url.pathname));
      try { return send(res, 200, readFileSync(f), 'text/html; charset=utf-8'); }
      catch { return send(res, 404, 'not found', 'text/plain'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/examples') {
      return send(res, 200, JSON.stringify(listExamples()), 'application/json');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/examples/')) {
      const f = path.basename(url.pathname);
      if (!listExamples().some((e) => e.file === f)) return send(res, 404, 'not found', 'text/plain');
      const p = path.join(EXAMPLES, f);
      if (!f.endsWith('.compact')) {
        const files = readdirSync(p).filter((n) => n.endsWith('.compact')).map((n) => ({ name: n, source: readFileSync(path.join(p, n), 'utf8') }));
        return send(res, 200, JSON.stringify({ main: `${f}.compact`, files }), 'application/json');
      }
      return send(res, 200, readFileSync(p, 'utf8'), 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/xray') {
      if (limited(req)) return send(res, 429, JSON.stringify({ error: 'too many requests, try again in a minute' }), 'application/json');
      const body = JSON.parse(await readBody(req)) as { source?: string; name?: string; deep?: boolean; files?: Upload[] };
      if (typeof body.source !== 'string' || !body.source.trim()) {
        return send(res, 400, JSON.stringify({ error: 'empty contract' }), 'application/json');
      }
      const others = (body.files ?? []).filter((f) => typeof f?.name === 'string' && typeof f?.source === 'string' && f.name !== body.name).slice(0, 32);
      const x = await serial(() => xrayProject({ name: body.name ?? 'contract', source: body.source! }, others, body.deep === true));
      return send(res, 200, JSON.stringify(x), 'application/json');
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: (e as Error).message }), 'application/json');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Compact X-Ray on http://${HOST}:${PORT}`);
});
