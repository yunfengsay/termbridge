import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { encodeControl, parseFrame, FrameType, RelayTopologySchema, type RelayTopology } from '@termbridge/protocol';
import { hmacHex, resolveSecret } from '@termbridge/settings';
import { dial } from './client.js';

/** An authenticated, read-only snapshot; capabilities do not imply Peer consent. */
export function readTopology(options: { host?: string; timeoutMs?: number; socket?: () => WebSocket; secret?: string } = {}): Promise<RelayTopology> {
  return new Promise((resolve, reject) => {
    const ws = (options.socket ?? dial)();
    let settled = false;
    const finish = (error?: Error, value?: RelayTopology) => {
      if (settled) return; settled = true; clearTimeout(timer);
      ws.close();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('中转未返回拓扑，请检查连接或更新中转服务。')), options.timeoutMs ?? 8000);
    ws.on('error', () => finish(new Error('无法连接中转。请检查 tb middle、密码和网络。')));
    ws.on('close', () => finish(new Error('中转已断开，未取得实时拓扑。')));
    ws.on('message', raw => {
      try {
        const frame = parseFrame(raw as Buffer);
        if (frame.type !== FrameType.Control) return;
        const msg = frame.msg;
        if (msg.t === 'auth_challenge') {
          ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(options.secret ?? resolveSecret(), msg.nonce) }));
          ws.send(encodeControl({ t: 'hello', role: 'client', hostId: options.host ?? '',
            wantsHosts: true, wantsTopology: true, clientInstanceId: randomUUID(), name: 'TB CLI topology' }));
        } else if (msg.t === 'relay_topology') finish(undefined, RelayTopologySchema.parse(msg));
        else if (msg.t === 'error') finish(new Error(msg.message));
      } catch { finish(new Error('中转返回的拓扑格式无效。')); }
    });
  });
}

export function formatTopology(topology: RelayTopology): string {
  // CLI output must never interpret remote names as terminal escape sequences.
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const relay = topology.nodes.find(node => node.id === topology.relayId);
  const lines = [`${clean(relay?.name ?? 'Relay')} (${clean(topology.relayId)})`];
  const nodes = topology.nodes.filter(node => node.id !== topology.relayId);
  nodes.forEach((node, index) => lines.push(`${index === nodes.length - 1 ? '└─' : '├─'} ${node.role}  ${clean(node.name)}  ${clean(node.hostId ?? node.id)}${node.id === topology.selfNodeId ? ' [本机查询]' : ''}${node.hostId && node.hostId === topology.selectedHostId ? ' [当前 Host]' : ''}  ${node.connections} 个连接`));
  if (topology.truncated) lines.push('拓扑较大，当前列表已截断。');
  lines.push('执行命令需在目标设备单独授权；用 tb peer list 查询当前 Host 可用的 Peer。');
  return lines.join('\n');
}
