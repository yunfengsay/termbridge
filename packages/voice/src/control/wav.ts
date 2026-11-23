/** Validate the actual container before feeding Android's PCM16/24k mono player. */
export function clarificationPcm(wav: Uint8Array): Uint8Array {
  const buffer = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Clarification audio is not WAV');
  }
  let format = false; let pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const declaredSize = buffer.readUInt32LE(offset + 4); const start = offset + 8;
    // DashScope's completed HTTP WAV uses this streaming length sentinel (observed
    // RIFF=0x7fffffbf/data=0x7fffff9b). Bound by actual downloaded bytes, not 2 GiB.
    const streamingData = type === 'data' && ((declaredSize === 0x7fffff9b && buffer.readUInt32LE(4) === 0x7fffffbf) ||
      (declaredSize === 0xffffffff && buffer.readUInt32LE(4) === 0xffffffff));
    const size = streamingData ? buffer.length - start : declaredSize;
    if (start + size > buffer.length) throw new Error('Truncated clarification WAV');
    if (type === 'fmt ') {
      format = size >= 16 && buffer.readUInt16LE(start) === 1 && buffer.readUInt16LE(start + 2) === 1 &&
        buffer.readUInt32LE(start + 4) === 24000 && buffer.readUInt16LE(start + 12) === 2 && buffer.readUInt16LE(start + 14) === 16;
    }
    if (type === 'data') pcm = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !pcm?.length || pcm.length % 2 || pcm.length > 24_000 * 2 * 15) throw new Error('Unsupported clarification PCM format or duration');
  return pcm;
}
