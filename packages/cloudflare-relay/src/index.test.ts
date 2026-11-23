import { SELF } from 'cloudflare:test';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { FrameType, decodeEnvelope, encodeControl, parseFrame } from '@termbridge/protocol';

function nextMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => {
      void (async () => {
        const data = event.data instanceof Blob ? await event.data.arrayBuffer() : (event.data as ArrayBuffer);
        resolve(Buffer.from(data));
      })();
    }, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
}

async function hmac(secret: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const result = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(nonce)));
  return [...result].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const SECRET = 'termbridge-test-secret-with-32-characters';

async function roomId(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function connect(secret = SECRET): Promise<WebSocket> {
  const room = await roomId(secret);
  const response = await SELF.fetch(`https://termbridge.test/r/${room}`, {
    headers: { Upgrade: 'websocket', 'X-Termbridge-Room-Key': secret },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const challenge = parseFrame(await nextMessage(ws));
  expect(challenge.type).toBe(FrameType.Control);
  if (challenge.type !== FrameType.Control || challenge.msg.t !== 'auth_challenge') throw new Error('missing challenge');
  ws.send(encodeControl({ t: 'auth_response', mac: await hmac(secret, challenge.msg.nonce) }));
  return ws;
}

describe('Cloudflare relay', () => {
  it('allows authenticated topology discovery with no Host and no command route', async () => {
    const ws = await connect('empty-topology-fixture-secret-with-32-characters');
    const messages: Buffer[] = [];
    ws.addEventListener('message', event => { void (async () => {
      messages.push(Buffer.from(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data as ArrayBuffer));
    })(); });
    ws.send(encodeControl({ t: 'hello', role: 'client', hostId: '', wantsHosts: true, wantsTopology: true }));
    for (let i = 0; i < 50 && messages.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const frames = messages.map(parseFrame);
    const topology = frames.find(frame => frame.type === FrameType.Control && frame.msg.t === 'relay_topology');
    expect(topology?.type === FrameType.Control && topology.msg.t === 'relay_topology' && topology.msg.nodes.some(node => node.role === 'host')).toBe(false);
    expect(topology, JSON.stringify(frames)).toBeDefined();
    const rejected = nextMessage(ws);
    ws.send(encodeControl({ t: 'session_list' }));
    const response = parseFrame(await rejected);
    expect(response.type === FrameType.Control && response.msg.t).toBe('error');
    ws.close();
  });
  it('reports a healthy, authenticated WebSocket relay', async () => {
    const response = await SELF.fetch('https://termbridge.test/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'termbridge-relay', mode: 'hosted', auth: 'required' });
  });

  it('rejects missing or mismatched room keys before WebSocket upgrade', async () => {
    const room = await roomId(SECRET);
    const missing = await SELF.fetch(`https://termbridge.test/r/${room}`, { headers: { Upgrade: 'websocket' } });
    expect(missing.status).toBe(403);
    const wrong = await SELF.fetch(`https://termbridge.test/r/${room}`, {
      headers: { Upgrade: 'websocket', 'X-Termbridge-Room-Key': `${SECRET}-wrong` },
    });
    expect(wrong.status).toBe(403);
  });

  it('registers a host and forwards binary frames in both directions', async () => {
    const host = await connect();
    const hostReady = nextMessage(host);
    host.send(encodeControl({ t: 'hello', role: 'host', hostId: 'mac-mini', name: 'Mac mini' }));
    const registered = decodeEnvelope(await hostReady);
    expect(registered.clientId).toBe(0);
    const registeredFrame = parseFrame(registered.frame);
    expect(registeredFrame.type === FrameType.Control && registeredFrame.msg.t).toBe('host_register_ok');

    const client = await connect();
    const hostConnect = nextMessage(host);
    client.send(encodeControl({ t: 'hello', role: 'client', hostId: 'mac-mini' }));
    const connected = decodeEnvelope(await hostConnect);
    expect(connected.clientId).not.toBe(0);

    const hostInput = nextMessage(host);
    client.send(encodeControl({ t: 'session_list' }));
    const input = decodeEnvelope(await hostInput);
    expect(input.clientId).toBe(connected.clientId);
    const inputFrame = parseFrame(input.frame);
    expect(inputFrame.type === FrameType.Control && inputFrame.msg.t).toBe('session_list');

    const clientOutput = nextMessage(client);
    host.send(new Uint8Array([0, 0, 0, ...new Uint8Array(encodeControl({ t: 'agents_result', names: ['codex'] }))]));
    // Send the correctly addressed envelope after proving a different client id is ignored.
    host.send(new Uint8Array([
      (connected.clientId >>> 24) & 0xff,
      (connected.clientId >>> 16) & 0xff,
      (connected.clientId >>> 8) & 0xff,
      connected.clientId & 0xff,
      ...new Uint8Array(encodeControl({ t: 'agents_result', names: ['codex'] })),
    ]));
    const output = parseFrame(await clientOutput);
    expect(output.type === FrameType.Control && output.msg.t).toBe('agents_result');

    client.close(1000, 'done');
    host.close(1000, 'done');
  });

  it('isolates hosts in different pairing rooms', async () => {
    const roomAHost = await connect();
    roomAHost.send(encodeControl({ t: 'hello', role: 'host', hostId: 'room-a', name: 'Room A' }));
    await nextMessage(roomAHost);

    const roomBClient = await connect('another-termbridge-test-secret-32-chars');
    const errorMessage = nextMessage(roomBClient);
    roomBClient.send(encodeControl({ t: 'hello', role: 'client', hostId: 'room-a' }));
    const error = parseFrame(await errorMessage);
    expect(error.type === FrameType.Control && error.msg.t).toBe('error');
    if (error.type === FrameType.Control && error.msg.t === 'error') expect(error.msg.message).toBe('host not found: room-a');

    roomBClient.close(1000, 'done');
    roomAHost.close(1000, 'done');
  });

  it('keeps different machine ids as separate hosts and never substitutes an explicit missing host', async () => {
    const home = await connect();
    const homeReady = nextMessage(home);
    home.send(encodeControl({ t: 'hello', role: 'host', hostId: 'mac-home', name: 'Home Mac' }));
    await homeReady;

    const office = await connect();
    const officeReady = nextMessage(office);
    office.send(encodeControl({ t: 'hello', role: 'host', hostId: 'mac-office', name: 'Office Mac' }));
    await officeReady;

    const client = await connect();
    const officeConnect = nextMessage(office);
    const rosterMessage = nextMessage(client);
    client.send(encodeControl({ t: 'hello', role: 'client', hostId: 'mac-office', wantsHosts: true }));
    await officeConnect;
    const roster = parseFrame(await rosterMessage);
    expect(roster.type).toBe(FrameType.Control);
    if (roster.type !== FrameType.Control || roster.msg.t !== 'host_list_result') throw new Error('missing host roster');
    expect(roster.msg.selectedHostId).toBe('mac-office');
    expect(roster.msg.hosts).toEqual(expect.arrayContaining([
      { hostId: 'mac-home', name: 'Home Mac' },
      { hostId: 'mac-office', name: 'Office Mac' },
    ]));

    const staleClient = await connect();
    const staleError = nextMessage(staleClient);
    staleClient.send(encodeControl({ t: 'hello', role: 'client', hostId: 'removed-mac', wantsHosts: true }));
    const parsedError = parseFrame(await staleError);
    expect(parsedError.type).toBe(FrameType.Control);
    if (parsedError.type !== FrameType.Control || parsedError.msg.t !== 'error') throw new Error('missing host error');
    expect(parsedError.msg.message).toBe('host not found: removed-mac');

    staleClient.close(1000, 'done');
    client.close(1000, 'done');
    office.close(1000, 'done');
    home.close(1000, 'done');
  });
});

describe('relay topology', () => {
  it('uses authenticated sockets, groups client instances, updates on close and supports host replacement', async () => {
    const secret = 'topology-isolated-test-room-secret';
    const sockets: WebSocket[] = [];
    const snapshots: Array<import('@termbridge/protocol').RelayTopology> = [];
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    try {
      const host = await connect(secret); sockets.push(host);
      const hostMessages: Array<import('@termbridge/protocol').RelayTopology> = [];
      host.addEventListener('message', async event => {
        const envelope = decodeEnvelope(Buffer.from(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data as ArrayBuffer));
        const frame = parseFrame(envelope.frame);
        if (frame.type === FrameType.Control && frame.msg.t === 'relay_topology') hostMessages.push(frame.msg);
      });
      const instance = '33333333-3333-4333-8333-333333333333';
      host.send(encodeControl({ t: 'hello', role: 'host', hostId: 'topology-host', name: 'Mac', wantsTopology: true,
        replaceExisting: false, hostInstanceId: instance }));
      await until(() => hostMessages.length > 0);
      expect(hostMessages.at(-1)?.selfNodeId).toBe('host:topology-host');
      for (let n = 0; n < 2; n++) {
        const client = await connect(secret); sockets.push(client);
        client.addEventListener('message', async event => {
          const frame = parseFrame(Buffer.from(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data as ArrayBuffer));
          if (frame.type === FrameType.Control && frame.msg.t === 'relay_topology') snapshots.push(frame.msg);
        });
        client.send(encodeControl({ t: 'hello', role: 'client', hostId: 'topology-host', name: 'Desktop', wantsTopology: true,
          clientInstanceId: '22222222-2222-4222-8222-222222222222' }));
      }
      await until(() => snapshots.at(-1)?.nodes.some(node => node.role === 'client' && node.connections === 2) === true);
      const latest = snapshots.at(-1)!;
      expect(latest.nodes).toHaveLength(3); expect(latest.edges).toHaveLength(2);
      expect(latest.selfNodeId).toBe('client:22222222-2222-4222-8222-222222222222');
      expect(latest.selectedHostId).toBe('topology-host');
      expect(JSON.stringify(latest)).not.toContain(secret);
      const duplicate = await connect(secret); sockets.push(duplicate);
      const rejected = nextMessage(duplicate);
      duplicate.send(encodeControl({ t: 'hello', role: 'host', hostId: 'topology-host', replaceExisting: false }));
      const rejection = parseFrame(await rejected);
      expect(rejection.type === FrameType.Control && rejection.msg.t === 'error' && rejection.msg.message).toBe('host already registered');
      // A rejected Host must not retire the real Host or either of its clients.
      const routed = nextMessage(host);
      sockets[1].send(encodeControl({ t: 'session_list' }));
      const forwarded = parseFrame(decodeEnvelope(await routed).frame);
      expect(forwarded.type === FrameType.Control && forwarded.msg.t).toBe('session_list');
      expect(host.readyState).toBe(WebSocket.OPEN);
      expect(sockets[2].readyState).toBe(WebSocket.OPEN);
      sockets[1].close(1000, 'done');
      await until(() => snapshots.at(-1)?.nodes.find(node => node.role === 'client')?.connections === 1);
      const replacement = await connect(secret); sockets.push(replacement);
      const replacementSnapshots: Array<import('@termbridge/protocol').RelayTopology> = [];
      replacement.addEventListener('message', async event => {
        const envelope = decodeEnvelope(Buffer.from(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data as ArrayBuffer));
        const frame = parseFrame(envelope.frame);
        if (frame.type === FrameType.Control && frame.msg.t === 'relay_topology') replacementSnapshots.push(frame.msg);
      });
      replacement.send(encodeControl({ t: 'hello', role: 'host', hostId: 'topology-host', name: 'Replacement', wantsTopology: true,
        replaceExisting: false, hostInstanceId: instance }));
      await until(() => replacementSnapshots.at(-1)?.nodes.length === 2);
      expect(replacementSnapshots.at(-1)?.nodes.find(node => node.role === 'host')?.name).toBe('Replacement');
    } finally { for (const socket of sockets) { try { socket.close(1000, 'done'); } catch {} } }
  });
});
