// Source rules (patterns the compiler accepts but the Midnight docs warn about) and --deep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { xrayFile, type Xray } from '../src/analyze.ts';

const fixture = path.join(import.meta.dirname, 'fixtures', 'rules.compact');
let x: Xray;

test('runs with --deep', async () => {
  x = await xrayFile(fixture, { deep: true });
  assert.equal(x.compiles, true, x.compileErrors.join('\n'));
});

test('ownPublicKey() used for authorization is flagged where it gates, not where it is stored', () => {
  const a = x.advice.find((k) => k.title.includes('ownPublicKey'));
  assert.ok(a, JSON.stringify(x.advice));
  assert.deepEqual(a.lines, [17]);
  assert.equal(a.severity, 'warning');
});

test('a constant commitment salt is flagged', () => {
  const a = x.advice.find((k) => k.title.includes('constant salt'));
  assert.ok(a);
  assert.deepEqual(a.lines, [27]);
});

test('--deep finds exactly the disclose() the compiler does not need', () => {
  assert.deepEqual(x.discloses.filter((d) => !d.needed).map((d) => d.line), [32]);
  assert.ok(x.discloses.find((d) => d.line === 12)?.needed);
  assert.ok(x.advice.some((k) => k.severity === 'info' && k.title.includes('not required')));
});
