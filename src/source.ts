// A small, position-preserving reader for Compact source. It does not parse the language;
// it finds the top-level declarations the report needs (ledger fields, witnesses, circuits
// and their line ranges) and answers "what name sits at this line/char".
//
// Positions follow the compiler: 1-based line, 1-based char.

export type LedgerField = { name: string; type: string; exported: boolean; sealed: boolean; line: number };
export type Witness = { name: string; params: string; returns: string; line: number };
export type Circuit = {
  name: string;           // 'constructor' for the constructor
  params: string;
  returns: string;        // '' for the constructor
  exported: boolean;
  pure: boolean;
  startLine: number;
  endLine: number;
};

export type SourceModel = {
  text: string;           // original text
  code: string;           // same length, comments and string contents blanked
  lines: string[];        // original lines
  codeLines: string[];    // blanked lines
  pragma: string | null;
  ledger: LedgerField[];
  witnesses: Witness[];
  circuits: Circuit[];
};

/** Blank comments and string contents with spaces, keeping every offset and newline. */
export function blankNonCode(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && n === '*') {
      out[i] = out[i + 1] = ' ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < src.length) out[i] = out[i + 1] = ' ';
      i += 2;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { out[i++] = ' '; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (code[i] === '\n') line++;
  return line;
}

/** Index just past the bracket that closes the one at `open` (handles (), <>, {}, []). */
function matchClose(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };
  const want = pairs[code[open]!]!;
  const first = code[open]!;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === first) depth++;
    else if (code[i] === want) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function readSource(text: string): SourceModel {
  const code = blankNonCode(text);
  const model: SourceModel = {
    text,
    code,
    lines: text.split('\n'),
    codeLines: code.split('\n'),
    pragma: null,
    ledger: [],
    witnesses: [],
    circuits: [],
  };

  const pragma = /pragma\s+language_version\s+([^;]+);/.exec(code);
  if (pragma) model.pragma = squash(text.slice(pragma.index + pragma[0].indexOf(pragma[1]!), pragma.index + pragma[0].length - 1));

  for (const m of code.matchAll(/\b(export\s+)?(sealed\s+)?ledger\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g)) {
    model.ledger.push({
      name: m[3]!,
      type: squash(text.slice(m.index! + m[0].lastIndexOf(m[4]!), m.index! + m[0].length - 1)),
      exported: !!m[1],
      sealed: !!m[2],
      line: lineOf(code, m.index!),
    });
  }

  for (const m of code.matchAll(/\b(?:export\s+)?witness\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchClose(code, open);
    const semi = code.indexOf(';', close);
    const ret = code.slice(close, semi).replace(/^\s*:/, '');
    model.witnesses.push({
      name: m[1]!,
      params: squash(text.slice(open + 1, close - 1)),
      returns: squash(ret),
      line: lineOf(code, m.index!),
    });
  }

  const decl = /\b(export\s+)?(pure\s+)?circuit\s+([A-Za-z_]\w*)\s*(<[^(]*>)?\s*\(|\bconstructor\s*\(/g;
  for (const m of code.matchAll(decl)) {
    const open = m.index! + m[0].length - 1;
    const close = matchClose(code, open);
    const brace = code.indexOf('{', close);
    const semi = code.indexOf(';', close);
    if (brace < 0 || (semi >= 0 && semi < brace)) continue; // a declaration without a body
    const end = matchClose(code, brace);
    const isCtor = m[0].trimStart().startsWith('constructor');
    model.circuits.push({
      name: isCtor ? 'constructor' : m[3]!,
      params: squash(text.slice(open + 1, close - 1)),
      returns: isCtor ? '' : squash(text.slice(close, brace).replace(/^\s*:/, '')),
      exported: isCtor ? true : !!m[1],
      pure: !!m[2],
      startLine: lineOf(code, m.index!),
      endLine: lineOf(code, end - 1),
    });
  }
  return model;
}

export type Span = { start: number; end: number; line: number; char: number };

/** Offset of a 1-based line/char in the file. */
export function offsetOf(model: SourceModel, line: number, char: number): number {
  let o = 0;
  for (let i = 0; i < line - 1 && i < model.codeLines.length; i++) o += model.codeLines[i]!.length + 1;
  return o + Math.max(0, char - 1);
}

function posOf(code: string, offset: number): { line: number; char: number } {
  let line = 1, last = -1;
  for (let i = 0; i < offset; i++) if (code[i] === '\n') { line++; last = i; }
  return { line, char: offset - last };
}

/** Every call of `name(…)` in code, with the span of the whole call including its argument list. */
export function callsOf(model: SourceModel, name: string): Span[] {
  const out: Span[] = [];
  for (const m of model.code.matchAll(new RegExp(`\\b${name}\\s*(?:<[^()]*>)?\\s*\\(`, 'g'))) {
    const open = m.index! + m[0].length - 1;
    out.push({ start: m.index!, end: matchClose(model.code, open), ...posOf(model.code, m.index!) });
  }
  return out;
}

/** The text of a call's arguments, split at top-level commas. */
export function callArgs(model: SourceModel, span: Span): string[] {
  const inner = model.code.slice(model.code.indexOf('(', span.start) + 1, span.end - 1);
  const args: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    // `<` opens a generic only right after a name (`Vector<2, T>`), never in `a < b`.
    const generic = ch === '<' && /\w/.test(inner[i - 1] ?? '');
    if ('([{'.includes(ch) || generic) depth++;
    if (')]}'.includes(ch) || (ch === '>' && depth > 0 && /[\w>\s]/.test(inner[i - 1] ?? ''))) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** The circuit whose body contains `line`, innermost first. */
export function circuitAt(model: SourceModel, line: number): Circuit | undefined {
  return model.circuits
    .filter((c) => c.startLine <= line && line <= c.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

/**
 * The ledger field a compiler "sink" position refers to. The compiler points at the `.` of
 * `field.op(...)` or at the operator of `field = …` / `field += …`; both have the field's name
 * immediately to the left (possibly after a chain like `m.lookup(k).insert`).
 */
export function ledgerFieldAt(model: SourceModel, line: number, char: number): string | undefined {
  const fields = new Set(model.ledger.map((f) => f.name));
  if (!fields.size || model.codeLines[line - 1] === undefined) return undefined;
  // Offset of the sink in the whole file.
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += model.codeLines[i]!.length + 1;
  offset += Math.max(0, char - 1);
  // The statement the sink belongs to starts after the previous `;`, `{` or `}`.
  let start = offset;
  while (start > 0 && !';{}'.includes(model.code[start - 1]!)) start--;
  const stmt = model.code.slice(start, offset + 1);
  // 1) `field = …`, `field += …` at the start of the statement (also covers `x = cond ? a : b`).
  const assign = /^\s*([A-Za-z_]\w*)\s*(?:[-+]?=)(?!=)/.exec(stmt);
  if (assign && fields.has(assign[1]!)) return assign[1];
  // 2) the root of the `field.op(` / `field.lookup(k).op(` chain that ends at the sink.
  const chain = /([A-Za-z_]\w*)(?:\s*(?:\.\s*[A-Za-z_]\w*|\([^()]*\)|\[[^\]]*\]))*\s*$/.exec(stmt.slice(0, -1));
  if (chain && fields.has(chain[1]!)) return chain[1];
  // 3) otherwise the last ledger field named in the statement before the sink.
  const named = [...stmt.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]).filter((id) => fields.has(id));
  return named[named.length - 1];
}
