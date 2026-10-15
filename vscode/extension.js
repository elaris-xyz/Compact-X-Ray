// Compact X-Ray for VS Code: runs the CLI on save and shows its findings in the editor.
//   - diagnostics: each disclosure on its line (information), advice (warning/information)
//   - code lens above each circuit: what it publishes
//   - status bar: counts; click for the visual report (the CLI's HTML in a webview)
'use strict';
const vscode = require('vscode');
const { exec } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const WORD = { value: 'exact value', hash: 'hash', comparison: 'decision', derived: 'derived' };
const results = new Map(); // uri -> xray JSON

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
function runCli(args) {
  return new Promise((resolve, reject) => {
    const cmd = `${cfg().get('command')} ${args.map(quote).join(' ')}`;
    exec(cmd, { maxBuffer: 64 * 1024 * 1024, timeout: 300_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code !== 1) return reject(new Error((stderr || err.message).trim().slice(0, 500)));
      resolve(stdout);
    });
  });
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
    out.push(new vscode.Diagnostic(lineRange(doc, 1), `Compact X-Ray: the contract does not compile. ${(x.compileErrors[0] || '').split('\n')[0]}`, vscode.DiagnosticSeverity.Error));
  }
  if (cfg().get('showDisclosures')) {
    const seen = new Set();
    for (const l of x.leaks) {
      const msg = `Public: ${sourceName(l)} → ${sinkName(l)} (${WORD[l.exposure]})${l.sink.reveals ? ` — reveals ${l.sink.reveals}` : ''}`;
      const key = `${l.sink.line}|${msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = new vscode.Diagnostic(lineRange(doc, l.sink.line), msg, vscode.DiagnosticSeverity.Information);
      d.source = 'compact-xray';
      d.relatedInformation = (l.path || []).filter((p) => p.at).map((p) =>
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
    if (!x || !cfg().get('codeLens')) return [];
    return x.circuits.filter((c) => c.exported || c.leaks).map((c) => {
      const mine = x.leaks.filter((l) => l.circuit === c.name && l.sink.kind !== 'return');
      const parts = [...new Set(mine.map((l) => `${l.source.name} (${WORD[l.exposure]}) → ${l.sink.kind === 'stdlib' ? `${l.sink.call}()` : l.sink.field}`))];
      const title = parts.length ? `🩻 publishes ${parts.slice(0, 3).join(', ')}${parts.length > 3 ? ` +${parts.length - 3}` : ''}` : '🩻 nothing private is published';
      return new vscode.CodeLens(lineRange(doc, c.startLine), { title, command: 'compactXray.report' });
    });
  }
}

async function analyze(doc, ctx, deep = false) {
  if (!doc || !doc.fileName.endsWith('.compact')) return;
  ctx.status.text = '$(sync~spin) X-Ray';
  ctx.status.show();
  try {
    const args = [toCliPath(doc.fileName), '--format', 'json'];
    if (deep) args.push('--deep');
    const x = JSON.parse(await runCli(args));
    results.set(doc.uri.toString(), x);
    publish(doc, x, ctx.diagnostics);
    ctx.lenses.changed.fire();
    const warnings = x.advice.filter((a) => a.severity === 'warning').length;
    ctx.status.text = `$(eye) X-Ray: ${x.leaks.length} disclosure${x.leaks.length === 1 ? '' : 's'}${warnings ? `, $(warning) ${warnings}` : ''}`;
    ctx.status.tooltip = 'Compact X-Ray — click for the visual report';
  } catch (e) {
    ctx.status.text = '$(error) X-Ray';
    ctx.status.tooltip = String(e.message);
    vscode.window.showErrorMessage(`Compact X-Ray: ${e.message}`);
  }
}

async function openReport(ctx) {
  const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (!doc || !doc.fileName.endsWith('.compact')) return vscode.window.showInformationMessage('Open a .compact file first.');
  const out = path.join(os.tmpdir(), `xray-${Date.now()}.html`);
  try {
    await runCli([toCliPath(doc.fileName), '--format', 'html', '--out', toCliPath(out)]);
    const panel = vscode.window.createWebviewPanel('compactXray', `X-Ray: ${path.basename(doc.fileName)}`, vscode.ViewColumn.Beside, { enableScripts: true });
    panel.webview.html = fs.readFileSync(out, 'utf8');
    fs.rmSync(out, { force: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Compact X-Ray: ${e.message}`);
  }
}

function activate(context) {
  const ctx = {
    diagnostics: vscode.languages.createDiagnosticCollection('compact-xray'),
    status: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50),
    lenses: new Lenses(),
  };
  ctx.status.command = 'compactXray.report';
  const active = () => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  context.subscriptions.push(
    ctx.diagnostics, ctx.status,
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.compact' }, ctx.lenses),
    vscode.commands.registerCommand('compactXray.analyze', () => analyze(active(), ctx)),
    vscode.commands.registerCommand('compactXray.deep', () => analyze(active(), ctx, true)),
    vscode.commands.registerCommand('compactXray.report', () => openReport(ctx)),
    vscode.commands.registerCommand('compactXray.initPolicy', async () => {
      const doc = active();
      if (!doc) return;
      try {
        await runCli(['init', toCliPath(doc.fileName)]);
        vscode.window.showInformationMessage('Compact X-Ray: wrote .xray.json next to the contract. Review and commit it.');
      } catch (e) { vscode.window.showErrorMessage(`Compact X-Ray: ${e.message}`); }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => cfg().get('runOnSave') && analyze(doc, ctx)),
    vscode.workspace.onDidCloseTextDocument((doc) => { ctx.diagnostics.delete(doc.uri); results.delete(doc.uri.toString()); }),
  );
  if (active()) analyze(active(), ctx);
}

function deactivate() {}

module.exports = { activate, deactivate };
