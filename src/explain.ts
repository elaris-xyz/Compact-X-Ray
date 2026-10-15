// "In plain words": one sentence per circuit saying what an observer of the chain learns when it
// runs. For readers who do not read Compact (auditors, product owners, users).
import type { Leak, Xray } from './analyze.ts';

const HOW: Record<Leak['exposure'], string> = {
  value: 'the exact',
  hash: 'a fingerprint (hash) of',
  comparison: 'a yes/no decision about',
  derived: 'something derived from',
};

function what(l: Leak): string {
  const n = `\`${l.source.name}\``;
  if (l.source.kind !== 'witness') return `${HOW[l.exposure]} ${n}`;
  return l.exposure === 'value' ? `the exact private value ${n}` : `${HOW[l.exposure]} the private value ${n}`;
}

function where(l: Leak): string {
  if (l.sink.kind === 'stdlib') return `through ${l.sink.call}() (${l.sink.reveals})`;
  return l.sink.field ? `in \`${l.sink.field}\`` : 'in the contract state';
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export type Sentence = { circuit: string; text: string; tone: 'private' | 'public' | 'caller' };

export function explain(x: Xray): Sentence[] {
  const out: Sentence[] = [];
  const shown = x.circuits.filter((c) => c.exported || c.leaks);
  for (const c of shown) {
    const mine = x.leaks.filter((l) => l.circuit === c.name);
    const onChain = mine.filter((l) => l.sink.kind !== 'return');
    const returned = mine.filter((l) => l.sink.kind === 'return');
    const who = c.name === 'constructor' ? 'When the contract is deployed' : c.exported ? `When someone calls \`${c.name}\`` : `Inside \`${c.name}\` (used by other circuits)`;
    if (!onChain.length) {
      out.push({
        circuit: c.name,
        tone: returned.length ? 'caller' : 'private',
        text: returned.length
          ? `${who}, nothing private is published; ${list([...new Set(returned.map((l) => what(l)))])} goes back to the caller only.`
          : `${who}, nothing private is published.`,
      });
      continue;
    }
    // Group by what is learned, then list where it shows up.
    const byWhat = new Map<string, Set<string>>();
    for (const l of onChain) {
      const k = what(l);
      const s = byWhat.get(k) ?? new Set<string>();
      s.add(where(l));
      byWhat.set(k, s);
    }
    const parts = [...byWhat.entries()].map(([w, places]) => `${w} ${list([...places])}`);
    out.push({ circuit: c.name, tone: 'public', text: `${who}, anyone watching the chain learns ${parts.join('; and ')}.` });
  }
  return out;
}
