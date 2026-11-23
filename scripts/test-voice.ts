import assert from 'node:assert/strict';
import { createVoiceService } from '../packages/voice/src/index.js';

const voice = createVoiceService();
assert(voice, 'DASHSCOPE_API_KEY is required for the live voice test');

const phrase = '语音链路已经连接成功。';
const synthesized = await voice.synthesize({ text: phrase, locale: 'zh-CN' });
assert(synthesized.audio.length > 44, 'Bailian returned an empty WAV file');
const transcript = await voice.transcribe({
  audio: synthesized.audio,
  mime: synthesized.mime,
  locale: 'zh-CN',
});
assert(/语音|链路|连接成功/.test(transcript), `ASR missed the Chinese verification phrase: ${transcript}`);
console.log(`PASS Bailian voice (${synthesized.audio.length} bytes) → ${transcript}`);
