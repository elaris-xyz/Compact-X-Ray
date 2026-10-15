// Markdown report: for pull-request comments and the GitHub Actions job summary.
import path from 'node:path';
import type { Xray } from './analyze.ts';
import { fingerprints, type Diff, type PolicyCheck } from './policy.ts';
import { explain } from './explain.ts';

const WORD = { value: 'exact value', hash: 'hash', comparison: 'decision', derived: 'derived' } as const;
const ICON = { warning: '🔴', notice: '🟡', info: '🔵' } as const;

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function renderMarkdown(x: Xray, opts: { check?: PolicyCheck; diff?: Diff } = {}): string {
  const out: string[] = [];
  const name = path.basename(x.file);
  const warnings = x.advice.filter((a) => a.severity === 'warning').length;
  const status = !x.compiles ? '❌ does not compile'
    : opts.check?.unexpected.length ? `❌ ${opts.check.unexpected.length} disclosure(s) not in the privacy policy`
    : warnings ? `⚠️ ${warnings} warning(s)` : '✅ no unexpected disclosures';

  out.push(`### 🩻 Compact X-Ray — \`${name}\``);
  out.push(`${status} · ${x.leaks.length} disclosure point(s) · compiler \`${x.compiler}\`${x.pragma ? ` · language \`${x.pragma}\`` : ''}`);
  out.push('');
  if (!x.compiles) {
    out.push('The contract must compile before anything can be said about what it makes public:');
    out.push('');
    for (const p of x.compileProblems ?? []) out.push(`- ${p.line ? `line ${p.line}: ` : ''}${p.message}`);
    return out.join('\n');
  }

  if (opts.check?.unexpected.length) {
    out.push('**New or unapproved disclosures** — add them to `.xray.json` if intended:');
    out.push('');
    for (const u of opts.check.unexpected) out.push(`- \`${u.fingerprint}\` (line ${u.lines.join(', ')})`);
    out.push('');
  }
  if (opts.check?.unused.length) {
    out.push(`<details><summary>${opts.check.unused.length} policy entr${opts.check.unused.length === 1 ? 'y' : 'ies'} no longer needed</summary>\n`);
    for (const u of opts.check.unused) out.push(`- \`${u}\``);
    out.push('\n</details>\n');
  }
  if (opts.diff) {
    out.push(`**Change vs. base:** ${opts.diff.added.length} newly public, ${opts.diff.removed.length} no longer public.`);
    for (const a of opts.diff.added) out.push(`- ➕ \`${a}\``);
    for (const r of opts.diff.removed) out.push(`- ➖ \`${r}\``);
    out.push('');
  }

  out.push('**In plain words**');
  out.push('');
  for (const e of explain(x)) out.push(`- ${e.tone === 'public' ? '🟠' : '🟢'} ${e.text}`);
  out.push('');

  if (x.advice.length) {
    out.push('**Advice**');
    out.push('');
    for (const a of x.advice) out.push(`- ${ICON[a.severity]} ${a.title}${a.lines.length ? ` (line ${a.lines.join(', ')})` : ''}`);
    out.push('');
  }

  out.push('<details><summary>What becomes public, circuit by circuit</summary>\n');
  out.push('| Circuit | Private value | Becomes public in | As | Lines |');
  out.push('|---|---|---|---|---|');
  for (const [, v] of fingerprints(x)) {
    const l = v.leak;
    const src = l.source.kind === 'witness' ? `witness \`${l.source.name}\`` : `\`${l.source.name}\``;
    const sink = l.sink.kind === 'stdlib' ? `\`${l.sink.call}()\` — ${cell(l.sink.reveals ?? '')}`
      : l.sink.kind === 'return' ? 'return value' : `ledger \`${l.sink.field ?? '?'}\``;
    out.push(`| \`${l.circuit}\` | ${src} | ${sink} | ${WORD[l.exposure]} | ${v.lines.join(', ')} |`);
  }
  out.push('\n</details>');
  return out.join('\n');
}
