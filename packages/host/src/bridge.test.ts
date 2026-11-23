import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAppDeviceToolCall, isHerdrDeviceToolCall, isHerdrDesktopToolCall, PeerBridge, serializeToolResponse } from './bridge.js';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameType, parseFrame } from '@termbridge/protocol';

describe('Herdr peer bridge scope', () => {
  it('exposes only the current topology and fails explicitly when disconnected', async () => {
    let snapshot: unknown = { relayId: 'fixture' };
    const bridge = new PeerBridge({ sock: '', token: 'fixture', resolveClient: () => { throw new Error('must not forward topology to a Peer'); },
      send: () => {}, topology: () => snapshot });
    assert.equal(isAppDeviceToolCall('app', 'peer.topology'), true);
    assert.deepEqual(await bridge.call('app', 'peer.topology', {}), { ok: true, data: snapshot });
    snapshot = undefined;
    assert.equal((await bridge.call('app', 'peer.topology', {})).ok, false);
  });
  it('allows only native device operations from an identified Herdr pane', () => {
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'info'), true);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'android.logcat'), true);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'artifact.chunk'), true);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'android.install_apk'), true);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'phone.photo.publish.chunk'), true);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'phone.action'), true);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'phone.asset.read'), true);
  });

  it('never opens shell or filesystem operations through the Herdr shortcut', () => {
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'exec'), false);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3', 'fs.read'), false);
    assert.equal(isHerdrDeviceToolCall('sess-1', 'android.logcat'), false);
    assert.equal(isHerdrDeviceToolCall('herdr:wA:p3:extra', 'android.logcat'), false);
  });

  it('allows local app-level device management without pretending a terminal is attached', () => {
    assert.equal(isAppDeviceToolCall('app', 'info'), true);
    assert.equal(isAppDeviceToolCall('app', 'android.install_apk'), true);
    assert.equal(isAppDeviceToolCall('app', 'phone.photo.publish.commit'), true);
    assert.equal(isAppDeviceToolCall('app', 'exec'), false);
    assert.equal(isAppDeviceToolCall('herdr:wA:p3', 'android.install_apk'), false);
  });
});

it('serializes Android tool responses that contain MessagePack BigInts', () => {
  assert.equal(
    serializeToolResponse({ ok: true, data: { offset: 4n, remoteId: 9_007_199_254_740_993n } }),
    '{"ok":true,"data":{"offset":4,"remoteId":"9007199254740993"}}\n',
  );
});

it('tokenless desktop access requires a real live Herdr session, not an invented label', () => {
  const known = (id: string) => id === 'herdr:wA:p1';
  assert.equal(isHerdrDesktopToolCall('herdr:wA:p1', 'exec', known), true);
  assert.equal(isHerdrDesktopToolCall('herdr:wA:p1', 'fs.read', known), true);
  assert.equal(isHerdrDesktopToolCall('herdr:wA:p9', 'exec', known), false);
  assert.equal(isHerdrDesktopToolCall('app', 'exec', known), false);
  assert.equal(isHerdrDesktopToolCall('herdr:wA:p1', 'unknown', known), false);
});

it('screen operations use the local desktop owner without resolving a phone or arbitrary shell', async () => {
  const bridge = new PeerBridge({ sock: '', token: 'fixture', resolveClient: () => { throw new Error('must not route to a phone'); }, send: () => {},
    screen: async (op, args) => ({ ok: true, data: { op, args } }),
  });
  assert.deepEqual(await bridge.call('app', 'screen.inspect', {}), { ok: true, data: { op: 'inspect', args: {} } });
});

it('multi-client responses bind to the selected connection and remain JSON-safe', async () => {
  const requests: Array<{ clientId: number; id: string }> = [];
  const bridge = new PeerBridge({ sock: '', token: 'fixture', resolveClient: () => 12,
    send: (clientId, frame) => {
      const parsed = parseFrame(frame);
      assert.equal(parsed.type, FrameType.Control);
      if (parsed.type === FrameType.Control && parsed.msg.t === 'tool_request') requests.push({ clientId, id: parsed.msg.id });
    },
  });
  const result = bridge.call('session', 'exec', {});
  const id = requests[0].id;
  let settled = false;
  void result.then(() => settled = true);
  bridge.onResponse(99, { id, ok: true, stdout: 'wrong peer' });
  await Promise.resolve();
  assert.equal(settled, false);
  bridge.onResponse(12, { id, ok: true, data: { id: 9007199254740993n } });
  assert.equal(serializeToolResponse(await result), `{"id":"${id}","ok":true,"data":{"id":"9007199254740993"}}\n`);
  const disconnected = bridge.call('session', 'exec', {});
  bridge.onClientDisconnect(99);
  bridge.onClientDisconnect(12);
  assert.match((await disconnected).error ?? '', /outcome unknown.*not retried/);
  assert.equal(requests.length, 2);
});

it('owner-only socket admits known Herdr desktop requests and refuses arbitrary sessions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-peer-bridge-'));
  const sock = join(dir, 'host.sock');
  const bridge = new PeerBridge({ sock, token: 'fixture-token',
    isKnownHerdrSession: (id) => id === 'herdr:wA:p1', listPeers: () => [{ deviceId: 'fixture-mac' }],
    resolveClient: () => 7, send: (clientId, frame) => {
      const parsed = parseFrame(frame);
      if (parsed.type === FrameType.Control && parsed.msg.t === 'tool_request') {
        bridge.onResponse(clientId, { id: parsed.msg.id, ok: true, stdout: 'REMOTE_ONLY' });
      }
    },
  });
  t.after(() => { bridge.close(); rmSync(dir, { recursive: true, force: true }); });
  bridge.listen();
  async function request(session: string, op: string, token = ''): Promise<{ ok: boolean; error?: string; stdout?: string; data?: unknown }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(sock);
      socket.setTimeout(3000, () => socket.destroy(new Error('fixture socket timeout')));
      socket.on('connect', () => socket.end(JSON.stringify({ session, op, token, args: {} }) + '\n'));
      let out = '';
      socket.on('data', (data) => out += data);
      socket.on('end', () => { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } });
      socket.on('error', reject);
    });
  }
  assert.equal((await request('herdr:wA:p1', 'exec')).stdout, 'REMOTE_ONLY');
  assert.deepEqual((await request('app', 'peer.list')).data, [{ deviceId: 'fixture-mac' }]);
  for (const session of ['herdr:wA:p9', 'app', 'sess-unknown']) {
    assert.equal((await request(session, 'exec')).error, 'forbidden');
  }
  assert.equal((await request('herdr:wA:p1', 'exec', 'wrong-token')).error, 'forbidden');
});
