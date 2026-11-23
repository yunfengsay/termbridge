// Temporary repro script: does the realtime voice session accept a SECOND turn?
// Mimics the Android BrainActivity call-mode flow (semantic VAD, no explicit commit).
// Safe to delete after debugging. Run: npx tsx scripts/two-turn-voice.local.mts
import { WebSocket } from 'ws';
import { encodeControl, FrameType, parseFrame } from '@termbridge/protocol';
import {
  hmacHex,
  relayWsOptions,
  resolveRelayUrl,
  resolveSecret,
  resolveStableHostId,
} from '@termbridge/settings';
import { createVoiceService } from '../packages/voice/src/index.js';
import { synthesizePcm16 } from './voice-test-audio.js';
import { randomUUID } from 'node:crypto';

const voice = createVoiceService();
if (!voice) { console.error('FAIL: DASHSCOPE_API_KEY missing'); process.exit(1); }

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

log('synthesizing two utterances...');
const turn1 = await synthesizePcm16(voice, '你好，请用一句话介绍你自己。');
const turn2 = await synthesizePcm16(voice, '好的，那现在请告诉我一加一等于几？');
log(`turn1 pcm=${turn1.length}B turn2 pcm=${turn2.length}B`);

const requestId = `two-turn-${randomUUID()}`;
const relayUrl = resolveRelayUrl();
log(`connecting ${relayUrl}`);
const ws = new WebSocket(relayUrl, relayWsOptions(relayUrl));

let phase: 'turn1' | 'turn2' = 'turn1';
const result = {
  turn1: { transcript: '', answer: '', audioBytes: 0, listening: false },
  turn2: { transcript: '', answer: '', audioBytes: 0, listening: false },
};
let turn2Started = false;

async function streamPcm(pcm: Uint8Array, silenceFrames: number): Promise<void> {
  for (let off = 0; off < pcm.length; off += 3200) {
    ws.send(encodeControl({ t: 'brain_voice_input_audio', requestId, data: pcm.subarray(off, Math.min(off + 3200, pcm.length)) }));
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let i = 0; i < silenceFrames; i += 1) {
    ws.send(encodeControl({ t: 'brain_voice_input_audio', requestId, data: new Uint8Array(3200) }));
    await new Promise((r) => setTimeout(r, 100));
  }
}

const done = new Promise<void>((resolve) => {
  const finishAll = () => { clearTimeout(hardStop); try { ws.send(encodeControl({ t: 'brain_voice_stop', requestId })); } catch {} setTimeout(() => { ws.close(); resolve(); }, 500); };
  const hardStop = setTimeout(() => { log('HARD TIMEOUT (120s)'); finishAll(); }, 120_000);

  ws.on('message', (raw) => {
    const frame = parseFrame(raw as Buffer);
    if (frame.type !== FrameType.Control) return;
    const m = frame.msg as Record<string, unknown> & { t: string };
    switch (m.t) {
      case 'auth_challenge':
        ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(resolveSecret(), m.nonce as string) }));
        ws.send(encodeControl({ t: 'hello', role: 'client', hostId: resolveStableHostId() }));
        ws.send(encodeControl({ t: 'brain_voice_start', requestId, locale: 'zh-CN', sendKeyword: '发送', mode: 'call', outputMode: 'voice' }));
        log('start sent');
        break;
      case 'brain_voice_ready':
        log('voice ready → streaming turn1');
        void streamPcm(turn1, 25);
        break;
      case 'brain_voice_transcript':
        if (m.final) { result[phase].transcript = String(m.text); log(`${phase} transcript(final): ${m.text}`); }
        break;
      case 'brain_voice_text':
        result[phase].answer += String(m.text ?? '');
        if (m.final) log(`${phase} answer(final len=${result[phase].answer.length}): ${String(result[phase].answer).slice(0, 60)}`);
        break;
      case 'brain_voice_output_audio':
        result[phase].audioBytes += (m.data as Uint8Array).length;
        break;
      case 'brain_voice_status': {
        const status = String(m.status);
        log(`status: ${status}${m.toolName ? ` tool=${m.toolName}` : ''}`);
        if (status === 'listening') {
          result[phase].listening = true;
          if (phase === 'turn1' && (result.turn1.answer || result.turn1.audioBytes) && !turn2Started) {
            turn2Started = true;
            phase = 'turn2';
            const gapMs = Number(process.env.TURN_GAP_MS || 15_000);
            log(`=== turn1 complete; SILENT for ${gapMs}ms (no frames at all), then turn2 ===`);
            void new Promise((r) => setTimeout(r, gapMs)).then(() => streamPcm(turn2, 25)).then(() => {
              setTimeout(() => { log('turn2 wait window elapsed'); finishAll(); }, 30_000);
            });
          } else if (phase === 'turn2' && (result.turn2.answer || result.turn2.audioBytes)) {
            finishAll();
          }
        }
        break;
      }
      case 'brain_voice_error': log(`VOICE ERROR: ${m.error}`); finishAll(); break;
      case 'brain_voice_stopped': log('voice stopped by host'); finishAll(); break;
      case 'error': log(`RELAY/HOST ERROR: ${m.message}`); break;
    }
  });
  ws.on('error', (e) => { log(`WS ERROR: ${(e as Error).message}`); finishAll(); });
  ws.on('close', () => log('ws closed'));
});

await done;
console.log('\n===== SUMMARY =====');
for (const key of ['turn1', 'turn2'] as const) {
  const r = result[key];
  console.log(`${key}: transcript=${JSON.stringify(r.transcript)} answerLen=${r.answer.length} audioBytes=${r.audioBytes} sawListening=${r.listening}`);
}
const t2ok = result.turn2.transcript || result.turn2.answer || result.turn2.audioBytes > 0;
console.log(t2ok ? 'VERDICT: turn2 WORKED — host/model side is fine, suspect the phone app' : 'VERDICT: turn2 DEAD — reproduced on host/model side');
process.exit(0);
