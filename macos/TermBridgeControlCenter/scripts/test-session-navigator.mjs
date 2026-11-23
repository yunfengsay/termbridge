// Real disposable Relay + Host: run after building dist, under Node 24+.
// Never touches the user's Host, settings or Herdr.
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.TB_TEST_DIST || resolve(project, '../../dist');
const root = mkdtempSync(join(tmpdir(), 'tb-mac-navigator-'));
const children = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const common = { PATH: process.env.PATH, USER: process.env.USER, TMPDIR: tmpdir(), SHELL: '/bin/sh',
  TB_SECRET: 'session-navigator-test', TB_HERDR: 'off', TB_BACKEND: 'direct' };
function launch(file, extra, folder) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'settings.json'), '{}');
  writeFileSync(join(folder, 'config.json'), JSON.stringify({ shell: '/bin/sh', agents: {} }));
  const fd = openSync(join(folder, 'process.log'), 'a');
  const child = spawn(process.execPath, [join(dist, file)], { cwd: folder, env: { ...common, HOME: folder,
    TB_SETTINGS: join(folder, 'settings.json'), TB_CONFIG: join(folder, 'config.json'),
    TB_CONTEXT_STATE: join(folder, 'context.json'), TB_BRAIN_STATE: join(folder, 'brain.json'),
    TB_BRAIN_MEMORY: join(folder, 'memory.md'), TB_BRIDGE_SOCK: join(folder, 'bridge.sock'),
    TB_VOICE_LEARNING_DIR: join(folder, 'voice'), ...extra }, stdio: ['ignore', fd, fd] });
  closeSync(fd); children.push(child); return child;
}
try {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  launch('relay.js', { PORT: String(port) }, join(root, 'relay'));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await new Promise(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (!ready) await pause(100);
  }
  if (!ready) throw Error(`Relay failed; inspect ${root}`);
  launch('host.js', { RELAY_URL: `ws://127.0.0.1:${port}`, HOST_ID: 'navigator' }, join(root, 'navigator'));
  await pause(1500);
  const test = spawn('/usr/bin/swift', ['test', '--filter', 'SessionNavigatorRemoteTests'], { cwd: project,
    env: { ...process.env, TB_MACOS_NAVIGATOR_RELAY: `ws://127.0.0.1:${port}` }, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { test.on('error', reject); test.on('close', resolve); });
  if (code !== 0) throw Error(`Session navigator tests failed (${code}); logs: ${root}`);
  console.log('PASS: navigator attaches the session on screen, keeps recent ones attached, detaches past the limit and on close.');
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 30 && child.exitCode === null; i++) await pause(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }));
}
