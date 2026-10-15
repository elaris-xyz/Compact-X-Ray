// Turns the compiler's "potential witness-value disclosure" report into structured records.
//
//   Exception: c.compact line 88 char 25:
//     potential witness-value disclosure must be declared but is not:
//       witness value potentially disclosed:
//         the return value of witness localSecretKey at line 53 char 1
//       nature of the disclosure:
//         ledger operation might disclose a hash of the witness value
//       via this path through the program:
//         the binding of secretKey at line 77 char 9
//         the argument to member at line 88 char 25

export type Pos = { line: number; char: number };

export type SourceKind = 'circuit-argument' | 'constructor-argument' | 'witness' | 'other';

export type DisclosureSource = {
  kind: SourceKind;
  name: string;            // parameter or witness name
  circuit?: string;        // owning circuit, for arguments
  text: string;            // the compiler's words
  at?: Pos;
};

/** How much of the private value an observer learns. */
export type Exposure = 'value' | 'hash' | 'comparison' | 'derived';

/**
 * Where the value goes public. `ledger` is a read or write of contract state; `stdlib` is a call
 * into the standard library that the network sees (token mint/send/receive, coin ops), for which
 * the compiler also says *what* is revealed ("the recipient of the unshielded token …").
 */
export type Sink =
  | { kind: 'ledger' }
  | { kind: 'stdlib'; call: string; reveals: string }
  | { kind: 'return'; circuit: string }    // the exported circuit's result is part of the transaction
  | { kind: 'other' };

export type RawDisclosure = {
  at: Pos;                 // where the value becomes public (the compiler's "sink")
  source: DisclosureSource;
  nature: string;
  exposure: Exposure;
  /** For a computed value: the operation the compiler names ("addition", "multiplication", …). */
  operation?: string;
  sink: Sink;
  path: { step: string; at?: Pos }[];
};

export type ParsedReport = {
  disclosures: RawDisclosure[];
  otherErrors: string[];   // compile errors that are not disclosure reports
};

const POS = /\s+at line (\d+) char (\d+)\s*$/;

function splitPos(s: string): { text: string; at?: Pos } {
  const m = POS.exec(s);
  if (!m) return { text: s.trim() };
  return { text: s.slice(0, m.index).trim(), at: { line: Number(m[1]), char: Number(m[2]) } };
}

function readSource(text: string, at?: Pos): DisclosureSource {
  let m = /^the value of parameter (\w+) of (?:exported )?circuit (\w+)/.exec(text);
  if (m) return { kind: 'circuit-argument', name: m[1]!, circuit: m[2]!, text, at };
  m = /^the value of parameter (\w+) of the constructor/.exec(text);
  if (m) return { kind: 'constructor-argument', name: m[1]!, circuit: 'constructor', text, at };
  m = /^the return value of witness (\w+)/.exec(text);
  if (m) return { kind: 'witness', name: m[1]!, text, at };
  return { kind: 'other', name: text, text, at };
}

function readExposure(nature: string): Exposure {
  if (/boolean value of (?:the )?(?:boolean value of )?the result of a comparison/.test(nature)) return 'comparison';
  if (/a hash of the witness value/.test(nature)) return 'hash';
  // A Boolean witness disclosed as such is its exact value, not something derived from it.
  if (/disclose the boolean value of the witness value/.test(nature)) return 'value';
  if (/disclose the witness value\b|given by the witness value\b/.test(nature)) return 'value';
  return 'derived';
}

function readSink(nature: string): Sink {
  const std = /the call to standard-library circuit (\w+) might disclose (.+?)(?: given by |$)/.exec(nature);
  if (std) return { kind: 'stdlib', call: std[1]!, reveals: std[2]! };
  const ret = /the value returned from exported circuit (\w+)/.exec(nature);
  if (ret) return { kind: 'return', circuit: ret[1]! };
  if (/ledger operation/.test(nature)) return { kind: 'ledger' };
  return { kind: 'other' };
}

export function parseCompilerReport(output: string): ParsedReport {
  const blocks = output.split(/^(?=Exception: )/m).filter((b) => b.startsWith('Exception: '));
  const disclosures: RawDisclosure[] = [];
  const otherErrors: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const head = /line (\d+) char (\d+):\s*$/.exec(lines[0]!);
    if (!/potential witness-value disclosure/.test(block) || !head) {
      otherErrors.push(block.trim());
      continue;
    }
    const section = (title: string): string[] => {
      const i = lines.findIndex((l) => l.trim().startsWith(title));
      if (i < 0) return [];
      const out: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (/^\s{4}\S/.test(l) && !/^\s{6}/.test(l)) break; // next 4-space heading
        if (l.trim()) out.push(l.trim());
      }
      return out;
    };
    const src = splitPos(section('witness value potentially disclosed:').join(' '));
    const nature = section('nature of the disclosure:').join(' ');
    // Path steps each end with "at line N char M"; wrapped lines are re-joined first.
    const pathText = section('via this path through the program:').join(' ');
    const steps = pathText.split(/(?<=char \d+)\s+/).filter(Boolean).map((s) => {
      const p = splitPos(s);
      return { step: p.text, at: p.at };
    });
    disclosures.push({
      at: { line: Number(head[1]), char: Number(head[2]) },
      source: readSource(src.text, src.at),
      nature,
      exposure: readExposure(nature),
      operation: /the result of an? (\w+) involving/.exec(nature)?.[1],
      sink: readSink(nature),
      path: steps,
    });
  }
  return { disclosures, otherErrors };
}
