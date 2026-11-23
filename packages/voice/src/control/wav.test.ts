import assert from 'node:assert/strict';
import test from 'node:test';
import { clarificationPcm } from './wav.js';
function wav() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(4, 40); b.writeInt16LE(1000, 44); b.writeInt16LE(-1000, 46);
  return b;
}
test('clarification decodes PCM WAV and the observed DashScope streaming-size header without playing it', () => {
  const normal = wav(); assert.deepEqual(clarificationPcm(normal), normal.subarray(44));
  const stream = wav(); stream.writeUInt32LE(0x7fffffbf, 4); stream.writeUInt32LE(0x7fffff9b, 40);
  assert.deepEqual(clarificationPcm(stream), normal.subarray(44));
});
test('incorrect rates, float/stereo audio and ordinary truncation cannot enter the PCM player', () => {
  for (const corrupt of [(b: Buffer) => b.writeUInt32LE(48000, 24), (b: Buffer) => b.writeUInt16LE(3, 20),
    (b: Buffer) => b.writeUInt16LE(2, 22), (b: Buffer) => b.writeUInt32LE(8, 40)]) {
    const b = wav(); corrupt(b); assert.throws(() => clarificationPcm(b));
  }
});
