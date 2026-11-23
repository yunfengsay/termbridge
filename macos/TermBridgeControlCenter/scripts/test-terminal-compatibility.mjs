// Only disposable Relay/Host and fake Herdr transports. Never launches an Agent.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tb-terminal-compat-'));
const dist = resolve(project, '../../dist');
const children = [], sockets = new Set();
let input = '', screen = 'FIXTURE_READY', revision = 1;
const socketPath = join(root, 'herdr.sock');
const api = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  let text = '';
  socket.on('data', data => {
    text += data;
    if (!text.includes('\n')) return;
    const request = JSON.parse(text.slice(0, text.indexOf('\n')));
    const reply = result => socket.end(JSON.stringify({ id: request.id, result }) + '\n');
    switch (request.method) {
      case 'session.snapshot': return reply({ snapshot: {
        version: 'fixture', protocol: 19, workspaces: [{ workspace_id: 'wTest', label: 'Fixture' }], tabs: [], layouts: [],
        panes: [{ pane_id: 'wTest:p1', terminal_id: 'occupied', workspace_id: 'wTest', tab_id: 'wTest:t1',
          agent: 'codex', agent_status: 'idle', revision }], agents: [],
      }});
      case 'pane.read': return reply({ read: { text: request.params.source === 'recent'
        ? Array.from({ length: 200 }, (_, n) => `HISTORY_ROW_${n + 1}`).join('\n') + '\n' + screen
        : screen, revision } });
      case 'pane.send_input':
        input += request.params.text ?? '';
        if (request.params.keys?.includes('enter')) { screen = input; input = ''; revision++; }
        return reply({ type: 'ok' });
      case 'events.wait': return socket.end(JSON.stringify({ id: request.id, error: { code: 'unsupported_event_wait_match', message: 'fixture polling' } }) + '\n');
      default: return reply({ type: 'ok' });
    }
  });
});
const fixtureBin = join(root, 'controller-fixture');
writeFileSync(fixtureBin, '#!/bin/sh\nprintf "controller already attached\\n" >&2\nexit 1\n', { mode: 0o700 });
writeFileSync(join(root, 'settings.json'), '{}');
writeFileSync(join(root, 'config.json'), JSON.stringify({ shell: '/bin/sh', agents: {} }));
const common = { PATH: process.env.PATH, HOME: root, USER: 'fixture', TMPDIR: tmpdir(), TB_BACKEND: 'direct',
  TB_SECRET: 'compat-test-secret', TB_SETTINGS: join(root, 'settings.json'), TB_CONFIG: join(root, 'config.json'),
  TB_CONTEXT_STATE: join(root, 'context.json'), TB_BRIDGE_SOCK: join(root, 'bridge.sock'),
  TB_BRAIN_STATE: join(root, 'brain.json'), TB_BRAIN_MEMORY: join(root, 'memory.md'),
  TB_VOICE_LEARNING_DIR: join(root, 'voice'), TB_HERDR_SOCKET: socketPath, TB_HERDR_BIN: fixtureBin };
function launch(file, env) {
  const fd = openSync(join(root, file + '.log'), 'a');
  const child = spawn(process.execPath, [join(dist, file)], { cwd: root, env: { ...common, ...env }, stdio: ['ignore', fd, fd] });
  closeSync(fd); children.push(child);
}
try {
  await new Promise(resolve => api.listen(socketPath, resolve));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  launch('relay.js', { PORT: String(port) });
  launch('host.js', { RELAY_URL: `ws://127.0.0.1:${port}`, HOST_ID: 'compat' });
  await new Promise(resolve => setTimeout(resolve, 2000));
  const test = spawn('/usr/bin/swift', ['test', '--filter', 'TerminalCompatibilityTests'], { cwd: project,
    env: { ...process.env, TB_MACOS_COMPAT_RELAY: `ws://127.0.0.1:${port}` }, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { test.on('error', reject); test.on('close', resolve); });
  if (code !== 0) throw Error(`Terminal compatibility failed (${code}); logs: ${root}`);
  console.log('PASS: occupied native controller, compatible attach, phone and desktop input; fixture logs:', root);
} finally {
  for (const child of children) child.kill('SIGTERM');
  for (const socket of sockets) socket.destroy();
  api.close();
}
