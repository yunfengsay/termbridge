import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HOST_SERVICE_LABEL,
  HostServiceManager,
  renderHostLaunchAgent,
  type CommandResult,
  type HostServiceDependencies,
} from './hostService.js';

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'tb-host-service-'));
  const nodePath = join(home, 'node');
  const hostEntrypoint = join(home, 'host.js');
  const shell = join(home, 'zsh');
  const helper = join(home, 'spawn-helper');
  for (const file of [nodePath, hostEntrypoint, shell, helper]) {
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  }
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, nodePath, hostEntrypoint, shell, helper };
}

function launchctl(): {
  calls: string[][];
  run: HostServiceDependencies['runLaunchctl'];
} {
  const calls: string[][] = [];
  let loaded = false;
  const run = (args: string[]): CommandResult => {
    calls.push(args);
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap' || args[0] === 'kickstart') loaded = true;
    if (args[0] === 'print') {
      return loaded
        ? { status: 0, stdout: 'state = running\npid = 4242\n', stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('managed Host plist captures proxy and safely quotes executable paths', (t) => {
  const files = fixture(t);
  const plist = renderHostLaunchAgent({
    ...files,
    shell: files.shell,
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:7890?a=1&b=2',
      NO_PROXY: 'localhost,127.0.0.1',
    },
  });

  assert.match(plist, /Managed by `tb host`/);
  assert.match(plist, /<key>HTTPS_PROXY<\/key>/);
  assert.match(plist, /http:\/\/127\.0\.0\.1:7890\?a=1&amp;b=2/);
  assert.match(plist, /<key>NO_PROXY<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.doesNotMatch(plist, /TB_SECRET|DASHSCOPE_API_KEY/);
});

test('tb host start runs in the background without enabling login startup', (t) => {
  const files = fixture(t);
  const fake = launchctl();
  const service = new HostServiceManager(
    { ...files, shell: files.shell, env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:7890' } },
    {
      platform: 'darwin',
      uid: 501,
      runLaunchctl: fake.run,
      repairSpawnHelpers: () => ({ found: [files.helper], repaired: [] }),
    },
  );

  const result = service.start();

  assert.equal(result.status.running, true);
  assert.equal(result.status.pid, 4242);
  assert.equal(result.status.loginStart, false);
  assert.equal(existsSync(service.paths.servicePlist), true);
  assert.equal(existsSync(service.paths.loginPlist), false);
  assert.deepEqual(fake.calls.slice(0, 4), [
    ['bootout', `gui/501/${HOST_SERVICE_LABEL}`],
    ['enable', `gui/501/${HOST_SERVICE_LABEL}`],
    ['bootstrap', 'gui/501', service.paths.servicePlist],
    ['kickstart', '-k', `gui/501/${HOST_SERVICE_LABEL}`],
  ]);
});

test('tb host enable preserves an unmanaged plist and enables login startup', (t) => {
  const files = fixture(t);
  const fake = launchctl();
  const service = new HostServiceManager(
    { ...files, shell: files.shell, env: { PATH: '/usr/bin' } },
    {
      platform: 'darwin',
      uid: 502,
      now: () => new Date('2026-08-30T10:00:00.000Z'),
      runLaunchctl: fake.run,
      repairSpawnHelpers: () => ({ found: [files.helper], repaired: [] }),
    },
  );
  mkdirSync(join(files.home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(service.paths.loginPlist, '<plist>user-owned</plist>', { flag: 'w' });

  const result = service.enableLoginStart();

  assert.equal(result.status.loginStart, true);
  assert.ok(result.backup);
  assert.equal(readFileSync(result.backup!, 'utf8'), '<plist>user-owned</plist>');
  assert.match(readFileSync(service.paths.loginPlist, 'utf8'), /Managed by `tb host`/);
});

test('tb host restart repairs node-pty helper permissions and reloads current environment', (t) => {
  const files = fixture(t);
  chmodSync(files.helper, 0o644);
  const fake = launchctl();
  const service = new HostServiceManager(
    { ...files, shell: files.shell, env: { PATH: '/usr/bin', HTTP_PROXY: 'http://127.0.0.1:7890' } },
    {
      platform: 'darwin',
      uid: 503,
      runLaunchctl: fake.run,
      repairSpawnHelpers: () => {
        chmodSync(files.helper, 0o755);
        return { found: [files.helper], repaired: [files.helper] };
      },
    },
  );

  const result = service.restart();

  assert.deepEqual(result.repaired, [files.helper]);
  assert.match(readFileSync(service.paths.servicePlist, 'utf8'), /<key>HTTP_PROXY<\/key>/);
  assert.equal(result.status.running, true);
});

test('tb host stop unloads the job and status reports it stopped', (t) => {
  const files = fixture(t);
  const fake = launchctl();
  const service = new HostServiceManager(
    { ...files, shell: files.shell, env: { PATH: '/usr/bin' } },
    { platform: 'darwin', uid: 504, runLaunchctl: fake.run },
  );

  const status = service.stop();

  assert.equal(status.running, false);
  assert.equal(status.state, 'stopped');
  assert.deepEqual(fake.calls[0], ['bootout', `gui/504/${HOST_SERVICE_LABEL}`]);
});

test('managed restart preserves only configured HA credential from active plist without copying other secrets', t => {
  const files = fixture(t), fake = launchctl();
  const root = join(files.home, '.termbridge');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ homeAssistant: { enabled: true, tokenEnv: 'TB_HA_TOKEN' } }));
  const reads: string[][] = [];
  const service = new HostServiceManager({ ...files, env: { PATH: '/usr/bin', DASHSCOPE_API_KEY: 'must-not-copy' } }, {
    platform: 'darwin', uid: 501, runLaunchctl: fake.run, repairSpawnHelpers: () => ({ found: [files.helper], repaired: [] }),
    readPlistValue: (path, key) => { reads.push([path, key]); return key.endsWith('.TB_HA_TOKEN') ? 'fixture-ha-secret' : undefined; },
  });
  mkdirSync(join(files.home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(service.paths.loginPlist, renderHostLaunchAgent(files));
  service.restart();
  assert.deepEqual(reads, ['TB_INTENT_HINTS', 'TYPESAFE_API_KEY', 'TB_HA_TOKEN']
    .map(key => [service.paths.loginPlist, `EnvironmentVariables.${key}`]));
  const result = readFileSync(service.paths.loginPlist, 'utf8');
  assert.match(result, /fixture-ha-secret/);
  assert.doesNotMatch(result, /must-not-copy|DASHSCOPE_API_KEY/);
  assert.equal(readFileSync(service.paths.servicePlist, 'utf8'), result);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ homeAssistant: { enabled: false } }));
  service.restart();
  assert.doesNotMatch(readFileSync(service.paths.loginPlist, 'utf8'), /fixture-ha-secret|TB_HA_TOKEN/);
});

test('Jev Host-only configuration survives restart; explicit empty key removes it', t => {
  const files = fixture(t), fake = launchctl();
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  const service = new HostServiceManager({ ...files, env }, {
    platform: 'darwin', uid: 501, runLaunchctl: fake.run,
    repairSpawnHelpers: () => ({ found: [files.helper], repaired: [] }),
    readPlistValue: (_path, key) => ({ 'EnvironmentVariables.TB_INTENT_HINTS': 'hint',
      'EnvironmentVariables.TYPESAFE_API_KEY': 'fixture-jev-secret' })[key],
  });
  mkdirSync(join(files.home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(service.paths.loginPlist, renderHostLaunchAgent(files));
  service.restart();
  assert.match(readFileSync(service.paths.loginPlist, 'utf8'), /fixture-jev-secret/);
  assert.match(readFileSync(service.paths.loginPlist, 'utf8'), /<string>hint<\/string>/);
  env.TYPESAFE_API_KEY = ''; env.TB_INTENT_HINTS = 'off';
  service.restart();
  assert.doesNotMatch(readFileSync(service.paths.loginPlist, 'utf8'), /fixture-jev-secret|TYPESAFE_API_KEY/);
  assert.match(readFileSync(service.paths.loginPlist, 'utf8'), /<string>off<\/string>/);
});
