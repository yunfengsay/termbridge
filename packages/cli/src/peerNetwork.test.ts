import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { hmacHex } from '@termbridge/settings';
import { encodeControl, parseFrame, FrameType, type ControlMessage } from '@termbridge/protocol';
import { callPeer } from './peerNetwork.js';

async function fixture(t: test.TestContext, handler: (ws: WebSocket, message: ControlMessage) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  server.on('connection', ws => {
    ws.send(encodeControl({ t: 'auth_challenge', nonce: 'test', required: true }));
    ws.on('message', raw => { const frame = parseFrame(raw as Buffer); if (frame.type === FrameType.Control) handler(ws, frame.msg); });
  });
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { socket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`), secret: 'fixture' };
}
test('ordinary shell authenticates and sends one exact-device request to selected Host', async t => {
  const received: string[] = [];
  const connection = await fixture(t, (ws, message) => {
    received.push(message.t);
    if (message.t === 'auth_response') assert.equal(message.mac, hmacHex('fixture', 'test'));
    if (message.t === 'hello') assert.equal(message.hostId, 'selected-host');
    if (message.t === 'peer_call') {
      assert.equal(message.args?.deviceId, 'selected-mac');
      ws.send(encodeControl({ t: 'peer_call_result', id: message.id, ok: true, stdout: 'REMOTE' }));
    }
  });
  assert.equal((await callPeer('exec', { deviceId: 'selected-mac', argv: ['/bin/true'] }, 1000, 'selected-host', connection)).stdout, 'REMOTE');
  assert.deepEqual(received, ['auth_response', 'hello', 'peer_call']);
});
test('disconnect after dispatch is uncertain and never automatically retried', async t => {
  let calls = 0;
  const connection = await fixture(t, (ws, message) => { if (message.t === 'peer_call') { calls++; ws.close(); } });
  const response = await callPeer('exec', { deviceId: 'selected-mac' }, 1000, '', connection);
  assert.equal(response.ok, false); assert.match(response.error!, /结果未知.*未自动重发/); assert.equal(calls, 1);
  const missing = await callPeer('exec', {}, 1000, '', connection);
  assert.match(missing.error!, /--device/); assert.equal(calls, 1);
});
