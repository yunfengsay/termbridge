import { randomUUID } from 'node:crypto';
import { encodeControl, parseFrame, FrameType, PeerCallSchema } from '@termbridge/protocol';
import { dial } from './client.js';
import { resolveSecret, hmacHex } from '@termbridge/settings';
import type { WebSocket } from 'ws';
import { callBridge, type PeerResult } from './peer.js';

const networkOps = new Set(['peer.list', 'peer.topology', 'info', 'exec', 'fs.read', 'fs.write', 'fs.ls', 'fs.stat', 'termbridge.lan']);
export async function callPeer(op: string, args: Record<string, unknown>, timeoutMs = 60000, host = '',
  connection?: { socket: () => WebSocket; secret: string }): Promise<PeerResult> {
  // An actual Host session keeps its injected bridge. Outside it, use the
  // configured authenticated Host and never infer a device from connection order.
  if (!connection && !host && (process.env.TB_BRIDGE_SOCK || process.env.TB_SESSION || process.env.HERDR_PANE_ID)) return callBridge(op, args, timeoutMs);
  if (!networkOps.has(op)) return callBridge(op, args, timeoutMs);
  if (!['peer.list', 'peer.topology'].includes(op) && (typeof args.deviceId !== 'string' || !args.deviceId)) {
    return { ok: false, error: '请先运行 tb peer list，再用 --device 精确指定设备。' };
  }
  return new Promise(resolve => {
    const ws = connection?.socket() ?? dial(), id = randomUUID(); let sent = false, finished = false;
    const done = (result: PeerResult) => {
      if (finished) return; finished = true; clearTimeout(timer); ws.close(); resolve(result);
    };
    const unknown = () => ({ ok: false, error: sent
      ? 'Peer 请求结果未知；未自动重发。请检查目标设备或更新 Host 后再查询。'
      : '无法连接 Host，请检查中转地址、密码和 --host。' });
    const timer = setTimeout(() => done(unknown()), Math.min(60000, Math.max(1000, timeoutMs)) + 5000);
    ws.on('error', () => done(unknown())); ws.on('close', () => done(unknown()));
    ws.on('message', raw => {
      try {
        const frame = parseFrame(raw as Buffer);
        if (frame.type !== FrameType.Control) return;
        if (frame.msg.t === 'auth_challenge' && !sent) {
          ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(connection?.secret ?? resolveSecret(), frame.msg.nonce) }));
          ws.send(encodeControl({ t: 'hello', role: 'client', hostId: host }));
          const request = PeerCallSchema.parse({ t: 'peer_call', id, op, args, timeoutMs: Math.min(60000, Math.max(100, timeoutMs)) });
          sent = true; ws.send(encodeControl(request));
        }
        if (frame.msg.t === 'peer_call_result' && frame.msg.id === id) done(frame.msg);
        else if (frame.msg.t === 'error') done({ ok: false, error: frame.msg.message });
      } catch { done({ ok: false, error: 'Host 返回了无效的 Peer 响应。' }); }
    });
  });
}
