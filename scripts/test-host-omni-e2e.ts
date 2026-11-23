import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { encodeControl, FrameType, parseFrame } from '@termbridge/protocol';
import {
  fingerprintMatches,
  hmacHex,
  relayWsOptions,
  resolvePin,
  resolveRelayUrl,
  resolveSecret,
  resolveStableHostId,
} from '@termbridge/settings';
import { createVoiceService } from '../packages/voice/src/index.js';
import { synthesizePcm16 } from './voice-test-audio.js';

const voice = createVoiceService();
assert(voice, 'DASHSCOPE_API_KEY is required for the Host Omni end-to-end test');
const requestId = `voice-e2e-${randomUUID()}`;
const expectedTool = process.env.TB_VOICE_E2E_TOOL || 'inspect_workspace';
const expectToolUi = process.env.TB_VOICE_E2E_EXPECT_UI !== '0';
const expectedAnswerText = process.env.TB_VOICE_E2E_EXPECT?.trim();
const spoken = process.env.TB_VOICE_E2E_SPOKEN
  || '请调用 inspect_workspace 工具的 overview 视图，告诉我当前有多少个 Agent 正在运行。';
const pcm = await synthesizePcm16(voice, spoken);
const relayUrl = resolveRelayUrl();
const ws = new WebSocket(relayUrl, relayWsOptions(relayUrl));
const pin = resolvePin();
let transcript = '';
let answer = '';
let outputBytes = 0;
let audioCommitted = false;
let responseFinished = false;
let realtimeToolViewReceived = false;
let durableToolViewReceived = false;
let stopping = false;
const toolCallIds = new Set<string>();
const executionPhases = new Map<string, Set<string>>();
let forkCompleted = false;
let answerAfterTools = false;
const toolPhases = new Set<string>();
const toolSummaries: string[] = [];
const observed = new Set<string>();

if (pin && /^wss:/i.test(relayUrl)) {
  ws.on('upgrade', (response) => {
    const fingerprint = (response.socket as { getPeerCertificate?: () => { fingerprint256?: string } })
      .getPeerCertificate?.()?.fingerprint256;
    assert(fingerprintMatches(fingerprint, pin), 'Relay TLS fingerprint mismatch');
  });
}

await new Promise<void>((resolve, reject) => {
  const timeoutMs = Number(process.env.TB_VOICE_E2E_TIMEOUT_MS || 120_000);
  const timeout = setTimeout(() => reject(new Error(
    `Host Omni end-to-end test timed out; observed=${[...observed].join(',') || 'nothing'}`,
  )), timeoutMs);
  const finish = () => {
    if (!toolPhases.has('started') || !toolPhases.has('completed') ||
      (expectToolUi && !realtimeToolViewReceived) ||
      !responseFinished || !answerAfterTools || outputBytes === 0 || !answer.trim()) return;
    // Full snapshots are deferred until hangup; realtime tool cards are the
    // in-call channel. Validate durable history only after the call is closed.
    if (!stopping) {
      stopping = true;
      ws.send(encodeControl({ t: 'brain_voice_stop', requestId }));
      return;
    }
    if (expectToolUi && !durableToolViewReceived) return;
    clearTimeout(timeout);
    resolve();
  };
  ws.on('message', (raw) => {
    const frame = parseFrame(raw as Buffer);
    if (frame.type !== FrameType.Control) return;
    const message = frame.msg;
    observed.add(
      message.t === 'brain_voice_status'
        ? `${message.t}:${message.status}${message.toolPhase ? `:${message.toolPhase}` : ''}`
        : message.t,
    );
    switch (message.t) {
      case 'auth_challenge':
        ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(resolveSecret(), message.nonce) }));
        ws.send(encodeControl({ t: 'hello', role: 'client', hostId: resolveStableHostId() }));
        ws.send(encodeControl({
          t: 'brain_voice_start',
          requestId,
          locale: 'zh-CN',
          sendKeyword: '发送',
          mode: 'call',
          agent: 'codex',
        }));
        break;
      case 'brain_voice_ready':
        if (message.requestId !== requestId || audioCommitted) break;
        audioCommitted = true;
        void (async () => {
          for (let offset = 0; offset < pcm.length; offset += 3_200) {
            ws.send(encodeControl({
              t: 'brain_voice_input_audio',
              requestId,
              data: pcm.subarray(offset, Math.min(offset + 3_200, pcm.length)),
            }));
            await new Promise((next) => setTimeout(next, 100));
          }
          // Call mode uses Qwen3.5 semantic VAD. Stream the same trailing
          // silence a phone capture provides instead of forcing a manual turn.
          for (let frame = 0; frame < 20; frame += 1) {
            ws.send(encodeControl({
              t: 'brain_voice_input_audio',
              requestId,
              data: new Uint8Array(3_200),
            }));
            await new Promise((next) => setTimeout(next, 100));
          }
          ws.send(encodeControl({ t: 'brain_voice_commit', requestId }));
        })().catch(reject);
        break;
      case 'brain_voice_transcript':
        if (message.requestId === requestId && message.final) transcript = message.text;
        break;
      case 'brain_voice_text':
        if (message.requestId !== requestId) break;
        if (forkCompleted) answerAfterTools = true;
        if (message.final) answer = message.text;
        else answer += message.text;
        finish();
        break;
      case 'brain_voice_output_audio':
        if (message.requestId === requestId) outputBytes += message.data.length;
        finish();
        break;
      case 'brain_voice_status':
        if (message.requestId !== requestId) break;
        if (message.status === 'responding') responseFinished = false;
        if (message.toolName === 'fork_execution' && message.toolPhase === 'completed') {
          forkCompleted = true; responseFinished = false;
        }
        if (message.status === 'tool' && message.toolName === expectedTool) {
          if (message.toolPhase) toolPhases.add(message.toolPhase);
          if (message.toolSummary) toolSummaries.push(message.toolSummary);
        }
        if (message.status === 'listening') responseFinished = true;
        finish();
        break;
      case 'brain_execution_event': {
        const event = message.event;
        if (event.toolName !== expectedTool || !event.callId) break;
        const phases = executionPhases.get(event.callId) ?? new Set<string>();
        if (event.phase === 'tool_started') phases.add('started');
        if (event.phase === 'tool_completed') phases.add('completed');
        executionPhases.set(event.callId, phases);
        if (toolCallIds.has(event.callId)) for (const phase of phases) toolPhases.add(phase);
        finish();
        break;
      }
      case 'brain_voice_tool_result':
        if (message.requestId !== requestId || message.toolName !== expectedTool) break;
        assert(message.view.items.length > 0, 'Realtime tool view did not contain any cards');
        toolCallIds.add(message.callId);
        for (const phase of executionPhases.get(message.callId) ?? []) toolPhases.add(phase);
        realtimeToolViewReceived = true;
        finish();
        break;
      case 'brain_snapshot_result':
        durableToolViewReceived = Boolean(
          message.toolResults?.some((result) =>
            toolCallIds.has(result.callId) && result.toolName === expectedTool && result.view.items.length > 0),
        );
        finish();
        break;
      case 'brain_voice_stopped':
        if (message.requestId === requestId) ws.send(encodeControl({ t: 'brain_snapshot' }));
        finish();
        break;
      case 'brain_voice_error':
        if (message.requestId === requestId) reject(new Error(message.error));
        break;
      case 'error':
        reject(new Error(message.message));
        break;
      default:
        break;
    }
  });
  ws.on('error', reject);
});
ws.close();

assert(!transcript.includes('发送'), `Call transcript unexpectedly required the send keyword: ${transcript}`);
assert(toolSummaries.every((summary) => summary.length > 0), 'Tool progress summaries were empty');
if (expectedAnswerText) {
  assert(answer.toLocaleLowerCase().includes(expectedAnswerText.toLocaleLowerCase()),
    `Voice answer did not include ${JSON.stringify(expectedAnswerText)}: ${answer}`);
}
console.log(
  `PASS Host Omni Call E2E: ${expectedTool} started/completed + ` +
  `${expectToolUi ? 'realtime/durable cards + ' : ''}automatic transcript + ` +
  `${answer.trim().length} text chars + ${outputBytes} PCM bytes`,
);
