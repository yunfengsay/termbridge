import sharp from 'sharp';
import { createHash } from 'node:crypto';

export type DesktopRect = { x: number; y: number; width: number; height: number };
export const MAX_DESKTOP_PIXELS = 32 * 1024 * 1024;
export function validDesktopSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= MAX_DESKTOP_PIXELS;
}
export function intersectRect(a: DesktopRect, b: DesktopRect): DesktopRect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
export function jpegRectangle(rect: DesktopRect, jpeg: Buffer): Buffer {
  if (jpeg.length >= 4194304) throw new Error('Compressed desktop rectangle too large');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(rect.x, 0); header.writeUInt16BE(rect.y, 2);
  header.writeUInt16BE(rect.width, 4); header.writeUInt16BE(rect.height, 6); header.writeInt32BE(7, 8);
  const length: number[] = []; let n = jpeg.length;
  length.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7;
  if (n) { length.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7; if (n) length.push(n); }
  return Buffer.concat([header, Buffer.from([0x90, ...length]), jpeg]);
}
export function framebufferUpdate(rectangles: Buffer[]): Buffer {
  if (rectangles.length > 1024) throw new Error('Too many desktop rectangles');
  const header = Buffer.alloc(4); header.writeUInt16BE(rectangles.length, 2);
  const frame = Buffer.concat([header, ...rectangles]);
  if (frame.length > 8 * 1024 * 1024) throw new Error('Compressed desktop frame too large');
  return frame;
}
export async function compressPixels(pixels: Buffer, source: DesktopRect, visible: DesktopRect, quality: number): Promise<Buffer | undefined> {
  const rect = intersectRect(source, visible);
  if (!rect) return;
  const jpeg = await sharp(pixels, { raw: { width: source.width, height: source.height, channels: 4 } })
    .extract({ left: rect.x - source.x, top: rect.y - source.y, width: rect.width, height: rect.height })
    .removeAlpha().jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
  return jpegRectangle(rect, jpeg);
}

/** Visible tile cache: unchanged pixels consume no image bandwidth; panning refreshes only the new tile set. */
export class VisibleTiles {
  private hashes = new Map<string, string>();
  private shape = '';
  private epoch = 0;
  clear() { this.epoch++; this.hashes.clear(); this.shape = ''; }
  async encode(jpeg: Buffer, width: number, height: number, viewport: DesktopRect, incremental: boolean): Promise<Buffer[]> {
    const shape = `${width}:${height}`;
    if (shape !== this.shape || !incremental) this.clear();
    this.shape = shape;
    const epoch = this.epoch;
    const { data, info } = await sharp(jpeg, { limitInputPixels: MAX_DESKTOP_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (epoch !== this.epoch) return [];
    if (info.width !== width || info.height !== height || !validDesktopSize(width, height)) throw new Error('Desktop image dimensions mismatch');
    const visible = intersectRect(viewport, { x: 0, y: 0, width, height });
    if (!visible) return [];
    const next = new Map<string, string>(), rectangles: Buffer[] = [];
    for (let y = Math.floor(visible.y / 256) * 256; y < visible.y + visible.height; y += 256) {
      for (let x = Math.floor(visible.x / 256) * 256; x < visible.x + visible.width; x += 256) {
        const rect = intersectRect({ x, y, width: Math.min(256, width - x), height: Math.min(256, height - y) }, visible)!;
        const tile = Buffer.allocUnsafe(rect.width * rect.height * 4);
        for (let row = 0; row < rect.height; row++) data.copy(tile, row * rect.width * 4, ((rect.y + row) * width + rect.x) * 4, ((rect.y + row) * width + rect.x + rect.width) * 4);
        const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
        const hash = createHash('sha256').update(tile).digest('hex'); next.set(key, hash);
        if (this.hashes.get(key) !== hash) rectangles.push((await compressPixels(tile, rect, rect, 75))!);
        if (epoch !== this.epoch) return [];
      }
    }
    this.hashes = next; return rectangles;
  }
}
