// X-ray a contract given as text (plus the files it includes), the way the web UI, the API and
// the site builder all need it: the result carries everything the page shows.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { xrayFile, type Xray } from './analyze.ts';
import { explain, type Sentence } from './explain.ts';
import { policyFrom, type Policy } from './policy.ts';
import { renderMarkdown } from './report-md.ts';

export type Upload = { name: string; source: string };

export type ProjectXray = Xray & {
  source: string;
  files: Upload[];          // the other files, as given
  policy: Policy;
  markdown: string;
  plain: Sentence[];
};

export const safeName = (n: string) =>
  (n.replace(/[^\w.-]/g, '_') || 'contract').replace(/(\.compact)?$/, '.compact');

/** Write the main contract and its included files into a fresh directory and x-ray it. */
export async function xrayProject(main: Upload, others: Upload[] = [], deep = false): Promise<ProjectXray> {
  const dir = mkdtempSync(path.join(tmpdir(), 'compact-xray-src-'));
  try {
    for (const f of others) writeFileSync(path.join(dir, safeName(f.name)), f.source);
    const name = safeName(main.name);
    const file = path.join(dir, name);
    writeFileSync(file, main.source);
    const x = { ...(await xrayFile(file, { deep })), file: name };
    return { ...x, source: main.source, files: others, policy: policyFrom(x), markdown: renderMarkdown(x), plain: explain(x) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
