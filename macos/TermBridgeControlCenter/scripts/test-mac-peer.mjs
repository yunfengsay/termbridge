// Native Mac Peer -> disposable Relay/Host -> real CLI/bridge. No user services.
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '..');
const dist = process.env.TB_TEST_DIST || resolve(project, '../../dist');
const token = 'isolated-mac-peer-test-token';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv[2] === 'request') {
  const [, , , socket, op, args] = process.argv;
  const data = await new Promise((resolve, reject) => {
    const conn = connect(socket); let output = '';
    conn.setTimeout(10_000, () => { conn.destroy(); reject(Error('test bridge timeout')); });
    conn.on('connect', () => conn.write(JSON.stringify({ token, session: 'mac-peer-test', op, args: JSON.parse(args), timeoutMs: 4000 }) + '\n'));
    conn.on('data', bytes => { output += bytes; });
    conn.on('end', () => resolve(output)); conn.on('error', reject);
  });
  process.stdout.write(data);
} else if (process.argv[2] === 'cli') {
  const child = spawn(process.execPath, [join(dist, 'cli.js'), '--host', basename(dirname(process.argv[3])), 'peer', ...JSON.parse(process.argv[4])], {
    env: { PATH: process.env.PATH, RELAY_URL: process.env.TB_MACOS_PEER_RELAY, TB_SECRET: 'mac-peer-test-secret', TB_SETTINGS: process.argv[3] + '.cli-settings' }, stdio: 'inherit',
  });
  process.exitCode = await new Promise(resolve => child.on('close', resolve));
} else {
  // /tmp keeps Unix-domain socket paths within Darwin's 104-byte limit.
  const root = mkdtempSync('/tmp/tb-mac-peer-');
  const children = [];
  function launch(file, extra, label) {
    const folder = join(root, label); mkdirSync(folder);
    writeFileSync(join(folder, 'settings.json'), '{}');
    writeFileSync(join(folder, 'config.json'), JSON.stringify({ shell: '/bin/sh', agents: {} }));
    const fd = openSync(join(folder, 'process.log'), 'a');
    const child = spawn(process.execPath, [join(dist, file)], { cwd: folder, env: {
      PATH: process.env.PATH, USER: process.env.USER, TMPDIR: tmpdir(), SHELL: '/bin/bash',
      TB_SECRET: 'mac-peer-test-secret', TB_HERDR: 'off', TB_BACKEND: 'direct',
      TB_SETTINGS: join(folder, 'settings.json'), TB_CONFIG: join(folder, 'config.json'),
      TB_CONTEXT_STATE: join(folder, 'context.json'), TB_BRAIN_STATE: join(folder, 'brain.json'),
      TB_BRAIN_MEMORY: join(folder, 'memory.md'), TB_BRIDGE_SOCK: join(folder, 'bridge.sock'),
      TB_BRIDGE_TOKEN: token, TB_VOICE_LEARNING_DIR: join(folder, 'voice'), ...extra,
    }, stdio: ['ignore', fd, fd] });
    closeSync(fd); children.push(child);
  }
  try {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    launch('relay.js', { PORT: String(port) }, 'relay');
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await new Promise(resolve => {
        const conn = connect(port, '127.0.0.1');
        conn.on('connect', () => { conn.destroy(); resolve(true); }); conn.on('error', () => resolve(false));
      });
      if (!ready) await pause(100);
    }
    if (!ready) throw Error('Test Relay did not start');
    for (const id of ['peer-a', 'peer-b']) launch('host.js', { HOST_ID: id, RELAY_URL: `ws://127.0.0.1:${port}` }, id);
    await pause(1000);
    const test = spawn('/usr/bin/swift', ['test', '--filter', 'MacPeerIntegrationTests'], { cwd: project, env: {
      ...process.env, TB_MACOS_PEER_RELAY: `ws://127.0.0.1:${port}`, TB_MACOS_PEER_ROOT: root,
      TB_MACOS_PEER_NODE: process.execPath, TB_MACOS_PEER_SCRIPT: script, TB_TEST_DIST: dist,
    }, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { test.on('error', reject); test.on('close', resolve); });
    if (code !== 0) throw Error(`Mac Peer tests failed (${code}); logs: ${root}`);
    console.log('PASS native Mac Peer: no terminal, two Hosts/two clients, real CLI read, write/exec, per-Host denial, revoke/cancel, reconnect.');
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 30 && child.exitCode === null; i++) await pause(100);
      if (child.exitCode === null) child.kill('SIGKILL');
    }));
  }
}
