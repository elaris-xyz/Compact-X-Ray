// Privacy policy: the list of disclosures a contract is *meant* to make. Anything the compiler
// reports that the policy does not allow is a privacy regression.
//
// A disclosure is identified by a fingerprint that survives unrelated edits (no line numbers):
//     <circuit>: <source> -> <sink> (<exposure>)
//   e.g. revealBid: arg amount -> ledger revealedBids (value)
//        placeBid: witness localSecretKey -> ledger bidCommitments (hash)
//        transfer: arg to -> sendUnshielded (value)
// Policy entries may use `*` as a wildcard for any run of characters.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Leak, Xray } from './analyze.ts';

export const POLICY_FILE = '.xray.json';

export type Policy = {
  $schema?: string;
  contract?: string;
  /** Disclosures the author intends. */
  allow: string[];
  /** Optional reasons, keyed by an `allow` entry. */
  reasons?: Record<string, string>;
};

export function sourceLabel(l: Leak): string {
  return l.source.kind === 'witness' ? `witness ${l.source.name}` : `arg ${l.source.name}`;
}

export function sinkLabel(l: Leak): string {
  if (l.sink.kind === 'stdlib') return `${l.sink.call}`;
  if (l.sink.kind === 'return') return 'return value';
  return `ledger ${l.sink.field ?? '?'}`;
}

export function fingerprint(l: Leak): string {
  return `${l.circuit}: ${sourceLabel(l)} -> ${sinkLabel(l)} (${l.exposure})`;
}

/** Distinct fingerprints in the x-ray, each with the lines it occurs on. */
export function fingerprints(x: Xray): Map<string, { leak: Leak; lines: number[] }> {
  const out = new Map<string, { leak: Leak; lines: number[] }>();
  for (const l of x.leaks) {
    const k = fingerprint(l);
    const e = out.get(k) ?? { leak: l, lines: [] };
    if (!e.lines.includes(l.sink.line)) e.lines.push(l.sink.line);
    out.set(k, e);
  }
  return out;
}

function toRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

export function readPolicy(file: string): Policy {
  const p = JSON.parse(readFileSync(file, 'utf8')) as Policy;
  if (!Array.isArray(p.allow)) throw new Error(`${file}: "allow" must be a list of disclosure fingerprints`);
  return p;
}

export function policyFrom(x: Xray): Policy {
  return {
    contract: x.file.split(/[\\/]/).pop(),
    allow: [...fingerprints(x).keys()].sort(),
  };
}

export function writePolicy(file: string, p: Policy): void {
  writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
}

export type PolicyCheck = {
  unexpected: { fingerprint: string; leak: Leak; lines: number[] }[]; // reported, not allowed
  unused: string[];                                                     // allowed, no longer reported
  allowed: number;
};

export function checkPolicy(x: Xray, p: Policy): PolicyCheck {
  const rules = p.allow.map((a) => ({ a, re: toRegex(a) }));
  const used = new Set<string>();
  const unexpected: PolicyCheck['unexpected'] = [];
  let allowed = 0;
  for (const [k, v] of fingerprints(x)) {
    const hit = rules.find((r) => r.re.test(k));
    if (hit) { used.add(hit.a); allowed++; }
    else unexpected.push({ fingerprint: k, leak: v.leak, lines: v.lines });
  }
  return { unexpected, unused: p.allow.filter((a) => !used.has(a)), allowed };
}

export type Diff = { added: string[]; removed: string[]; kept: string[] };

/** What changed between two x-rays of the same contract (e.g. main vs a pull request). */
export function diffXrays(before: Xray, after: Xray): Diff {
  const a = new Set(fingerprints(before).keys());
  const b = new Set(fingerprints(after).keys());
  return {
    added: [...b].filter((k) => !a.has(k)).sort(),
    removed: [...a].filter((k) => !b.has(k)).sort(),
    kept: [...b].filter((k) => a.has(k)).sort(),
  };
}
