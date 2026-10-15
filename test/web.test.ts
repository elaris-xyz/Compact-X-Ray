// The web UI is one inline script; a stray quote or an unescaped </script> inside it silently
// blanks the whole page. Parse it the way a browser would split it, then compile it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import { renderHtml } from '../src/report-html.ts';

const page = readFileSync(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');

function inlineScripts(html: string): string[] {
  // An HTML parser ends a script at the first `</script`, whatever the JS around it says.
  return [...html.matchAll(/<script>([\s\S]*?)<\/script/g)].map((m) => m[1]!);
}

test('the web UI script compiles as the browser will split it', () => {
  const scripts = inlineScripts(page);
  assert.equal(scripts.length, 1);
  new Script(scripts[0]!);
});

test('a standalone report embeds data that cannot close the script early', () => {
  const html = renderHtml({
    file: 'c.compact', compiler: '0.31.1', compiles: true, compileErrors: [], compileProblems: [], pragma: '0.23',
    ledger: [], witnesses: [], circuits: [], leaks: [], discloses: [], advice: [],
    source: '// a comment with </script><script>alert(1)</script> in it',
  });
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 2);
  for (const s of scripts) new Script(s);
  assert.match(scripts[0]!, /window\.__XRAY__ = /);
});
