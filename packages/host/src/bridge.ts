import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeControl } from '@termbridge/protocol';
import { jsonSafeValue, stringifyJsonSafe } from './jsonSafe.js';
import { isLocalScreenOperation } from './remoteDesktop/native.js';
import {
  APP_DEVICE_SESSION,
  isDesktopToolOp,
  isDeviceToolOp,
  type PeerClientResolution,
} from './peerRouting.js';

/**
 * The reverse tool channel, HOST side. A process running inside a tb session
 * (the agent's `tb peer …`) connects to a local unix socket and asks to run a
 * tool on the machine of the CLIENT attached to that session. We forward it as a
 * `tool_request` over the existing (authed, encrypted) relay link to that
 * client, await its `tool_response`, and hand the result back over the socket.
 *
 * Host-side gates remain independent of what the client itself allows:
 *  - the socket is unix-permission gated (owner-only), and
 *  - normal TermBridge sessions must present their injected per-boot token.
 * Externally owned Herdr panes cannot receive that token, so their exact
 * native tool allowlist stays available. Desktop requests without a token are
 * accepted only for a pane in the live Herdr registry, via this owner-only
 * socket. The selected desktop always enforces its own tb expose consent.
 */
export interface ToolResponse {
  ok: boolean;
  exit?: number;
  stdout?: string;
  stderr?: string;
  data?: unknown;
  error?: string;
}

interface BridgeOpts {
  sock: string;
  token: string;
  /** One explicitly resolved executor, never a broadcast or last-viewer guess. */
  resolveClient: (sessionId: string, op: string, args: Record<string, unknown>) => PeerClientResolution;
  isKnownHerdrSession?: (sessionId: string) => boolean;
  listPeers?: (sessionId: string) => unknown;
  topology?: () => unknown;
  /** Send an enveloped frame to a client over the relay. */
  send: (clientId: number, frame: Buffer) => void;
  /** Default per-call timeout (ms) before we give up on the client. */
  timeoutMs?: number;
  /** Owner-only local desktop service, independent of attached phone peers. */
  screen?: (op: string, args: Record<string, unknown>) => Promise<ToolResponse>;
}

/** Herdr agents may reach only the phone's allowlisted native tool surface. */
export function isHerdrDeviceToolCall(sessionId: string, op: string): boolean {
  return /^herdr:[^\s:]+:[^\s:]+$/.test(sessionId) && isDeviceToolOp(op);
}

/** Owner-only host socket shortcut for native app management outside a Terminal. */
export function isAppDeviceToolCall(sessionId: string, op: string): boolean {
  return sessionId === APP_DEVICE_SESSION && isDeviceToolOp(op);
}

export function isHerdrDesktopToolCall(sessionId: string, op: string, isKnown: (id: string) => boolean): boolean {
  return /^herdr:[^\s:]+:[^\s:]+$/.test(sessionId) && isDesktopToolOp(op) && isKnown(sessionId);
}

/** MessagePack may decode uint64 values as BigInt, while the local peer socket uses JSON lines. */
export function serializeToolResponse(response: ToolResponse): string {
  return stringifyJsonSafe(response) + '\n';
}

export class PeerBridge {
  private server: net.Server | null = null;
  private pending = new Map<string, { clientId: number; resolve: (r: ToolResponse) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(private readonly opts: BridgeOpts) {}

  /** A fresh host-boot token to inject into sessions. */
  static newToken(): string {
    return randomBytes(16).toString('hex');
  }

  listen(): void {
    try {
      if (existsSync(this.opts.sock)) unlinkSync(this.opts.sock); // clear a stale socket
    } catch {
      /* noop */
    }
    try {
      mkdirSync(dirname(this.opts.sock), { recursive: true });
    } catch {
      /* noop */
    }
    const server = net.createServer((conn) => {
      let buf = '';
      let handled = false;
      conn.on('data', (d) => {
        if (handled) return;
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n'); // one newline-terminated JSON request per connection
        if (nl === -1) return;
        handled = true;
        const reply = (r: ToolResponse) => conn.end(serializeToolResponse(r));
        let req: { token?: string; session?: string; op?: string; args?: Record<string, unknown>; timeoutMs?: number };
        try {
          req = JSON.parse(buf.slice(0, nl));
        } catch {
          return reply({ ok: false, error: 'bad request' });
        }
        if (req.token !== this.opts.token &&
            !(req.session === APP_DEVICE_SESSION && !req.token && isLocalScreenOperation(req.op || '')) &&
            !isHerdrDeviceToolCall(req.session || '', req.op || '') &&
            !isAppDeviceToolCall(req.session || '', req.op || '') &&
            !(!req.token && isHerdrDesktopToolCall(req.session || '', req.op || '',
              this.opts.isKnownHerdrSession ?? (() => false)))) {
          return reply({ ok: false, error: 'forbidden' });
        }
        this.call(req.session || '', req.op || '', req.args || {}, req.timeoutMs).then(reply, (e) =>
          reply({ ok: false, error: String((e as Error).message) }),
        );
      });
      conn.on('error', () => {
        /* peer hung up */
      });
    });
    server.on('error', (e) => console.error('[host] peer bridge socket error:', (e as Error).message));
    server.listen(this.opts.sock, () => {
      chmodSync(this.opts.sock, 0o600);
      console.log(`[host] peer bridge on ${this.opts.sock}`);
    });
    this.server = server;
  }

  /** Route a tool call to a session's attached client; resolves with its response. */
  call(sessionId: string, op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResponse> {
    if (isLocalScreenOperation(op)) return this.opts.screen?.(op.slice(7), args)
      ?? Promise.resolve({ ok: false, error: 'Local desktop service unavailable' });
    if (op === 'peer.list') return Promise.resolve({ ok: true, data: this.opts.listPeers?.(sessionId) ?? [] });
    if (op === 'peer.topology') {
      const data = this.opts.topology?.();
      return Promise.resolve(data ? { ok: true, data } : { ok: false, error: '实时拓扑不可用：Host 离线或中转版本不支持。' });
    }
    const resolution = this.opts.resolveClient(sessionId, op, args);
    if (resolution == null) {
      return Promise.resolve({ ok: false, error: isDeviceToolOp(op)
        ? 'no app peer online (open TermBridge and enable its Agent monitor)'
        : 'no client attached to this session (the user must be attached)' });
    }
    if (typeof resolution !== 'number') return Promise.resolve({ ok: false, error: resolution.error });
    const clientId = resolution;
    const id = `t${++this.seq}-${randomBytes(4).toString('hex')}`;
    // Give the round trip a few seconds beyond the tool's own timeout.
    const ms = Math.max(1000, timeoutMs ?? this.opts.timeoutMs ?? 60_000) + 5_000;
    return new Promise<ToolResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `tool timed out after ${ms}ms (client unresponsive?)` });
      }, ms);
      this.pending.set(id, { clientId, resolve, timer });
      try {
        this.opts.send(clientId, encodeControl({ t: 'tool_request', id, op, args }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `peer send failed: ${(error as Error).message}` });
      }
    });
  }

  /** Called by the host when a client's `tool_response` arrives. */
  onResponse(clientId: number, msg: ToolResponse & { id: string }): void {
    const p = this.pending.get(msg.id);
    if (!p || p.clientId !== clientId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(jsonSafeValue(msg) as ToolResponse);
  }

  onClientDisconnect(clientId: number): void {
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      // Do not replay a possibly completed write on another device/connection.
      p.resolve({ ok: false, error: 'peer disconnected; execution outcome unknown (not retried)' });
    }
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'peer bridge closed; execution outcome unknown (not retried)' });
    }
    this.pending.clear();
    this.server?.close();
    try {
      if (existsSync(this.opts.sock)) unlinkSync(this.opts.sock);
    } catch {
      /* noop */
    }
  }
}
