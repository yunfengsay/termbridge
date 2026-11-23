import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacAppInstaller, macAppRelease, validateAppArchive, verifyAppDownload, type AppRunner } from './macApp.js';

const release = { version: '0.3.10', build: '14', url: '/download/TermBridge-0.3.10-macOS-AppleSilicon.zip?v=aaaaaaaaaaaa',
  sha256: 'a'.repeat(64), size: 100, minOS: '13.0', arch: 'arm64', format: 'zip', notarized: true };
test('app manifest allows only bounded official notarized Apple Silicon ZIP releases', () => {
  assert.equal(macAppRelease({ schema: 1, macos: release }).version, '0.3.10');
  for (const change of [{ url: '//evil.example/a.zip' }, { url: '/download/../../a.zip' }, { notarized: false },
    { size: 1e10 }, { arch: 'x64' }, { version: 'latest' }, { build: '-1' }, { sha256: 'bad' }]) {
    assert.throws(() => macAppRelease({ schema: 1, macos: { ...release, ...change } }));
  }
});
test('unsigned feed and substituted download cannot pass the pinned update key', () => {
  assert.throws(() => verifyAppDownload(Buffer.from('<rss/>'), Buffer.alloc(100), release));
  assert.throws(() => validateAppArchive(Buffer.from('not a zip')));
});
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), 'tb-app-install-')); t.after(() => rm(home, { recursive: true, force: true }));
  const app = join(home, 'Applications/TermBridge.app'); await mkdir(app, { recursive: true });
  await writeFile(join(app, 'keep.txt'), 'previous app');
  return { home, app };
}
test('corrupt download leaves existing app untouched and cleans staging', async t => {
  const { home, app } = await fixture(t);
  const runner: AppRunner = async (command, args) => {
    if (command.endsWith('sysctl')) return '1';
    if (command.endsWith('sw_vers')) return '26.0';
    if (command.endsWith('PlistBuddy')) return args[1].includes('CFBundleVersion') ? '13' : '0.3.9';
    if (command.endsWith('lsof')) throw Object.assign(new Error('no process'), { code: 1 });
    if (command.endsWith('curl')) {
      await writeFile(args[args.indexOf('--output') + 1], args.at(-1)?.endsWith('manifest.json') ? JSON.stringify({ schema: 1, macos: release }) : 'corrupt'); return '';
    }
    throw new Error('Unexpected mutation command: ' + command);
  };
  await assert.rejects(new MacAppInstaller(home, runner).install(() => {}), /校验失败/);
  assert.equal(await readFile(join(app, 'keep.txt'), 'utf8'), 'previous app');
  assert.deepEqual(await readdir(join(home, 'Applications')), ['TermBridge.app']);
});
test('running app is preserved; installer never kills or quits it', async t => {
  const { home, app } = await fixture(t);
  const runner: AppRunner = async (command, args) => {
    if (command.endsWith('sysctl')) return '1';
    if (command.endsWith('sw_vers')) return '26.0';
    if (command.endsWith('PlistBuddy')) return args[1].includes('CFBundleVersion') ? '13' : '0.3.9';
    if (command.endsWith('lsof')) return '12345';
    if (command.endsWith('curl')) { assert(args.at(-1)?.endsWith('manifest.json')); await writeFile(args[args.indexOf('--output') + 1], JSON.stringify({ schema: 1, macos: release })); return ''; }
    throw new Error('Unexpected process command');
  };
  await assert.rejects(new MacAppInstaller(home, runner).install(() => {}), /请先正常退出/);
  assert.equal(await readFile(join(app, 'keep.txt'), 'utf8'), 'previous app');
});
test('real official archive installs and verifies in a disposable Applications directory', { skip: process.env.TB_APP_INSTALL_LIVE !== '1' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'tb-real-app-')); t.after(() => rm(home, { recursive: true, force: true }));
  const installer = new MacAppInstaller(home);
  const installed = await installer.install(() => {});
  assert.equal(installed.path, join(home, 'Applications/TermBridge.app'));
  assert.deepEqual(await installer.status(), installed);
  assert.deepEqual(await installer.install(() => {}), installed, 'repeat install verifies and retains current release');
  const info = join(installed.path, 'Contents/Info.plist');
  await installer.runner('/usr/libexec/PlistBuddy', ['-c', 'Set CFBundleVersion 0', info]);
  await writeFile(join(installed.path, 'previous-install-marker'), 'retain me');
  assert.deepEqual(await installer.install(() => {}), installed, 'replace an older installation only after verification');
  const backups = (await readdir(join(home, 'Applications'))).filter(name => name.startsWith('TermBridge.app.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, 'Applications', backups[0], 'previous-install-marker'), 'utf8'), 'retain me');
});
