import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import {
  FrameType,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  parseFrame,
  type ControlMessage,
  ControlMessageSchema, relayTopology, type RelayTopologyNode,
} from '@termbridge/protocol';

type SocketAttachment =
  | { phase: 'closed' }
  | { phase: 'auth'; nonce: string; secret: string }
  | { phase: 'hello' }
  | { phase: 'host'; hostId: string; name: string; wantsTopology?: boolean; instanceId?: string }
  | { phase: 'client'; hostId: string; clientId: number; wantsHosts: boolean; wantsTopology?: boolean; nodeId?: string; name?: string };

function wire(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytes(message: string | ArrayBuffer): Buffer {
  if (typeof message === 'string') throw new Error('binary WebSocket frame required');
  return Buffer.from(message);
}

function attachment(ws: WebSocket): SocketAttachment | undefined {
  try {
    return ws.deserializeAttachment() as SocketAttachment | undefined;
  } catch {
    return undefined;
  }
}

function send(ws: WebSocket, payload: Uint8Array): void {
  ws.send(wire(payload));
}

function sendError(ws: WebSocket, message: string): void {
  try {
    send(ws, encodeControl({ t: 'error', message }));
  } finally {
    ws.close(1008, 'termbridge protocol error');
  }
}

function randomClientId(inUse: Set<number>): number {
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] === 0 || inUse.has(value[0]));
  return value[0];
}

function fromHex(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/i.test(value)) return undefined;
  const result = new Uint8Array(32);
  for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

const CLOUD_ROOM_KEY_HEADER = 'X-Termbridge-Room-Key';
const ROOM_PATH = /^\/r\/([a-f0-9]{64})$/i;

async function roomMatchesSecret(roomId: string, secret: string): Promise<boolean> {
  if (secret.length < 32 || secret.length > 256) return false;
  const room = fromHex(roomId);
  if (!room) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return crypto.subtle.timingSafeEqual(room, digest);
}

async function validMac(secret: string, nonce: string, mac: string): Promise<boolean> {
  const supplied = fromHex(mac);
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(nonce)));
  return crypto.subtle.timingSafeEqual(expected, supplied);
}

/**
 * One Durable Object coordinates one private relay or one hosted pairing room.
 * WebSocket attachments hold all routing state so the object may hibernate
 * between messages without losing live connections.
 */
export class TermbridgeRelay extends DurableObject<Env> {
  private retire(ws: WebSocket, reason: string): void {
    ws.serializeAttachment({ phase: 'closed' } satisfies SocketAttachment);
    ws.close(1012, reason);
  }
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN);
  }

  private hosts(): Array<{ ws: WebSocket; hostId: string; name: string; instanceId?: string }> {
    const result: Array<{ ws: WebSocket; hostId: string; name: string; instanceId?: string }> = [];
    for (const ws of this.sockets()) {
      const meta = attachment(ws);
      if (meta?.phase === 'host') result.push({ ws, hostId: meta.hostId, name: meta.name, instanceId: meta.instanceId });
    }
    return result;
  }

  private host(hostId: string): WebSocket | undefined {
    return this.hosts().find((candidate) => candidate.hostId === hostId)?.ws;
  }

  private clients(hostId: string): Array<{ ws: WebSocket; clientId: number; wantsHosts: boolean }> {
    const result: Array<{ ws: WebSocket; clientId: number; wantsHosts: boolean }> = [];
    for (const ws of this.sockets()) {
      const meta = attachment(ws);
      if (meta?.phase === 'client' && meta.hostId === hostId) {
        result.push({ ws, clientId: meta.clientId, wantsHosts: meta.wantsHosts });
      }
    }
    return result;
  }

  private sendHostList(ws: WebSocket, selectedHostId?: string): void {
    const hosts = this.hosts().map(({ hostId, name }) => ({ hostId, name }));
    send(ws, encodeControl({ t: 'host_list_result', hosts, selectedHostId }));
  }

  private broadcastHostLists(): void {
    for (const ws of this.sockets()) {
      const meta = attachment(ws);
      if (meta?.phase === 'client' && meta.wantsHosts) this.sendHostList(ws, meta.hostId);
    }
  }

  private broadcastTopology(): void {
    const entries = this.sockets().map(ws => ({ ws, meta: attachment(ws) }));
    const peers: Omit<RelayTopologyNode, 'connections'>[] = [];
    for (const { meta } of entries) {
      if (meta?.phase === 'host') peers.push({ id: 'host:' + meta.hostId, role: 'host', hostId: meta.hostId, name: meta.name });
      else if (meta?.phase === 'client') peers.push({ id: meta.nodeId ?? `client:${meta.hostId}:${meta.clientId}`, role: 'client', name: meta.name || 'Client' });
    }
    for (const { ws, meta } of entries) {
      if (!meta || !('wantsTopology' in meta) || !meta.wantsTopology) continue;
      const selfNodeId = meta.phase === 'host' ? 'host:' + meta.hostId : meta.nodeId ?? `client:${meta.hostId}:${meta.clientId}`;
      const frame = encodeControl(relayTopology({ relayId: 'relay:' + this.ctx.id.toString(), relayName: 'Cloudflare Relay',
        selfNodeId, selectedHostId: meta.phase === 'client' ? meta.hostId : undefined, peers }));
      send(ws, meta.phase === 'host' ? encodeEnvelope(0, frame) : frame);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const secret = request.headers.get(CLOUD_ROOM_KEY_HEADER) || this.env.TB_SECRET;
    if (!secret) return new Response('Relay authentication is not configured', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = [...nonceBytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    server.serializeAttachment({ phase: 'auth', nonce, secret } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    send(server, encodeControl({ t: 'auth_challenge', nonce, required: true }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = attachment(ws);
    if (!meta) return sendError(ws, 'missing connection state');
    if (meta.phase === 'closed' || ws.readyState !== WebSocket.OPEN) return;

    if (meta.phase === 'auth') {
      try {
        const parsed = parseFrame(bytes(message));
        if (parsed.type !== FrameType.Control || parsed.msg.t !== 'auth_response') {
          throw new Error('expected auth_response');
        }
        if (!(await validMac(meta.secret, meta.nonce, parsed.msg.mac))) throw new Error('wrong password');
        ws.serializeAttachment({ phase: 'hello' } satisfies SocketAttachment);
      } catch (error) {
        sendError(ws, `authentication failed: ${(error as Error).message}`);
      }
      return;
    }

    if (meta.phase === 'hello') {
      let hello: Extract<ControlMessage, { t: 'hello' }>;
      try {
        const parsed = parseFrame(bytes(message));
        if (parsed.type !== FrameType.Control || parsed.msg.t !== 'hello') throw new Error('first frame must be hello');
        const checked = ControlMessageSchema.parse(parsed.msg);
        if (checked.t !== 'hello') throw new Error('expected hello');
        hello = checked;
      } catch (error) {
        return sendError(ws, `handshake failed: ${(error as Error).message}`);
      }

      if (hello.role === 'host') {
        const oldHosts = this.hosts().filter((candidate) => candidate.hostId === hello.hostId && candidate.ws !== ws);
        if (hello.replaceExisting === false && oldHosts.some(host => !hello.hostInstanceId || host.instanceId !== hello.hostInstanceId)) {
          ws.serializeAttachment({ phase: 'closed' } satisfies SocketAttachment);
          sendError(ws, 'host already registered');
          return;
        }
        for (const client of this.clients(hello.hostId)) this.retire(client.ws, 'host reconnected');
        for (const old of oldHosts) this.retire(old.ws, 'host replaced');
        ws.serializeAttachment({ phase: 'host', hostId: hello.hostId, name: hello.name ?? hello.hostId, wantsTopology: !!hello.wantsTopology,
          instanceId: hello.hostInstanceId } satisfies SocketAttachment);
        send(ws, encodeEnvelope(0, encodeControl({ t: 'host_register_ok' })));
        this.broadcastHostLists();
        this.broadcastTopology();
        return;
      }

      const available = this.hosts();
      if (hello.wantsTopology && hello.wantsHosts && !hello.hostId && available.length === 0) {
        // An authenticated observer has no Host/client routing identity.
        ws.serializeAttachment({ phase: 'client', hostId: '', clientId: 0, wantsHosts: true,
          wantsTopology: true, nodeId: 'client:' + (hello.clientInstanceId || crypto.randomUUID()),
          name: hello.name || 'Topology observer' } satisfies SocketAttachment);
        this.sendHostList(ws, ''); this.broadcastTopology(); return;
      }
      let targetId = hello.hostId;
      if (targetId === '' || targetId === 'default' || targetId === '-') {
        if (available.length === 1 || (hello.wantsHosts && available.length > 0)) targetId = available[0].hostId;
        else if (available.length === 0) return sendError(ws, 'no host online');
        else return sendError(ws, `multiple hosts: ${available.map((host) => host.hostId).join(', ')} — pick one with @<id>`);
      }
      const host = this.host(targetId);
      if (!host) return sendError(ws, `host not found: ${targetId}`);

      const inUse = new Set(this.clients(targetId).map((client) => client.clientId));
      const clientId = randomClientId(inUse);
      ws.serializeAttachment({ phase: 'client', hostId: targetId, clientId, wantsHosts: !!hello.wantsHosts,
        wantsTopology: !!hello.wantsTopology, nodeId: 'client:' + (hello.clientInstanceId || crypto.randomUUID()), name: hello.name || 'Client' } satisfies SocketAttachment);
      send(host, encodeEnvelope(clientId, encodeControl({ t: 'client_connect' })));
      if (hello.wantsHosts) this.sendHostList(ws, targetId);
      this.broadcastTopology();
      return;
    }

    try {
      const payload = bytes(message);
      if (meta.phase === 'host') {
        if (this.host(meta.hostId) !== ws) return;
        const envelope = decodeEnvelope(payload);
        const client = this.clients(meta.hostId).find((candidate) => candidate.clientId === envelope.clientId);
        if (client) send(client.ws, envelope.frame);
      } else {
        const host = this.host(meta.hostId);
        if (!host) return sendError(ws, `host not found: ${meta.hostId}`);
        send(host, encodeEnvelope(meta.clientId, payload));
      }
    } catch (error) {
      sendError(ws, `forwarding failed: ${(error as Error).message}`);
    }
  }

  webSocketClose(ws: WebSocket): void {
    const meta = attachment(ws);
    if (meta?.phase === 'host') {
      const replacementExists = this.hosts().some((host) => host.hostId === meta.hostId && host.ws !== ws);
      if (!replacementExists) {
        for (const client of this.clients(meta.hostId)) this.retire(client.ws, 'host disconnected');
      }
      this.broadcastHostLists();
    } else if (meta?.phase === 'client') {
      const host = this.host(meta.hostId);
      if (host) send(host, encodeEnvelope(meta.clientId, encodeControl({ t: 'client_disconnect' })));
    }
    this.broadcastTopology();
  }

  webSocketError(ws: WebSocket): void {
    ws.close(1011, 'websocket error');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if (url.pathname === '/' || url.pathname === '/health') {
        return Response.json(
          {
            service: 'termbridge-relay',
            transport: 'websocket',
            mode: env.TB_PUBLIC_ROOMS === '1' ? 'hosted' : 'self-hosted',
            auth: env.TB_PUBLIC_ROOMS === '1' || env.TB_SECRET ? 'required' : 'missing',
          },
          { status: env.TB_PUBLIC_ROOMS === '1' || env.TB_SECRET ? 200 : 503 },
        );
      }
      return new Response('Not found', { status: 404 });
    }

    const room = url.pathname.match(ROOM_PATH)?.[1]?.toLowerCase();
    if (room) {
      if (env.TB_PUBLIC_ROOMS !== '1') return new Response('Hosted rooms are disabled', { status: 404 });
      const secret = request.headers.get(CLOUD_ROOM_KEY_HEADER) || '';
      if (!(await roomMatchesSecret(room, secret))) return new Response('Invalid connection code', { status: 403 });
      return env.RELAY.getByName(`room:${room}`).fetch(request);
    }

    if (url.pathname !== '/') return new Response('Not found', { status: 404 });
    if (!env.TB_SECRET) return new Response('TB_SECRET is not configured', { status: 503 });
    return env.RELAY.getByName('private:relay').fetch(request);
  },
} satisfies ExportedHandler<Env>;
