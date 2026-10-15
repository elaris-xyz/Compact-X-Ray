// The VS Code extension against a fake `vscode` module, with both engines: the local CLI (via bin/)
// and the online service (the local server started on a spare port). Diagnostics must land on the
// right lines, code lenses must say what each circuit publishes, and the report must embed the result.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'test', 'fixtures', 'bid.compact');
const PORT = 4471;

class Range { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} }
class Diagnostic { source?: string; relatedInformation?: unknown[]; constructor(public range: Range, public message: string, public severity: number) {} }
const collections: Map<string, Diagnostic[]>[] = [];
const commands = new Map<string, () => Promise<unknown>>();
const asked: string[] = [];
const webviews: { html: string }[] = [];
let lens: { provideCodeLenses(d: unknown): { range: Range; command: { title: string } }[] } | undefined;
const settings: Record<string, unknown> = {
  engine: 'local',
  command: path.join(root, 'bin', 'compact-xray'),
  onlineUrl: `http://127.0.0.1:${PORT}/api/xray`,
  wslPaths: false, showDisclosures: true, codeLens: true, runOnSave: true,
};

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
    setTextDocumentLanguage: async (d: { languageId: string }, id: string) => { d.languageId = id; return d; },
  },
  window: {
    activeTextEditor: undefined as unknown,
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    createWebviewPanel: () => { const w = { webview: { html: '' } }; webviews.push(w.webview); return w; },
    showErrorMessage: (m: string) => { throw new Error(`extension reported: ${m}`); },
    showInformationMessage: async (m: string) => { asked.push(m); return 'Allow'; },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
  commands: { registerCommand: (id: string, fn: () => Promise<unknown>) => { commands.set(id, fn); return { dispose() {} }; } },
  workspace: {
    textDocuments: [] as unknown[],
    getConfiguration: () => ({ get: (k: string) => settings[k] }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
  },
};

const original = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? fakeVscode : original.call(this, request, ...rest);
};

const text = readFileSync(fixture, 'utf8');
const lines = text.split('\n');
const doc = {
  fileName: fixture,
  uri: { toString: () => `file://${fixture}` },
  lineCount: lines.length,
  getText: () => text,
  lineAt: (i: number) => ({ text: lines[i] ?? '', firstNonWhitespaceCharacterIndex: (lines[i] ?? '').search(/\S|$/) }),
};
const state = new Map<string, unknown>();
let ext: { activate(c: unknown): void; _test: { resetEngine(): void } };
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'local-server.ts'), '--port', String(PORT)], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/examples`).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  fakeVscode.window.activeTextEditor = { document: doc };
  ext = createRequire(import.meta.url)(path.join(root, 'vscode', 'extension.js'));
  ext.activate({ subscriptions: [], globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } } });
});

after(() => server?.kill());

function check() {
  const diags = collections[0]!.get(doc.uri.toString())!;
  const reveal = diags.find((d) => d.message.startsWith('Public: amount → revealed (exact value)'));
  assert.ok(reveal, diags.map((d) => d.message).join('\n'));
  assert.equal(reveal.range.sl, 27); // 0-based line 27 = line 28 in the file
  assert.ok(diags.some((d) => d.severity === 1 && /guessed/.test(d.message)), 'the guessable-hash warning');
  const revealLens = lens!.provideCodeLenses(doc).find((l) => l.range.sl === 26);
  assert.ok(revealLens);
  assert.match(revealLens.command.title, /publishes .*amount \(exact value\) → revealed/);
}

test('local engine: runs the CLI and marks the lines', async () => {
  settings.engine = 'local';
  await commands.get('compactXray.analyze')!();
  check();
  assert.equal(asked.length, 0, 'never asks when the compiler is local');
});

test('online engine: asks once, then sends the contract to the service', async () => {
  settings.engine = 'online';
  ext._test.resetEngine();
  collections[0]!.clear();
  await commands.get('compactXray.analyze')!();
  check();
  assert.equal(asked.length, 1);
  await commands.get('compactXray.analyze')!();
  assert.equal(asked.length, 1, 'the consent is remembered');
});

test('the visual report embeds the result in the bundled page', async () => {
  await commands.get('compactXray.report')!();
  const html = webviews.at(-1)!.html;
  assert.match(html, /window\.__XRAY__ = /);
  assert.match(html, /"file":"bid\.compact"/);
});

test('a contract pasted into an Untitled tab is recognised and analysed, with either engine', async () => {
  const untitled = {
    ...doc,
    fileName: 'Untitled-1',
    isUntitled: true,
    languageId: 'plaintext',
    uri: { scheme: 'untitled', toString: () => 'untitled:Untitled-1' },
  };
  const ext2 = ext as unknown as { _test: { isCompact(d: unknown): boolean } };
  assert.equal(ext2._test.isCompact(untitled), true);
  assert.equal(ext2._test.isCompact({ ...untitled, getText: () => 'hello world' }), false);
  fakeVscode.window.activeTextEditor = { document: untitled };
  for (const engine of ['online', 'local']) {
    settings.engine = engine;
    ext._test.resetEngine();
    await commands.get('compactXray.analyze')!();
    const diags = collections[0]!.get('untitled:Untitled-1')!;
    assert.ok(diags?.some((d) => d.message.startsWith('Public: amount → revealed (exact value)')), engine);
    collections[0]!.delete('untitled:Untitled-1');
  }
  fakeVscode.window.activeTextEditor = { document: doc };
});
