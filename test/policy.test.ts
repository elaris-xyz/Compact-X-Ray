// Policy and diff, end-to-end on the fixture: a new disclosure must be caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { xrayFile } from '../src/analyze.ts';
import { checkPolicy, diffXrays, policyFrom } from '../src/policy.ts';
import { renderMarkdown } from '../src/report-md.ts';
import { renderSarif } from '../src/report-sarif.ts';

const fixture = path.join(import.meta.dirname, 'fixtures', 'bid.compact');

test('a policy made from a contract accepts that contract, and fingerprints have no line numbers', async () => {
  const x = await xrayFile(fixture);
  const p = policyFrom(x);
  assert.ok(p.allow.includes('reveal: arg amount -> ledger revealed (value)'), p.allow.join('\n'));
  assert.ok(p.allow.every((a) => !/\d+:\d+/.test(a)));
  assert.equal(checkPolicy(x, p).unexpected.length, 0);
});

test('a change that publishes the bid amount is caught by both check and diff', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xray-policy-'));
  const changed = path.join(dir, 'bid.compact');
  // The regression: placeBid now writes the amount itself instead of a commitment.
  writeFileSync(changed, readFileSync(fixture, 'utf8').replace(
    'commitments.insert(who, persistentCommit<Uint<64>>(amount, salt));',
    'commitments.insert(who, persistentCommit<Uint<64>>(amount, salt));\n  revealed.insert(who, disclose(amount));',
  ));
  const [before, after] = await Promise.all([xrayFile(fixture), xrayFile(changed)]);
  const check = checkPolicy(after, policyFrom(before));
  // Both the amount and the bidder key (used as the new map key) become newly public.
  const expected = ['placeBid: arg amount -> ledger revealed (value)', 'placeBid: witness secretKey -> ledger revealed (hash)'];
  assert.deepEqual(check.unexpected.map((u) => u.fingerprint).sort(), expected.sort());
  assert.deepEqual(diffXrays(before, after).added, expected.sort());

  const md = renderMarkdown(after, { check });
  assert.match(md, /not in the privacy policy/);
  const sarif = JSON.parse(renderSarif(after, check));
  assert.ok(sarif.runs[0].results.some((r: { ruleId: string }) => r.ruleId === 'unapproved-disclosure'));
});

test('wildcards in the policy', async () => {
  const x = await xrayFile(fixture);
  assert.equal(checkPolicy(x, { allow: ['*'] }).unexpected.length, 0);
  assert.ok(checkPolicy(x, { allow: ['reveal: *'] }).unexpected.length > 0);
});
