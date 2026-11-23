// node-pty ships a prebuilt `spawn-helper` binary that pnpm's store extraction
// (and some npm flows) can leave without its execute bit, causing
// `posix_spawnp failed` at runtime. Restore +x on every install. No-op on
// Windows (uses conpty, no spawn-helper).
//
// Runs both in the dev workspace (cwd = repo root) AND from the installed npm
// package (`npm i -g agent-termbridge`), where node-pty is hoisted beside us or
// nested under the package — so we walk several candidate node_modules roots.
import { readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// node-pty is a host-only, Unix-only concern (Windows uses conpty — no
// spawn-helper). Skip entirely on Windows so a client-only install there never
// trips on this postinstall.
if (process.platform === 'win32') process.exit(0);

const seen = new Set();

function walk(dir, depth) {
  if (depth > 8 || seen.has(dir)) return;
  seen.add(dir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // Prune aggressively: only descend where node-pty prebuilds can live.
      if (
        e.name === 'node_modules' ||
        e.name === '.pnpm' ||
        e.name === 'prebuilds' ||
        e.name === 'build' ||
        e.name === 'Release' ||
        e.name.includes('node-pty') ||
        e.name.startsWith('darwin')
      ) {
        walk(p, depth + 1);
      }
    } else if (e.name === 'spawn-helper') {
      try {
        chmodSync(p, 0o755);
        console.log('[fix-pty-perms] chmod +x', p);
      } catch {
        /* best effort */
      }
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/scripts
const pkgRoot = join(here, '..'); // <pkg>
for (const root of [
  join(process.cwd(), 'node_modules'), // dev: repo root
  join(pkgRoot, 'node_modules'), // local install: nested under the package
  join(pkgRoot, '..'), // global install: the node_modules dir holding us
]) {
  walk(root, 0);
}
