/** Opt-in, capped cloud integration experiment. All audio goes through files/pipes.
 * Never opens a microphone/player, talks to the deployed Host, or runs a real tool.
 * Synthetic Tingting speech is NOT a measurement of this user's voice/car/noise.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { BailianRealtimeConversation } from '../packages/voice/src/omni-realtime.js';
import { createBrainConversationService } from '../packages/brain/src/conversation.js';
import { createTurnJudge } from '../packages/host/src/voiceTurnJudge.js';
import { BailianVoiceService } from '../packages/voice/src/index.js';
import { clarificationPcm } from '../packages/voice/src/control/wav.js';
import { buildVoiceFrontendInstructions, buildExecutionForkInstructions, EXECUTION_FORK_VOICE_TOOLS } from '../packages/host/src/voicePrompt.js';

if (!process.argv.includes('--live')) throw new Error('Use --live to authorize bounded cloud inference');
if (!process.env.DASHSCOPE_API_KEY) throw new Error('No cloud credential configured');
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'tb-voice-control-live-'));
const service = createBrainConversationService()!;
const speech = new BailianVoiceService({ apiKey: process.env.DASHSCOPE_API_KEY! });
const communicationCheck = process.argv.includes('--communication-check');
// Reproduce the reported control path even if today's cloud model considers the
// first ambiguous statement complete. Only that recorded initial WAIT is injected;
// subsequent ASR, judgement, Fork, answer and audio use real cloud services.
const replayInitialWait = process.argv.includes('--replay-initial-wait');
if (replayInitialWait && !communicationCheck) throw new Error('The recorded WAIT belongs to the communication-check fixture');
const fixtureHistory = communicationCheck ? [] : [{ role: 'user' as const, content: '我们在讨论 TermBridge 中正在执行任务的 Agent。' }];
const judge = createTurnJudge(service, () => fixtureHistory);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function pcm(text: string, name: string): Promise<Buffer> {
  const path = join(directory, `${name}.aiff`);
  // The mandatory -o argument prevents audible output.
  await exec('/usr/bin/say', ['-v', 'Tingting', '-r', '170', '-o', path, text], { timeout: 15_000 });
  const result = await exec('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2_000_000, timeout: 15_000 });
  return result.stdout;
}
const phrases = communicationCheck ? ['你现在在听', '在听我说话吗'] : ['我最近的', 'Agent 是什么'];
const first = await pcm(phrases[0], 'fragment-a');
const second = await pcm(phrases[1], 'fragment-b');
const pauseMs = Number(process.argv.find(arg => arg.startsWith('--pause-ms='))?.split('=')[1] ?? (process.argv.includes('--long-pause') ? 4500 : 2600));
if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 15000) throw new Error('Fixture pause must be 0..15000 ms');
const turns = process.argv.includes('--two-turns') ? 2 : 1;
const fixture = Buffer.concat(Array.from({ length: turns }, () => Buffer.concat([first, Buffer.alloc(pauseMs * 32), second, Buffer.alloc(12 * 32_000)])));
await writeFile(join(directory, 'synthetic.pcm'), fixture, { mode: 0o600 });
const rows: Record<string, unknown>[] = [];
const productionFork = process.argv.includes('--production-fork');
const fixtureTool = { name: 'inspect_fixture', description: '只读最近 Agent 测试数据', parameters: { type: 'object', properties: {}, additionalProperties: false } };
let candidateFailures = 0;
for (const adaptive of process.argv.includes('--adaptive-only') ? [true] : process.argv.includes('--vad-three-only') ? [false] : [false, true]) {
  const events: Record<string, unknown>[] = [];
  const started = Date.now();
  const note = (event: string, fields: Record<string, unknown> = {}) => events.push({ ms: Date.now() - started, event, ...fields });
  let conversation: BailianRealtimeConversation | undefined;
  let outputBytes = 0, calls = 0, responseCount = 0, judgeCalls = 0, forks = 0;
  let answer = '', finished = false, inputStartedAt = 0;
  let lastSubmittedAt = 0, lastAnswerAt = 0;
  let clarificationAt: number | undefined;
  const submitted: string[] = [];
  let stopInput = false;
  let pendingTools = 0, pendingSpeech = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let failure: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('experiment deadline')), turns * 35_000);
      conversation = new BailianRealtimeConversation({
        apiKey: process.env.DASHSCOPE_API_KEY!, url: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
        model: 'qwen3.5-omni-flash-realtime', sendKeyword: '发送', turnMode: 'semantic',
        semanticSilenceMs: process.argv.includes('--vad-three-only') ? 3000 : undefined,
        instructions: productionFork ? buildVoiceFrontendInstructions({ mode: 'call', sendKeyword: '发送' }) : '你是 TermBridge 的 Agent 调度助手。用户指的是他电脑上正在执行的具体 Agent，不是在问 Agent 的概念。你没有该电脑的状态数据，必须实际调用 inspect_fixture 才能回答他最近的 Agent 是谁、在干什么。禁止凭空回答或声称已经查询；拿到工具回执以后只说一句结果。语音里停顿后的句子可能是前一句的延续。',
        tools: productionFork ? EXECUTION_FORK_VOICE_TOOLS : [fixtureTool],
        speakClarification: async (question, signal) => {
          pendingSpeech++;
          try {
            const pcm = clarificationPcm((await speech.synthesize({ text: question, signal })).audio);
            note('clarification_audio_ready', { bytes: pcm.length }); return pcm;
          } finally { pendingSpeech--; }
        },
        turnJudge: adaptive ? async input => {
          judgeCalls++; const at = Date.now();
          const replayed = replayInitialWait && input.segments.length === 1;
          const decision = replayed ? { decision: 'wait' as const, clarification: '您想让我做什么呢？' } :
            process.argv.includes('--deterministic-judge') ? (input.segments.length > 1 ? 'respond' : 'wait') : await judge(input);
          if (replayed) note('initial_wait_replayed');
          note('judge', { decision, latencyMs: Date.now() - at, segments: input.segments }); return decision;
        } : undefined,
        socketFactory: (url, options) => {
          const socket = new WebSocket(url, options);
          if (process.argv.includes('--system-context-only') || process.argv.includes('--server-vad')) {
            const send = socket.send.bind(socket);
            socket.send = ((data: string, ...args: unknown[]) => {
              const event = JSON.parse(String(data));
              if (process.argv.includes('--system-context-only') && event.type === 'conversation.item.create' && event.item?.type === 'message') {
                note('ablation_omit_unsupported_text_item'); return;
              }
              if (process.argv.includes('--server-vad') && event.session?.turn_detection) event.session.turn_detection.type = 'server_vad';
              return Reflect.apply(send, socket, [JSON.stringify(event), ...args]);
            }) as typeof socket.send;
          }
          socket.on('message', data => {
            const e = JSON.parse(data.toString());
            if (e.type === 'session.updated') note('configured_tools', { names: e.session?.tools?.map((t: { name?: string; function?: { name: string } }) => t.name || t.function?.name), turnDetection: e.session?.turn_detection });
            // Only this authored fixture's text/metadata; never log PCM or credentials.
            if (e.type === 'response.output_item.done' || e.type === 'conversation.item.created') note(e.type, {
              id: e.item?.id, previous: e.previous_item_id, type: e.item?.type, role: e.item?.role,
              name: e.item?.name, content: e.item?.content?.map((c: { type: string; text?: string; transcript?: string }) => ({
                type: c.type, text: c.text, transcript: c.transcript,
              })),
            });
            if (e.type === 'response.done') note('response_result', { id: e.response?.id, status: e.response?.status,
              output: e.response?.output?.map((item: { id: string; type: string; role?: string; name?: string }) => ({ id: item.id, type: item.type, role: item.role, name: item.name })),
            });
            if (['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'response.created', 'response.done', 'session.updated'].includes(e.type)) note(e.type);
          });
          return socket;
        },
        callbacks: {
          onReady() {
            note('ready'); inputStartedAt = Date.now();
            void (async () => {
              for (let offset = 0; offset < fixture.length && !stopInput; offset += 3200) {
                conversation!.append(fixture.subarray(offset, Math.min(offset + 3200, fixture.length)));
                await sleep(100);
              }
              const settleDeadline = Date.now() + 12000;
              do { await sleep(100); }
              while (Date.now() < settleDeadline && (pendingTools > 0 || pendingSpeech > 0 || !finished || lastAnswerAt < lastSubmittedAt || submitted.length < turns || (communicationCheck ? forks : calls) < turns));
              resolve();
            })().catch(reject);
          },
          onTranscript(text, final) { if (final) note('transcript', { text }); },
          onTurnSubmitted(text) { lastSubmittedAt = Date.now(); submitted.push(text); note('submitted', { text }); },
          onTurnWaiting(reason) { note('waiting', { reason }); },
          onClarificationRequested(question) { clarificationAt = Date.now() - started; note('clarification_requested', { question }); },
          onText(text, final) { if (final) { lastAnswerAt = Date.now(); answer = text; note('answer_final', { text }); } },
          onAudio(data) { outputBytes += data.length; /* Intentionally no playback device. */ },
          onResponseStarted() { responseCount++; finished = false; note('response_started'); },
          onResponseFinished(status) { finished = status === 'completed'; note('finished', { status }); },
          onUsage(usage) { note('usage', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }); },
          async onToolCall(call) {
            pendingTools++;
            try {
            const result = () => { calls++; note('fixture_tool_completed'); return JSON.stringify({ ok: true, agent: { name: 'TermBridge', task: '语音控制验证', status: 'working' } }); };
            if (!productionFork) return result();
            if (call.name !== 'fork_execution') throw new Error('Unexpected live fixture tool');
            forks++;
            note('fork_execution', { text: call.arguments.text, origin: call.origin || 'provider' });
            const reply = await service.respond({
              instructions: buildExecutionForkInstructions({ runtimeContext: 'This is an isolated test. inspect_fixture is the only available live Agent status source; use it for a recent Agent query. There are no real devices or workers.' }),
              messages: [...fixtureHistory,
                { role: 'user', content: String(call.arguments.text) }], tools: [fixtureTool],
              onToolCall: async tool => { if (tool.name !== 'inspect_fixture') throw new Error('Tool not allowed'); return result(); },
            });
            note('fork_answer', { text: reply.text });
            return JSON.stringify({ ok: true, answer: reply.text });
            } finally { pendingTools--; }
          },
          onError(error) { reject(error); }, onFinished() {},
        },
      });
    });
  } catch (error) { failure = error instanceof Error ? error.message : 'experiment failed'; }
  finally { stopInput = true; if (deadline) clearTimeout(deadline); conversation?.close(); }
  const secondStartsMs = inputStartedAt - started + first.length / 32 + pauseMs;
  const prematureResponses = events.filter(e => e.event === 'response_started' && Number(e.ms) < secondStartsMs &&
    (clarificationAt === undefined || Number(e.ms) < clarificationAt)).length;
  const compact = (text: string) => text.replace(/[\s。！？!?，,.]/gu, '').toLowerCase();
  const checks = {
    noFailure: !failure, singleWholeUserTurn: submitted.length === turns && submitted.every(text => compact(text) === compact(phrases.join(''))),
    noPrematureReply: prematureResponses === 0, realFixtureReceipt: calls === (communicationCheck ? 0 : turns),
    groundedAnswer: communicationCheck ? /在听|听到|听见|收到|接收/.test(answer) && !/无法|不能|没有.*(?:声音|听)|什么任务/.test(answer) : /TermBridge/i.test(answer) && answer.includes('语音控制验证'),
    finishedWithAudio: finished && outputBytes > 0,
    clarificationOnce: events.filter(e => e.event === 'clarification_requested').length === (pauseMs >= 9000 ? turns : 0),
    clarificationSpoken: pauseMs < 9000 || events.some(e => e.event === 'clarification_audio_ready' && Number(e.ms) < secondStartsMs),
  };
  const accepted = Object.values(checks).every(Boolean);
  if (adaptive && !accepted) candidateFailures++;
  rows.push({ adaptive, productionFork, turns, communicationCheck, forks, replayInitialWait, providerSilenceMs: adaptive || process.argv.includes('--vad-three-only') ? 3000 : 1400,
    judge: !adaptive ? 'none' : replayInitialWait ? 'cloud-after-replayed-wait' : process.argv.includes('--deterministic-judge') ? 'fixture' : 'cloud', fixture: 'synthetic-Tingting', firstAudioMs: first.length / 32, pauseMs, secondStartsMs,
    submitted, answer, outputBytes, responseCount, judgeCalls, fixtureToolCompletions: calls, finished, failure,
    prematureResponses, accepted, checks, events });
  console.log(JSON.stringify({ adaptive, accepted, checks, submitted, calls, finished, outputBytes, failure }));
}
await writeFile(join(directory, 'report.json'), JSON.stringify({ provenance: 'synthetic file-only experiment, not user/car recordings',
  at: new Date().toISOString(), model: 'qwen3.5-omni-flash-realtime',
  pcm: { rate: 16000, channels: 1, bits: 16, endian: 'little', bytes: fixture.length, sha256: createHash('sha256').update(fixture).digest('hex') },
  outputPolicy: 'count and discard; no playback', rows }, null, 2), { mode: 0o600 });
console.log(`Evidence: ${join(directory, 'report.json')}`);
// Measurement runs may deliberately include failing ablations, but normal candidate validation
// must fail its process when the actual tool/answer/history contract fails, not just on WS errors.
if (candidateFailures && !process.argv.includes('--measure-only')) process.exitCode = 1;
