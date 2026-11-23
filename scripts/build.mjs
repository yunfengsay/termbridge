// Bundle the three long-running entrypoints into dist/ for the npm package.
//
// Everything is bundled in (protocol, settings, ws, msgpackr, zod, @clack, …)
// EXCEPT truly-native / optional-native modules, which stay external and
// resolve from the installed package's own node_modules:
//   node-pty                    — required native PTY; a real runtime dependency
//   msgpackr-extract            — optional msgpackr accelerator (pure-JS fallback)
//   bufferutil / utf-8-validate — optional ws accelerators   (pure-JS fallback)
//
// `tb` (dist/cli.js) spawns dist/relay.js / dist/host.js with the same node, so
// the three live side-by-side in dist/. `define: __TB_BUNDLED__` flips the CLI
// from the dev path (tsx on packages/*/src) to this layout — see cli.ts.
import { build } from 'esbuild';
import { chmodSync, cpSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// ESM output, but our deps (node-pty, msgpackr, cli-table3, selfsigned) reach
// for CJS globals. Provide them up top so the bundle is self-contained.
const esmShim = [
  "import { createRequire as __tbRequire } from 'node:module';",
  "import { fileURLToPath as __tbFileURL } from 'node:url';",
  "import { dirname as __tbDirname } from 'node:path';",
  'const require = __tbRequire(import.meta.url);',
  'const __filename = __tbFileURL(import.meta.url);',
  'const __dirname = __tbDirname(__filename);',
].join('\n');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['sharp', 'node-pty', 'msgpackr-extract', 'bufferutil', 'utf-8-validate'],
  define: { __TB_BUNDLED__: 'true', __TB_VERSION__: JSON.stringify(version) },
  absWorkingDir: root,
  logLevel: 'info',
  legalComments: 'none',
};

rmSync(join(root, 'dist'), { recursive: true, force: true });

// cli.js needs the shebang first; relay.js/host.js are spawned via `node …`.
await build({
  ...common,
  entryPoints: { cli: 'packages/cli/src/cli.ts' },
  outdir: 'dist',
  banner: { js: '#!/usr/bin/env node\n' + esmShim },
});

// Cloudflare's relay is a separate, browser-compatible bundle. It is shipped
// beside its Wrangler config so an installed `tb` can deploy it without the
// source workspace or Node-only relay dependencies.
mkdirSync(join(root, 'cloudflare'), { recursive: true });
await build({
  entryPoints: { worker: 'packages/cloudflare-relay/src/index.ts' },
  outfile: 'cloudflare/worker.js',
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  external: ['node:buffer', 'cloudflare:workers'],
  logLevel: 'info',
  legalComments: 'none',
});

await build({
  ...common,
  entryPoints: {
    relay: 'packages/relay/src/index.ts',
    host: 'packages/host/src/index.ts',
    'voice-learning-worker': 'packages/host/src/voiceLearningWorker.ts',
    'voice-training-worker': 'packages/host/src/turnTrainingWorker.ts',
  },
  outdir: 'dist',
  banner: { js: esmShim },
});

chmodSync(join(root, 'dist', 'cli.js'), 0o755);
// Optional Python training engine only: never package private examples, venvs or model weights.
const engine = join(root, 'training', 'livekit-turn');
mkdirSync(join(root, 'dist', 'livekit-turn'), { recursive: true });
for (const file of readdirSync(engine).filter(name => name.endsWith('.py') || ['README.md', 'PLAN.md', 'pyproject.toml', 'uv.lock'].includes(name))) {
  copyFileSync(join(engine, file), join(root, 'dist', 'livekit-turn', file));
}
console.log('built → dist/{cli,relay,host}.js + cloudflare/worker.js');

// One shared browser extension and native connection component for both desktop installers.
mkdirSync(join(root, 'dist/browser-extension'), { recursive: true });
copyFileSync(join(root, 'browser-extension/bridge.mjs'), join(root, 'dist/browser-extension/bridge.mjs'));
cpSync(join(root, 'browser-extension/extension'), join(root, 'dist/browser-extension/extension'), { recursive: true });

for (const target of ['dist/desktop', 'android/app/src/main/assets/desktop', 'ios/Termbridge/Resources/Desktop', 'macos/TermBridgeControlCenter/Sources/TermBridgeControlCenter/Resources/Desktop']) {
  execFileSync(process.execPath, [join(root, 'packages/desktop-ui/scripts/build.mjs'), join(root, target)], { stdio: 'inherit' });
}
if (process.platform === 'darwin') {
  const nativeArgs = ['build', '--package-path', join(root, 'macos/TermBridgeDesktop'), '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64'];
  execFileSync('swift', nativeArgs, { stdio: 'inherit' });
  const bin = execFileSync('swift', [...nativeArgs, '--show-bin-path'], { encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'dist/native'), { recursive: true });
  copyFileSync(join(bin, 'termbridge-desktop'), join(root, 'dist/native/termbridge-desktop'));
  chmodSync(join(root, 'dist/native/termbridge-desktop'), 0o755);
}
