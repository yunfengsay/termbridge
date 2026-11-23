// Real disposable Relay + two Hosts: run after building dist, under Node 24+.
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.TB_TEST_DIST || resolve(project, '../../dist');
const root = mkdtempSync(join(tmpdir(), 'tb-mac-create-'));
// A TUI startup handshake, without launching any actual coding agent. It exits
// if the creating client drops its connection or ignores terminal queries.
const handshake = join(root, 'terminal-handshake.cjs');
writeFileSync(handshake, `process.stdin.setRawMode(true);
process.stdout.write('\\x1b[6n');
const timeout = setTimeout(() => process.exit(7), 600);
let received = '';
process.stdin.on('data', chunk => {
  received += chunk.toString();
  if (/\\x1b\\[\\d+;\\d+R/.test(received)) {
    clearTimeout(timeout);
    process.stdout.write('TERMINAL_HANDSHAKE_OK\\r\\n');
    received = '';
  }
});
`);
const children = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const common = { PATH: process.env.PATH, USER: process.env.USER, TMPDIR: tmpdir(), SHELL: '/bin/bash',
  TB_SECRET: 'session-creation-test', TB_HERDR: 'off', TB_BACKEND: 'direct' };
function launch(file, extra, folder) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'settings.json'), '{}');
  writeFileSync(join(folder, 'config.json'), JSON.stringify({ shell: '/bin/sh', agents: {
    'qa-shell': 'exec /bin/bash --noprofile --norc',
    'qa-handshake': `exec '${process.execPath}' '${handshake}'`,
    'qa-failed': "printf 'FIXTURE_STARTUP_FAILED\\n'; exit 7",
  } }));
  const fd = openSync(join(folder, 'process.log'), 'a');
  const child = spawn(process.execPath, [join(dist, file)], { cwd: folder, env: { ...common,
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
  for (const host of ['create-a', 'create-b']) launch('host.js', { RELAY_URL: `ws://127.0.0.1:${port}`, HOST_ID: host }, join(root, host));
  await pause(1500);
  const cwd = join(root, '工作目录'); mkdirSync(cwd);
  const test = spawn('/usr/bin/swift', ['test', '--filter', 'MacSessionCreationTests'], { cwd: project,
    env: { ...process.env, TB_MACOS_CREATE_RELAY: `ws://127.0.0.1:${port}`, TB_MACOS_CREATE_CWD: cwd }, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { test.on('error', reject); test.on('close', resolve); });
  if (code !== 0) throw Error(`Session creation tests failed (${code}); logs: ${root}`);
  console.log('PASS: Host selection, one creation, cwd, terminal attach/focus/input, rejected credentials.');
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 30 && child.exitCode === null; i++) await pause(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }));
  // Keep small logs on failure for diagnosis; never touch user Host data.
}
