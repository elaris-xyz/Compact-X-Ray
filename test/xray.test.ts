// End-to-end: runs the real compiler on a fixture and checks what the x-ray concludes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { xrayFile, type Xray } from '../src/analyze.ts';

const fixture = path.join(import.meta.dirname, 'fixtures', 'bid.compact');
let x: Xray;

test('compiles and reads the declarations', async () => {
  x = await xrayFile(fixture);
  assert.equal(x.compiles, true);
  assert.deepEqual(x.ledger.map((f) => f.name), ['minimumBid', 'commitments', 'revealed', 'pinHashes', 'saltedPins', 'status']);
  assert.equal(x.ledger[0]!.sealed, true);
  assert.deepEqual(x.witnesses.map((w) => w.name), ['secretKey']);
  assert.ok(x.circuits.some((c) => c.name === 'bidderKey' && !c.exported));
});

test('a disclosed constructor argument is public as its exact value', () => {
  const l = x.leaks.find((k) => k.circuit === 'constructor');
  assert.ok(l);
  assert.equal(l.source.name, 'minimum');
  assert.equal(l.exposure, 'value');
  assert.equal(l.sink.field, 'minimumBid');
});

test('a committed amount stays private; the bidder key is a hash', () => {
  const place = x.leaks.filter((k) => k.circuit === 'placeBid');
  assert.ok(!place.some((k) => k.source.name === 'amount'), 'amount must not leak in placeBid');
  assert.ok(place.some((k) => k.source.kind === 'witness' && k.exposure === 'hash' && k.sink.field === 'commitments'));
});

test('a revealed amount is public', () => {
  assert.ok(x.leaks.some((k) => k.circuit === 'reveal' && k.source.name === 'amount' && k.exposure === 'value' && k.sink.field === 'revealed'));
});

test('a small value hashed alone is flagged as guessable, and only that one', () => {
  const warn = x.advice.filter((a) => a.severity === 'warning');
  assert.equal(warn.length, 1, JSON.stringify(warn));
  assert.match(warn[0]!.title, /pin/);
  assert.ok(warn[0]!.lines.includes(33));
});

test('a branch on a secret that writes the ledger is reported as a revealed decision', () => {
  assert.ok(x.leaks.some((k) => k.circuit === 'branch' && k.exposure === 'comparison' && k.sink.field === 'status'));
});

test('a returned witness value is reported as going back to the caller', () => {
  const r = x.leaks.find((k) => k.circuit === 'peek');
  assert.ok(r);
  assert.equal(r.sink.kind, 'return');
  assert.equal(r.source.kind, 'witness');
});

test('plain-language summary', async () => {
  const { explain } = await import('../src/explain.ts');
  const lines = explain(x);
  const reveal = lines.find((l) => l.circuit === 'reveal');
  assert.ok(reveal);
  assert.match(reveal.text, /anyone watching the chain learns .*the exact `amount` in `revealed`/);
  assert.equal(lines.find((l) => l.circuit === 'peek')?.tone, 'caller');
});
