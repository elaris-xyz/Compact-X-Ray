// Vercel function: POST /api/xray — the same analysis the local server does, for the hosted site.
// The Compact compiler binary is copied into vendor/ at build time (scripts/vercel-build.sh) and
// moved to /tmp on cold start, the one place a function may mark a file executable.
import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { register } from 'tsx/esm/api';

register();

const BIN = '/tmp/compactc.bin';
if (!existsSync(BIN)) {
  copyFileSync(path.join(process.cwd(), 'vendor', 'compactc.bin'), BIN);
  chmodSync(BIN, 0o755);
}
process.env.XRAY_COMPACTC = BIN;
process.env.XRAY_COMPILE_TIMEOUT_MS ??= '45000';

const { xrayProject } = await import('../src/project.ts');

const MAX_SOURCE = 256 * 1024;
const RATE = Number(process.env.XRAY_RATE ?? 20); // per client per minute, per warm instance
const hits = new Map();

function limited(req) {
  const who = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'anon';
  const now = Date.now();
  const recent = (hits.get(who) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(who, recent);
  return recent.length > RATE;
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  // The GitHub Pages site calls this API cross-origin; XRAY_CORS overrides the allowed origin.
  res.setHeader('access-control-allow-origin', process.env.XRAY_CORS ?? 'https://elaris-xyz.github.io');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('vary', 'origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST a contract to /api/xray' });
  if (limited(req)) return res.status(429).json({ error: 'too many requests, try again in a minute' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const source = body.source;
  if (typeof source !== 'string' || !source.trim()) return res.status(400).json({ error: 'empty contract' });
  const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f?.name === 'string' && typeof f?.source === 'string').slice(0, 32) : [];
  const size = source.length + files.reduce((n, f) => n + f.source.length, 0);
  if (size > MAX_SOURCE) return res.status(413).json({ error: 'contract too large' });

  try {
    const x = await xrayProject({ name: String(body.name ?? 'contract'), source }, files, body.deep === true);
    return res.status(200).json(x);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
