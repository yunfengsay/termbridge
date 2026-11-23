// Real BSD-socket and Network.framework direct transports against disposable
// local servers; no system settings or user Host are modified.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, createServer as createTCPServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocketServer } = createRequire(join(project, '../../package.json'))('ws');
const dir = mkdtempSync(join(tmpdir(), 'tb-direct-transport-'));
const server = createServer(), proxy = createServer(), peers = new Set();
const websockets = new WebSocketServer({ noServer: true });
let messages = 0, tunnels = 0;
const switching = key => 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '
  + createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n';
// Handshake and framing a conforming server never sends.
const raw = {
  '/reject': socket => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
  '/stall': () => {},
  '/badaccept': (socket, key) => socket.write(switching(`${key}x`)),
  '/masked': (socket, key) => socket.write(Buffer.concat([Buffer.from(switching(key)), Buffer.from([0x82, 0x81, 1, 2, 3, 4, 0x41 ^ 1])])),
  // Split the response head, put a frame behind it, then deliver a frame byte by byte.
  '/split': async (socket, key) => {
    socket.setNoDelay(true);
    const head = Buffer.from(switching(key));
    socket.write(head.subarray(0, 10)); await delay(20);
    socket.write(Buffer.concat([head.subarray(10), Buffer.from([0x81, 0x02, 0x68, 0x69])]));
    for (const byte of Buffer.concat([Buffer.from([0x82, 0x7e, 0x01, 0x00]), Buffer.alloc(256, 7)])) {
      await delay(1); if (!socket.destroyed) socket.write(Buffer.from([byte]));
    }
  },
};
server.on('upgrade', (req, socket, head) => {
  peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
  const handler = raw[req.url];
  if (handler) { void handler(socket, req.headers['sec-websocket-key']); return; }
  websockets.handleUpgrade(req, socket, head, ws => websockets.emit('connection', ws, req));
});
websockets.on('connection', (socket, req) => {
  socket.on('error', () => {});
  switch (req.url) {
    case '/oversize': socket.send(Buffer.alloc(3 * 1024 * 1024)); return;
    case '/fragments': for (const fin of [false, false, true]) socket.send(Buffer.alloc(1024 * 1024), { fin }); return;
    case '/limit': socket.send(Buffer.alloc(2 * 1024 * 1024, 1)); return;
    case '/text': socket.send('hello'); return;
    case '/closecode': socket.close(4001, 'bye'); return;
    case '/serverping':
      socket.on('pong', data => { if (data.toString() === 'srv-ping') socket.send(Buffer.from('pong-ok')); });
      socket.ping(Buffer.from('srv-ping')); return;
  }
  socket.send(Buffer.from('welcome'));
  socket.on('message', data => {
    messages++;
    if (data.toString() === 'close-now') { socket.close(1000); return; }
    socket.send(data.subarray(0, 50000), { fin: false });
    socket.send(data.subarray(50000), { fin: true });
  });
});
proxy.on('connect', (request, downstream, head) => {
  tunnels++;
  downstream.on('error', () => {});
  // Only the forced-proxy control has a reachable target behind the tunnel.
  if (request.url !== `termbridge-proxy-test.invalid:${server.address().port}`) {
    downstream.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); return;
  }
  const upstream = connect(server.address().port, '127.0.0.1', () => {
    downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    downstream.pipe(upstream); upstream.pipe(downstream);
  });
  for (const socket of [downstream, upstream]) {
    peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
  }
});
async function run(command, args) {
  const child = spawn(command, args); let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output += data);
  const timeout = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timeout);
  if (code !== 0) throw Error(`${command}: ${code}\n${output}`);
  return output;
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const closed = createTCPServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const binary = join(dir, 'probe'), shared = join(project, 'Sources/TermBridgeControlCenter/Shared');
  await run('/usr/bin/swiftc', ['-parse-as-library', join(shared, 'DirectWebSocket.swift'), join(shared, 'SocketWebSocket.swift'),
    join(project, 'scripts/fixtures/DirectTransportProbe.swift'), '-o', binary]);
  const url = `ws://127.0.0.1:${server.address().port}`;
  const probe = async (transport, mode, target = `${url}/${mode}`) => {
    const before = { messages, tunnels };
    const output = await run(binary, [target, mode, String(proxy.address().port), transport]);
    console.log(`${transport} ${mode}: ${output.trim().replaceAll('\n', ' | ')}`);
    return { output, messages: messages - before.messages, tunnels: tunnels - before.tunnels };
  };
  for (const transport of ['socket', 'network']) {
    let result = await probe(transport, 'echo');
    for (const line of [/PROXY false/, /FRAGMENTED_ECHO_OK/, /PING_OK/, /CLOSE_OK/]) assert.match(result.output, line);
    assert.match((await probe(transport, 'cancel')).output, /CANCEL_OK/);
    assert.match((await probe(transport, 'replace')).output, /REPLACE_REENTRANT_OK/);
    assert.match((await probe(transport, 'oversize')).output, /OVERSIZE_REJECTED/);
    result = await probe(transport, 'fallback', `ws://termbridge-proxy-test.invalid:${closedPort}/fallback`);
    if (transport === 'network') {
      // The mechanism seen on the affected Mac: preferNoProxies tries a configured
      // proxy once the direct candidate cannot complete.
      assert.equal(result.tunnels, 1, 'Network.framework must demonstrate its proxy fallback');
    } else {
      assert.equal(result.tunnels, 0, 'The socket transport never attempts a proxy');
      assert.match(result.output, /FAILED NSURLErrorDomain -1003 \S+ resolve/);
    }
  }
  const forced = await probe('network', 'proxy', `ws://termbridge-proxy-test.invalid:${server.address().port}/proxy`);
  assert.equal(forced.tunnels, 1, 'Control must actually traverse the disposable proxy');
  assert.match(forced.output, /PROXY true/); assert.match(forced.output, /PROXY_REJECTED_BEFORE_AUTH/);
  assert.equal(forced.messages, 0, 'No authentication or application messages may cross the proxy');

  const refused = (await probe('socket', 'refused', `ws://127.0.0.1:${closedPort}/`)).output.match(/FAILED NSURLErrorDomain (-?\d+) (\d+) (\w+) (\d+)/);
  assert.ok(refused, 'refused port must fail');
  assert.deepEqual(refused.slice(1, 4), ['-1004', '61', 'connect'], 'ECONNREFUSED maps to cannotConnectToHost at connect');
  assert.ok(Number(refused[4]) < 1000, 'a refused port fails immediately, not at the deadline');
  const stall = (await probe('socket', 'stall')).output.match(/TIMEOUT_STAGE (\w+) (\d+)/);
  assert.equal(stall?.[1], 'upgrade'); assert.ok(Number(stall[2]) >= 1400 && Number(stall[2]) < 5000);
  assert.match((await probe('socket', 'reject')).output, /UPGRADE_REJECTED 403 upgrade/);
  assert.match((await probe('socket', 'badaccept')).output, /ACCEPT_REJECTED upgrade/);
  assert.match((await probe('socket', 'masked')).output, /MASKED_REJECTED/);
  assert.match((await probe('socket', 'split')).output, /SPLIT_OK/);
  assert.match((await probe('socket', 'text')).output, /TEXT_OK/);
  assert.match((await probe('socket', 'serverping')).output, /SERVER_PING_OK/);
  assert.match((await probe('socket', 'closecode')).output, /CLOSE_CODE 4001/);
  assert.match((await probe('socket', 'fragments')).output, /OVERSIZE_REJECTED/);
  assert.match((await probe('socket', 'limit')).output, /LIMIT_OK/);
} finally {
  for (const socket of websockets.clients) socket.terminate();
  for (const socket of peers) socket.destroy();
  websockets.close(); server.close(); proxy.close();
  rmSync(dir, { recursive: true, force: true });
}
