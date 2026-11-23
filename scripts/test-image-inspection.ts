/** Opt-in live cloud test. Synthetic pixels only; no phone media or files are read. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { createAndroidArtifactTestReceiver } from '@termbridge/settings';
import { inspectAttachedImages, createImageDescriber } from '../packages/host/src/imageInspection.js';

assert(process.env.DASHSCOPE_API_KEY, 'DASHSCOPE_API_KEY is required; credentials are never printed');
function chunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([size, tag, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(128, 0); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc(128 * (1 + 128 * 3));
for (let y = 0; y < 128; y++) {
  for (let x = 0; x < 128; x++) pixels[y * 385 + 1 + x * 3 + (x < 64 ? 0 : 2)] = 255;
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
]);
const asset = { assetId: 'synthetic-image', name: 'fixture.png', mime: 'image/png', size: png.length,
  sha256: createHash('sha256').update(png).digest('hex') };
const started = Date.now();
const result = await inspectAttachedImages({
  attachment: { actionId: 'synthetic-batch', deviceId: 'mock-phone', assets: [asset] },
  question: '请只用中文回答这张图片左半边和右半边各是什么颜色。',
  isCurrent: () => true, describe: createImageDescriber(),
  async readAsset(args) {
    const crypto = createAndroidArtifactTestReceiver(String(args.clientPublicKey), String(args.salt));
    const offset = Number(args.offset);
    const bytes = png.subarray(offset, offset + Number(args.length));
    return { ok: true, data: { ...asset, encrypted: true, phonePublicKey: crypto.receiverPublicKey,
      ...crypto.encrypt(asset.assetId, offset, bytes), nextOffset: BigInt(offset + bytes.length),
      eof: offset + bytes.length === png.length } };
  },
});
assert.equal(result.status, 'completed');
assert.match(String(result.text), /红/);
assert.match(String(result.text), /蓝/);
console.log(JSON.stringify({ test: 'encrypted mock peer -> real Bailian vision', status: result.status,
  model: result.model, elapsedMs: Date.now() - started, answer: result.text }));
