import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeControl, parseFrame, FrameType, relayTopology } from '@termbridge/protocol';
import { readTopology, formatTopology } from './topology.js';

test('topology authenticates and subscribes without issuing terminal commands', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const received: string[] = [];
  server.on('connection', ws => {
    ws.send(encodeControl({ t: 'auth_challenge', nonce: 'fixture', required: true }));
    ws.on('message', raw => {
      const frame = parseFrame(raw as Buffer); assert.equal(frame.type, FrameType.Control);
      if (frame.type !== FrameType.Control) return;
      received.push(frame.msg.t);
      if (frame.msg.t === 'hello') {
        assert.equal(frame.msg.wantsTopology, true); assert.equal(frame.msg.wantsHosts, true);
        ws.send(encodeControl(relayTopology({ relayId: 'r', relayName: 'Relay', selfNodeId: 'c', peers: [] })));
      }
    });
  });
  try {
    const port = (server.address() as { port: number }).port;
    const graph = await readTopology({ socket: () => new WebSocket(`ws://127.0.0.1:${port}`), secret: 'fixture' });
    assert.equal(graph.relayId, 'r'); assert.deepEqual(received, ['auth_response', 'hello']);
    assert.match(formatTopology(graph), /Relay/);
  } finally { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('terminal formatting strips remote control bytes from labels and identifiers', () => {
  const graph = relayTopology({ relayId: 'relay', relayName: 'Mini', selfNodeId: 'host:one',
    peers: [{ id: 'host:one', name: 'Mac\x1b[2J', role: 'host', hostId: 'one\x07' }] });
  const output = formatTopology(graph);
  assert.doesNotMatch(output, /[\x1b\x07]/); assert.match(output, /host/);
});
