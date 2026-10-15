#!/usr/bin/env -S npx tsx
// compact-xray — what a Midnight Compact contract makes public, from the compiler itself.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { xrayFile, type Xray } from './analyze.ts';
import { checkPolicy, diffXrays, policyFrom, POLICY_FILE, readPolicy, writePolicy, type Diff, type PolicyCheck } from './policy.ts';
import { renderHtml } from './report-html.ts';
import { renderMarkdown } from './report-md.ts';
import { renderSarif } from './report-sarif.ts';
import { renderText } from './report-text.ts';
import { explain } from './explain.ts';

const VERSION = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

const HELP = `compact-xray ${VERSION} — see what a Compact contract makes public

usage
  compact-xray <contract.compact>               report what becomes public
  compact-xray check <contract.compact>         fail if a disclosure is not in the privacy policy
  compact-xray init <contract.compact>          write the current disclosures as the policy
  compact-xray diff <before.compact> <after.compact>   what a change makes newly public

options
  --format text|json|md|sarif|html   output format (default text)
  --out <file>                       write the output to a file instead of stdout
  --policy <file>                    policy file (default: .xray.json next to the contract)
  --fail-on warning|notice|never     also fail on advice of this severity (default: never; check: warning)
  --deep                             also ask the compiler, one by one, which disclose() calls are needed

exit codes
  0 ok · 1 findings that fail the run (or the contract does not compile) · 2 usage or tool error

The Compact compiler must be on PATH (or set COMPACT_BIN). Findings come from compiling the
contract with every disclose() removed: the compiler then names each private value that would
reach the public side, how much of it, and through which path.`;

type Opts = { format: string; out?: string; policy?: string; failOn: string; deep: boolean };

function parseArgs(argv: string[]): { cmd: string; files: string[]; opts: Opts } {
  const opts: Opts = { format: 'text', failOn: '', deep: false };
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => { const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`); return v; };
    if (a === '--format' || a === '-f') opts.format = val();
    else if (a === '--json') opts.format = 'json';
    else if (a === '--out' || a === '-o') opts.out = val();
    else if (a === '--policy') opts.policy = val();
    else if (a === '--fail-on') opts.failOn = val();
    else if (a === '--deep') opts.deep = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  const cmd = ['check', 'init', 'diff'].includes(files[0] ?? '') ? files.shift()! : 'report';
  return { cmd, files, opts };
}

function emit(opts: Opts, text: string) {
  if (opts.out) {
    writeFileSync(opts.out, text.endsWith('\n') ? text : `${text}\n`);
    console.error(`compact-xray: wrote ${opts.out}`);
  } else {
    console.log(text);
  }
}

function render(x: Xray, opts: Opts, extra: { check?: PolicyCheck; diff?: Diff } = {}): string {
  switch (opts.format) {
    case 'json': return JSON.stringify({ ...x, plain: explain(x), policy: policyFrom(x), ...extra }, null, 2);
    case 'md': case 'markdown': return renderMarkdown(x, extra);
    case 'sarif': return renderSarif(x, extra.check, VERSION);
    case 'html': return renderHtml({ ...x, source: readFileSync(x.file, 'utf8') });
    case 'text': return renderText(x, extra);
    default: throw new Error(`unknown format ${opts.format}`);
  }
}

function adviceFails(x: Xray, failOn: string): boolean {
  if (failOn === 'warning') return x.advice.some((a) => a.severity === 'warning');
  if (failOn === 'notice') return x.advice.some((a) => a.severity !== 'info');
  return false;
}

function policyPath(file: string, opts: Opts): string {
  return opts.policy ?? path.join(path.dirname(file), POLICY_FILE);
}

async function main(): Promise<number> {
  const { cmd, files, opts } = parseArgs(process.argv.slice(2));
  if (!files.length || (cmd === 'diff' && files.length < 2)) {
    console.error(HELP);
    return 2;
  }
  for (const f of files) if (!existsSync(f)) throw new Error(`no such file: ${f}`);

  if (cmd === 'init') {
    const x = await xrayFile(files[0]!, { deep: opts.deep });
    if (!x.compiles) throw new Error('the contract does not compile; fix it before writing a policy');
    const p = policyPath(files[0]!, opts);
    writePolicy(p, policyFrom(x));
    console.error(`compact-xray: wrote ${p} with ${policyFrom(x).allow.length} allowed disclosure(s). Review it, then commit it.`);
    return 0;
  }

  if (cmd === 'diff') {
    const [before, after] = await Promise.all([xrayFile(files[0]!, { deep: opts.deep }), xrayFile(files[1]!)]);
    const diff = diffXrays(before, after);
    emit(opts, render(after, opts, { diff }));
    return after.compiles && !diff.added.length ? 0 : 1;
  }

  const x = await xrayFile(files[0]!, { deep: opts.deep });
  if (cmd === 'check') {
    const p = policyPath(files[0]!, opts);
    if (!existsSync(p)) throw new Error(`no policy at ${p}; create one with: compact-xray init ${files[0]}`);
    const check = checkPolicy(x, readPolicy(p));
    emit(opts, render(x, opts, { check }));
    return x.compiles && !check.unexpected.length && !adviceFails(x, opts.failOn || 'warning') ? 0 : 1;
  }

  emit(opts, render(x, opts));
  return x.compiles && !adviceFails(x, opts.failOn) ? 0 : 1;
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(`compact-xray: ${e.message}`);
  process.exit(2);
});
