import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeDesktop, isLocalScreenOperation } from './native.js';

const fixture = `
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.wait) return;
  if (message.crash) process.exit(2);
  if (message.eventFirst) console.log(JSON.stringify({event: 'frame', generation: 3, data: 'fixture'}));
  console.log(JSON.stringify({id: message.id, ok: true, data: {op: message.op, pid: process.pid}}));
});`;

test('desktop helper isolates request IDs, starts lazily and delivers events preceding replies', async (t) => {
  const desktop = new NativeDesktop({ executable: process.execPath, args: ['-e', fixture] });
  t.after(() => desktop.close());
  const events: string[] = [];
  desktop.onEvent = event => events.push(event.event);
  const replies = await Promise.all([
    desktop.request('status', { id: 'forged', op: 'press' }),
    desktop.request('start', { eventFirst: true }),
  ]);
  assert.equal(replies[0].ok, true);
  assert.equal((replies[0].data as { op: string }).op, 'status');
  assert.deepEqual(events, ['frame']);
  await desktop.close();
  assert.equal((await desktop.request('status')).ok, false);
});

test('timed out input fails every pending request and is never replayed on replacement', async (t) => {
  const desktop = new NativeDesktop({ executable: process.execPath, args: ['-e', fixture], timeoutMs: 200 });
  t.after(() => desktop.close());
  const before = await desktop.request('status');
  const failed = await Promise.all([desktop.request('key', { wait: true }), desktop.request('pointer', { wait: true })]);
  assert.ok(failed.every(result => !result.ok && result.error?.includes('not retried')));
  const after = await desktop.request('status');
  assert.equal(after.ok, true);
  assert.notEqual((after.data as { pid: number }).pid, (before.data as { pid: number }).pid);
});

test('crashed helper fails a possibly delivered operation; closed service cannot respawn', async () => {
  const desktop = new NativeDesktop({ executable: process.execPath, args: ['-e', fixture] });
  const result = await desktop.request('press', { crash: true });
  assert.match(result.error ?? '', /outcome unknown.*not retried/);
  await desktop.close();
  assert.equal((await desktop.request('press')).ok, false);
});

test('local socket allowlist excludes streaming lifecycle and arbitrary commands', () => {
  assert.equal(isLocalScreenOperation('screen.capture'), true);
  assert.equal(isLocalScreenOperation('screen.press'), true);
  for (const op of ['screen.start', 'screen.ack', 'screen.stop', 'screen.exec', 'exec', 'screen.__proto__']) assert.equal(isLocalScreenOperation(op), false);
});
