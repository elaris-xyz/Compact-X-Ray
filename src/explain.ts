// "In plain words": one sentence per circuit saying what an observer of the chain learns when it
// runs. For readers who do not read Compact (auditors, product owners, users).
import type { Leak, Xray } from './analyze.ts';

const an = (w: string) => `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w}`;

/** "the private value `sk`" for a witness, "`amount`" for an argument. */
function name(l: Leak): string {
  return l.source.kind === 'witness' ? `the private value \`${l.source.name}\`` : `\`${l.source.name}\``;
}

/** What is learned about these values (all of one leak kind): "the result of an addition of `a` and `b`". */
function learned(sample: Leak, names: string[]): string {
  const who = list(names);
  switch (sample.exposure) {
    case 'value': return `the exact value of ${who}`.replace('the exact value of the private value', 'the exact private value');
    case 'hash': return `a fingerprint (hash) of ${who}`;
    case 'comparison': return `a yes/no decision about ${who}`;
    default: return sample.operation ? `the result of ${an(sample.operation)} of ${who}` : `the result of a computation with ${who}`;
  }
}

function what(l: Leak): string {
  return learned(l, [name(l)]);
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
  if (!x.compiles) return out; // no analysis ran: claiming "nothing is published" would be false
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
    // Values that leak the same way into the same place read as one phrase ("an addition of `a` and
    // `b` in `result`"), and one phrase that reaches several places lists them all.
    const byPlace = new Map<string, { sample: Leak; names: Set<string>; place: string }>();
    for (const l of onChain) {
      const k = `${l.exposure}|${l.operation ?? ''}|${where(l)}`;
      const g = byPlace.get(k) ?? { sample: l, names: new Set<string>(), place: where(l) };
      g.names.add(name(l));
      byPlace.set(k, g);
    }
    const byWhat = new Map<string, Set<string>>();
    for (const g of byPlace.values()) {
      const w = learned(g.sample, [...g.names]);
      byWhat.set(w, (byWhat.get(w) ?? new Set<string>()).add(g.place));
    }
    const parts = [...byWhat.entries()].map(([w, places]) => `${w} ${list([...places])}`);
    out.push({ circuit: c.name, tone: 'public', text: `${who}, anyone watching the chain learns ${parts.join('; and ')}.` });
  }
  return out;
}
