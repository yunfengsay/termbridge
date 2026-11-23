import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  parseFrame,
  FrameType,
  encodeControl,
  encodeEnvelope,
  decodeEnvelope,
  type ControlMessage,
  ControlMessageSchema, relayTopology, type RelayTopologyNode,
} from '@termbridge/protocol';
import { resolveSecret, makeNonce, verifyMac, loadServerTls } from '@termbridge/settings';

/**
 * Relay = dumb, stateful forwarder.
 *
 *  - A host dials in and registers under a hostId.
 *  - Clients dial in, name the hostId they want, get a per-host clientId.
 *  - client -> relay: bare frame      ──▶  relay -> host: [clientId][frame]
 *  - host -> relay:  [clientId][frame] ──▶  relay -> client: bare frame
 *
 * The relay never parses PTY data; it only peeks CONTROL frames to authenticate
 * + route the connection, then shovels bytes. Optional password auth (P2): if a
 * secret is configured (env TB_SECRET or settings.json), every connection must
 * pass an HMAC challenge before its `hello` — otherwise it's pure-trust (hostId
 * is the only credential). For traffic confidentiality it can serve self-signed
 * `wss://` (a cert from `tb middle cert`); peers pin its fingerprint.
 */

// App-owned children must not outlive an unexpectedly terminated parent.
if (process.env.TB_LAN_PARENT === '1' && process.connected) {
  process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
}

const PORT = Number(process.env.PORT ?? 7400);
const BIND_ADDRESS = process.env.TB_RELAY_BIND || '0.0.0.0';
const SECRET = resolveSecret(); // undefined → open relay (no password)
// ping every peer this often; reap any that didn't pong. Lower it (env
// TB_HEARTBEAT_MS) behind an aggressive NAT/idle timeout that kills the link
// faster than 30s — or in tests, to detect a half-open peer in milliseconds.
const HEARTBEAT_MS = Number(process.env.TB_HEARTBEAT_MS ?? 30_000);

// Only the App-owned supervisor receives these bounded events. No payloads or credentials.
function diagnose(code: string, fields: Record<string, string | number> = {}): void {
  if (process.env.TB_LAN_PARENT === '1' && process.connected) {
    process.send?.({ event: 'diagnostic', code, fields }, () => {});
  }
}

// Identification is only a connectivity hint, never a replacement for the
// WebSocket password challenge. No Host roster, IDs or credentials are public.
function handleHTTP(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === '/.well-known/termbridge' && (req.method === 'HEAD' || req.method === 'GET')) {
    diagnose('http_probe', { httpStatus: 200 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-TermBridge-Service': 'relay-v1' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'termbridge', version: 1, transport: 'websocket' }));
    return;
  }
  res.writeHead(426, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('Upgrade Required');
}

interface HostEntry {
  ws: WebSocket;
  hostId: string;
  name: string;
  instanceId?: string;
  clients: Map<number, WebSocket>;
  nextClientId: number;
}

/** A peer socket tagged with liveness for the ping/reap heartbeat. */
type HeartbeatWs = WebSocket & { isAlive?: boolean };

const hosts = new Map<string, HostEntry>();
const hostListSubscribers = new Map<WebSocket, string>();
const relayId = 'relay:' + (process.env.TB_RELAY_ID || randomUUID());
const relayName = process.env.TB_RELAY_NAME || 'TermBridge Relay';
const topologyPeers = new Map<WebSocket, { node: Omit<RelayTopologyNode, 'connections'>; wants: boolean; target?: string }>();
let topologyTimer: ReturnType<typeof setTimeout> | undefined;
function broadcastTopology(): void {
  if (topologyTimer) return;
  topologyTimer = setTimeout(() => {
    topologyTimer = undefined;
    const peers = [...topologyPeers.entries()].filter(([ws]) => ws.readyState === WebSocket.OPEN);
    const snapshot = (selfNodeId: string, selectedHostId?: string) => relayTopology({ relayId, relayName,
      selfNodeId, selectedHostId, peers: peers.map(([, peer]) => peer.node) });
    for (const [ws, peer] of peers) if (peer.wants) {
      const frame = encodeControl(snapshot(peer.node.id, peer.target));
      ws.send(peer.node.role === 'host' ? encodeEnvelope(0, frame) : frame);
    }
    if (process.env.TB_LAN_PARENT === '1' && process.connected) {
      process.send?.({ event: 'topology', topology: snapshot(relayId) }, () => {});
    }
  }, 25);
  topologyTimer.unref();
}

/**
 * Close codes in the 4000-4999 app range so clients can tell rejections apart.
 * A bare ws.close() sends no status code, which OkHttp/browsers surface as the
 * reserved 1005 — clients that echo it back then crash their own close() call
 * and the real reason is lost.
 */
export const CloseCode = {
  AUTH_FAILED: 4001,
  BAD_HANDSHAKE: 4002,
  NO_HOST_ONLINE: 4003,
  AMBIGUOUS_HOST: 4004,
  HOST_NOT_FOUND: 4005,
  HOST_GONE: 4006,
  REPLACED: 4007,
} as const;

/** ws close reasons are capped at 123 UTF-8 bytes; over-long ones throw. */
function closeReason(message: string): string {
  const bytes = Buffer.from(message, 'utf8');
  if (bytes.length <= 123) return message;
  return bytes.subarray(0, 120).toString('utf8').replace(/�+$/u, '') + '…';
}

/** Send a final control error, then close with a code + reason the peer keeps. */
function reject(ws: WebSocket, code: number, message: string): void {
  diagnose('client_rejected', { closeCode: code });
  ws.send(encodeControl({ t: 'error', message }));
  ws.close(code, closeReason(message));
}

function sendHostList(ws: WebSocket, selectedHostId?: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(encodeControl({
    t: 'host_list_result',
    hosts: [...hosts.values()].map((host) => ({ hostId: host.hostId, name: host.name })),
    selectedHostId,
  }));
}

function broadcastHostLists(): void {
  for (const [client, selectedHostId] of hostListSubscribers) {
    sendHostList(client, selectedHostId);
  }
}

/**
 * Detect half-open connections: every HEARTBEAT_MS, ping each peer and terminate
 * any that hasn't ponged since the previous round. Without this a host whose TCP
 * link silently dies (laptop sleep, NAT/idle timeout, flaky wifi) lingers in
 * `hosts` as a zombie — the relay keeps routing clients to a socket that will
 * never answer, so `tb new` hangs and "no host online" never even fires. The
 * terminate() makes the host observe a 'close' and re-register, healing it.
 */
function attachHeartbeat(wss: WebSocketServer): void {
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const hb = ws as HeartbeatWs;
      if (hb.isAlive === false) {
        ws.terminate();
        continue;
      }
      hb.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(timer));
}

function handleConnection(ws: WebSocket): void {
  const attempt = randomUUID();
  diagnose('socket_open', { attempt });
  ws.on('close', code => diagnose('socket_closed', { attempt, closeCode: code }));
  ws.on('error', error => diagnose('socket_error', { attempt, code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
  (ws as HeartbeatWs).isAlive = true;
  ws.on('pong', () => {
    (ws as HeartbeatWs).isAlive = true;
  });
  let authed = false;
  let role: 'host' | 'client' | null = null;
  let hostId: string | null = null;
  let clientId: number | null = null;

  // Always challenge first: the peer must answer before `hello`. `required`
  // tells it whether a real password is needed (so a passwordless relay still
  // gets a uniform handshake — the peer replies with an empty mac).
  const nonce = makeNonce();
  ws.send(encodeControl({ t: 'auth_challenge', nonce, required: !!SECRET }));

  ws.on('message', (raw) => {
    const buf = raw as Buffer;

    if (!authed) {
      try {
        const parsed = parseFrame(buf);
        if (parsed.type !== FrameType.Control || parsed.msg.t !== 'auth_response') {
          throw new Error('expected auth_response');
        }
        if (SECRET && !verifyMac(SECRET, nonce, parsed.msg.mac)) {
          throw new Error('wrong password');
        }
      } catch (e) {
        diagnose('auth_rejected', { attempt, closeCode: CloseCode.AUTH_FAILED });
        reject(
          ws,
          CloseCode.AUTH_FAILED,
          `authentication failed: ${(e as Error).message} — set the matching password with \`tb secret set\``,
        );
        return;
      }
      authed = true;
      diagnose('auth_accepted', { attempt });
      return;
    }

    if (role === null) {
      let hello: Extract<ControlMessage, { t: 'hello' }>;
      try {
        const parsed = parseFrame(buf);
        if (parsed.type !== FrameType.Control || parsed.msg.t !== 'hello') {
          throw new Error('first frame must be hello');
        }
        const checked = ControlMessageSchema.parse(parsed.msg);
        if (checked.t !== 'hello') throw new Error('expected hello');
        hello = checked;
      } catch (e) {
        reject(ws, CloseCode.BAD_HANDSHAKE, `handshake failed: ${(e as Error).message}`);
        return;
      }

      if (hello.role === 'host') {
        const registered = hosts.get(hello.hostId);
        const sameInstance = hello.hostInstanceId !== undefined && registered?.instanceId === hello.hostInstanceId;
        if (hello.replaceExisting === false && registered && !sameInstance) {
          reject(ws, CloseCode.REPLACED, 'host already registered');
          return;
        }
        role = 'host';
        hostId = hello.hostId;
        const previous = hosts.get(hostId);
        if (previous) {
          topologyPeers.delete(previous.ws);
          for (const client of previous.clients.values()) {
            topologyPeers.delete(client); hostListSubscribers.delete(client);
            client.close(CloseCode.HOST_GONE, 'host reconnected');
          }
          previous.ws.close(CloseCode.REPLACED, 'replaced by a new registration');
        }
        hosts.set(hostId, {
          ws,
          hostId,
          name: hello.name ?? hostId,
          instanceId: hello.hostInstanceId,
          clients: new Map(),
          nextClientId: 1,
        });
        broadcastHostLists();
        // Every relay->host message is enveloped; clientId 0 = relay control-plane.
        ws.send(encodeEnvelope(0, encodeControl({ t: 'host_register_ok' })));
        topologyPeers.set(ws, { node: { id: 'host:' + hostId, role: 'host', hostId, name: hello.name ?? hostId }, wants: !!hello.wantsTopology });
        broadcastTopology();
        console.log(`[relay] host registered: ${hostId} (${hello.name ?? ''})`);
      } else {
        // Read-only discovery also works before the first Host joins a relay.
        // This observer never receives a client id and cannot forward commands.
        if (hello.wantsTopology && hello.wantsHosts && !hello.hostId && hosts.size === 0) {
          role = 'client';
          topologyPeers.set(ws, { node: { id: 'client:' + (hello.clientInstanceId || randomUUID()),
            role: 'client', name: hello.name || 'Topology observer' }, wants: true });
          hostListSubscribers.set(ws, '');
          sendHostList(ws, ''); broadcastTopology(); return;
        }
        // Empty / "default" hostId means "the only host" — zero-config for the
        // common single-machine case.
        let targetId = hello.hostId;
        if (targetId === '' || targetId === 'default' || targetId === '-') {
          const ids = [...hosts.keys()];
          if (ids.length === 1) targetId = ids[0];
          else if (ids.length === 0) {
            reject(ws, CloseCode.NO_HOST_ONLINE, 'no host online');
            return;
          } else if (hello.wantsHosts) {
            targetId = ids[0];
          } else {
            reject(ws, CloseCode.AMBIGUOUS_HOST, `multiple hosts: ${ids.join(', ')} — pick one with @<id>`);
            return;
          }
        }
        const host = hosts.get(targetId);
        if (!host) {
          reject(ws, CloseCode.HOST_NOT_FOUND, `host not found: ${targetId}`);
          return;
        }
        role = 'client';
        hostId = targetId;
        clientId = host.nextClientId++;
        host.clients.set(clientId, ws);
        topologyPeers.set(ws, { node: { id: 'client:' + (hello.clientInstanceId || randomUUID()), role: 'client', name: hello.name || 'Client' },
          wants: !!hello.wantsTopology, target: hostId });
        host.ws.send(encodeEnvelope(clientId, encodeControl({ t: 'client_connect' })));
        if (hello.wantsHosts) {
          hostListSubscribers.set(ws, hostId);
          sendHostList(ws, hostId);
        }
        console.log(`[relay] client ${clientId} -> host ${hostId}`);
        broadcastTopology();
      }
      return;
    }

    // Established: forward.
    if (role === 'host') {
      if (hosts.get(hostId!)?.ws !== ws) return;
      const { clientId: cid, frame } = decodeEnvelope(buf);
      hosts.get(hostId!)?.clients.get(cid)?.send(frame);
    } else {
      const host = hosts.get(hostId!);
      if (host && host.clients.get(clientId!) === ws && host.ws.readyState === WebSocket.OPEN) {
        host.ws.send(encodeEnvelope(clientId!, buf));
      }
    }
  });

  ws.on('close', () => {
    topologyPeers.delete(ws);
    hostListSubscribers.delete(ws);
    if (role === 'host' && hostId) {
      const host = hosts.get(hostId);
      if (host && host.ws === ws) {
        for (const c of host.clients.values()) {
          topologyPeers.delete(c); hostListSubscribers.delete(c);
          c.close(CloseCode.HOST_GONE, 'host disconnected');
        }
        hosts.delete(hostId);
        broadcastHostLists();
        console.log(`[relay] host gone: ${hostId}`);
      }
    } else if (role === 'client' && hostId && clientId != null) {
      const host = hosts.get(hostId);
      if (host && host.clients.get(clientId) === ws) {
        host.clients.delete(clientId);
        if (host.ws.readyState === WebSocket.OPEN) {
          host.ws.send(encodeEnvelope(clientId, encodeControl({ t: 'client_disconnect' })));
        }
        console.log(`[relay] client ${clientId} gone`);
      }
    }
    broadcastTopology();
  });

  ws.on('error', () => ws.close(1011, 'relay socket error'));
}

/**
 * Bind the port, retrying every 3s while it's unavailable (e.g. the middle
 * relay just restarted and the OS hasn't released the socket yet). Once we're
 * listening we stay up — post-bind errors are logged, not fatal.
 *
 * If a self-signed cert is present (`tb middle cert` / env TB_TLS_CERT+KEY) we
 * serve `wss://` over an https server; otherwise plain `ws://`.
 */
function start(): void {
  // `tb surf` runs this for a loopback-only host link, so it forces plain ws
  // even if a cert happens to sit in ~/.termbridge/tls (wss is the middle path).
  const tls = process.env.TB_RELAY_NO_TLS ? null : loadServerTls();
  let listening = false;

  const onListen = (): void => {
    listening = true;
    console.log(`[relay] listening on ${tls ? 'wss' : 'ws'}://${BIND_ADDRESS}:${PORT}`);
    process.send?.({ event: 'listening' });
    broadcastTopology();
    diagnose('listening', { address: BIND_ADDRESS, port: PORT, protocol: tls ? 'wss' : 'ws' });
    console.log(`[relay] auth: ${SECRET ? 'password REQUIRED' : 'OPEN (no password — set TB_SECRET / tb secret set)'}`);
    console.log(`[relay] tls: ${tls ? 'on (self-signed wss — pin its fingerprint)' : 'off (plain ws — add wss via tb middle cert)'}`);
  };
  const onError = (err: Error): void => {
    diagnose('bind_failed', { address: BIND_ADDRESS, port: PORT, code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
    if (listening) {
      console.error(`[relay] server error: ${err.message}`);
      return;
    }
    console.error(`[relay] cannot bind :${PORT} (${err.message}); retrying in 3s`);
    // Discard this failed listener and its heartbeat before replacing it.
    wss.close();
    setTimeout(start, 3000);
  };

  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handleHTTP) : http.createServer(handleHTTP);
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on('connection', handleConnection);
  attachHeartbeat(wss);
  // WebSocketServer forwards the HTTP server's error event. Handle it once,
  // otherwise a bind conflict either throws or schedules two replacements.
  wss.on('error', onError);
  server.listen(PORT, BIND_ADDRESS, onListen);
}

start();
