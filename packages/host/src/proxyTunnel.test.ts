import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProxyTunnelMessage, ProxyTunnelPolicy } from '@termbridge/protocol';
import { isLoopbackTunnelHost, normalizeTunnelHost, ProxyTunnelManager } from './proxyTunnel.js';

function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = fn();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('normalizeTunnelHost and isLoopbackTunnelHost handle IPv4/IPv6/0.0.0.0 safely', () => {
  assert.equal(normalizeTunnelHost('0.0.0.0'), '127.0.0.1');
  assert.equal(normalizeTunnelHost('[::]'), '127.0.0.1');
  assert.equal(normalizeTunnelHost('[::1]'), '::1');
  assert.equal(normalizeTunnelHost('bad host/path'), undefined);
  assert.equal(isLoopbackTunnelHost('127.0.0.1'), true);
  assert.equal(isLoopbackTunnelHost('127.0.1.5'), true);
  assert.equal(isLoopbackTunnelHost('localhost'), true);
  assert.equal(isLoopbackTunnelHost('foo.localhost'), true);
  assert.equal(isLoopbackTunnelHost('::1'), true);
  assert.equal(isLoopbackTunnelHost('192.168.0.177'), false);
  assert.equal(isLoopbackTunnelHost('example.com'), false);
});

test('ProxyTunnelManager tunnels full-duplex HTTP bytes and writes metadata audit log', async () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'tb-tunnel-audit-'));
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('GET /ping')) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const sent: ProxyTunnelMessage[] = [];
  const mgr = new ProxyTunnelManager({
    send: (_client, msg) => sent.push(msg),
    policy: () => 'full',
    auditDir,
  });

  try {
    mgr.handle(7, { t: 'proxy_tunnel', id: 't1', kind: 'open', host: '0.0.0.0', port });
    await waitFor(() => sent.find((m) => m.kind === 'opened'));

    const req = Buffer.from('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    mgr.handle(7, { t: 'proxy_tunnel', id: 't1', kind: 'data', data: req.toString('base64') });

    await waitFor(() => sent.find((m) => m.kind === 'close'));
    const payload = Buffer.concat(
      sent.filter((m) => m.kind === 'data' && m.data).map((m) => Buffer.from(m.data!, 'base64')),
    ).toString('utf8');
    assert.match(payload, /HTTP\/1\.1 200 OK/);
    assert.match(payload, /pong$/);

    const auditText = readFileSync(join(auditDir, 'audit.log'), 'utf8');
    assert.match(auditText, /"op":"proxy_tunnel"/);
    assert.match(auditText, /"host":"127\.0\.0\.1"/);
    assert.doesNotMatch(auditText, /GET \/ping/);
    assert.doesNotMatch(auditText, /pong/);
  } finally {
    mgr.dispose();
    server.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('ProxyTunnelManager enforces policy off/loopback and flow-control window', async () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'tb-tunnel-policy-'));
  let policy: ProxyTunnelPolicy = 'off';
  const sent: ProxyTunnelMessage[] = [];
  const mgr = new ProxyTunnelManager({
    send: (_client, msg) => sent.push(msg),
    policy: () => policy,
    auditDir,
  });

  const big = Buffer.alloc(700 * 1024, 0x41);
  const server = createServer((socket) => {
    socket.end(big);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    mgr.handle(1, { t: 'proxy_tunnel', id: 'off1', kind: 'open', host: '127.0.0.1', port });
    assert.equal(sent.at(-1)?.kind, 'close');
    assert.match(sent.at(-1)?.reason ?? '', /disabled/i);

    policy = 'loopback';
    mgr.handle(1, { t: 'proxy_tunnel', id: 'lan1', kind: 'open', host: '192.168.0.177', port: 80 });
    assert.equal(sent.at(-1)?.kind, 'close');
    assert.match(sent.at(-1)?.reason ?? '', /loopback/i);

    sent.length = 0;
    mgr.handle(2, { t: 'proxy_tunnel', id: 'stream1', kind: 'open', host: '127.0.0.1', port });
    await waitFor(() => sent.find((m) => m.kind === 'opened'));

    // Wait until initial window pauses upstream reads before sending all 700 KiB.
    await waitFor(() => {
      const received = sent
        .filter((m) => m.kind === 'data' && m.data)
        .reduce((sum, m) => sum + Buffer.from(m.data!, 'base64').length, 0);
      return received >= 512 * 1024 ? received : undefined;
    });
    // Send ack credits so the remaining bytes finish streaming.
    mgr.handle(2, { t: 'proxy_tunnel', id: 'stream1', kind: 'ack', bytes: 512 * 1024 });
    await waitFor(() => sent.find((m) => m.kind === 'close'));
    const total = sent
      .filter((m) => m.kind === 'data' && m.data)
      .reduce((sum, m) => sum + Buffer.from(m.data!, 'base64').length, 0);
    assert.equal(total, big.length);
  } finally {
    mgr.dispose();
    server.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});
