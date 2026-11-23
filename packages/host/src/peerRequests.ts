import { PeerCallSchema, type ControlMessage } from '@termbridge/protocol';
import type { PeerBridge } from './bridge.js';

/** Authenticated clients share the Host trust boundary; execution still requires
 * exact device selection and that device's current, per-Host permission. */
export class PeerRequests {
  private readonly pending = new Map<object, Set<string>>();
  private count = 0;
  private readonly seen = new WeakMap<object, Set<string>>();
  async handle(owner: object, message: ControlMessage, bridge: PeerBridge,
    send: (message: ControlMessage) => void, current: () => boolean): Promise<void> {
    if (message.t !== 'peer_call') return;
    const checked = PeerCallSchema.safeParse(message);
    const error = (detail: string) => send({ t: 'peer_call_result', id: String(message.id).slice(0, 128), ok: false, error: detail });
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(message)); } catch { /* Non-JSON arguments are not accepted by this RPC. */ }
    if (!checked.success || size > 128 * 1024) { error('Invalid or oversized Peer request'); return; }
    const request = checked.data, args = request.args ?? {};
    if (!['peer.list', 'peer.topology'].includes(request.op) &&
      (typeof args.deviceId !== 'string' || !args.deviceId || args.deviceId.length > 256)) {
      error('Choose an exact --device ID from tb peer list'); return;
    }
    const ids = this.pending.get(owner) ?? new Set<string>();
    const seen = this.seen.get(owner) ?? new Set<string>();
    if (seen.has(request.id) || ids.size >= 4 || this.count >= 64 || seen.size >= 128) { error('Peer request busy or duplicate id; use a new connection for more requests'); return; }
    seen.add(request.id); this.seen.set(owner, seen);
    this.pending.set(owner, ids); ids.add(request.id); this.count++;
    try {
      const response = await bridge.call('app', request.op, args, request.timeoutMs);
      if (current()) send({ ...response, t: 'peer_call_result', id: request.id });
    } catch { if (current()) error('Peer execution failed; outcome may be unknown. Do not automatically resend.'); }
    finally { ids.delete(request.id); this.count--; if (!ids.size) this.pending.delete(owner); }
  }
}
