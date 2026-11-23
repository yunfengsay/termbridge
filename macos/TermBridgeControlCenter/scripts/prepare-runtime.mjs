// Build the App's self-contained Host runtime from this checkout, never a global CLI.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, '../..');
const destination = resolve(process.argv[2] || join(project, 'build/Runtime'));
if (process.platform !== 'darwin') throw new Error('Build the macOS runtime on macOS');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24 or newer');
const deps = execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' });
if (deps.split('\n').slice(1).some(line => line.trim() && !/^\s*\/(usr\/lib|System\/Library)\//.test(line))) {
  throw new Error('Use a standalone official Node runtime; this executable depends on external libraries');
}
mkdirSync(dirname(destination), { recursive: true });
const stage = mkdtempSync(join(dirname(destination), '.runtime-'));
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH };
const npm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
try {
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit', env });
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', stage], { cwd: root, env, encoding: 'utf8' }));
  execFileSync(process.execPath, [npm, 'install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund', join(stage, packed[0].filename)], { env, stdio: 'inherit' });
  // Keep dependency resolution beside the package, with no developer checkout symlinks.
  renameSync(join(stage, 'node_modules/agent-termbridge'), join(stage, 'package'));
  unlinkSync(join(stage, 'node_modules/.bin/tb'));
  unlinkSync(join(stage, 'node_modules/.bin/termbridge'));
  cpSync(process.execPath, join(stage, 'node'));
  const nodeLicense = join(dirname(process.execPath), '../LICENSE');
  if (!existsSync(nodeLicense)) throw new Error('Node redistribution licence is missing');
  cpSync(nodeLicense, join(stage, 'Node-LICENSE.txt'));
  rmSync(join(stage, packed[0].filename));
  const version = JSON.parse(readFileSync(join(stage, 'package/package.json'))).version;
  const actual = execFileSync(join(stage, 'node'), [join(stage, 'package/dist/cli.js'), '--version'], { encoding: 'utf8', env }).trim();
  if (actual !== version) throw new Error('Embedded CLI version mismatch');
  execFileSync(join(stage, 'node'), [join(stage, 'package/dist/cli.js'), 'lan-app', '--help'], { env, stdio: 'inherit' });
  const backup = destination + '.previous';
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, backup);
  renameSync(stage, destination);
  console.log('Embedded runtime prepared:', destination);
} catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
