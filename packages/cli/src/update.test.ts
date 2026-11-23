import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { newerRelease, updateNpmPackage } from './update.js';

async function fixture(t: test.TestContext, failure = '') {
  const directory = await mkdtemp('/tmp/tb-update-'), root = join(directory, 'node_modules/agent-termbridge');
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'agent-termbridge', version: '1.0.0' }));
  await writeFile(join(root, 'old'), 'retained');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let restarted = 0;
  const options = { packageRoot: root, current: '1.0.0', npm: '/fixture/npm-cli.js', log: () => {},
    reload: async (path: string) => { assert.equal(path, root); restarted++; return 2; },
    runner: async (_: string, args: string[]) => {
      if (args[1] === 'view') return '"1.2.0"';
      if (args[1] === 'install') {
        const staged = join(args[args.indexOf('--prefix') + 1], 'lib/node_modules/agent-termbridge');
        await mkdir(join(staged, 'dist'), { recursive: true });
        await writeFile(join(staged, 'package.json'), JSON.stringify({ name: 'agent-termbridge', version: '1.2.0' }));
        await writeFile(join(staged, 'dist/cli.js'), 'candidate'); return '';
      }
      if (args[1] === '--version') return failure === 'version' ? '1.1.0' : '1.2.0';
      if (args[0] === '-e') { if (failure === 'pty') throw Error('PTY cannot load'); return ''; }
      throw Error('unexpected runner call');
    } };
  return { directory, root, options, restarted: () => restarted };
}
test('version checks never downgrade and handle stable promotion', () => {
  assert.equal(newerRelease('1.1.0', '1.2.0'), false);
  assert.equal(newerRelease('1.2.0', '1.2.0'), false);
  assert.equal(newerRelease('1.2.0', '1.2.0-beta.1'), true);
  assert.equal(newerRelease('1.10.0', '1.9.9'), true);
  assert.throws(() => newerRelease('latest', '1.0.0'));
});
test('staged update retains backup, swaps verified runtime, then reloads owned serves', async t => {
  const f = await fixture(t); const result = await updateNpmPackage(f.options);
  assert.equal(result.status, 'updated'); assert.equal(result.restarted, 2); assert.equal(f.restarted(), 1);
  assert.equal(JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8')).version, '1.2.0');
  assert.equal(await readFile(join(result.backup!, 'old'), 'utf8'), 'retained');
  assert.equal((await readdir(join(f.directory, 'node_modules'))).filter(name => name.startsWith('.')).length, 0);
});
test('version or native-runtime verification failure leaves old CLI intact', async t => {
  for (const failure of ['version', 'pty']) {
    const f = await fixture(t, failure); await assert.rejects(updateNpmPackage(f.options));
    assert.equal(await readFile(join(f.root, 'old'), 'utf8'), 'retained'); assert.equal(f.restarted(), 0);
    assert.deepEqual(await readdir(join(f.directory, 'node_modules')), ['agent-termbridge']);
  }
});
test('check only does not stage or restart; restart failure is reported as installed with a warning', async t => {
  const f = await fixture(t);
  assert.equal((await updateNpmPackage({ ...f.options, check: true })).status, 'available'); assert.equal(f.restarted(), 0);
  const result = await updateNpmPackage({ ...f.options, reload: async () => { throw Error('uncertain'); } });
  assert.equal(result.status, 'updated'); assert.equal(result.restartError, 'uncertain');
});
