// Combines the source reading and the compiler's report into the x-ray: for every exported
// circuit, which private inputs reach the public ledger, how much of them, and through what.
import { readFileSync } from 'node:fs';
import { compileEachWithout, compileForXray, compilerVersion } from './compiler.ts';
import { parseCompilerReport, type Exposure, type RawDisclosure, type DisclosureSource } from './parse.ts';
import { callArgs, callsOf, circuitAt, ledgerFieldAt, readSource, type Circuit, type SourceModel } from './source.ts';

export type Severity = 'info' | 'notice' | 'warning';

export type Leak = {
  circuit: string;            // where it happens ('constructor' included)
  source: DisclosureSource;   // which private value
  sourceType?: string;        // its declared type, when the source says
  exposure: Exposure;         // how much of it
  operation?: string;         // for a computed value: "addition", "multiplication", …
  sink: {
    line: number;
    char: number;
    kind: RawDisclosure['sink']['kind'];
    field?: string;           // ledger sinks: the field read or written
    call?: string;            // stdlib sinks: e.g. sendUnshielded
    reveals?: string;         // stdlib sinks: what the network learns, in the compiler's words
    code: string;
  };
  nature: string;             // the compiler's words
  path: RawDisclosure['path'];
};

export type Advice = { severity: Severity; title: string; detail: string; lines: number[] };

export type Xray = {
  file: string;
  compiler: string;
  compiles: boolean;
  compileErrors: string[];
  /** Where the compiler stopped, when the contract does not compile. */
  compileProblems: { line: number; char: number; message: string }[];
  pragma: string | null;
  ledger: SourceModel['ledger'];
  witnesses: SourceModel['witnesses'];
  circuits: (Circuit & { leaks: number })[];
  leaks: Leak[];
  /** With --deep: every disclose() in the source, and whether the compiler requires it. */
  discloses: { line: number; char: number; needed: boolean }[];
  advice: Advice[];
};

/** "a: Uint<64>, b: Bytes<32>" → { a: 'Uint<64>', b: 'Bytes<32>' } (generics may contain commas). */
function paramTypes(params: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0, cur = '';
  const parts: string[] = [];
  for (const ch of params) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}

/** Types whose every value an observer can try in seconds: hashing them hides nothing. */
function isGuessable(type: string | undefined): boolean {
  if (!type) return false;
  if (/^Boolean$/.test(type)) return true;
  const u = /^Uint<\s*(\d+)\s*>$/.exec(type);
  if (u) return Number(u[1]) <= 32;
  const r = /^Uint<\s*0\s*\.\.\s*(\d+)\s*>$/.exec(type);
  if (r) return Number(r[1]) <= 2 ** 32;
  return false;
}

function typeOf(model: SourceModel, src: DisclosureSource): string | undefined {
  if (src.kind === 'witness') return model.witnesses.find((w) => w.name === src.name)?.returns;
  if (src.circuit) {
    const c = model.circuits.find((x) => x.name === src.circuit);
    return c ? paramTypes(c.params)[src.name] : undefined;
  }
  return undefined;
}

/** "Exception: c.compact line 84 char 86:\n  parse error: …" → { line, char, message }. */
function compileProblems(output: string): Xray['compileProblems'] {
  const out: Xray['compileProblems'] = [];
  for (const block of output.split(/^(?=Exception: )/m)) {
    const m = /^Exception: .*?line (\d+) char (\d+):\s*([\s\S]*)$/.exec(block.trim());
    if (m) out.push({ line: Number(m[1]), char: Number(m[2]), message: m[3]!.replace(/\s+/g, ' ').trim() });
    else if (block.trim()) out.push({ line: 0, char: 0, message: block.replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  return out;
}

export type XrayOptions = { deep?: boolean; concurrency?: number };

export async function xrayFile(file: string, opts: XrayOptions = {}): Promise<Xray> {
  const text = readFileSync(file, 'utf8');
  const model = readSource(text);
  const [{ original, exposed }, compiler] = await Promise.all([
    compileForXray(file, model.code),
    compilerVersion().catch(() => 'unknown'),
  ]);

  const parsed = parseCompilerReport(exposed.output);
  const seen = new Set<string>();
  const leaks: Leak[] = [];
  for (const d of parsed.disclosures) {
    const key = `${d.at.line}:${d.at.char}:${d.source.kind}:${d.source.name}:${d.exposure}:${d.nature}`;
    if (seen.has(key)) continue; // the compiler can report one sink twice (once per branch)
    seen.add(key);
    leaks.push({
      circuit: circuitAt(model, d.at.line)?.name ?? '(top level)',
      source: d.source,
      sourceType: typeOf(model, d.source),
      exposure: d.exposure,
      operation: d.operation,
      sink: {
        line: d.at.line,
        char: d.at.char,
        kind: d.sink.kind,
        field: d.sink.kind === 'ledger' ? ledgerFieldAt(model, d.at.line, d.at.char) : undefined,
        call: d.sink.kind === 'stdlib' ? d.sink.call : undefined,
        reveals: d.sink.kind === 'stdlib' ? d.sink.reveals : undefined,
        code: (model.lines[d.at.line - 1] ?? '').trim(),
      },
      nature: d.nature,
      path: d.path,
    });
  }

  // The compiler names each private input of a hash separately. A guessable input hashed
  // together with a strong secret at the same sink is protected by that secret.
  const strongHashAt = new Set(
    leaks
      .filter((l) => l.exposure === 'hash' && l.sourceType !== undefined && !isGuessable(l.sourceType))
      .map((l) => `${l.sink.line}:${l.sink.char}`),
  );

  const advice: Advice[] = [];
  for (const l of leaks) {
    if (l.exposure === 'hash' && isGuessable(l.sourceType) && !strongHashAt.has(`${l.sink.line}:${l.sink.char}`)) {
      advice.push({
        severity: 'warning',
        lines: [l.sink.line],
        title: `A hash of \`${l.source.name}\` (${l.sourceType}) is public — it can be guessed`,
        detail:
          `\`${l.source.name}\` has few possible values, so anyone can hash each one and compare. ` +
          `Mix in a secret or random salt, e.g. persistentCommit(value, salt).`,
      });
    }
    if (l.exposure === 'value' && l.source.kind === 'witness') {
      advice.push({
        severity: 'notice',
        lines: [l.sink.line],
        title: `Witness \`${l.source.name}\` is published as-is in \`${l.circuit}\``,
        detail: 'Its exact value reaches the ledger. Fine if that is intended; otherwise publish a commitment.',
      });
    }
    if (l.exposure === 'comparison') {
      advice.push({
        severity: 'info',
        lines: [l.sink.line],
        title: `A decision based on \`${l.source.name}\` is visible in \`${l.circuit}\``,
        detail: 'The ledger update depends on a comparison with this private value, so observers learn its outcome.',
      });
    }
  }
  // A computation that reaches public state from ONE private value (and constants or public
  // values) can usually be undone: num1 * num1 gives num1 back.
  const computedAt = new Map<string, Leak[]>();
  for (const l of leaks) {
    if (l.exposure !== 'derived' || l.sink.kind === 'return') continue;
    const k = `${l.circuit}|${l.sink.line}|${l.sink.char}`;
    computedAt.set(k, [...(computedAt.get(k) ?? []), l]);
  }
  for (const group of computedAt.values()) {
    const sources = new Set(group.map((l) => `${l.source.kind}:${l.source.name}`));
    if (sources.size !== 1) continue;
    const l = group[0]!;
    const place = l.sink.kind === 'stdlib' ? `${l.sink.call}()` : `\`${l.sink.field ?? 'the ledger'}\``;
    advice.push({
      severity: 'notice',
      lines: [l.sink.line],
      title: `\`${l.source.name}\` can probably be worked back out of ${place} in \`${l.circuit}\``,
      detail:
        `The public value is the result of ${l.operation ? `a ${l.operation}` : 'a computation'} of this one private value ` +
        '(with constants or public values), and such computations can usually be reversed. Treat it as published, ' +
        'or mix in a secret before it reaches the ledger.',
    });
  }

  // --deep: ask the compiler, one disclose() at a time, whether each is needed. Removing a needed
  // one makes the contract fail to compile; one whose removal still compiles protects nothing.
  const discloses: Xray['discloses'] = [];
  if (opts.deep && original.ok) {
    const calls = callsOf(model, 'disclose');
    const needed = await compileEachWithout(file, text, calls.map((c) => ({ start: c.start, len: 'disclose'.length })), opts.concurrency ?? 4);
    calls.forEach((c, i) => discloses.push({ line: c.line, char: c.char, needed: needed[i]! }));
    const extra = discloses.filter((d) => !d.needed);
    if (extra.length) {
      advice.push({
        severity: 'info',
        lines: extra.map((d) => d.line),
        title: `${extra.length} disclose() call${extra.length === 1 ? ' is' : 's are'} not required by the compiler`,
        detail:
          'Removing each one alone still compiles: the value is already public (a ledger read, a constant, a commitment) or is not ' +
          'disclosed on any path. Harmless, but it can hide which disclose() actually matters.',
      });
    }
  }

  // --- Source rules: patterns the compiler accepts but the Midnight docs warn about. -------------

  // ownPublicKey() returns whatever the prover claims; gating on it authorizes anyone.
  for (const call of callsOf(model, 'ownPublicKey')) {
    let s = call.start;
    while (s > 0 && !';{}'.includes(model.code[s - 1]!)) s--;
    let e = call.end;
    while (e < model.code.length && !';{}'.includes(model.code[e]!)) e++;
    const stmt = model.code.slice(s, e);
    if (/\bassert\s*\(|[=!]=|\bif\s*\(/.test(stmt)) {
      advice.push({
        severity: 'warning',
        lines: [call.line],
        title: '`ownPublicKey()` is used to decide who may act',
        detail:
          'It returns a value the caller chooses, with no binding to a signature, so anyone can pass this check. ' +
          'Prove knowledge of a secret instead: store persistentHash([domain, sk]) and compare it to a hash of a witness-supplied sk.',
      });
    }
  }

  // A commitment with a constant salt is just a hash: same value, same commitment, guessable.
  for (const fn of ['persistentCommit', 'transientCommit']) {
    for (const call of callsOf(model, fn)) {
      const salt = callArgs(model, call)[1] ?? '';
      if (/^(?:pad\s*\(\s*\d+\s*,\s*"\s*"\s*\)|\d+|default\s*<[^>]*>\s*\(\s*\))$/.test(salt)) {
        advice.push({
          severity: 'warning',
          lines: [call.line],
          title: `\`${fn}\` uses a constant salt`,
          detail: 'Equal values give equal commitments, and small values can be guessed. Use a fresh random salt kept in private state.',
        });
      }
    }
  }

  if (!original.ok) {
    advice.unshift({
      severity: 'warning',
      lines: [],
      title: 'The contract does not compile as written',
      detail: 'The leak list below assumes it would; fix the compile errors first.',
    });
  }

  // One entry per distinct finding, with every line it occurs on.
  const merged = new Map<string, Advice>();
  for (const a of advice) {
    const m = merged.get(a.title);
    if (m) m.lines = [...new Set([...m.lines, ...a.lines])].sort((x, y) => x - y);
    else merged.set(a.title, { ...a, lines: [...a.lines] });
  }
  const order: Record<Severity, number> = { warning: 0, notice: 1, info: 2 };

  const counts = new Map<string, number>();
  for (const l of leaks) counts.set(l.circuit, (counts.get(l.circuit) ?? 0) + 1);

  return {
    file,
    compiler,
    compiles: original.ok,
    compileErrors: original.ok ? [] : parseCompilerReport(original.output).otherErrors.concat(
      parseCompilerReport(original.output).disclosures.length ? ['(undeclared disclosures, see leaks)'] : [],
    ),
    compileProblems: original.ok ? [] : compileProblems(original.output),
    pragma: model.pragma,
    ledger: model.ledger,
    witnesses: model.witnesses,
    circuits: model.circuits.map((c) => ({ ...c, leaks: counts.get(c.name) ?? 0 })),
    leaks,
    discloses,
    advice: [...merged.values()].sort((a, b) => order[a.severity] - order[b.severity]),
  };
}
