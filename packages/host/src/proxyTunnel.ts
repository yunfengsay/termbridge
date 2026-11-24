import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ProxyTunnelSchema,
  type ProxyTunnelMessage,
  type ProxyTunnelPolicy,
} from '@termbridge/protocol';
import { Audit } from './automation/storage.js';

const MAX_CHUNK_BYTES = 48 * 1024;
const INITIAL_WINDOW_BYTES = 512 * 1024;
const MAX_WINDOW_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_TUNNELS_PER_CLIENT = 64;
const MAX_TOTAL_TUNNELS = 256;

interface TunnelEntry {
  clientId: number;
  id: string;
  host: string;
  port: number;
  socket: Socket;
  startedAt: number;
  opened: boolean;
  closed: boolean;
  windowBytes: number;
  bytesUp: number;
  bytesDown: number;
  pendingWrites: Buffer[];
}

export function normalizeTunnelHost(raw: string): string | undefined {
  let host = raw.trim();
  if (!host || host.length > 255) return undefined;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /[\s\x00-\x1f\x7f/@\\]/.test(host)) return undefined;
  const lower = host.toLowerCase();
  if (lower === '0.0.0.0' || lower === '::' || lower === '0:0:0:0:0:0:0:0') return '127.0.0.1';
  return host;
}

export function isLoopbackTunnelHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.endsWith('.localhost')) return true;
  if (/^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(lower)) {
    return true;
  }
  return false;
}

export class ProxyTunnelManager {
  private tunnels = new Map<string, TunnelEntry>();
  private clientCounts = new Map<number, number>();
  private audit: Audit;

  constructor(
    private options: {
      send: (clientId: number, msg: ProxyTunnelMessage) => void;
      policy: () => ProxyTunnelPolicy;
      auditDir?: string;
    },
  ) {
    this.audit = new Audit(options.auditDir || process.env.TB_AUTOMATION_DIR || join(homedir(), '.termbridge'));
  }

  handle(clientId: number, input: ProxyTunnelMessage): void {
    const parsed = ProxyTunnelSchema.safeParse(input);
    if (!parsed.success) return;
    const msg = parsed.data;
    const key = `${clientId}:${msg.id}`;

    switch (msg.kind) {
      case 'open':
        this.openTunnel(clientId, key, msg);
        return;
      case 'data': {
        const entry = this.tunnels.get(key);
        if (!entry || entry.closed || !msg.data) return;
        const buf = Buffer.from(msg.data, 'base64');
        if (buf.length === 0) return;
        entry.bytesUp += buf.length;
        if (!entry.opened) {
          if (entry.pendingWrites.reduce((sum, b) => sum + b.length, 0) + buf.length > MAX_WINDOW_BYTES) {
            this.closeTunnel(key, 'Upstream buffer overflow before connect', true);
            return;
          }
          entry.pendingWrites.push(buf);
          return;
        }
        entry.socket.write(buf);
        return;
      }
      case 'ack': {
        const entry = this.tunnels.get(key);
        if (!entry || entry.closed || !msg.bytes) return;
        entry.windowBytes = Math.min(MAX_WINDOW_BYTES, entry.windowBytes + msg.bytes);
        if (entry.windowBytes > 0 && entry.socket.isPaused()) {
          entry.socket.resume();
        }
        return;
      }
      case 'close':
        this.closeTunnel(key, msg.reason, false);
        return;
      default:
        return;
    }
  }

  private openTunnel(clientId: number, key: string, msg: ProxyTunnelMessage): void {
    if (this.tunnels.has(key)) return;
    const policy = this.options.policy();
    if (policy === 'off') {
      this.options.send(clientId, {
        t: 'proxy_tunnel',
        id: msg.id,
        kind: 'close',
        reason: 'Proxy tunnel disabled by host configuration',
      });
      return;
    }
    const host = msg.host ? normalizeTunnelHost(msg.host) : undefined;
    const port = msg.port;
    if (!host || !port || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.options.send(clientId, {
        t: 'proxy_tunnel',
        id: msg.id,
        kind: 'close',
        reason: 'Invalid tunnel host or port',
      });
      return;
    }
    if (policy === 'loopback' && !isLoopbackTunnelHost(host)) {
      this.options.send(clientId, {
        t: 'proxy_tunnel',
        id: msg.id,
        kind: 'close',
        reason: 'Host proxy policy only permits loopback targets',
      });
      return;
    }
    const count = this.clientCounts.get(clientId) ?? 0;
    if (count >= MAX_TUNNELS_PER_CLIENT || this.tunnels.size >= MAX_TOTAL_TUNNELS) {
      this.options.send(clientId, {
        t: 'proxy_tunnel',
        id: msg.id,
        kind: 'close',
        reason: 'Too many active proxy tunnels',
      });
      return;
    }

    const socket = createConnection({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    const entry: TunnelEntry = {
      clientId,
      id: msg.id,
      host,
      port,
      socket,
      startedAt: Date.now(),
      opened: false,
      closed: false,
      windowBytes: INITIAL_WINDOW_BYTES,
      bytesUp: 0,
      bytesDown: 0,
      pendingWrites: [],
    };
    this.tunnels.set(key, entry);
    this.clientCounts.set(clientId, count + 1);

    socket.on('connect', () => {
      if (entry.closed) return;
      entry.opened = true;
      socket.setTimeout(IDLE_TIMEOUT_MS);
      this.options.send(clientId, { t: 'proxy_tunnel', id: msg.id, kind: 'opened' });
      if (entry.pendingWrites.length > 0) {
        const queued = entry.pendingWrites.splice(0);
        for (const chunk of queued) socket.write(chunk);
      }
    });

    socket.on('data', (chunk: Buffer) => {
      if (entry.closed) return;
      for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK_BYTES) {
        const slice = chunk.subarray(offset, Math.min(chunk.length, offset + MAX_CHUNK_BYTES));
        entry.bytesDown += slice.length;
        entry.windowBytes -= slice.length;
        this.options.send(clientId, {
          t: 'proxy_tunnel',
          id: msg.id,
          kind: 'data',
          data: slice.toString('base64'),
        });
      }
      if (entry.windowBytes <= 0) {
        socket.pause();
      }
    });

    socket.on('timeout', () => {
      this.closeTunnel(key, entry.opened ? 'Tunnel idle timeout' : 'Connection timed out', true);
    });

    socket.on('error', (err) => {
      this.closeTunnel(key, err.message || 'Upstream connection error', true);
    });

    socket.on('close', () => {
      this.closeTunnel(key, undefined, true);
    });
  }

  private closeTunnel(key: string, reason: string | undefined, notifyClient: boolean): void {
    const entry = this.tunnels.get(key);
    if (!entry || entry.closed) return;
    entry.closed = true;
    this.tunnels.delete(key);
    const remaining = (this.clientCounts.get(entry.clientId) ?? 1) - 1;
    if (remaining <= 0) this.clientCounts.delete(entry.clientId);
    else this.clientCounts.set(entry.clientId, remaining);
    entry.pendingWrites.length = 0;
    try {
      entry.socket.destroy();
    } catch {
      // already destroyed
    }
    try {
      this.audit.append({
        clientId: entry.clientId,
        op: 'proxy_tunnel',
        host: entry.host,
        port: entry.port,
        bytesUp: entry.bytesUp,
        bytesDown: entry.bytesDown,
        durationMs: Date.now() - entry.startedAt,
        ...(reason ? { error: reason } : {}),
      });
    } catch {
      // audit write failures never tear down unrelated tunnels
    }
    if (notifyClient) {
      this.options.send(entry.clientId, {
        t: 'proxy_tunnel',
        id: entry.id,
        kind: 'close',
        ...(reason ? { reason: reason.slice(0, 512) } : {}),
      });
    }
  }

  drop(clientId: number): void {
    const prefix = `${clientId}:`;
    for (const key of [...this.tunnels.keys()]) {
      if (key.startsWith(prefix)) this.closeTunnel(key, 'Client disconnected', false);
    }
  }

  dispose(): void {
    for (const key of [...this.tunnels.keys()]) {
      this.closeTunnel(key, 'Host shutting down', false);
    }
    this.tunnels.clear();
    this.clientCounts.clear();
  }
}
