// Real WebKit + encrypted desktop protocol against a disposable, synthetic Host.
// No screen capture, OS input, user Host or system screen-sharing connection.
import { WebSocketServer } from 'ws';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { encodeControl, parseFrame, FrameType } from '../../../packages/protocol/src/index.js';
import { RemoteDesktopService } from '../../../packages/host/src/remoteDesktop/service.js';
import type { DesktopEvent } from '../../../packages/host/src/remoteDesktop/native.js';

const secret = 'mac-desktop-fixture-secret';
const folder = mkdtempSync(join(tmpdir(), 'tb-mac-desktop-'));
const audit = join(folder, 'audit.jsonl');
const jpeg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#2383c5' } }).jpeg().toBuffer();
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => server.once('listening', resolve));
const sessions = new Set<RemoteDesktopService>();
server.on('connection', socket => {
  const nonce = randomUUID(); let authenticated = false;
  let service: RemoteDesktopService | undefined;
  socket.send(encodeControl({ t: 'auth_challenge', required: true, nonce }));
  socket.on('message', bytes => {
    const frame = parseFrame(Buffer.from(bytes as Buffer));
    if (frame.type !== FrameType.Control) return;
    const message = frame.msg;
    if (message.t === 'auth_response') {
      authenticated = message.mac === createHmac('sha256', secret).update(nonce).digest('hex');
      if (!authenticated) socket.close();
    } else if (authenticated && message.t === 'hello') {
      const hostId = message.hostId!;
      const record = (op: string, args = {}) => appendFileSync(audit, JSON.stringify({ hostId, op, args }) + '\n');
      const native = {
        onEvent: undefined as ((event: DesktopEvent) => void) | undefined,
        async request(op: string, args?: Record<string, unknown>) {
          record(op, args);
          if (op === 'start') {
            setTimeout(() => native.onEvent?.({ event: 'frame', generation: 4, width: 1280, height: 720, data: jpeg.toString('base64') }), 50);
            return { ok: true, data: { generation: 4, width: 1280, height: 720, displayId: 3 } };
          }
          return { ok: true, data: { displays: [{ id: 3, name: 'Fixture display' }] } };
        },
        async reset() { record('stop'); }, async close() {},
      };
      service = new RemoteDesktopService(native, { hostId, secret: () => secret,
        send: (_, message) => { if (socket.readyState === 1) socket.send(encodeControl(message)); } });
      sessions.add(service);
    } else if (authenticated) service?.handle(1, message);
  });
  socket.on('close', () => { if (service) { service.drop(1); void service.close(); sessions.delete(service); } });
});
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture listener');
  const child = spawn('/usr/bin/swift', ['test', '--package-path', 'macos/TermBridgeControlCenter', '--filter', 'MacRemoteDesktopTests'], {
    env: { ...process.env, TB_MACOS_DESKTOP_RELAY: `ws://127.0.0.1:${address.port}`, TB_MACOS_DESKTOP_AUDIT: audit }, stdio: 'inherit',
  });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (exit !== 0) throw new Error(`Desktop viewer acceptance failed; evidence: ${folder}`);
  console.log(`PASS: encrypted WebKit desktop, pixels, input, target ownership and teardown. Evidence: ${folder}`);
} finally {
  await Promise.all([...sessions].map(session => session.close()));
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
