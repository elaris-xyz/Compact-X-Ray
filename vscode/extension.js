// Compact X-Ray for VS Code: shows, in the editor, what a Midnight Compact contract makes public.
//   - diagnostics: each disclosure on its line (information), advice (warning/information)
//   - code lens above each circuit: what it publishes
//   - status bar: counts; click for the visual report (the X-Ray page in a webview)
//
// Two engines, same analysis:
//   local  — the compact-xray CLI with the Compact compiler on this machine (compactXray.command)
//   online — the hosted service (compactXray.onlineUrl), so the extension works with no setup.
//            The contract text is sent to it; the user is asked once before that happens.
// "auto" (the default) uses local when the CLI answers, online otherwise.
'use strict';
const vscode = require('vscode');
const { exec } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const WORD = { value: 'exact value', hash: 'hash', comparison: 'decision', derived: 'computed' };
const how = (l) => (l.exposure === 'derived' && l.operation ? `result of ${/^[aeiou]/.test(l.operation) ? 'an' : 'a'} ${l.operation}` : WORD[l.exposure]);
const results = new Map(); // uri -> x-ray result
let localWorks; // undefined until probed

/** A Compact contract: a .compact file, the compact language, or text that declares a language version
 *  (e.g. a contract pasted into an Untitled tab). */
function isCompact(doc) {
  if (!doc) return false;
  if (doc.fileName.endsWith('.compact') || doc.languageId === 'compact') return true;
  if (doc.uri && doc.uri.scheme && !['file', 'untitled'].includes(doc.uri.scheme)) return false;
  return /\bpragma\s+language_version\b/.test(doc.getText().slice(0, 20000));
}

function cfg() {
  return vscode.workspace.getConfiguration('compactXray');
}

function toCliPath(p) {
  if (!cfg().get('wslPaths')) return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

// cmd.exe (Windows) only understands double quotes; POSIX shells get single quotes.
function quote(s) {
  if (process.platform === 'win32') return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Run the CLI; resolves with stdout even on exit code 1 (findings), rejects on tool errors. */
function runCli(args, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    const cmd = `${cfg().get('command')} ${args.map(quote).join(' ')}`;
    exec(cmd, { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code !== 1) return reject(new Error((stderr || err.message).trim().slice(0, 500)));
      resolve(stdout);
    });
  });
}

async function engine(ctx) {
  const want = cfg().get('engine');
  if (want === 'local' || want === 'online') return want;
  if (localWorks === undefined) {
    localWorks = await runCli(['--version'], 20_000).then((v) => /\d+\.\d+/.test(v), () => false);
  }
  return localWorks ? 'local' : 'online';
}

/** Ask once before any contract leaves the machine. */
async function onlineAllowed(ctx) {
  if (ctx.state.get('onlineConsent') === true) return true;
  const url = cfg().get('onlineUrl');
  const pick = await vscode.window.showInformationMessage(
    `Compact X-Ray has no local compiler, so it can analyse this contract with the online service (${new URL(url).host}). The contract text is sent there to be compiled; nothing is stored.`,
    { modal: true },
    'Allow',
  );
  if (pick !== 'Allow') return false;
  await ctx.state.update('onlineConsent', true);
  return true;
}

/** The contract and the other .compact files next to it (it may import them). */
function projectFiles(doc) {
  if (doc.isUntitled) return { main: { name: 'contract.compact', source: doc.getText() }, others: [] };
  const dir = path.dirname(doc.fileName);
  const open = new Map(vscode.workspace.textDocuments.map((d) => [d.fileName, d.getText()]));
  const others = [];
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (!n.endsWith('.compact') || p === doc.fileName) continue;
      others.push({ name: n, source: open.get(p) ?? fs.readFileSync(p, 'utf8') });
      if (others.length >= 31) break;
    }
  } catch { /* an unsaved file has no directory to read */ }
  return { main: { name: path.basename(doc.fileName), source: doc.getText() }, others };
}

async function xrayOnline(doc, deep) {
  const { main, others } = projectFiles(doc);
  const r = await fetch(cfg().get('onlineUrl'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: main.name, source: main.source, files: others, deep }),
  });
  const x = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(x.error || `HTTP ${r.status}`);
  return x;
}

async function xray(doc, ctx, deep = false) {
  if ((await engine(ctx)) === 'local') {
    // The CLI reads files: an unsaved contract goes through a temporary copy.
    let file = doc.fileName, tmp;
    if (doc.isUntitled || !doc.fileName.endsWith('.compact')) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-vscode-'));
      file = path.join(tmp, 'contract.compact');
      fs.writeFileSync(file, doc.getText());
    }
    try {
      const args = [toCliPath(file), '--format', 'json'];
      if (deep) args.push('--deep');
      return { ...JSON.parse(await runCli(args)), source: doc.getText() };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (!(await onlineAllowed(ctx))) throw new Error('analysis cancelled (no local compiler, online not allowed). Set compactXray.command to use a local one.');
  return xrayOnline(doc, deep);
}

function sourceName(l) {
  return l.source.kind === 'witness' ? `witness ${l.source.name}` : l.source.name;
}
function sinkName(l) {
  if (l.sink.kind === 'stdlib') return `${l.sink.call}()`;
  if (l.sink.kind === 'return') return 'the return value (to the caller, not on chain)';
  return l.sink.field || 'the ledger';
}

function lineRange(doc, line) {
  const i = Math.max(0, Math.min(doc.lineCount - 1, line - 1));
  const text = doc.lineAt(i);
  return new vscode.Range(i, text.firstNonWhitespaceCharacterIndex, i, text.text.length);
}

function publish(doc, x, diagnostics) {
  const out = [];
  if (!x.compiles) {
    // No analysis ran: report only where the compiler stopped.
    const problems = (x.compileProblems && x.compileProblems.length) ? x.compileProblems : [{ line: 1, char: 1, message: (x.compileErrors[0] || '').split('\n')[0] }];
    for (const p of problems) {
      const d = new vscode.Diagnostic(lineRange(doc, p.line || 1), `Compact X-Ray: the contract does not compile — ${p.message}`, vscode.DiagnosticSeverity.Error);
      d.source = 'compact-xray';
      out.push(d);
    }
    diagnostics.set(doc.uri, out);
    return;
  }
  if (cfg().get('showDisclosures')) {
    // One entry per line and per way of leaking: "num1 and num2 → result (result of an addition)".
    const groups = new Map();
    for (const l of x.leaks) {
      const key = `${l.sink.line}|${sinkName(l)}|${how(l)}|${l.sink.reveals || ''}`;
      const g = groups.get(key) || { l, names: [], steps: new Map() };
      if (!g.names.includes(sourceName(l))) g.names.push(sourceName(l));
      for (const p of l.path || []) if (p.at) g.steps.set(`${p.at.line}|${p.step}`, p);
      groups.set(key, g);
    }
    for (const { l, names, steps } of groups.values()) {
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      const msg = `Public: ${who} → ${sinkName(l)} (${how(l)})${l.sink.reveals ? ` — reveals ${l.sink.reveals}` : ''}`;
      const d = new vscode.Diagnostic(lineRange(doc, l.sink.line), msg, vscode.DiagnosticSeverity.Information);
      d.source = 'compact-xray';
      d.relatedInformation = [...steps.values()].map((p) =>
        new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, lineRange(doc, p.at.line)), p.step));
      out.push(d);
    }
  }
  for (const a of x.advice) {
    const sev = a.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
    for (const line of a.lines.length ? a.lines : [1]) {
      const d = new vscode.Diagnostic(lineRange(doc, line), `${a.title.replace(/`/g, "'")} — ${a.detail.replace(/`/g, "'")}`, sev);
      d.source = 'compact-xray';
      out.push(d);
    }
  }
  diagnostics.set(doc.uri, out);
}

class Lenses {
  constructor() { this.changed = new vscode.EventEmitter(); this.onDidChangeCodeLenses = this.changed.event; }
  provideCodeLenses(doc) {
    const x = results.get(doc.uri.toString());
    if (!x || !x.compiles || !cfg().get('codeLens')) return [];
    return x.circuits.filter((c) => c.exported || c.leaks).map((c) => {
      const mine = x.leaks.filter((l) => l.circuit === c.name && l.sink.kind !== 'return');
      const parts = [...new Set(mine.map((l) => `${l.source.name} (${how(l)}) → ${l.sink.kind === 'stdlib' ? `${l.sink.call}()` : l.sink.field}`))];
      const title = parts.length ? `🩻 publishes ${parts.slice(0, 3).join(', ')}${parts.length > 3 ? ` +${parts.length - 3}` : ''}` : '🩻 nothing private is published';
      return new vscode.CodeLens(lineRange(doc, c.startLine), { title, command: 'compactXray.report' });
    });
  }
}

async function analyze(doc, ctx, deep = false) {
  if (!isCompact(doc)) return;
  ctx.status.text = '$(sync~spin) X-Ray';
  ctx.status.show();
  try {
    const x = await xray(doc, ctx, deep);
    results.set(doc.uri.toString(), x);
    publish(doc, x, ctx.diagnostics);
    ctx.lenses.changed.fire();
    const warnings = x.advice.filter((a) => a.severity === 'warning').length;
    ctx.status.text = !x.compiles ? '$(error) X-Ray: does not compile'
      : `$(eye) X-Ray: ${x.leaks.length} disclosure${x.leaks.length === 1 ? '' : 's'}${warnings ? `, $(warning) ${warnings}` : ''}`;
    ctx.status.tooltip = `Compact X-Ray (${localWorks ? 'local compiler' : 'online'}) — click for the visual report`;
    return x;
  } catch (e) {
    ctx.status.text = '$(error) X-Ray';
    ctx.status.tooltip = String(e.message);
    vscode.window.showErrorMessage(`Compact X-Ray: ${e.message}`);
  }
}

/** The X-Ray page with this result embedded, as the CLI's --format html does. */
function reportHtml(x) {
  const bundled = path.join(__dirname, 'media', 'report.html');
  const page = fs.readFileSync(fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const data = JSON.stringify(x).replace(/</g, '\\u003c');
  return page.replace('<script>', `<script>window.__XRAY__ = ${data};</script>\n<script>`);
}

async function openReport(ctx) {
  const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (!isCompact(doc)) return vscode.window.showInformationMessage('Open a Compact contract first (a .compact file, or one pasted into an editor tab).');
  const x = results.get(doc.uri.toString()) ?? (await analyze(doc, ctx));
  if (!x) return;
  const panel = vscode.window.createWebviewPanel('compactXray', `X-Ray: ${path.basename(doc.fileName)}`, vscode.ViewColumn.Beside, { enableScripts: true });
  panel.webview.html = reportHtml({ ...x, file: doc.isUntitled ? 'contract.compact' : path.basename(doc.fileName) });
}

async function initPolicy(ctx) {
  const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (!isCompact(doc)) return;
  if (doc.isUntitled) return vscode.window.showInformationMessage('Save the contract first: the policy is written next to it.');
  try {
    if ((await engine(ctx)) === 'local') {
      await runCli(['init', toCliPath(doc.fileName)]);
    } else {
      const x = await analyze(doc, ctx);
      if (!x?.policy) return;
      fs.writeFileSync(path.join(path.dirname(doc.fileName), '.xray.json'), `${JSON.stringify(x.policy, null, 2)}\n`);
    }
    vscode.window.showInformationMessage('Compact X-Ray: wrote .xray.json next to the contract. Review and commit it.');
  } catch (e) { vscode.window.showErrorMessage(`Compact X-Ray: ${e.message}`); }
}

function activate(context) {
  const ctx = {
    diagnostics: vscode.languages.createDiagnosticCollection('compact-xray'),
    status: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50),
    lenses: new Lenses(),
    state: context.globalState,
  };
  ctx.status.command = 'compactXray.report';
  const active = () => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  context.subscriptions.push(
    ctx.diagnostics, ctx.status,
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.compact' }, ctx.lenses),
    vscode.commands.registerCommand('compactXray.analyze', () => analyze(active(), ctx)),
    vscode.commands.registerCommand('compactXray.deep', () => analyze(active(), ctx, true)),
    vscode.commands.registerCommand('compactXray.report', () => openReport(ctx)),
    vscode.commands.registerCommand('compactXray.initPolicy', () => initPolicy(ctx)),
    vscode.workspace.onDidSaveTextDocument((doc) => cfg().get('runOnSave') && analyze(doc, ctx)),
    vscode.workspace.onDidOpenTextDocument((doc) => adopt(doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && seen(ed.document, ctx)),
    vscode.workspace.onDidChangeTextDocument((e) => typed(e.document, ctx)),
    vscode.workspace.onDidCloseTextDocument((doc) => { ctx.diagnostics.delete(doc.uri); results.delete(doc.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('compactXray')) localWorks = undefined; }),
  );
  if (active()) seen(active(), ctx);
}

/** Give a contract the Compact language (colours, and the language id other tools key on). */
function adopt(doc) {
  if (isCompact(doc) && doc.languageId !== 'compact' && vscode.languages.setTextDocumentLanguage) {
    vscode.languages.setTextDocumentLanguage(doc, 'compact').then(undefined, () => undefined);
  }
}

/** A contract came into view: analyse it unless it already has a result. */
function seen(doc, ctx) {
  if (!isCompact(doc)) return;
  adopt(doc);
  if (!results.has(doc.uri.toString())) analyze(doc, ctx);
}

/** Unsaved contracts (an Untitled tab) are analysed a moment after typing or pasting stops;
 *  saved files are analysed on save. */
const typing = new Map();
function typed(doc, ctx) {
  if (!doc.isUntitled || !cfg().get('runOnType') || !isCompact(doc)) return;
  const k = doc.uri.toString();
  clearTimeout(typing.get(k));
  typing.set(k, setTimeout(() => { typing.delete(k); adopt(doc); analyze(doc, ctx); }, 1500));
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { isCompact, projectFiles, reportHtml, resetEngine: () => { localWorks = undefined; } } };
