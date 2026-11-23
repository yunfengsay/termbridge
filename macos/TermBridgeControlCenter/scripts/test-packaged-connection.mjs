// Regression: XCTest has no app ATS policy. Exercise a signed .app carrying the
// shipping Info.plist against disposable plain WS and self-signed TLS relays.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { createServer as createHTTPServer } from 'node:http';
import { X509Certificate, createHmac } from 'node:crypto';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, '../../package.json'));
const { WebSocketServer } = require('ws');
const { pack, unpack } = createRequire(join(project, '../../packages/protocol/package.json'))('msgpackr');
const dir = mkdtempSync(join(tmpdir(), 'tb-packaged-tls-'));
let server, sockets, plainServer, plainSockets;
async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw Error(`${command} failed (${code}): ${output}`);
  return output.trim();
}
try {
  await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]);
  const cert = readFileSync(join(dir, 'cert.pem'));
  server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert });
  sockets = new WebSocketServer({ server });
  const secret = 'disposable-packaged-tls-test';
  const handleConnection = socket => {
    const send = msg => socket.send(Buffer.concat([Buffer.from([0]), pack(msg)]));
    const nonce = 'disposable-auth-challenge'; let authed = false, hello = false;
    send({ t: 'auth_challenge', required: true, nonce });
    socket.on('message', data => {
      const message = unpack(data.subarray(1));
      if (!authed) {
        authed = message.t === 'auth_response' && message.mac === createHmac('sha256', secret).update(nonce).digest('hex');
        if (!authed) socket.close(4001); return;
      }
      if (!hello) { hello = message.t === 'hello'; if (!hello) socket.close(4002); return; }
      if (message.t === 'session_list') send({ t: 'session_list_result', sessions: [] });
    });
  };
  sockets.on('connection', handleConnection);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ middle: `wss://localhost:${server.address().port}`, secret, tlsPin: new X509Certificate(cert).fingerprint256 }), { mode: 0o600 });
  const contents = join(dir, 'TermBridge.app/Contents'); mkdirSync(join(contents, 'MacOS'), { recursive: true });
  cpSync(join(project, 'Resources/Info.plist'), join(contents, 'Info.plist'));
  const binary = join(contents, 'MacOS/TermBridgeControlCenter');
  const shared = join(project, 'Sources/TermBridgeControlCenter/Shared');
  const nativeSources = ['MacConnectionStore.swift', 'CLIInstallation.swift', 'CLIDiscovery.swift'];
  await run('/usr/bin/swiftc', ['-parse-as-library', ...readdirSync(shared).filter(f => f.endsWith('.swift')).map(f => join(shared, f)),
    ...nativeSources.map(f => join(project, 'Sources/TermBridgeControlCenter', f)), join(project, 'scripts/fixtures/ConnectionProbe.swift'), '-o', binary]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', dirname(contents)]);
  for (const mode of ['valid-pin', 'wrong-pin', 'no-pin']) {
    console.log(`${mode}: ${await run(binary, [settings, mode])}`);
  }
  writeFileSync(settings, JSON.stringify({ middle: `wss://localhost:${server.address().port}`, secret, mode: 'direct', tlsPin: new X509Certificate(cert).fingerprint256 }), { mode: 0o600 });
  for (const mode of ['valid-pin', 'wrong-pin', 'no-pin']) {
    console.log(`direct-${mode}: ${await run(binary, [settings, mode])}`);
  }
  plainServer = createHTTPServer();
  plainSockets = new WebSocketServer({ server: plainServer });
  plainSockets.on('connection', handleConnection);
  await new Promise(resolve => plainServer.listen(0, '127.0.0.1', resolve));
  writeFileSync(settings, JSON.stringify({ middle: `ws://127.0.0.1:${plainServer.address().port}`, secret, mode: 'direct' }), { mode: 0o600 });
  console.log(`plain-ws: ${await run(binary, [settings, 'plain-ws'])}`);
} finally {
  for (const socket of sockets?.clients ?? []) socket.terminate();
  for (const socket of plainSockets?.clients ?? []) socket.terminate();
  plainSockets?.close(); plainServer?.close();
  sockets?.close(); server?.close(); rmSync(dir, { recursive: true, force: true });
}
