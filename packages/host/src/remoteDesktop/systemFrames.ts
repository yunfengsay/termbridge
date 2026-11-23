import { compressPixels, framebufferUpdate, validDesktopSize, type DesktopRect, MAX_DESKTOP_PIXELS } from './frameEncoding.js';

/** Bounded post-auth RFB decoder. Only Raw and DesktopSize are negotiated on loopback.
 * Account authentication remains opaque; compressed rectangles leave the Host only inside desktop encryption.
 */
export class SystemFrames {
  private chunks: Buffer[] = [];
  private offset = 0;
  private length = 0;
  private remaining = -1;
  private rectangle?: DesktopRect & { encoding: number };
  private rectangles: Buffer[] = [];
  private pixels = 0;
  private encodedBytes = 0;
  private closed = false;
  private viewport: DesktopRect;
  private quality = 65;
  readonly stats = { rawBytes: 0, encodedBytes: 0, frames: 0 };
  constructor(private width: number, private height: number, private readonly output: (bytes: Buffer) => Promise<void>) {
    if (!validDesktopSize(width, height)) throw new Error('Invalid desktop size');
    this.viewport = { x: 0, y: 0, width, height };
  }
  setViewport(rect: DesktopRect) { this.viewport = { ...rect }; }
  close() { this.closed = true; this.chunks = []; this.length = 0; this.rectangles = []; }
  private take(count: number): Buffer {
    const first = this.chunks[0];
    if (count <= first.length - this.offset) {
      const result = first.subarray(this.offset, this.offset + count); this.offset += count; this.length -= count;
      if (this.offset === first.length) { this.chunks.shift(); this.offset = 0; } return result;
    }
    const result = Buffer.allocUnsafe(count); let copied = 0;
    while (copied < count) { const size = Math.min(count - copied, this.chunks[0].length - this.offset); this.take(size).copy(result, copied); copied += size; }
    return result;
  }
  async receive(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    this.chunks.push(Buffer.from(data)); this.length += data.length;
    if (this.length > MAX_DESKTOP_PIXELS * 4 + 65536) throw new Error('Desktop receive limit');
    while (!this.closed) {
      if (this.remaining < 0) {
        if (!this.length) return;
        const type = this.chunks[0][this.offset];
        if (type === 2) { await this.output(this.take(1)); continue; }
        // Clipboard was not requested; reject unexpected messages instead of guessing framing.
        if (type !== 0) throw new Error('Unsupported system desktop message');
        if (this.length < 4) return;
        this.remaining = this.take(4).readUInt16BE(2);
        if (this.remaining > 1024) throw new Error('Desktop rectangle count');
        this.pixels = 0; this.encodedBytes = 0;
      }
      if (!this.remaining) {
        const frame = framebufferUpdate(this.rectangles); this.rectangles = []; this.remaining = -1;
        const start = Date.now(); await this.output(frame);
        this.stats.frames++; this.stats.encodedBytes += frame.length;
        // Quality adapts to actual downstream delivery, not just local socket writes.
        const elapsed = Date.now() - start;
        if (elapsed > 600) this.quality = Math.max(40, this.quality - 5);
        else if (elapsed < 150) this.quality = Math.min(80, this.quality + 2);
        continue;
      }
      if (!this.rectangle) {
        if (this.length < 12) return;
        const h = this.take(12);
        const rect = { x: h.readUInt16BE(0), y: h.readUInt16BE(2), width: h.readUInt16BE(4), height: h.readUInt16BE(6), encoding: h.readInt32BE(8) };
        if (!validDesktopSize(rect.width, rect.height)) throw new Error('Invalid system rectangle');
        if (rect.encoding === -223) {
          this.width = rect.width; this.height = rect.height; this.viewport = { x: 0, y: 0, width: this.width, height: this.height };
          this.rectangles.push(h); this.remaining--; continue;
        }
        if (rect.encoding !== 0 || rect.x + rect.width > this.width || rect.y + rect.height > this.height) throw new Error('Unexpected system encoding or bounds');
        this.pixels += rect.width * rect.height;
        if (this.pixels > MAX_DESKTOP_PIXELS) throw new Error('Desktop frame pixel limit');
        this.rectangle = rect;
      }
      const rect = this.rectangle, size = rect.width * rect.height * 4;
      if (this.length < size) return;
      const pixels = this.take(size); this.stats.rawBytes += size;
      const encoded = await compressPixels(pixels, rect, this.viewport, this.quality);
      if (this.closed) return;
      if (encoded) { this.encodedBytes += encoded.length; if (this.encodedBytes > 8 * 1024 * 1024) throw new Error('Desktop compressed size limit'); this.rectangles.push(encoded); }
      this.rectangle = undefined; this.remaining--;
    }
  }
}
