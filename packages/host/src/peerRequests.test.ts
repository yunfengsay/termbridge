import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerRequests } from './peerRequests.js';
import { PeerBridge } from './bridge.js';
import { parseFrame, FrameType, type ControlMessage } from '@termbridge/protocol';

test('network Peer requests require exact devices, bind response to requester, and never replay IDs', async () => {
  const requests = new PeerRequests(), owner = {}, sent: ControlMessage[] = [];
  let current = true, toolId = '', forwarded = 0;
  const bridge = new PeerBridge({ sock: '', token: 'fixture', resolveClient: (_session, _op, args) => {
    assert.equal(args?.deviceId, 'fixture-mac'); return 4;
  }, send: (_client, bytes) => {
    const frame = parseFrame(bytes); if (frame.type === FrameType.Control && frame.msg.t === 'tool_request') { toolId = frame.msg.id; forwarded++; }
  } });
  const request = { t: 'peer_call', id: 'one', op: 'exec', args: { deviceId: 'fixture-mac', argv: ['/bin/true'] } } as const;
  await requests.handle(owner, { ...request, args: {} }, bridge, m => sent.push(m), () => current);
  assert.equal(forwarded, 0); assert.equal(sent.length, 1); sent.length = 0;
  await requests.handle(owner, { ...request, args: { deviceId: 'fixture-mac', value: 1n } }, bridge, m => sent.push(m), () => current);
  assert.equal(forwarded, 0); assert.equal(sent.length, 1); sent.length = 0;
  const pending = requests.handle(owner, request, bridge, m => sent.push(m), () => current);
  assert.equal(forwarded, 1);
  current = false; bridge.onResponse(4, { id: toolId, ok: true }); await pending;
  assert.equal(sent.length, 0, 'late responses must not reach a replacement requester');
  current = true; await requests.handle(owner, request, bridge, m => sent.push(m), () => current);
  assert.equal(forwarded, 1); assert.equal(sent[0].t, 'peer_call_result');
  assert.match((sent[0] as { error?: string }).error!, /duplicate/);
  bridge.close();
});

test('per-connection budget bounds in-flight requests and prevents unsupported operations', async () => {
  const requests = new PeerRequests(), owner = {}, messages: ControlMessage[] = [], ids: string[] = [];
  const bridge = new PeerBridge({ sock: '', token: 'fixture', resolveClient: () => 1, send: (_, bytes) => {
    const frame = parseFrame(bytes); if (frame.type === FrameType.Control && frame.msg.t === 'tool_request') ids.push(frame.msg.id);
  } });
  const pending = Array.from({ length: 5 }, (_, i) => requests.handle(owner,
    { t: 'peer_call', id: String(i), op: 'info', args: { deviceId: 'fixture' } }, bridge, m => messages.push(m), () => true));
  assert.equal(ids.length, 4); assert.equal(messages.length, 1);
  for (const id of ids) bridge.onResponse(1, { id, ok: true });
  await Promise.all(pending); assert.equal(messages.length, 5); bridge.close();
});
