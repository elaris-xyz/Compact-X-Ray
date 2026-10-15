// Build the static site (GitHub Pages): landing page, the X-Ray app, and every bundled example
// pre-analysed so the site works with no server. Live analysis of a pasted contract needs the API
// (XRAY_API, e.g. a Vercel deployment); without it the app shows the examples only.
//
//   npx tsx scripts/build-site.ts [outDir=site]
//   XRAY_API=https://…  XRAY_REPO=https://github.com/owner/repo  npx tsx scripts/build-site.ts
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compilerVersion } from '../src/compiler.ts';
import { xrayProject, type ProjectXray, type Upload } from '../src/project.ts';
import { renderHtml } from '../src/report-html.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'site'));
const API = process.env['XRAY_API'] ?? '';
const REPO = process.env['XRAY_REPO'] ?? 'https://github.com/elaris-xyz/Compact-X-Ray';
const ACTION = process.env['XRAY_ACTION'] ?? `${REPO.replace('https://github.com/', '')}@v0`;
const VERSION = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

type Example = { name: string; main: Upload; others: Upload[] };

function examples(): Example[] {
  const dir = path.join(ROOT, 'examples');
  const out: Example[] = [];
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) {
      const files = readdirSync(p).filter((f) => f.endsWith('.compact')).map((f) => ({ name: f, source: readFileSync(path.join(p, f), 'utf8') }));
      const main = files.find((f) => f.name === `${n}.compact`) ?? files[0]!;
      out.push({ name: n, main, others: files.filter((f) => f !== main) });
    } else if (n.endsWith('.compact')) {
      out.push({ name: n.replace(/\.compact$/, ''), main: { name: n, source: readFileSync(p, 'utf8') }, others: [] });
    }
  }
  return out;
}

function card(e: Example, x: ProjectXray): string {
  const pub = x.plain.find((p) => p.tone === 'public') ?? x.plain[0];
  const warnings = x.advice.filter((a) => a.severity === 'warning').length;
  const extra = x.discloses.filter((d) => !d.needed).length;
  return `<div class="ex"><h3>${esc(e.name)}</h3>
    <p>${pub ? md(pub.text) : 'Nothing private is published.'}</p>
    <div class="stats"><span><b>${x.ledger.length}</b> public fields</span><span><b>${x.leaks.length}</b> disclosures</span><span><b>${warnings}</b> warnings</span>${extra ? `<span><b>${extra}</b> extra disclose()</span>` : ''}</div>
    <div class="links"><a href="app/?example=${encodeURIComponent(e.name)}">Open in the X-Ray →</a><a href="reports/${encodeURIComponent(e.name)}.html">Standalone report</a></div></div>`;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  for (const d of ['app', 'reports', 'examples']) mkdirSync(path.join(OUT, d), { recursive: true });

  const list = examples();
  const cards: string[] = [];
  let extraTotal = 0;
  for (const e of list) {
    process.stderr.write(`x-ray ${e.name}… `);
    const x = await xrayProject(e.main, e.others, true);
    process.stderr.write(`${x.leaks.length} disclosures\n`);
    if (!x.compiles) throw new Error(`${e.name} does not compile:\n${x.compileErrors.join('\n')}`);
    extraTotal += x.discloses.filter((d) => !d.needed).length;
    writeFileSync(path.join(OUT, 'reports', `${e.name}.json`), JSON.stringify(x));
    writeFileSync(path.join(OUT, 'reports', `${e.name}.html`), renderHtml(x));
    cards.push(card(e, x));
  }
  writeFileSync(path.join(OUT, 'examples', 'index.json'), JSON.stringify(list.map((e) => ({ name: e.name, file: e.name }))));
  cpSync(path.join(ROOT, 'examples'), path.join(OUT, 'examples'), { recursive: true });

  const config = `<script>window.XRAY_CONFIG = ${JSON.stringify({ static: '..', api: API })};</script>\n`;
  const app = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8').replace('<script>', `${config}<script>`);
  writeFileSync(path.join(OUT, 'app', 'index.html'), app);

  const compiler = await compilerVersion();
  const landing = readFileSync(path.join(ROOT, 'web', 'landing.html'), 'utf8')
    .replaceAll('{{REPO}}', REPO)
    .replaceAll('{{ACTION}}', ACTION)
    .replaceAll('{{VERSION}}', VERSION)
    .replaceAll('{{COMPILER}}', compiler)
    .replaceAll('{{DATE}}', new Date().toISOString().slice(0, 10))
    .replaceAll('{{EXTRA}}', String(extraTotal))
    .replace('{{GALLERY}}', cards.join('\n'));
  writeFileSync(path.join(OUT, 'index.html'), landing);
  writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log(`site: ${list.length} examples, ${extraTotal} unnecessary disclose(), api=${API || '(none)'} -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
