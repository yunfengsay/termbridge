/** Isolated ARD authentication fixture. Fixed test credentials only; never connects to a real desktop. */
import { createDecipheriv, createHash, getDiffieHellman } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { encodeControl, parseFrame, FrameType } from '../packages/protocol/src/index.js';
import { RemoteDesktopService } from '../packages/host/src/remoteDesktop/service.js';
import { SystemSharing } from '../packages/host/src/remoteDesktop/systemSharing.js';

class AuthenticationFixture extends SystemSharing {
  private input = Buffer.alloc(0);
  private stage = 0;
  private emitBytes!: (bytes: Uint8Array) => Promise<void>;
  private dh = getDiffieHellman('modp2');
  override async connect(onBytes: (bytes: Uint8Array) => Promise<void>): Promise<boolean> {
    this.emitBytes = onBytes; this.dh.generateKeys();
    void onBytes(Buffer.from('RFB 003.008\n')); return true;
  }
  override enableFrames(_width: number, _height: number) { /* Fixture already emits Raw rectangles. */ }
  override receive(bytes: Uint8Array) {
    this.input = Buffer.concat([this.input, bytes]);
    while (this.step()) { /* Consume complete RFB packets only. */ }
  }
  private take(length: number) { const bytes = this.input.subarray(0, length); this.input = this.input.subarray(length); return bytes; }
  private step(): boolean {
    const n = this.input.length;
    if (this.stage === 0 && n >= 12) { this.take(12); this.stage = 1; void this.emitBytes(Buffer.from([1, 30])); return true; }
    if (this.stage === 1 && n >= 1) {
      if (this.take(1)[0] !== 30) throw new Error('Input corrupted ARD negotiation');
      this.stage = 2; void this.emitBytes(Buffer.concat([Buffer.from([0, 2, 0, 128]), this.dh.getPrime(), this.dh.getPublicKey()])); return true;
    }
    if (this.stage === 2 && n >= 256) {
      const response = this.take(256), shared = this.dh.computeSecret(response.subarray(128));
      const aes = createDecipheriv('aes-128-ecb', createHash('md5').update(shared).digest(), null); aes.setAutoPadding(false);
      const plain = Buffer.concat([aes.update(response.subarray(0, 128)), aes.final()]);
      const user = plain.subarray(0, 64).toString().split('\0')[0], password = plain.subarray(64).toString().split('\0')[0];
      const valid = user === 'fixture-user' && password === 'fixture-password'; plain.fill(0);
      if (!valid) { this.stage = -1; void this.emitBytes(Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])); }
      else { this.stage = 3; void this.emitBytes(Buffer.alloc(4)); }
      return true;
    }
    if (this.stage === 3 && n >= 1) {
      this.take(1); this.stage = 4;
      const name = Buffer.from('Authentication fixture'), init = Buffer.alloc(24);
      init.writeUInt16BE(64, 0); init.writeUInt16BE(64, 2);
      Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
      init.writeUInt32BE(name.length, 20); void this.emitBytes(Buffer.concat([init, name])); return true;
    }
    if (this.stage !== 4 || !n) return false;
    const type = this.input[0];
    const length = type === 0 ? 20 : type === 2 && n >= 4 ? 4 + this.input.readUInt16BE(2) * 4 : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : 0;
    if (!length || n < length) return false;
    this.take(length);
    if (type === 3) {
      const frame = Buffer.alloc(16 + 64 * 64 * 4); frame.writeUInt16BE(1, 2); frame.writeUInt16BE(64, 8); frame.writeUInt16BE(64, 10);
      frame.fill(120, 16); void this.emitBytes(frame);
    }
    return true;
  }
  override close() { this.stage = -1; this.input = Buffer.alloc(0); }
}
const sockets = new Map<number, import('ws').WebSocket>(); let sequence = 0;
const service = new RemoteDesktopService({ onEvent: undefined, async request() { return { ok: false }; }, async close() {}, async reset() {} }, {
  hostId: 'desktop-auth-fixture', secret: () => 'desktop-fixture-pairing-key', systemSharing: () => new AuthenticationFixture(),
  send: (id, message) => sockets.get(id)?.send(encodeControl(message)),
});
const server = new WebSocketServer({ host: '127.0.0.1', port: 38644 });
server.on('connection', socket => {
  const id = ++sequence; sockets.set(id, socket);
  socket.send(encodeControl({ t: 'auth_challenge', nonce: 'desktop-fixture', required: true }));
  socket.on('message', bytes => {
    const frame = parseFrame(Buffer.from(bytes as Buffer)); if (frame.type !== FrameType.Control) return;
    if (service.handle(id, frame.msg)) return;
    if (frame.msg.t === 'hello') socket.send(encodeControl({ t: 'host_list_result', hosts: [{ hostId: 'desktop-auth-fixture', name: 'Authentication fixture' }], selectedHostId: 'desktop-auth-fixture' }));
  });
  socket.on('close', () => { service.drop(id); sockets.delete(id); });
});
console.log('Isolated desktop authentication fixture on loopback 38644');
