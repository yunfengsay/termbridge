import assert from 'node:assert/strict';
import test from 'node:test';

import { listPeerDevices, resolvePeerClient } from './peerRouting.js';

const desktop = (clientId: number, deviceId: string, registeredAt = clientId) => ({
  clientId, deviceId, registeredAt, name: `mac-${deviceId}`, platform: 'darwin',
  role: 'manager' as const, capabilities: ['peer.desktop', 'peer.exec', 'peer.fs'],
});

test('unregistered Mac viewers fail immediately instead of receiving unanswered tools', () => {
  for (const op of ['exec', 'fs.read', 'info']) {
    const result = resolvePeerClient([42], [], op);
    assert.equal(typeof result, 'object');
    assert.match((result as { error: string }).error, /registered.*[Pp]eer|[Pp]eer.*register/);
  }
});

test('Mac app manager stays available without terminals and viewer sockets cannot replace it', () => {
  const mac = { ...desktop(7, 'mac-app-test'), name: 'Mac App' };
  const viewer = { ...mac, clientId: 8, registeredAt: 8, capabilities: ['peer.control-only'] };
  assert.equal(resolvePeerClient([], [mac, viewer, manager(9, 'phone')], 'fs.read'), 7);
  assert.equal(listPeerDevices([mac, viewer]).length, 1);
});

test('one Host routes CLI exec to a desktop, not the last attached phone', () => {
  const peers = [desktop(4, 'laptop'), manager(9, 'samsung')];
  assert.equal(resolvePeerClient([4, 9], peers, 'exec'), 4);
  assert.equal(resolvePeerClient([4, 9], peers, 'info'), 4);
  assert.equal(resolvePeerClient([4, 9], peers, 'android.logcat'), 9);
});

test('desktop peers are Host-wide even when attached to another session', () => {
  assert.equal(resolvePeerClient(null, [desktop(4, 'laptop'), manager(9, 'samsung')], 'fs.read'), 4);
});

test('explicit device selection is honored by exec, fs and info; never falls back', () => {
  const peers = [desktop(4, 'laptop'), desktop(6, 'office'), manager(9, 'samsung')];
  for (const op of ['exec', 'fs.read', 'fs.write', 'info']) {
    assert.equal(resolvePeerClient([4, 9], peers, op, 'office'), 6);
    assert.equal(typeof resolvePeerClient([4], peers, op, 'missing'), 'object');
  }
  assert.notEqual(resolvePeerClient([9], peers, 'exec', 'samsung'), 9);
  assert.notEqual(resolvePeerClient([4], peers, 'phone.action', 'laptop'), 4);
});

test('multiple desktops never resolve by attachment order, and errors provide stable IDs', () => {
  const peers = [desktop(4, 'laptop'), desktop(6, 'office'), manager(9, 'samsung')];
  for (const viewers of [[4, 6, 9], [6, 4, 9], []]) {
    const result = resolvePeerClient(viewers, peers, 'exec');
    assert.equal(typeof result, 'object');
    assert.match((result as { error: string }).error, /--device laptop/);
    assert.match((result as { error: string }).error, /--device office/);
  }
  assert.equal(resolvePeerClient([4, 9], peers, 'exec'), 4);
});

test('desktop reconnects deduplicate by physical ID and exclude control-only sockets', () => {
  const peers = [desktop(4, 'laptop', 1), desktop(12, 'laptop', 2),
    { ...desktop(15, 'laptop', 3), capabilities: ['peer.control-only'] }];
  assert.equal(resolvePeerClient([4], peers, 'exec'), 12);
  assert.equal(resolvePeerClient([], peers, 'info'), 12);
});

test('registered phone viewers cannot receive desktop filesystem or exec commands', () => {
  for (const op of ['exec', 'fs.read', 'fs.write']) {
    assert.equal(resolvePeerClient([9], [manager(9, 'samsung')], op), null);
  }
});

test('discovery summarizes physical devices without losing connections or session association', () => {
  const peers = [desktop(4, 'laptop'), desktop(8, 'laptop'), manager(9, 'samsung')];
  assert.deepEqual(listPeerDevices(peers, [4]).map(({ deviceId, connections, attachedToSession }) =>
    ({ deviceId, connections, attachedToSession })), [
    { deviceId: 'laptop', connections: 2, attachedToSession: true },
    { deviceId: 'samsung', connections: 1, attachedToSession: false },
  ]);
  assert.match((resolvePeerClient([4, 4], [], 'exec') as { error: string }).error, /registered Peer/);
});

test('Windows computer, desktop CLI, phone and control-only executors remain separate', () => {
  const windows = { ...desktop(2, 'windows'), platform: 'win32', capabilities: ['computer.tools', 'computer.call'] };
  const control = { ...manager(10, 'samsung'), capabilities: ['peer.control-only'] };
  const peers = [windows, desktop(4, 'laptop'), manager(9, 'samsung'), control];
  assert.equal(resolvePeerClient([2, 4, 9, 10], peers, 'computer.call'), 2);
  assert.equal(resolvePeerClient([2, 4, 9, 10], peers, 'exec'), 4);
  assert.equal(resolvePeerClient([2, 4, 9, 10], peers, 'phone.action'), 9);
  assert.notEqual(resolvePeerClient([], [windows], 'exec'), 2);
  assert.notEqual(resolvePeerClient([], [windows], 'phone.action'), 2);
  assert.equal(listPeerDevices(peers).length, 3);
});

const manager = (clientId: number, deviceId: string, registeredAt = clientId) => ({
  clientId,
  deviceId,
  name: `phone-${deviceId}`,
  platform: 'android',
  role: 'manager' as const,
  capabilities: ['artifact.apk.e2ee'],
  registeredAt,
});

test('routes native device operations to the app manager without a session viewer', () => {
  assert.equal(resolvePeerClient(null, [manager(9, 'samsung')], 'android.install_apk'), 9);
  assert.equal(resolvePeerClient(null, [manager(9, 'samsung')], 'info'), 9);
});

test('prefers the stable app manager over a transient terminal connection', () => {
  assert.equal(resolvePeerClient(4, [manager(9, 'samsung')], 'artifact.chunk'), 9);
});

test('does not assume an unregistered session viewer implements shell tools', () => {
  assert.match((resolvePeerClient(4, [manager(9, 'samsung')], 'exec') as { error: string }).error, /registered Peer/);
  assert.equal(resolvePeerClient(null, [manager(9, 'samsung')], 'fs.read'), null);
});

test('refuses to guess when multiple app devices are online', () => {
  assert.deepEqual(
    resolvePeerClient(null, [manager(9, 'samsung'), manager(12, 'tablet')], 'android.logcat'),
    { error: 'multiple app peers online: phone-samsung (--device samsung), phone-tablet (--device tablet)' },
  );
});

test('deduplicates reconnecting manager sockets for the same physical device', () => {
  assert.equal(
    resolvePeerClient(null, [manager(9, 'samsung', 1), manager(12, 'samsung', 2)], 'android.logcat'),
    12,
  );
});

test('routes an explicit phone action to the requested physical device', () => {
  assert.equal(
    resolvePeerClient(null, [manager(9, 'samsung'), manager(12, 'tablet')], 'phone.action', 'tablet'),
    12,
  );
  assert.deepEqual(
    resolvePeerClient(null, [manager(9, 'samsung')], 'phone.action', 'missing'),
    { error: 'app peer missing is not online' },
  );
});

test('routes read-only phone action recovery to the requested physical device', () => {
  assert.equal(
    resolvePeerClient(null, [manager(9, 'samsung')], 'phone.action.status', 'samsung'),
    9,
  );
});

test('a newer learning/settings socket never steals phone actions from the durable manager', () => {
  const controlOnly = { ...manager(12, 'samsung', 10), capabilities: ['voice.personalization', 'peer.control-only'] };
  const peers = [manager(9, 'samsung', 1), controlOnly];
  assert.equal(resolvePeerClient(null, peers, 'phone.action', 'samsung'), 9);
  assert.equal(resolvePeerClient(null, peers, 'phone.action.status'), 9);
  assert.equal(resolvePeerClient(null, peers, 'android.install_apk'), 9);
  assert.equal(resolvePeerClient(null, [controlOnly], 'phone.action'), null);
});
