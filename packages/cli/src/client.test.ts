import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { encodeControl, parseFrame, FrameType } from '@termbridge/protocol';

test('terminal allocation failure exits CLI once with the actual error instead of retrying', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-pty-error-'));
  const settings = join(directory, 'settings.json');
  writeFileSync(settings, '{}');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let requests = 0;
  const message = 'Cannot start terminal: 终端句柄耗尽 (PTY handles exhausted). Restart the Host to release terminal handles.';
  server.on('connection', ws => {
    ws.send(encodeControl({ t: 'auth_challenge', nonce: 'fixture', required: false }));
    ws.on('message', raw => {
      const f = parseFrame(raw as Buffer);
      if (f.type === FrameType.Control && f.msg.t === 'session_create') {
        requests++;
        ws.send(encodeControl({ t: 'error', message }));
      }
    });
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/index.ts', 'new', '--', '/bin/echo', 'x'], {
    env: { ...process.env, TB_SETTINGS: settings, RELAY_URL: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
      TB_SECRET: 'fixture', RELAY_PIN: '', TB_PEER_ID_FILE: join(directory, 'peer-id') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(code, 1, output);
    assert.equal(requests, 1);
    assert.ok(output.includes(message), output);
    assert.doesNotMatch(output, /reconnecting/);
  } finally {
    clearTimeout(timeout);
    child.kill();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
