import assert from 'node:assert/strict';
import { createVoiceService, type RealtimeTranscription } from '../packages/voice/src/index.js';

const voice = createVoiceService();
assert(voice, 'DASHSCOPE_API_KEY is required for the live realtime voice test');

const phrase = '请查看所有 Agent，然后发送。';
const synthesized = await voice.synthesize({ text: phrase, locale: 'zh-CN' });
const pcm = resampleTo16Khz(synthesized.audio);

let stream: RealtimeTranscription;
const transcript = await new Promise<string>(async (resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Realtime ASR timed out')), 30_000);
  stream = voice.startRealtimeTranscription('zh-CN', {
    onText: (text, final) => {
      if (!final) return;
      clearTimeout(timeout);
      stream.finish();
      resolve(text);
    },
    onError: (error) => {
      clearTimeout(timeout);
      reject(error);
    },
    onFinished: () => undefined,
  });
  for (let offset = 0; offset < pcm.length; offset += 3_200) {
    stream.append(pcm.subarray(offset, Math.min(offset + 3_200, pcm.length)));
    await new Promise((next) => setTimeout(next, 100));
  }
  stream.commit();
});

assert(/Agent/i.test(transcript), `Realtime ASR missed Agent: ${transcript}`);
assert(/发送/.test(transcript), `Realtime ASR missed the send keyword: ${transcript}`);
console.log(`PASS Bailian realtime voice (${pcm.length} PCM bytes) → ${transcript}`);

function resampleTo16Khz(wav: Uint8Array): Uint8Array {
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
  const sourceSamples = pcm.length / 2;
  const outputSamples = Math.floor(sourceSamples * 16_000 / sampleRate);
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourceIndex = Math.min(sourceSamples - 1, Math.floor(index * sampleRate / 16_000));
    output.writeInt16LE(pcm.readInt16LE(sourceIndex * 2), index * 2);
  }
  return output;
}
