// Real URLSession + shipping ATS policy; disposable HTTP/WS endpoints only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, '../../package.json'));
const { WebSocketServer } = require('ws');
const { pack, unpack } = createRequire(join(project, '../../packages/protocol/package.json'))('msgpackr');
const dir = mkdtempSync(join(tmpdir(), 'tb-http-connection-'));
const servers = [], peers = new Set();
async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  if (code !== 0) throw Error(`${command} failed (${code}): ${output}`);
  return output.trim();
}
async function fixture(mode) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, roomKey: req.headers['x-termbridge-room-key'] });
    if (mode === 'hang') return;
    if (mode === 'dropped') { req.socket.destroy(); return; }
    if (mode === 'challenge') { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="probe"' }); res.end(); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/private-target` }); res.end(); return; }
    if (mode === 'legacy') { res.writeHead(426); res.end(); return; }
    res.writeHead(200, { 'X-TermBridge-Service': 'relay-v1' }); res.end();
  });
  servers.push(server);
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    requests.push({ method: 'UPGRADE' });
    if (['reject', 'redirect'].includes(mode)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    const send = msg => socket.send(Buffer.concat([Buffer.from([0]), pack(msg)]));
    send({ t: 'auth_challenge', required: true, nonce: 'http-probe-nonce' });
    socket.on('message', data => {
      const message = unpack(data.subarray(1));
      if (message.t === 'auth_response') assert.equal(message.mac, createHmac('sha256', 'probe-password').update('http-probe-nonce').digest('hex'));
      if (message.t === 'hello') send({ t: 'host_list_result', hosts: [{ hostId: 'probe-host', name: 'Probe' }], selectedHostId: 'probe-host' });
      if (message.t === 'session_list') send({ t: 'session_list_result', sessions: [] });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `ws://127.0.0.1:${server.address().port}`, requests };
}
try {
  const contents = join(dir, 'TermBridge.app/Contents'); mkdirSync(join(contents, 'MacOS'), { recursive: true });
  cpSync(join(project, 'Resources/Info.plist'), join(contents, 'Info.plist'));
  const binary = join(contents, 'MacOS/TermBridgeControlCenter');
  const source = join(project, 'Sources/TermBridgeControlCenter'), shared = join(source, 'Shared');
  const names = ['MacConnectionTest.swift', 'ConnectionFailure.swift', 'AppDiagnostics.swift', 'MacHTTPConnectionProbe.swift'].filter(f => readdirSync(source).includes(f));
  await run('/usr/bin/swiftc', ['-parse-as-library', ...readdirSync(shared).filter(f => f.endsWith('.swift')).map(f => join(shared, f)),
    ...names.map(f => join(source, f)), join(project, 'scripts/fixtures/HTTPConnectionProbe.swift'), '-o', binary]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', dirname(contents)]);
  for (const mode of ['normal', 'legacy', 'hang', 'dropped', 'challenge']) {
    const server = await fixture(mode), output = await run(binary, [server.url, mode]);
    assert.match(output, /HOST probe-host/);
    assert.equal(server.requests[0].method, 'HEAD', 'HTTP must run before WebSocket/authentication');
    assert.equal(server.requests[0].path, '/.well-known/termbridge');
    assert.equal(server.requests.at(-1).method, 'UPGRADE');
    // Foundation may retry a dropped HEAD, but must not send any credentials.
    for (const request of server.requests) {
      assert.equal(request.auth, undefined); assert.equal(request.roomKey, undefined);
    }
    console.log(`${mode}: HTTP first, then authenticated Host/session list`);
  }
  for (const mode of ['reject', 'redirect']) {
    const server = await fixture(mode), output = await run(binary, [server.url, mode]);
    assert.match(output, /FAILED/); assert.match(output, /HTTP (200|302)/); assert.match(output, /WebSocket/);
    assert.equal(server.requests.length, 2, 'HTTP redirects must never be followed');
    assert.ok(!output.includes('probe-password'));
    console.log(`${mode}: HTTP evidence preserved beside WebSocket failure`);
  }
  const server = await fixture('hang'), start = Date.now(), output = await run(binary, [server.url, 'cancel']);
  assert.match(output, /CANCELLED/); assert.ok(Date.now() - start < 1500);
  assert.deepEqual(server.requests.map(r => r.method), ['HEAD'], 'Cancellation must not begin WebSocket');
  console.log('cancel: HTTP cancelled promptly; WebSocket never started');
} finally {
  for (const socket of peers) socket.terminate();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
}
