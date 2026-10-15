// SARIF 2.1.0 output, so GitHub code scanning shows findings inline on pull requests.
import path from 'node:path';
import type { Xray } from './analyze.ts';
import type { PolicyCheck } from './policy.ts';

const LEVEL = { warning: 'error', notice: 'warning', info: 'note' } as const;

export function renderSarif(x: Xray, check?: PolicyCheck, version = '0.1.0'): string {
  const uri = path.relative(process.cwd(), x.file).split(path.sep).join('/');
  const results: unknown[] = [];
  const loc = (line: number) => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: Math.max(1, line) } } }];

  for (const a of x.advice) {
    const rule = a.title.includes('guessed') ? 'guessable-hash'
      : a.title.includes('published as-is') ? 'witness-published'
      : a.title.includes('decision') ? 'secret-branch'
      : a.title.includes('worked back') ? 'reversible-computation'
      : a.title.includes('ownPublicKey') ? 'ownpublickey-auth'
      : a.title.includes('constant salt') ? 'constant-salt'
      : a.title.includes('not required') ? 'unneeded-disclose'
      : 'compile';
    for (const line of a.lines.length ? a.lines : [1]) {
      results.push({ ruleId: rule, level: LEVEL[a.severity], message: { text: `${a.title}. ${a.detail}`.replace(/`/g, "'") }, locations: loc(line) });
    }
  }
  for (const u of check?.unexpected ?? []) {
    for (const line of u.lines) {
      results.push({
        ruleId: 'unapproved-disclosure',
        level: 'error',
        message: { text: `Not in the privacy policy: ${u.fingerprint}. If intended, add it to .xray.json.` },
        locations: loc(line),
      });
    }
  }

  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'compact-xray',
          version,
          informationUri: 'https://github.com/elaris-xyz/Compact-X-Ray',
          rules: [
            { id: 'unapproved-disclosure', shortDescription: { text: 'A private value reaches the public side and the privacy policy does not allow it' } },
            { id: 'guessable-hash', shortDescription: { text: 'A hash of a small-domain private value is public and can be brute-forced' } },
            { id: 'witness-published', shortDescription: { text: 'A witness value is published unchanged' } },
            { id: 'secret-branch', shortDescription: { text: 'A ledger update depends on a decision about a private value' } },
            { id: 'reversible-computation', shortDescription: { text: 'A computation of a single private value is public and can usually be reversed' } },
            { id: 'ownpublickey-auth', shortDescription: { text: 'ownPublicKey() is used to decide who may act; anyone can pass that check' } },
            { id: 'constant-salt', shortDescription: { text: 'A commitment uses a constant salt, so it is a plain hash' } },
            { id: 'unneeded-disclose', shortDescription: { text: 'A disclose() call the compiler does not require' } },
            { id: 'compile', shortDescription: { text: 'The contract does not compile' } },
          ],
        },
      },
      results,
    }],
  }, null, 2);
}
