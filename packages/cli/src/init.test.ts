import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getInitStatus,
  initPaths,
  installInit,
  isAgentPaneBusy,
  normalizeAgentArgs,
  resolveAgentExecutable,
  shouldIntercept,
  stripShimPath,
  uninstallInit,
} from './init.js';

test('tb init installs idempotent PATH shims and preserves an rc backup', () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-init-'));
  const rcFile = join(home, '.zshrc');
  writeFileSync(rcFile, 'export EXISTING=1\n');
  const paths = initPaths({ TB_INIT_HOME: home, TB_INIT_RC: rcFile, TB_INIT_SHELL: '/bin/zsh' });
  const cliEntrypoint = join(home, 'bin', 'tb');
  mkdirSync(join(home, 'bin'));
  writeFileSync(cliEntrypoint, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
  chmodSync(cliEntrypoint, 0o755);
  const integrations: string[] = [];
  const first = installInit(
    paths,
    (agent) => {
      integrations.push(agent);
      return undefined;
    },
    cliEntrypoint,
  );

  assert.equal(first.changed, true);
  assert.ok(first.backup);
  assert.equal(readFileSync(first.backup!, 'utf8'), 'export EXISTING=1\n');
  assert.deepEqual(integrations, ['codex', 'claude']);
  assert.match(readFileSync(rcFile, 'utf8'), /termbridge agent interception/);
  const dispatcher = join(paths.shimsDir, '.agent-shim');
  assert.match(readFileSync(dispatcher, 'utf8'), /exec "\$shim_dir\/\.tb" __agent-shim "\$agent" "\$@"/);
  assert.equal(readlinkSync(join(paths.shimsDir, '.tb')), cliEntrypoint);
  for (const agent of ['codex', 'claude']) {
    const shim = join(paths.shimsDir, agent);
    assert.equal(lstatSync(shim).isSymbolicLink(), true);
    assert.equal(readlinkSync(shim), '.agent-shim');
    assert.equal(statSync(shim).mode & 0o111, 0o111);
  }
  const linkedInvocation = spawnSync(join(paths.shimsDir, 'codex'), ['--version'], {
    env: { ...process.env, PATH: `${paths.shimsDir}:${join(home, 'bin')}:/usr/bin:/bin` }, encoding: 'utf8',
  });
  assert.equal(linkedInvocation.status, 0);
  assert.equal(linkedInvocation.stdout, '__agent-shim\ncodex\n--version\n');

  const second = installInit(paths, () => undefined, cliEntrypoint);
  assert.equal(second.changed, false);
  assert.equal((readFileSync(rcFile, 'utf8').match(/>>> termbridge agent interception/g) || []).length, 1);
  assert.equal(getInitStatus(paths).installed, true);

  const removed = uninstallInit(paths);
  assert.equal(removed.changed, true);
  assert.equal(readFileSync(rcFile, 'utf8'), 'export EXISTING=1\n');
  assert.equal(getInitStatus(paths).installed, false);
});

test('shim path removal keeps the upgraded real executable discoverable', () => {
  assert.equal(stripShimPath('/shim:/new/codex:/usr/bin:/shim', '/shim'), '/new/codex:/usr/bin');
  assert.equal(isAgentPaneBusy('', '{"error":{"code":"agent_pane_busy"}}'), true);
  assert.equal(isAgentPaneBusy('', '{"error":{"code":"agent_not_found"}}'), false);
});

test('agent resolution follows PATH even when a package-manager hint points to another installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-agent-resolution-'));
  const first = join(root, 'first');
  const alternate = join(root, 'alternate');
  mkdirSync(first);
  mkdirSync(alternate);
  for (const directory of [first, alternate]) {
    const executable = join(directory, 'codex');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
  }

  assert.equal(
    resolveAgentExecutable('codex', `${first}:${alternate}`, { PNPM_HOME: alternate }),
    join(first, 'codex'),
  );
});

test('installed wrapper follows a moved CLI and an updated launcher without reinstalling shims', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-dynamic-shim-'));
  const paths = initPaths({ TB_INIT_HOME: root, TB_INIT_SHELL: '/bin/zsh' });
  const oldBin = join(root, 'old bin'), newBin = join(root, 'new bin');
  for (const dir of [oldBin, newBin]) mkdirSync(dir);
  const launcher = (directory: string, version: string) => {
    const file = join(directory, 'tb');
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}' "$@"\n`, { mode: 0o755 });
    return file;
  };
  installInit(paths, () => undefined, launcher(oldBin, 'old'));
  const invoke = (bin: string) => spawnSync(join(paths.shimsDir, 'codex'), ['--version', 'argument with spaces'], {
    env: { ...process.env, PATH: `${paths.shimsDir}:${bin}:/usr/bin:/bin` }, encoding: 'utf8',
  });
  assert.equal(invoke(oldBin).stdout, 'old\n__agent-shim\ncodex\n--version\nargument with spaces\n');
  launcher(newBin, 'new');
  assert.equal(invoke(newBin).stdout, 'new\n__agent-shim\ncodex\n--version\nargument with spaces\n');
  launcher(newBin, 'updated-in-place');
  assert.equal(invoke(newBin).stdout, 'updated-in-place\n__agent-shim\ncodex\n--version\nargument with spaces\n');
  assert.equal(invoke('/usr/bin').stdout, 'old\n__agent-shim\ncodex\n--version\nargument with spaces\n');
});

test('only interactive agent sessions are intercepted', () => {
  const stdinTty = process.stdin.isTTY;
  const stdoutTty = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    assert.equal(shouldIntercept('codex', [], {}), true);
    assert.equal(shouldIntercept('codex', ['--version'], {}), false);
    assert.equal(shouldIntercept('codex', ['exec', 'echo ok'], {}), false);
    assert.equal(shouldIntercept('claude', ['--print', 'hi'], {}), false);
    assert.equal(shouldIntercept('claude', [], { HERDR_ENV: '1' }), false);
    assert.equal(shouldIntercept('codex', [], { TB_SESSION: 'sess-1' }), false,
      'A Host-owned PTY must not create a second Herdr session and hold its controller');
    assert.equal(shouldIntercept('claude', [], { TB_SESSION: 'sess-2' }), false);
    assert.equal(shouldIntercept('codex', [], { TB_SESSION: '' }), true);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
  }
});

test('legacy Codex yolo flag follows the current upstream spelling', () => {
  assert.deepEqual(
    normalizeAgentArgs('codex', ['--yolo', '-m', 'gpt-5']),
    ['--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5'],
  );
  assert.deepEqual(normalizeAgentArgs('claude', ['--yolo']), ['--yolo']);
  assert.deepEqual(normalizeAgentArgs('codex', ['--version']), ['--version']);
});
