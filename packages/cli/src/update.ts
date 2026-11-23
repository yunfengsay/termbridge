import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MacAppInstaller } from './macApp.js';
import { withAppControl } from './appControl.js';
import { reloadOwnedServes } from './serveSupervisor.js';

const exec = promisify(execFile);
type Runner = (file: string, args: string[]) => Promise<string>;
const run: Runner = async (file, args) => (await exec(file, args, { timeout: 600000, maxBuffer: 256 * 1024 })).stdout.trim();
export function newerRelease(candidate: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(current)) throw new Error('CLI version metadata is invalid');
  const a = candidate.split('.').map(Number), b = current.split(/[.\-+]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index++) { if (a[index] !== b[index]) return a[index] > b[index]; }
  return current.includes('-');
}

async function npmCLI(): Promise<string> {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].filter((value): value is string => !!value);
  for (const path of candidates) {
    try { await access(path); if (path.endsWith('npm-cli.js')) return path; } catch { /* next supported runtime layout */ }
  }
  throw new Error('找不到此 Node 的 npm。App 用户请从 App 添加命令行入口；独立安装请补齐 npm 后更新。');
}

/** Stage/validate before atomic replacement. Retain the old package for rollback
 * and running processes; never run an installer over the live package tree. */
export async function updateNpmPackage(options: { packageRoot: string; current: string; check?: boolean; npm: string;
  runner?: Runner; reload?: (root: string) => Promise<number>; log?: (message: string) => void }) {
  const runner = options.runner ?? run, log = options.log ?? console.log, root = resolve(options.packageRoot);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'agent-termbridge' || dirname(root).split(/[\\/]/).at(-1) !== 'node_modules' || !(await lstat(root)).isDirectory()) throw new Error('此 tb 不是独立安装；开发目录请先构建，不会覆盖源码。');
  log('正在检查 TB CLI 更新…');
  const latest = JSON.parse(await runner(process.execPath, [options.npm, 'view', 'agent-termbridge@latest', 'version', '--json', '--registry=https://registry.npmjs.org']));
  if (typeof latest !== 'string') throw new Error('npm 返回的版本无效');
  if (!newerRelease(latest, options.current)) return { status: 'current', version: options.current, restarted: 0 };
  if (options.check) return { status: 'available', version: latest, current: options.current, restarted: 0 };
  const lock = join(dirname(root), '.agent-termbridge-update');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`已有更新进行中。若上次更新中断，请先检查 ${lock} 后再重试。`); throw error; }
  let work: string | undefined;
  const backup = root + '.backup-' + randomUUID();
  try {
    // Another updater may have finished between the metadata query and lock.
    const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    if (!newerRelease(latest, installed)) return { status: 'current', version: installed, restarted: 0 };
    work = await mkdtemp(join(dirname(root), '.tb-update-'));
    log(`正在准备 TB ${latest}…`);
    await runner(process.execPath, [options.npm, 'install', '--global', '--prefix', work, `agent-termbridge@${latest}`,
      '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund']);
    const staged = join(work, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'agent-termbridge');
    const entry = join(staged, 'dist/cli.js');
    if ((await runner(process.execPath, [entry, '--version'])).trim() !== latest) throw new Error('更新候选版本验证失败，旧 CLI 未改动。');
    await runner(process.execPath, ['-e', "const {createRequire}=require('module'); const r=createRequire(process.argv[1]); const p=r('node-pty').spawn(process.execPath,['-e','process.exit(0)'],{env:process.env}); p.onExit(e=>process.exit(e.exitCode)); setTimeout(()=>process.exit(2),5000).unref();", entry]);
    await rename(root, backup);
    try { await rename(staged, root); } catch (error) { await rename(backup, root); throw error; }
    log('CLI 已更新，正在重启由这份 CLI 管理的 serve…');
    try {
      const restarted = await (options.reload ?? reloadOwnedServes)(root);
      return { status: 'updated', version: latest, restarted, backup };
    } catch (error) {
      return { status: 'updated', version: latest, backup, restartError: (error as Error).message };
    }
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function updateCLI(options: { entryDirectory: string; current: string; bundled: boolean; check?: boolean }) {
  if (!options.bundled) throw new Error('当前是源码开发入口，请使用项目构建命令；不会覆盖工作区。');
  const marker = '/Contents/Resources/Runtime/package/dist';
  const app = options.entryDirectory.endsWith(marker) ? options.entryDirectory.slice(0, -marker.length) : undefined;
  if (app) {
    if (options.check) return withAppControl({ action: 'update.check' });
    const installer = new MacAppInstaller(undefined, undefined, app);
    const before = await installer.status();
    try {
      const result = await installer.install();
      const changed = result.build !== before?.build;
      const restarted = changed ? await reloadOwnedServes(join(app, 'Contents/Resources/Runtime/package')) : 0;
      return { status: changed ? 'updated' : 'current', appVersion: result.version, restarted };
    } catch (error) {
      if (error instanceof Error && error.message.includes('请先正常退出 TermBridge App')) return withAppControl({ action: 'update.check' });
      throw error;
    }
  }
  return updateNpmPackage({ packageRoot: join(options.entryDirectory, '..'), current: options.current, check: options.check, npm: await npmCLI() });
}
