// Plain-language terminal report.
import path from 'node:path';
import type { Exposure } from './parse.ts';
import type { Xray } from './analyze.ts';
import type { Diff, PolicyCheck } from './policy.ts';
import { explain } from './explain.ts';

const EXPOSURE: Record<Exposure, string> = {
  value: 'the exact value',
  hash: 'a hash of it',
  comparison: 'the result of a comparison with it',
  derived: 'the result of a computation with it',
};

const tty = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36');

function argNames(params: string): string[] {
  return [...params.matchAll(/([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]!);
}

export function renderText(x: Xray, extra: { check?: PolicyCheck; diff?: Diff } = {}): string {
  const out: string[] = [];
  const say = (s = '') => out.push(s);

  say(bold(`Compact X-Ray — ${path.basename(x.file)}`) + dim(`   compiler ${x.compiler}${x.pragma ? `, language ${x.pragma}` : ''}`));
  if (!x.compiles) {
    say(red('  ✗ does not compile — fix this first; nothing below can be known until it does:'));
    for (const p of (x.compileProblems ?? []).slice(0, 5)) say(`    ${p.line ? `line ${p.line}:${p.char}  ` : ''}${p.message}`);
    if (!(x.compileProblems ?? []).length) for (const e of x.compileErrors.slice(0, 5)) say(dim(`    ${e.split('\n')[0]}`));
    return out.join('\n');
  }
  say();

  if (extra.check) {
    const k = extra.check;
    say(bold('PRIVACY POLICY'));
    if (!k.unexpected.length) say(green(`  ✓ all ${k.allowed} disclosure(s) are in the policy`));
    for (const u of k.unexpected) say(red(`  ✗ not in policy: ${u.fingerprint}`) + dim(`   line ${u.lines.join(', ')}`));
    for (const u of k.unused) say(dim(`  · no longer needed: ${u}`));
    say();
  }
  if (extra.diff) {
    const d = extra.diff;
    say(bold('CHANGE'));
    if (!d.added.length && !d.removed.length) say(green('  ✓ nothing new becomes public'));
    for (const a of d.added) say(red(`  + newly public: ${a}`));
    for (const r of d.removed) say(green(`  - no longer public: ${r}`));
    say();
  }

  say(bold('IN PLAIN WORDS'));
  for (const e of explain(x)) {
    const mark = e.tone === 'public' ? yellow('●') : green('●');
    say(`  ${mark} ${e.text.replace(/`/g, '')}`);
  }
  say();

  say(bold('PUBLIC — on the ledger, readable by anyone'));
  if (!x.ledger.length) say(dim('  (no ledger fields)'));
  for (const f of x.ledger) {
    const tags = [f.sealed ? 'sealed: set only at deploy' : '', f.exported ? '' : 'not exported (still public on-chain)']
      .filter(Boolean).join('; ');
    say(`  ${cyan(f.name)}: ${f.type}${tags ? dim(`   ${tags}`) : ''}`);
  }
  say();

  say(bold('PRIVATE INPUTS — stay on the user\'s device unless disclosed'));
  for (const w of x.witnesses) say(`  witness ${cyan(w.name)}(${w.params}): ${w.returns}`);
  for (const ci of x.circuits.filter((k) => k.exported && k.params.trim())) {
    say(`  ${ci.name === 'constructor' ? 'constructor' : `circuit ${ci.name}`} arguments: ${argNames(ci.params).map(cyan).join(', ')}`);
  }
  say();

  say(bold('WHAT BECOMES PUBLIC, circuit by circuit'));
  const exported = x.circuits.filter((k) => k.exported);
  // Helpers are listed when a disclosure happens inside them (on behalf of their callers).
  const shown = x.circuits.filter((k) => k.exported || k.leaks > 0);
  for (const ci of shown) {
    const mine = x.leaks.filter((l) => l.circuit === ci.name);
    say(`  ${bold(ci.name)}${ci.pure ? dim(' (pure)') : ''}${ci.exported ? '' : dim(' (helper — runs inside the circuits that call it)')}`);
    if (!mine.length) {
      say(green('    nothing private reaches the ledger'));
      continue;
    }
    // Merge repeated sinks of the same value into one line with all its line numbers.
    const groups = new Map<string, { label: string; lines: number[] }>();
    for (const l of mine) {
      const what = l.source.kind === 'witness' ? `witness ${l.source.name}` : l.source.name;
      const where = l.sink.kind === 'stdlib'
        ? `${l.sink.call}() — reveals ${l.sink.reveals}`
        : l.sink.kind === 'return' ? 'returned to the caller (not in the transaction)'
        : l.sink.field ? `ledger ${l.sink.field}` : 'a ledger operation';
      const how = l.exposure === 'value' ? yellow(EXPOSURE[l.exposure])
        : l.exposure === 'derived' && l.operation ? `the result of ${/^[aeiou]/.test(l.operation) ? 'an' : 'a'} ${l.operation} with it`
        : EXPOSURE[l.exposure];
      const key = `${what}|${where}|${l.exposure}`;
      const g = groups.get(key) ?? {
        label: l.sink.kind === 'stdlib' ? `${cyan(what)} → ${where} ${dim(`(${EXPOSURE[l.exposure]})`)}` : `${cyan(what)} → ${where}: ${how}`,
        lines: [],
      };
      g.lines.push(l.sink.line);
      groups.set(key, g);
    }
    for (const g of groups.values()) say(`    • ${g.label}${dim(`   line ${[...new Set(g.lines)].join(', ')}`)}`);
  }
  say();

  const never: string[] = [];
  const onChain = x.leaks.filter((l) => l.sink.kind !== 'return'); // returns stay with the caller
  for (const ci of exported) {
    for (const a of argNames(ci.params)) {
      if (!onChain.some((l) => l.circuit === ci.name && l.source.name === a)) never.push(`${ci.name}(${a})`);
    }
  }
  for (const w of x.witnesses) if (!onChain.some((l) => l.source.kind === 'witness' && l.source.name === w.name)) never.push(`witness ${w.name}`);
  if (never.length) {
    say(bold('STAYS PRIVATE — never reaches the ledger in any form the compiler tracks'));
    for (const n of never) say(green(`  ✓ ${n}`));
    say(dim('  (commitments made with persistentCommit/transientCommit are by design not reported)'));
    say();
  }

  if (x.advice.length) {
    say(bold('ADVICE'));
    for (const a of x.advice) {
      const mark = a.severity === 'warning' ? red('!') : a.severity === 'notice' ? yellow('•') : dim('i');
      say(`  ${mark} ${a.title}${a.lines.length ? dim(`   line ${a.lines.join(', ')}`) : ''}`);
      say(dim(`    ${a.detail}`));
    }
    say();
  }

  say(dim('Exact value: readable by anyone. Hash: hides it only if hard to guess. Decision: one yes/no per call.'));
  say(dim('Computation (e.g. num1 + num2): not the value itself, but often reversible — treat it as published.'));
  say(dim('Returned values go back to the calling DApp. Measured on a local network (ledger 8): they are not in the'));
  say(dim('published transaction, even when the compiler asks for disclose() on them.'));
  return out.join('\n');
}
