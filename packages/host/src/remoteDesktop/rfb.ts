import { VisibleTiles, framebufferUpdate, type DesktopRect } from './frameEncoding.js';
/** Minimal RFB 3.8 server. noVNC supplies decoding and input; native capture supplies JPEG. */
export type RfbInput = { op: 'pointer' | 'key' | 'scroll' | 'text'; args: Record<string, unknown> };
export class DesktopRfb {
  private buffered = Buffer.alloc(0);
  private state: 'version' | 'security' | 'init' | 'ready' | 'closed' = 'version';
  private requested = false;
  private viewport?: DesktopRect;
  private incremental = false;
  private encoding = false;
  private epoch = 0;
  private tiles = new VisibleTiles();
  private tight = false;
  private resize = false;
  private buttons = 0;
  private frame?: { width: number; height: number; jpeg: Buffer; consumed: () => void };

  constructor(private width: number, private height: number, private readonly callbacks: {
    send: (bytes: Buffer) => void; sendFrame?: (bytes: Buffer) => Promise<void>; streaming?: boolean; input: (event: RfbInput) => void; close: (reason: string) => void;
  }) { callbacks.send(Buffer.from('RFB 003.008\n')); }

  receive(bytes: Uint8Array): void {
    if (this.state === 'closed') return;
    this.buffered = Buffer.concat([this.buffered, bytes]);
    if (this.buffered.length > 256 * 1024) return this.fail('RFB input exceeded limit');
    try { while (this.parse()) { /* fragmented or coalesced messages */ } }
    catch { this.fail('Invalid RFB message'); }
  }

  private take(count: number): Buffer { const result = this.buffered.subarray(0, count); this.buffered = this.buffered.subarray(count); return result; }
  private parse(): boolean {
    if (this.state === 'version') {
      if (this.buffered.length < 12) return false;
      if (this.take(12).toString() !== 'RFB 003.008\n') { this.fail('RFB 3.8 required'); return false; }
      // This private byte stream exists only inside an authenticated encrypted desktop session.
      this.callbacks.send(Buffer.from([1, 1])); this.state = 'security'; return true;
    }
    if (this.state === 'security') {
      if (!this.buffered.length) return false;
      if (this.take(1)[0] !== 1) { this.fail('Invalid RFB security selection'); return false; }
      this.callbacks.send(Buffer.alloc(4)); this.state = 'init'; return true;
    }
    if (this.state === 'init') {
      if (!this.buffered.length) return false;
      this.take(1);
      const name = Buffer.from('TermBridge Desktop'); const init = Buffer.alloc(24 + name.length);
      init.writeUInt16BE(this.width, 0); init.writeUInt16BE(this.height, 2);
      init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0], 4);
      init.writeUInt32BE(name.length, 20); init.set(name, 24);
      this.callbacks.send(init); this.state = 'ready'; return true;
    }
    if (this.state !== 'ready' || !this.buffered.length) return false;
    const type = this.buffered[0];
    if (type === 0) {
      if (this.buffered.length < 20) return false;
      const format = this.take(20);
      if (format[4] !== 32 || format[5] !== 24 || format[7] !== 1) this.fail('True colour 32-bit format required');
    } else if (type === 2) {
      if (this.buffered.length < 4) return false;
      const count = this.buffered.readUInt16BE(2);
      if (count > 256) throw new Error('encoding count');
      if (this.buffered.length < 4 + count * 4) return false;
      const encodings = this.take(4 + count * 4); this.tight = false; this.resize = false;
      for (let i = 0; i < count; i++) {
        const encoding = encodings.readInt32BE(4 + i * 4);
        if (encoding === 7) this.tight = true;
        if (encoding === -223) this.resize = true;
      }
      if (!this.tight) this.fail('Tight JPEG encoding required');
    } else if (type === 3) {
      if (this.buffered.length < 10) return false;
      const request = this.take(10);
      this.incremental = request[1] !== 0;
      this.viewport = { x: request.readUInt16BE(2), y: request.readUInt16BE(4), width: request.readUInt16BE(6), height: request.readUInt16BE(8) };
      this.requested = true; this.flush();
    } else if (type === 4) {
      if (this.buffered.length < 8) return false;
      const key = this.take(8); const down = key[1] !== 0; const symbol = key.readUInt32BE(4);
      const code = macKey(symbol);
      if (code !== undefined) this.callbacks.input({ op: 'key', args: { code, down } });
      else if (down) {
        const point = symbol >= 0x01000000 ? symbol - 0x01000000 : symbol;
        if (point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && (symbol < 0xff00 || symbol >= 0x01000000)) {
          this.callbacks.input({ op: 'text', args: { text: String.fromCodePoint(point) } });
        }
      }
    } else if (type === 5) {
      if (this.buffered.length < 6) return false;
      const mouse = this.take(6), mask = mouse[1];
      const x = Math.min(1, mouse.readUInt16BE(2) / Math.max(1, this.width - 1));
      const y = Math.min(1, mouse.readUInt16BE(4) / Math.max(1, this.height - 1));
      this.callbacks.input({ op: 'pointer', args: { action: 'move', x, y } });
      for (const [bit, button] of [[1, 0], [2, 2], [4, 1]]) if ((mask & bit) !== (this.buttons & bit)) {
        this.callbacks.input({ op: 'pointer', args: { action: (mask & bit) ? 'down' : 'up', x, y, button } });
      }
      if ((mask & 0x78) && !(this.buttons & 0x78)) {
        this.callbacks.input({ op: 'scroll', args: { dx: mask & 32 ? 80 : mask & 64 ? -80 : 0, dy: mask & 8 ? 80 : mask & 16 ? -80 : 0 } });
      }
      this.buttons = mask;
    } else if (type === 6) {
      if (this.buffered.length < 8) return false;
      const length = this.buffered.readUInt32BE(4);
      if (length > 16_384) throw new Error('clipboard limit');
      if (this.buffered.length < 8 + length) return false;
      // Clipboard sync is deliberately disabled. Explicit text input uses the session command.
      this.take(8 + length);
    } else { this.fail('Unsupported RFB client message'); return false; }
    return this.state === 'ready';
  }

  offerFrame(width: number, height: number, jpeg: Buffer, consumed: () => void): void {
    if (this.state === 'closed') return;
    if (jpeg.length >= 4_194_304 || width < 1 || height < 1 || width > 65535 || height > 65535) return this.fail('Desktop frame exceeds RFB bounds');
    if (this.frame) return this.fail('Desktop producer exceeded its acknowledgement window');
    this.frame = { width, height, jpeg, consumed }; this.flush();
  }

  private flush(): void {
    if (this.state !== 'ready' || !this.requested || !this.tight || !this.frame || this.encoding) return;
    const frame = this.frame; this.frame = undefined;
    const changed = frame.width !== this.width || frame.height !== this.height;
    if (changed && !this.resize) return this.fail('Client cannot resize desktop');
    if (this.callbacks.streaming) {
      const epoch = this.epoch, incremental = this.incremental && !changed;
      const viewport = changed || !this.viewport ? { x: 0, y: 0, width: frame.width, height: frame.height } : this.viewport;
      this.requested = false; this.encoding = true;
      void this.tiles.encode(frame.jpeg, frame.width, frame.height, viewport, incremental).then(async rectangles => {
        if (this.state === 'closed' || epoch !== this.epoch) return;
        if (changed) { const resize = Buffer.alloc(12); resize.writeUInt16BE(frame.width, 4); resize.writeUInt16BE(frame.height, 6); resize.writeInt32BE(-223, 8); rectangles.unshift(resize); }
        this.width = frame.width; this.height = frame.height;
        const bytes = framebufferUpdate(rectangles);
        if (this.callbacks.sendFrame) await this.callbacks.sendFrame(bytes); else this.callbacks.send(bytes);
        if (epoch === this.epoch) frame.consumed();
      }).catch(() => { if (this.state !== 'closed' && epoch === this.epoch) this.fail('Desktop frame compression failed'); })
        .finally(() => { this.encoding = false; this.flush(); });
      return;
    }
    const header = Buffer.alloc(4); header.writeUInt16BE(changed ? 2 : 1, 2);
    const rectangle = (encoding: number) => {
      const rect = Buffer.alloc(12); rect.writeUInt16BE(frame.width, 4); rect.writeUInt16BE(frame.height, 6); rect.writeInt32BE(encoding, 8); return rect;
    };
    const length: number[] = []; let remaining = frame.jpeg.length;
    length.push((remaining & 127) | (remaining > 127 ? 128 : 0)); remaining >>>= 7;
    if (remaining) { length.push((remaining & 127) | (remaining > 127 ? 128 : 0)); remaining >>>= 7; if (remaining) length.push(remaining); }
    this.width = frame.width; this.height = frame.height; this.requested = false;
    this.callbacks.send(Buffer.concat([header, ...(changed ? [rectangle(-223)] : []), rectangle(7), Buffer.from([0x90, ...length]), frame.jpeg]));
    frame.consumed();
  }

  discardFrame(): void { this.epoch++; this.tiles.clear(); this.frame = undefined; }
  resetInput(): void { this.buttons = 0; }
  close(): void { this.epoch++; this.tiles.clear(); this.state = 'closed'; this.frame = undefined; this.buffered = Buffer.alloc(0); }
  private fail(reason: string): void { if (this.state === 'closed') return; this.close(); this.callbacks.close(reason); }
}

const asciiCodes: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50, ' ': 49,
};
const specialCodes: Record<number, number> = { 0xff08: 51, 0xff09: 48, 0xff0d: 36, 0xff1b: 53, 0xffff: 117,
  0xff50: 115, 0xff51: 123, 0xff52: 126, 0xff53: 124, 0xff54: 125, 0xff55: 116, 0xff56: 121, 0xff57: 119,
  0xffe1: 56, 0xffe2: 60, 0xffe3: 59, 0xffe4: 62, 0xffe9: 58, 0xffea: 61, 0xffe7: 55, 0xffe8: 54, 0xffeb: 55, 0xffec: 54,
  0xffbe: 122, 0xffbf: 120, 0xffc0: 99, 0xffc1: 118, 0xffc2: 96, 0xffc3: 97, 0xffc4: 98, 0xffc5: 100, 0xffc6: 101, 0xffc7: 109, 0xffc8: 103, 0xffc9: 111 };
export function macKey(symbol: number): number | undefined {
  if (symbol < 128) return asciiCodes[String.fromCharCode(symbol).toLowerCase()];
  return specialCodes[symbol];
}
