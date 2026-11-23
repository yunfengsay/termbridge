import test from 'node:test';
import assert from 'node:assert/strict';
import { relayTopology, RelayTopologySchema, type RelayTopologyNode } from './topology.js';

test('topology groups client sockets, strips control labels and preserves receiver/target when bounded', () => {
  const peers: Omit<RelayTopologyNode, 'connections'>[] = Array.from({ length: 180 }, (_, n) => ({ id: `client:${n}`, role: 'client', name: 'Phone' }));
  peers.push({ id: 'client:self', role: 'client', name: 'This\nMac' }, { id: 'client:self', role: 'client', name: 'same app' });
  peers.push({ id: 'host:target', role: 'host', hostId: 'target', name: 'Office' });
  const value = relayTopology({ relayId: 'relay:one', relayName: 'Relay', selfNodeId: 'client:self', selectedHostId: 'target', peers });
  assert.equal(RelayTopologySchema.safeParse(value).success, true);
  assert.equal(value.nodes.length, 128); assert.equal(value.edges.length, 127); assert.equal(value.truncated, true);
  assert.deepEqual(value.nodes[1], { id: 'client:self', role: 'client', name: 'This Mac', connections: 2 });
  assert.equal(value.nodes[2]?.id, 'host:target');
  assert.ok(value.edges.every(edge => edge.to === 'relay:one' && edge.from !== edge.to));
});
test('an empty running relay has one self node and no connections', () => {
  const value = relayTopology({ relayId: 'relay:one', relayName: 'Relay', selfNodeId: 'relay:one', peers: [] });
  assert.equal(value.nodes[0]?.id, value.selfNodeId); assert.deepEqual(value.edges, []); assert.equal(value.truncated, false);
});
