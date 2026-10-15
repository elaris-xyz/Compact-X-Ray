// The VS Code extension against a fake `vscode` module: it must run the real CLI (via bin/),
// put diagnostics on the right lines, and build a code lens per circuit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'test', 'fixtures', 'bid.compact');

class Range { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} }
class Diagnostic { source?: string; relatedInformation?: unknown[]; constructor(public range: Range, public message: string, public severity: number) {} }
const collections: Map<string, Diagnostic[]>[] = [];
const commands = new Map<string, () => unknown>();
let lens: { provideCodeLenses(d: unknown): { range: Range; command: { title: string } }[] } | undefined;

const fakeVscode = {
  Range, Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  DiagnosticRelatedInformation: class { constructor(public location: unknown, public message: string) {} },
  Location: class { constructor(public uri: unknown, public range: unknown) {} },
  EventEmitter: class { event = () => undefined; fire() {} },
  CodeLens: class { constructor(public range: Range, public command: { title: string }) {} },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { Beside: 2 },
  languages: {
    createDiagnosticCollection: () => {
      const m = new Map<string, Diagnostic[]>();
      collections.push(m);
      return { set: (u: { toString(): string }, d: Diagnostic[]) => m.set(u.toString(), d), delete: () => undefined, dispose() {} };
    },
    registerCodeLensProvider: (_: unknown, p: typeof lens) => { lens = p; return { dispose() {} }; },
  },
  window: {
    activeTextEditor: undefined as unknown,
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    showErrorMessage: (m: string) => { throw new Error(`extension reported: ${m}`); },
    showInformationMessage: () => undefined,
  },
  commands: { registerCommand: (id: string, fn: () => unknown) => { commands.set(id, fn); return { dispose() {} }; } },
  workspace: {
    getConfiguration: () => ({ get: (k: string) => ({ command: path.join(root, 'bin', 'compact-xray'), wslPaths: false, showDisclosures: true, codeLens: true, runOnSave: true } as Record<string, unknown>)[k] }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
  },
};

// Serve the fake for require('vscode').
const original = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? fakeVscode : original.call(this, request, ...rest);
};

function fakeDoc(file: string, lines: string[]) {
  return {
    fileName: file,
    uri: { toString: () => `file://${file}` },
    lineCount: lines.length,
    lineAt: (i: number) => ({ text: lines[i] ?? '', firstNonWhitespaceCharacterIndex: (lines[i] ?? '').search(/\S|$/) }),
  };
}

test('the extension analyzes the active contract on activation', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = fakeDoc(fixture, readFileSync(fixture, 'utf8').split('\n'));
  fakeVscode.window.activeTextEditor = { document: doc };
  const ext = createRequire(import.meta.url)(path.join(root, 'vscode', 'extension.js'));
  ext.activate({ subscriptions: [] });
  await commands.get('compactXray.analyze')!();

  const diags = collections[0]!.get(doc.uri.toString())!;
  assert.ok(diags.length > 0);
  const reveal = diags.find((d) => d.message.startsWith('Public: amount → revealed (exact value)'));
  assert.ok(reveal, diags.map((d) => d.message).join('\n'));
  assert.equal(reveal.range.sl, 27); // 0-based line 27 = line 28 in the file
  assert.ok(diags.some((d) => d.severity === 1 && /guessed/.test(d.message)), 'the guessable-hash warning');

  const lenses = lens!.provideCodeLenses(doc);
  const revealLens = lenses.find((l) => l.range.sl === 26);
  assert.ok(revealLens, lenses.map((l) => `${l.range.sl}: ${l.command.title}`).join('\n'));
  assert.match(revealLens.command.title, /publishes .*amount \(exact value\) → revealed/);
});
