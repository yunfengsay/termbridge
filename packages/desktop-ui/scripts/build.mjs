import { build } from 'esbuild';
import { cpSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
const target = resolve(process.argv[2] ?? resolve(root, 'dist/desktop'));
mkdirSync(target, { recursive: true });
const result = await build({ entryPoints: [resolve(here, '../src/viewer.js')], bundle: true, format: 'esm', platform: 'browser', target: ['chrome110', 'safari16'], minify: true, legalComments: 'inline', write: false });
// noVNC probes WebCodecs with top-level await. Preserve that probe inside one async
// entrypoint so native file WebViews do not need cross-origin module loading.
writeFileSync(resolve(target, 'desktop.js'), '(async()=>{\n"use strict";\n' + result.outputFiles[0].text + '\n})().catch(()=>{document.getElementById("status").textContent="桌面组件加载失败"});\n');
for (const file of ['index.html', 'desktop.css']) copyFileSync(resolve(here, '../src', file), resolve(target, file));
const require = createRequire(import.meta.url), novnc = resolve(dirname(require.resolve('@novnc/novnc')), '..');
cpSync(novnc, resolve(target, 'novnc-source'), { recursive: true });
writeFileSync(resolve(target, 'THIRD_PARTY_LICENSES.txt'), 'noVNC 1.7.0; https://github.com/novnc/noVNC/tree/v1.7.0\nUnmodified corresponding source and notices: novnc-source/\n\n' + readFileSync(resolve(novnc, 'LICENSE.txt'), 'utf8'));
