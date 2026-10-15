// Bundle the X-Ray page into the extension (media/report.html) so the visual report works
// without the CLI. Runs before packaging (vscode:prepublish).
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
mkdirSync(path.join(here, 'media'), { recursive: true });
copyFileSync(path.join(here, '..', 'web', 'index.html'), path.join(here, 'media', 'report.html'));
console.log('bundled media/report.html');
