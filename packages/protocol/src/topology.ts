import { z } from 'zod';

export const RelayTopologyNodeSchema = z.object({
  id: z.string().min(1).max(256),
  role: z.enum(['relay', 'host', 'client']),
  name: z.string().max(96),
  hostId: z.string().max(128).optional(),
  connections: z.number().int().min(1).max(1_000_000),
});
export const RelayTopologySchema = z.object({
  t: z.literal('relay_topology'),
  relayId: z.string().min(1).max(256),
  selfNodeId: z.string().min(1).max(256),
  selectedHostId: z.string().max(128).optional(),
  generatedAt: z.number().int().nonnegative(),
  nodes: z.array(RelayTopologyNodeSchema).max(128),
  edges: z.array(z.object({ from: z.string().max(256), to: z.string().max(256) })).max(127),
  truncated: z.boolean(),
});
export type RelayTopology = z.infer<typeof RelayTopologySchema>;
export type RelayTopologyNode = z.infer<typeof RelayTopologyNodeSchema>;

/** Wire projection only. Relays supply authenticated, currently live connections. */
export function relayTopology(input: {
  relayId: string; relayName: string; selfNodeId: string; selectedHostId?: string;
  peers: Omit<RelayTopologyNode, 'connections'>[];
}): RelayTopology {
  const name = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 96);
  const grouped = new Map<string, RelayTopologyNode>();
  for (const peer of input.peers) {
    const previous = grouped.get(peer.id);
    if (previous) previous.connections = Math.min(previous.connections + 1, 1_000_000);
    else grouped.set(peer.id, { ...peer, name: name(peer.name), connections: 1 });
  }
  // Always include the receiver and its target before truncating large rooms.
  const priority = (node: RelayTopologyNode) => node.id === input.selfNodeId ? 0
    : node.role === 'host' && node.hostId === input.selectedHostId ? 1 : node.role === 'host' ? 2 : 3;
  const peers = [...grouped.values()].sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id)).slice(0, 127);
  const nodes: RelayTopologyNode[] = [{ id: input.relayId, role: 'relay', name: name(input.relayName), connections: 1 }, ...peers];
  return {
    t: 'relay_topology', relayId: input.relayId, selfNodeId: input.selfNodeId,
    selectedHostId: input.selectedHostId, generatedAt: Date.now(), nodes,
    edges: peers.map(peer => ({ from: peer.id, to: input.relayId })), truncated: grouped.size > peers.length,
  };
}
