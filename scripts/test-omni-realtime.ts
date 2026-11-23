import assert from 'node:assert/strict';
import { createVoiceService, type RealtimeConversation } from '../packages/voice/src/index.js';
import { synthesizePcm16 } from './voice-test-audio.js';

const voice = createVoiceService();
assert(voice, 'DASHSCOPE_API_KEY is required for the live Omni test');

const pcm = await synthesizePcm16(voice, '请简短回答你好，发送。');
let transcript = '';
let answer = '';
let outputBytes = 0;
let usageTokens = 0;
let conversation: RealtimeConversation;
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Qwen3.5 Omni Realtime round trip timed out')), 60_000);
  conversation = voice.startRealtimeConversation({
    instructions: '你是 TermBridge 测试助手。只用一句很短的中文回答，不要调用工具。',
    sendKeyword: '发送',
  }, {
    onReady: () => {
      void (async () => {
        for (let offset = 0; offset < pcm.length; offset += 3_200) {
          conversation.append(pcm.subarray(offset, Math.min(offset + 3_200, pcm.length)));
          await new Promise((next) => setTimeout(next, 100));
        }
        conversation.commit();
      })().catch(reject);
    },
    onTranscript: (text, final) => {
      if (final) transcript = text;
    },
    onTurnSubmitted: (text) => {
      transcript = text;
    },
    onText: (text, final) => {
      if (final) answer = text;
      else answer += text;
    },
    onAudio: (audio) => {
      outputBytes += audio.length;
    },
    onResponseStarted: () => undefined,
    onResponseFinished: () => {
      if (outputBytes === 0) return;
      clearTimeout(timeout);
      resolve();
    },
    onUsage: (usage) => {
      usageTokens += usage.totalTokens;
    },
    onToolCall: async () => JSON.stringify({ ok: false, error: 'Tools are disabled in the handshake test' }),
    onError: (error) => {
      clearTimeout(timeout);
      reject(error);
    },
    onFinished: () => undefined,
  });
});
conversation.close();

assert(transcript, 'Qwen3.5 Omni returned no user transcript');
assert(answer.trim(), 'Qwen3.5 Omni returned no assistant text');
assert(outputBytes > 0, 'Qwen3.5 Omni returned no assistant audio');
assert(usageTokens > 0, 'Qwen3.5 Omni returned no usage metrics');
console.log(
  `PASS Bailian Qwen3.5 Omni: transcript + ${answer.trim().length} text chars + ` +
  `${outputBytes} PCM bytes + ${usageTokens} tokens`,
);
