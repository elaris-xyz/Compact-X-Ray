// Runs the real Compact compiler. The x-ray never guesses what the language does: every
// disclosure it shows is one the compiler itself reported.
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type CompileResult = { ok: boolean; output: string };

const COMPILE_TIMEOUT_MS = Number(process.env['XRAY_COMPILE_TIMEOUT_MS'] ?? 120_000);

export function compactBinary(): string {
  return process.env['XRAY_COMPACTC'] ?? process.env['COMPACT_BIN'] ?? 'compact';
}

// Two ways to reach the compiler: the `compact` launcher (`compact compile …`), or, where only the
// compiler binary is shipped (a serverless bundle), `compactc.bin` itself via XRAY_COMPACTC.
const direct = () => !!process.env['XRAY_COMPACTC'];

async function compile(file: string, outDir: string): Promise<CompileResult> {
  try {
    const args = direct() ? ['--skip-zk', file, outDir] : ['compile', '--skip-zk', file, outDir];
    const r = await run(compactBinary(), args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: COMPILE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { ok: true, output: `${r.stdout}${r.stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; message: string };
    if (err.killed) throw new Error(`the compiler took longer than ${COMPILE_TIMEOUT_MS / 1000}s`);
    if (err.code === 'ENOENT') {
      throw new Error(`Compact compiler not found (${compactBinary()}). Install it or set COMPACT_BIN.`);
    }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
  }
}

export async function compilerVersion(): Promise<string> {
  const r = await run(compactBinary(), direct() ? ['--version'] : ['compile', '--version']);
  return r.stdout.trim();
}

/**
 * `disclose(` → `        (`: same length, so every line and char the compiler reports for the
 * blanked copy is also the right position in the original file.
 */
export function blankDisclose(src: string, code: string): string {
  const out = src.split('');
  for (const m of code.matchAll(/\bdisclose\s*\(/g)) {
    for (let i = m.index!; i < m.index! + m[0].length - 1; i++) out[i] = ' ';
  }
  return out.join('');
}

/**
 * For each span, compile a copy with only that span blanked. Returns, per span, whether the
 * contract then FAILS to compile, i.e. whether the blanked text was needed.
 */
export async function compileEachWithout(
  file: string,
  src: string,
  spans: { start: number; len: number }[],
  concurrency = 4,
): Promise<boolean[]> {
  const work = mkdtempSync(path.join(tmpdir(), 'compact-xray-deep-'));
  try {
    cpSync(path.dirname(path.resolve(file)), work, {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|managed|\.git)([\\/]|$)/.test(p),
    });
    const base = path.basename(file, '.compact');
    const result: boolean[] = new Array(spans.length);
    let next = 0;
    const worker = async () => {
      while (next < spans.length) {
        const i = next++;
        const { start, len } = spans[i]!;
        // Variants live beside the original so relative includes still resolve.
        const variant = path.join(work, `${base}.__xray${i}.compact`);
        writeFileSync(variant, src.slice(0, start) + ' '.repeat(len) + src.slice(start + len));
        const r = await compile(variant, path.join(work, `out-${i}`));
        result[i] = !r.ok;
        rmSync(path.join(work, `out-${i}`), { recursive: true, force: true });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, spans.length)) }, worker));
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export type XrayCompile = {
  original: CompileResult;   // the contract as written
  exposed: CompileResult;    // every disclose() removed
};

/**
 * Compile the contract as written, then with every `disclose()` removed. The second run makes
 * the compiler list each place a private value reaches the public side. The contract's own
 * directory is copied so sibling `include`/`import` files resolve.
 */
export async function compileForXray(file: string, code: string): Promise<XrayCompile> {
  const work = mkdtempSync(path.join(tmpdir(), 'compact-xray-'));
  try {
    cpSync(path.dirname(path.resolve(file)), work, {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|managed|\.git)([\\/]|$)/.test(p),
    });
    const copy = path.join(work, path.basename(file));
    const src = readFileSync(copy, 'utf8');
    const original = await compile(copy, path.join(work, 'out-original'));
    writeFileSync(copy, blankDisclose(src, code));
    const exposed = await compile(copy, path.join(work, 'out-exposed'));
    return { original, exposed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
