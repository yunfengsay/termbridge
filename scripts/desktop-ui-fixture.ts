/** Isolated mobile viewer acceptance; never captures or sends input to the real desktop. */
import { readFileSync, appendFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { encodeControl, parseFrame, FrameType } from '../packages/protocol/src/index.js';
import { RemoteDesktopService } from '../packages/host/src/remoteDesktop/service.js';
import type { DesktopEvent } from '../packages/host/src/remoteDesktop/native.js';

const image = process.argv[2];
if (!image) throw new Error('Usage: tsx scripts/desktop-ui-fixture.ts <1280x720-jpeg> [audit-jsonl]');
const jpeg = readFileSync(image).toString('base64');
const audit = (value: object) => { if (process.argv[3]) appendFileSync(process.argv[3], JSON.stringify(value) + '\n'); };
let sequence = 0;
let frameTimer: NodeJS.Timeout | undefined;
let capturing = false;
const sockets = new Map<number, import('ws').WebSocket>();
const native = {
  onEvent: undefined as ((event: DesktopEvent) => void) | undefined,
  async request(op: string, args: Record<string, unknown> = {}) {
    audit({ op, args });
    if (op === 'start') {
      capturing = true;
      native.onEvent?.({ event: 'frame', generation: 4, width: 1280, height: 720, data: jpeg });
      return { ok: true, data: { generation: 4, displayId: 3, width: 1280, height: 720 } };
    }
    if (op === 'ack' && capturing) { clearTimeout(frameTimer); frameTimer = setTimeout(() => { if (capturing) native.onEvent?.({ event: 'frame', generation: 4, width: 1280, height: 720, data: jpeg }); }, 100); }
    return { ok: true, data: { displays: [{ id: 3, name: 'Desktop fixture', main: true }] } };
  }, async close() {}, async reset() { capturing = false; clearTimeout(frameTimer); audit({ op: 'stop' }); },
};
const service = new RemoteDesktopService(native, {
  hostId: 'desktop-fixture', secret: () => 'desktop-fixture-pairing-key',
  send: (id, message) => sockets.get(id)?.send(encodeControl(message)),
});
const server = new WebSocketServer({ host: '127.0.0.1', port: 38642 });
server.on('connection', socket => {
  const id = ++sequence; sockets.set(id, socket);
  socket.send(encodeControl({ t: 'auth_challenge', nonce: 'desktop-fixture', required: true }));
  socket.on('message', bytes => {
    const frame = parseFrame(Buffer.from(bytes as Buffer)); if (frame.type !== FrameType.Control) return;
    const message = frame.msg;
    if (service.handle(id, message)) return;
    if (message.t === 'hello') socket.send(encodeControl({ t: 'host_list_result', hosts: [{ hostId: 'desktop-fixture', name: 'Desktop QA' }], selectedHostId: 'desktop-fixture' }));
    if (message.t === 'session_list') socket.send(encodeControl({ t: 'session_list_result', sessions: [] }));
    if (message.t === 'agents') socket.send(encodeControl({ t: 'agents_result', names: [] }));
  });
  socket.on('close', () => { service.drop(id); sockets.delete(id); });
});
console.log('Desktop fixture on loopback 38642; no real desktop access');
