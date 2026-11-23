import assert from 'node:assert/strict';
import type { VoiceService } from '../packages/voice/src/index.js';

export async function synthesizePcm16(voice: VoiceService, text: string): Promise<Uint8Array> {
  const synthesized = await voice.synthesize({ text, locale: 'zh-CN' });
  return resampleWavTo16Khz(synthesized.audio);
}

function resampleWavTo16Khz(wav: Uint8Array): Uint8Array {
  const input = Buffer.from(wav);
  assert.equal(input.subarray(0, 4).toString(), 'RIFF', 'TTS output is not RIFF WAV');
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let pcm: Buffer | undefined;
  while (offset + 8 <= input.length) {
    const id = input.subarray(offset, offset + 4).toString();
    const size = input.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      assert.equal(input.readUInt16LE(body), 1, 'TTS WAV must be PCM');
      channels = input.readUInt16LE(body + 2);
      sampleRate = input.readUInt32LE(body + 4);
      bits = input.readUInt16LE(body + 14);
    } else if (id === 'data') {
      pcm = input.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  assert(pcm && channels === 1 && bits === 16 && sampleRate > 0, 'Unsupported TTS WAV format');
  if (sampleRate === 16_000) return pcm;
  const outputSamples = Math.floor(pcm.length / 2 * 16_000 / sampleRate);
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourceIndex = Math.min(pcm.length / 2 - 1, Math.floor(index * sampleRate / 16_000));
    output.writeInt16LE(pcm.readInt16LE(sourceIndex * 2), index * 2);
  }
  return output;
}
