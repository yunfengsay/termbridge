import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { encodeControl, parseFrame, FrameType, decodeEnvelope } from '@termbridge/protocol';
import { parsePairing } from './pairing.js';
import { unicastIPv4, startLan, validateLanConfiguration } from './lan.js';
import { readTopology } from './topology.js';

test('pure relay exposes authenticated topology before any Host joins', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-empty-topology-'));
  const port = await freePort();
  const service = await startLan({ address: '127.0.0.1', port, password: 'fixture-topology', mode: 'relay', shareLocalHost: false }, { directory });
  try {
    const graph = await readTopology({ socket: () => new WebSocket(`ws://127.0.0.1:${port}`), secret: 'fixture-topology' });
    assert.equal(graph.nodes.filter(node => node.role === 'relay').length, 1);
    assert.equal(graph.nodes.filter(node => node.role === 'host').length, 0);
    await assert.rejects(readTopology({ socket: () => new WebSocket(`ws://127.0.0.1:${port}`), secret: 'wrong' }));
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function roster(service: Awaited<ReturnType<typeof startLan>>, password?: string): Promise<string[]> {
  const info = parsePairing(service.info.pairing);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(info.relayUrl);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('roster timeout')); }, 6000);
    ws.on('error', reject);
    ws.on('close', () => { clearTimeout(timer); reject(new Error('connection closed')); });
    ws.on('message', raw => {
      const frame = parseFrame(raw as Buffer);
      if (frame.type !== FrameType.Control) return;
      if (frame.msg.t === 'auth_challenge') {
        ws.send(encodeControl({ t: 'auth_response', mac: createHmac('sha256', password ?? info.secret).update(frame.msg.nonce).digest('hex') }));
        ws.send(encodeControl({ t: 'hello', role: 'client', hostId: info.hostId ?? '', wantsHosts: true }));
      } else if (frame.msg.t === 'host_list_result') {
        resolve(frame.msg.hosts.map(host => host.hostId)); ws.close();
      }
    });
  });
}

test('LAN HTTP discovery is password-free and does not expose hosts or bypass authentication', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-http-'));
  let service: Awaited<ReturnType<typeof startLan>> | undefined;
  const diagnostics: unknown[] = [];
  try {
    const port = await freePort();
    service = await startLan({ address: '127.0.0.1', port, password: '2468' }, { directory, diagnostic: event => diagnostics.push(event) });
    const probe = (method: string) => new Promise<{ status?: number; marker?: string | string[]; body: string }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}/.well-known/termbridge`, { method, timeout: 3000 }, res => {
        let body = ''; res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, marker: res.headers['x-termbridge-service'], body }));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP probe timeout'))); req.end();
    });
    assert.deepEqual(await probe('HEAD'), { status: 200, marker: 'relay-v1', body: '' });
    assert.deepEqual(JSON.parse((await probe('GET')).body), { service: 'termbridge', version: 1, transport: 'websocket' });
    await assert.rejects(roster(service, 'wrong-password'), /closed/);
    assert.deepEqual(await roster(service), [service.info.hostId]);
    assert.match(JSON.stringify(diagnostics), /http_probe/);
  } finally { await service?.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('LAN input accepts enterprise interface addresses and short nonempty passwords', () => {
  for (const ip of ['192.168.1.2', '10.0.0.1', '172.16.1.1', '30.20.30.40', '172.32.1.1']) assert.ok(unicastIPv4(ip));
  for (const ip of ['0.0.0.0', '224.0.0.1', '010.0.0.1', '192.168.1.256', 'host.local', '1.2.3']) assert.equal(unicastIPv4(ip), false);
  assert.throws(() => validateLanConfiguration({ address: '127.0.0.1', port: 80 }));
  assert.doesNotThrow(() => validateLanConfiguration({ address: '127.0.0.1', port: 7400, password: '2468' }));
  assert.throws(() => validateLanConfiguration({ address: '127.0.0.1', port: 7400, password: '' }));
  assert.doesNotThrow(() => validateLanConfiguration({ address: '30.20.30.40', port: 7400 }));
  for (const address of ['0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.throws(() => validateLanConfiguration({ address, port: 7400 }));
  }
});

test('four-character LAN password pairs, authenticates and survives restart', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-short-'));
  const port = await freePort();
  let service: Awaited<ReturnType<typeof startLan>> | undefined;
  const diagnostics: unknown[] = [];
  try {
    service = await startLan({ address: '127.0.0.1', port, password: '2468' }, { directory, diagnostic: event => diagnostics.push(event) });
    assert.equal(parsePairing(service.info.pairing).secret, '2468');
    assert.deepEqual(await roster(service), [service.info.hostId]);
    await assert.rejects(roster(service, '8642'), /closed/);
    await service.stop();
    const log = JSON.stringify(diagnostics);
    assert.match(log, /auth_accepted/); assert.match(log, /auth_rejected/);
    assert.match(log, /configuration_saved/); assert.match(log, /child_exited/);
    assert.doesNotMatch(log, /2468|8642|tb1_|nonce|pairing/);
    service = await startLan({ address: '127.0.0.1', port }, { directory });
    assert.equal(parsePairing(service.info.pairing).secret, '2468');
    assert.deepEqual(await roster(service), [service.info.hostId]);
  } finally { await service?.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('LAN owns password authentication, readiness, lease and repeatable shutdown without TLS', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-test-'));
  const port = await freePort();
  let service: Awaited<ReturnType<typeof startLan>> | undefined;
  try {
    service = await startLan({ address: '127.0.0.1', port }, { directory });
    const info = service.info;
    assert.deepEqual(await roster(service), [info.hostId]);
    await assert.rejects(roster(service, 'incorrect-password'), /closed/);
    assert.equal(parsePairing(info.pairing).relayUrl, `ws://127.0.0.1:${port}`);
    assert.equal(parsePairing(info.pairing).tlsPin, undefined);
    assert.equal(existsSync(join(directory, 'cert.pem')), false);
    assert.equal(existsSync(join(directory, 'key.pem')), false);
    await assert.rejects(startLan({ address: '127.0.0.1', port }, { directory }), /already running/);
    assert.equal(statSync(join(directory, 'connection.json')).mode & 0o777, 0o600);
    await Promise.all([service.stop(), service.stop()]);
    assert.equal(existsSync(join(directory, 'service.pid')), false);
    service = await startLan({ address: '127.0.0.1', port }, { directory });
    assert.equal(parsePairing(service.info.pairing).relayUrl, parsePairing(info.pairing).relayUrl);
    assert.equal(parsePairing(service.info.pairing).secret, parsePairing(info.pairing).secret);
    assert.deepEqual(await roster(service), [info.hostId]);
  } finally { await service?.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('LAN launch ignores legacy certificates and explicitly disables child TLS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-transport-'));
  const dist = join(directory, 'fixtures');
  mkdirSync(dist);
  // Deliberately invalid old files: startup must not parse or overwrite them.
  writeFileSync(join(directory, 'cert.pem'), 'legacy certificate');
  writeFileSync(join(directory, 'key.pem'), 'legacy key');
  const captured = join(directory, 'transport.json');
  writeFileSync(join(dist, 'relay.js'), `
    require('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify({
      url: process.env.RELAY_URL, noTLS: process.env.TB_RELAY_NO_TLS,
      cert: process.env.TB_TLS_CERT, key: process.env.TB_TLS_KEY, pin: process.env.TB_TLS_PIN
    }));
    process.send({event:'listening'}); setInterval(() => {}, 1000);
  `);
  writeFileSync(join(dist, 'host.js'), "process.send({event:'ready'}); setInterval(() => {}, 1000);");
  let service: Awaited<ReturnType<typeof startLan>> | undefined;
  try {
    service = await startLan({ address: '127.0.0.1', port: 37400, password: '2468' }, { directory, dist });
    assert.deepEqual(JSON.parse(readFileSync(captured, 'utf8')), {
      url: 'ws://127.0.0.1:37400', noTLS: '1', cert: '', key: '', pin: '',
    });
    assert.equal(parsePairing(service.info.pairing).tlsPin, undefined);
    assert.equal(parsePairing(service.info.pairing).secret, '2468');
    assert.equal(readFileSync(join(directory, 'cert.pem'), 'utf8'), 'legacy certificate');
    assert.equal(readFileSync(join(directory, 'key.pem'), 'utf8'), 'legacy key');
  } finally { await service?.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('occupied port and cancelled startup release ownership', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-cancel-'));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // The App refuses occupied ports promptly; it must not take over another service.
    await assert.rejects(startLan({ address: '127.0.0.1', port }, { directory }), /已被占用/);
    assert.equal(existsSync(join(directory, 'service.pid')), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(startLan({ address: '127.0.0.1', port }, { directory, signal: controller.signal }), /取消/);
    assert.equal(existsSync(join(directory, 'service.pid')), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test('port conflict leaves the original listener intact and permits a manual retry', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-retry-'));
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = (occupied.address() as { port: number }).port;
  let service: Awaited<ReturnType<typeof startLan>> | undefined;
  try {
    const start = Date.now();
    await assert.rejects(startLan({ address: '127.0.0.1', port, password: '2468' }, { directory }), /端口.*已被占用/);
    assert.ok(Date.now() - start < 5000, 'Do not wait for the 20 second startup timeout');
    assert.equal(occupied.listening, true);
    assert.equal(existsSync(join(directory, 'connection.json')), false);
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    service = await startLan({ address: '127.0.0.1', port, password: '2468' }, { directory });
    assert.deepEqual(await roster(service), [service.info.hostId]);
  } finally {
    await service?.stop();
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancellation while children start and unexpected child exit clean up both children', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-race-'));
  const dist = join(directory, 'fixtures');
  const { mkdirSync } = await import('node:fs'); mkdirSync(dist);
  const port = await freePort();
  try {
    writeFileSync(join(dist, 'relay.js'), "setTimeout(() => process.send({event:'listening'}), 1000); setInterval(() => {}, 1000);");
    writeFileSync(join(dist, 'host.js'), "process.send({event:'ready'}); setTimeout(() => process.exit(1), 150);");
    const cancel = new AbortController();
    const pending = startLan({ address: '127.0.0.1', port }, { directory, dist, signal: cancel.signal });
    setTimeout(() => cancel.abort(), 50);
    await assert.rejects(pending, /退出|中断|取消/);
    assert.equal(existsSync(join(directory, 'service.pid')), false);
    const service = await startLan({ address: '127.0.0.1', port }, { directory, dist });
    await new Promise<void>(resolve => service.onExit(resolve));
    await service.stop();
    assert.equal(existsSync(join(directory, 'service.pid')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('App supervisor crash does not leave an orphan listener or Host', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const directory = mkdtempSync(join(tmpdir(), 'tb-lan-parent-'));
  const port = await freePort();
  const entry = join(directory, 'parent.mjs');
  writeFileSync(entry, `import {startLan} from ${JSON.stringify(new URL('./lan.ts', import.meta.url).href)}; await startLan({address:'127.0.0.1',port:${port}}, {directory:${JSON.stringify(directory)}}); console.log('ready'); setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href, entry], { stdio: ['ignore', 'pipe', 'ignore'] });
  let recovered: Awaited<ReturnType<typeof startLan>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('supervisor timeout')), 15000);
      child.stdout!.on('data', data => { if (String(data).includes('ready')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('supervisor exited')); });
    });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
    // The relay releases its port after IPC disconnect. Retry binding rather than assuming a fixed delay.
    const deadline = Date.now() + 5000;
    while (true) {
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        await new Promise<void>(resolve => server.close(() => resolve())); break;
      } catch { server.close(); if (Date.now() >= deadline) throw new Error('orphan listener'); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    recovered = await startLan({ address: '127.0.0.1', port }, { directory });
    assert.deepEqual(await roster(recovered), [recovered.info.hostId]);
  } finally { child.kill('SIGTERM'); await recovered?.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('join accepts DNS and rejects malformed endpoint/password input', () => {
  for (const address of ['mac-mini.local', 'relay', '192.168.1.8']) {
    assert.doesNotThrow(() => validateLanConfiguration({ mode: 'join', address, port: 7400, password: '2468' }));
  }
  for (const address of ['ws://relay', 'relay:7400', '224.1.2.3', '01.2.3.4', 'bad/name', '']) {
    assert.throws(() => validateLanConfiguration({ mode: 'join', address, port: 7400 }));
  }
  assert.throws(() => validateLanConfiguration(JSON.parse('{"mode":"join","port":7400}')));
  assert.throws(() => validateLanConfiguration(JSON.parse('{"address":"relay","mode":"join","port":7400,"password":123}')));
});

test('a second App Host cannot replace an existing tb serve Host on the same relay', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-lan-conflict-'));
  const port = await freePort();
  let original: Awaited<ReturnType<typeof startLan>> | undefined;
  let duplicate: Awaited<ReturnType<typeof startLan>> | undefined;
  const starts: string[] = [];
  try {
    original = await startLan({ address: '127.0.0.1', port, password: 'fixture-password' }, { directory: join(root, 'original') });
    await assert.rejects(async () => {
      duplicate = await startLan({ mode: 'join', address: '127.0.0.1', port, password: 'fixture-password' }, {
        directory: join(root, 'duplicate'), diagnostic: event => { if (event.code === 'child_started') starts.push(event.fields.source!); },
      });
    }, /已.*共享|已有.*Host/);
    assert.deepEqual(starts, [], 'Detect the existing Host before launching another one');
    assert.deepEqual(await roster(original), [original.info.hostId]);
    assert.equal(existsSync(join(root, 'duplicate/connection.json')), false);
  } finally { await duplicate?.stop(); await original?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('relay atomically rejects a racing non-replacing Host and preserves connected clients', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-registration-race-'));
  const port = await freePort();
  const sockets: WebSocket[] = [];
  const relay = await startLan({ mode: 'relay', shareLocalHost: false, address: '127.0.0.1', port, password: 'race-password' }, { directory });
  const url = parsePairing(relay.info.pairing).relayUrl;
  const instances = new Map<WebSocket, string>();
  const register = (instanceId: string = randomUUID()) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url); sockets.push(ws);
    instances.set(ws, instanceId);
    let registered = false;
    const timer = setTimeout(() => reject(new Error('registration timeout')), 5000);
    ws.on('error', reject); ws.on('close', () => clearTimeout(timer));
    ws.on('message', raw => {
      if (registered) return;
      const data = raw as Buffer;
      if (data.subarray(0, 4).equals(Buffer.alloc(4))) {
        const frame = parseFrame(decodeEnvelope(data).frame);
        if (frame.type === FrameType.Control && frame.msg.t === 'host_register_ok') { registered = true; clearTimeout(timer); resolve(ws); }
        return;
      }
      const frame = parseFrame(data); if (frame.type !== FrameType.Control) return;
      if (frame.msg.t === 'auth_challenge') {
        ws.send(encodeControl({ t: 'auth_response', mac: createHmac('sha256', 'race-password').update(frame.msg.nonce).digest('hex') }));
        ws.send(encodeControl({ t: 'hello', role: 'host', hostId: 'race-host', replaceExisting: false, hostInstanceId: instanceId }));
      } else if (frame.msg.t === 'error') { clearTimeout(timer); reject(new Error(frame.msg.message)); }
    });
  });
  try {
    const results = await Promise.allSettled([register(), register()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejection.reason), /host already registered/);
    const original = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<WebSocket>).value;
    let connects = 0;
    original.on('message', raw => {
      const frame = parseFrame(decodeEnvelope(raw as Buffer).frame);
      if (frame.type === FrameType.Control && frame.msg.t === 'client_connect') connects++;
    });
    assert.deepEqual(await roster(relay), ['race-host']);
    await assert.rejects(register(), /host already registered/);
    assert.equal(original.readyState, WebSocket.OPEN);
    assert.deepEqual(await roster(relay), ['race-host']);
    assert.ok(connects >= 2, 'The original Host remains routable after duplicate registration');
    const oldClosed = new Promise<void>(resolve => original.once('close', () => resolve()));
    const recovered = await register(instances.get(original)!);
    await oldClosed;
    assert.equal(recovered.readyState, WebSocket.OPEN, 'The same Host instance can recover its own stale socket');
    assert.deepEqual(await roster(relay), ['race-host']);
  } finally { for (const ws of sockets) ws.terminate(); await relay.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent App Host startups report a conflict without reconnecting against the winner', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-app-host-race-'));
  const port = await freePort();
  const relay = await startLan({ mode: 'relay', shareLocalHost: false, address: '127.0.0.1', port, password: 'fixture' }, { directory: join(root, 'relay') });
  const winners: Awaited<ReturnType<typeof startLan>>[] = [];
  try {
    const results = await Promise.allSettled(['a', 'b'].map(name => startLan({ mode: 'join', address: '127.0.0.1', port, password: 'fixture' }, { directory: join(root, name) })));
    for (const result of results) if (result.status === 'fulfilled') winners.push(result.value);
    assert.equal(winners.length, 1);
    const loser = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(loser.reason), /已有服务共享本机/);
    assert.deepEqual(await roster(relay), [winners[0]!.info.hostId]);
    const failed = results[0]!.status === 'rejected' ? 'a' : 'b';
    assert.equal(existsSync(join(root, failed, 'service.pid')), false);
    assert.equal(existsSync(join(root, failed, 'connection.json')), false);
  } finally { await Promise.all(winners.map(service => service.stop())); await relay.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('relay-only and two outbound hosts expose live topology and recover after relay restart', { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-topology-'));
  const previous = { HOST_ID: process.env.HOST_ID, TB_HERDR: process.env.TB_HERDR };
  process.env.TB_HERDR = 'off';
  const services: Awaited<ReturnType<typeof startLan>>[] = [];
  const sockets: WebSocket[] = [];
  const { RelayTopologySchema } = await import('@termbridge/protocol');
  type Snapshot = import('@termbridge/protocol').RelayTopology;
  const serverSnapshots: Snapshot[] = [], aSnapshots: Snapshot[] = [], bSnapshots: Snapshot[] = [];
  const states: boolean[] = [];
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(predicate(), 'topology state did not converge');
  };
  const port = await freePort();
  const launchRelay = async () => {
    process.env.HOST_ID = 'topology-relay';
    const service = await startLan({ mode: 'relay', shareLocalHost: false, address: '127.0.0.1', port, password: '2468' },
      { directory: join(root, 'relay'), topology: value => serverSnapshots.push(value) });
    services.push(service); return service;
  };
  try {
    let relay = await launchRelay();
    assert.equal(relay.info.sharesHost, false); assert.equal(parsePairing(relay.info.pairing).hostId ?? '', '');
    await until(() => serverSnapshots.at(-1)?.nodes.length === 1);
    process.env.HOST_ID = 'topology-a';
    const a = await startLan({ mode: 'join', address: '127.0.0.1', port, password: '2468' },
      { directory: join(root, 'a'), topology: value => aSnapshots.push(value), connectionState: value => states.push(value) });
    services.push(a);
    process.env.HOST_ID = 'topology-b';
    const b = await startLan({ mode: 'join', address: '127.0.0.1', port, password: '2468' },
      { directory: join(root, 'b'), topology: value => bSnapshots.push(value) });
    services.push(b);
    assert.equal(b.info.mode, 'join');
    assert.deepEqual((await roster(a)).sort(), ['topology-a', 'topology-b']);
    await until(() => aSnapshots.at(-1)?.nodes.filter(node => node.role === 'host').length === 2 && bSnapshots.length > 0);
    assert.equal(aSnapshots.at(-1)?.selfNodeId, 'host:topology-a');
    assert.equal(bSnapshots.at(-1)?.selfNodeId, 'host:topology-b');
    const clientSnapshots: Snapshot[] = [];
    for (let n = 0; n < 2; n++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(ws);
      ws.on('error', () => {});
      ws.on('message', raw => {
        const frame = parseFrame(raw as Buffer); if (frame.type !== FrameType.Control) return;
        if (frame.msg.t === 'auth_challenge') {
          ws.send(encodeControl({ t: 'auth_response', mac: createHmac('sha256', '2468').update(frame.msg.nonce).digest('hex') }));
          ws.send(encodeControl({ t: 'hello', role: 'client', hostId: 'topology-a', wantsTopology: true,
            clientInstanceId: '11111111-1111-4111-8111-111111111111', name: 'Desktop fixture' }));
        } else if (frame.msg.t === 'relay_topology') clientSnapshots.push(RelayTopologySchema.parse(frame.msg));
      });
    }
    await until(() => clientSnapshots.at(-1)?.nodes.some(node => node.id.startsWith('client:') && node.connections === 2) === true);
    assert.equal(clientSnapshots.at(-1)?.selfNodeId, 'client:11111111-1111-4111-8111-111111111111');
    assert.equal(clientSnapshots.at(-1)?.selectedHostId, 'topology-a');
    assert.doesNotMatch(JSON.stringify(clientSnapshots), /2468|tb1_|nonce|connection\.json/);
    sockets[0]!.close();
    await until(() => clientSnapshots.at(-1)?.nodes.find(node => node.id.startsWith('client:'))?.connections === 1);
    await relay.stop();
    await until(() => states.includes(false));
    relay = await launchRelay();
    await until(() => states.at(-1) === true && aSnapshots.at(-1)?.nodes.filter(node => node.role === 'host').length === 2);
    await b.stop();
    await until(() => aSnapshots.at(-1)?.nodes.filter(node => node.role === 'host').length === 1);
    await a.stop();
    await until(() => serverSnapshots.at(-1)?.nodes.length === 1);
    // Failed/cancelled replacement configuration must not erase the last known good endpoint.
    const saved = readFileSync(join(root, 'a/connection.json'), 'utf8');
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 500);
    try {
      await assert.rejects(startLan({ mode: 'join', address: '127.0.0.1', port, password: 'wrong-password' },
        { directory: join(root, 'a'), signal: abort.signal }));
    } finally { clearTimeout(timer); }
    assert.equal(readFileSync(join(root, 'a/connection.json'), 'utf8'), saved);
  } finally {
    for (const ws of sockets) ws.terminate();
    await Promise.all(services.map(service => service.stop()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
