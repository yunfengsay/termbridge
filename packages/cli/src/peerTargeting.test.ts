import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

test('CLI forwards --device for every desktop command and preserves argv after --', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-peer-target-'));
  const sock = join(dir, 'bridge.sock');
  const input = join(dir, 'input.txt');
  writeFileSync(input, 'fixture');
  const requests: Array<{ op: string; args: { deviceId?: string; argv?: string[] } }> = [];
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      requests.push(JSON.parse(data));
      socket.end(JSON.stringify({ ok: true, exit: 0, data: { entries: [], content: 'fixture', encoding: 'utf8', bytes: 7 } }) + '\n');
    });
  });
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  server.listen(sock);
  await once(server, 'listening');
  const run = (args: string[]) => new Promise<{ code: number | null; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/index.ts', 'peer', ...args], {
      env: { ...process.env, TB_BRIDGE_SOCK: sock, TB_SESSION: 'fixture-session', TB_BRIDGE_TOKEN: 'fixture-token' },
    });
    let error = '';
    child.stdout.resume();
    child.stderr.on('data', (data) => error += data);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, error }));
  });
  const cases = [
    ['exec', '--device', 'office', '--', 'echo', '--device', 'literal-argument'],
    ['read', '/tmp/file', '--device', 'office'],
    ['write', '/tmp/file', '--from', input, '--device', 'office'],
    ['ls', '/tmp', '--device', 'office'], ['stat', '/tmp/file', '--device', 'office'],
    ['info', '--device', 'office'],
    ['logcat', '--device', 'office'], ['apk', 'status', 'fixture-artifact', '--device', 'office'],
    ['apk', 'retry', 'fixture-artifact', '--device', 'office'], ['apk', 'delete', 'fixture-artifact', '--device', 'office'],
  ];
  for (const args of cases) {
    const result = await run(args);
    assert.equal(result.code, 0, result.error);
    assert.equal(requests.at(-1)?.args.deviceId, 'office', args.join(' '));
  }
  assert.deepEqual(requests[0].args.argv, ['echo', '--device', 'literal-argument']);
  const count = requests.length;
  assert.notEqual((await run(['exec', '--device', '--', 'echo'])).code, 0);
  assert.equal(requests.length, count, 'invalid target must not silently invoke any remote command');
  assert.equal((await run(['list'])).code, 0);
  assert.equal(requests.at(-1)?.op, 'peer.list');
});
