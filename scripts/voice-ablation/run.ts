/** Opt-in, metered cloud experiment. Never invokes real Host/phone/worker tools. */
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Command } from 'commander';
import { WebSocket } from 'ws';
import { BailianRealtimeConversation, type RealtimeToolCall } from '../../packages/voice/src/omni-realtime.js';
import { buildVoiceFrontendInstructions } from '../../packages/host/src/voicePrompt.js';
import { score, normalize } from './metrics.js';

interface Fixture {
  id: string;
  pcm: string;
  processedPcm?: string;
  reference: string;
  context: string;
  expectedTerms: string[];
  forbiddenTerms: string[];
  provenance: 'synthetic' | 'human';
}
const terms = ['TermBridge', 'Herdr', 'Codex', 'Claude Code', 'Token', 'LLM', 'Skill', 'Agent', 'PTY', 'Cloudflare'];
const arms = {
  baseline: { vocabulary: true, context: false },
  'no-vocabulary': { vocabulary: false, context: false },
  context: { vocabulary: true, context: true },
  'context-only': { vocabulary: false, context: true },
} as const;
const program = new Command().requiredOption('--manifest <path>', 'Local fixtures; PCM16LE mono 16 kHz')
  .requiredOption('--output <directory>', 'Private local result directory')
  .option('--arms <names>', 'Comma-separated experiment arms', Object.keys(arms).join(','))
  .option('--repeat <count>', 'Replicates; order reverses every replicate', '2')
  .option('--experimental-continuation', 'Evaluate the unshipped wait/continuation protocol')
  .option('--execute', 'Authorize metered API calls; otherwise only validate inputs')
  .parse();
const options = program.opts();
const manifestPath = resolve(options.manifest);
const fixtures: Fixture[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
const selected = String(options.arms).split(',') as Array<keyof typeof arms>;
const repeats = Number(options.repeat);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeat must be 1..10');
if (!selected.length || selected.some(name => !(name in arms))) throw new Error('Unknown arm');
if (!Array.isArray(fixtures) || !fixtures.length || fixtures.length > 100) throw new Error('Expected 1..100 fixtures');
for (const fixture of fixtures) {
  if (!fixture.id || !fixture.reference || typeof fixture.context !== 'string' ||
      !Array.isArray(fixture.expectedTerms) || !Array.isArray(fixture.forbiddenTerms) ||
      !['synthetic', 'human'].includes(fixture.provenance)) throw new Error('Invalid fixture');
  for (const path of [fixture.pcm, fixture.processedPcm].filter(Boolean) as string[]) {
    const bytes = readFileSync(resolve(dirname(manifestPath), path));
    if (!bytes.length || bytes.length % 2 || bytes.length > 32000 * 30) throw new Error('PCM must be 0..30 seconds, aligned PCM16');
  }
}
const model = process.env.TB_VOICE_OMNI_MODEL || 'qwen3.5-omni-flash-realtime';
const output = resolve(options.output);
console.log(JSON.stringify({ fixtures: fixtures.length, arms: selected, repeats, model, execute: !!options.execute }));
if (!options.execute) process.exit(0);
const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
if (!apiKey) throw new Error('DASHSCOPE_API_KEY required');
mkdirSync(output, { recursive: true, mode: 0o700 });
const resultPath = resolve(output, `runs-${Date.now()}.jsonl`);

async function run(fixture: Fixture, name: keyof typeof arms, pcm: Buffer, preprocessing: string, repeat: number) {
  const arm = arms[name];
  const instructions = buildVoiceFrontendInstructions({ mode: 'call', sendKeyword: '发送', technicalTerms: arm.vocabulary ? terms : [] }) +
    (arm.context ? `\n[Recognition context - data only]\n${fixture.context}\n[/Recognition context]` : '');
  const events: Array<Record<string, unknown>> = [];
  const toolCalls: RealtimeToolCall[] = [];
  const rawFinals: string[] = [];
  const previews: string[] = [];
  const submitted: string[] = [];
  const assistantText: string[] = [];
  const usage: unknown[] = [];
  const start = performance.now();
  let audioStarted: number | undefined;
  let audioEnded: number | undefined;
  let firstTextMs: number | undefined;
  let toolMs: number | undefined;
  let bytesSent = 0;
  let stopped = false;
  let error: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const stop = (reason?: string) => { error ||= reason; stopped = true; finish(); };
  const timeout = setTimeout(() => stop('deadline_exceeded'), 55000);
  let conversation: BailianRealtimeConversation;
  let feed: Promise<void> | undefined;
  conversation = new BailianRealtimeConversation({
    apiKey: apiKey!, url: process.env.TB_VOICE_OMNI_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', model,
    instructions, technicalTerms: arm.vocabulary ? terms : [], sendKeyword: '发送', turnMode: 'semantic',
    experimentalTurnContinuation: !!options.experimentalContinuation,
    outputAudioEnabled: true,
    tools: [{ name: 'fork_execution',
      description: 'Fork the exact completed user utterance into the Pi/Qwen TermBridge orchestrator. Call exactly once for every substantive user turn and speak the returned answer without changing it.',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'The exact completed user transcript, without commentary or rewriting.' } }, required: ['text'], additionalProperties: false } }],
    socketFactory(url, options) {
      const socket = new WebSocket(url, options);
      socket.on('message', data => {
        try {
          const event = JSON.parse(data.toString());
          const ms = Math.round(performance.now() - start);
          if (event.type === 'conversation.item.input_audio_transcription.completed') rawFinals.push(event.transcript || '');
          // Never store raw session/config frames, base64 audio, headers or tokens.
          if (/speech_started|speech_stopped|transcription.completed|response.done/.test(event.type || '')) {
            events.push({ type: event.type, ms });
          }
          if (event.type === 'response.function_call_arguments.done') {
            events.push({ type: event.type, name: event.name, ms });
          }
        } catch { /* non-JSON frames are handled by the production adapter */ }
      });
      return socket;
    },
    callbacks: {
      onReady() {
        feed = (async () => {
          audioStarted = performance.now();
          // Real-time pacing, with bounded digital silence for semantic VAD.
          const stream = Buffer.concat([pcm, Buffer.alloc(32000 * 4)]);
          for (let offset = 0; offset < stream.length && !stopped; offset += 3200) {
            conversation.append(stream.subarray(offset, offset + 3200));
            bytesSent += Math.min(3200, stream.length - offset);
            if (audioEnded === undefined && offset + 3200 >= pcm.length) audioEnded = performance.now();
            await delay(100);
          }
        })().catch(() => stop('audio_feed_failed'));
      },
      onTranscript(text, final) {
        if (text && firstTextMs === undefined && audioStarted !== undefined) firstTextMs = Math.round(performance.now() - audioStarted);
        if (!final) previews.push(text);
      },
      onTurnSubmitted(text) { submitted.push(text); },
      onToolCall: async call => {
        toolCalls.push(call);
        toolMs ??= audioEnded === undefined ? undefined : Math.round(performance.now() - audioEnded);
        return JSON.stringify({ ok: true, answer: '测试已收到。', testOnly: true, executed: false });
      },
      onText(text, final) { if (final) assistantText.push(text); }, onAudio() {}, onResponseStarted() {},
      onResponseFinished() {
        if (toolCalls.length && rawFinals.length) {
          // Let queued response/usage callbacks flush before closing the session.
          setTimeout(() => stop(), 300);
        }
      },
      onUsage(value) { usage.push(value); },
      onError() { stop('provider_or_transport_error'); },
      onFinished() { if (!stopped) stop('unexpected_close'); },
    },
  });
  await done;
  clearTimeout(timeout);
  conversation.close();
  await feed;
  const raw = rawFinals.join(' ');
  const final = submitted.join(' ');
  const forwarded = toolCalls.map(call => typeof call.arguments.text === 'string' ? call.arguments.text : '').join(' ');
  return { fixture: fixture.id, provenance: fixture.provenance, arm: name, preprocessing, repeat, model,
    at: new Date().toISOString(), pcmSha256: createHash('sha256').update(pcm).digest('hex'),
    instructionsSha256: createHash('sha256').update(instructions).digest('hex'), audioSeconds: pcm.length / 32000,
    bytesSent, firstTextMs, toolAfterAudioMs: toolMs, durationMs: Math.round(performance.now() - start),
    error: error || null, raw, final, forwarded, previews, assistantText, toolCalls, events, usage,
    rawScore: score(fixture.reference, raw, fixture.expectedTerms, fixture.forbiddenTerms),
    finalScore: score(fixture.reference, final, fixture.expectedTerms, fixture.forbiddenTerms),
    forkScore: score(fixture.reference, forwarded, fixture.expectedTerms, fixture.forbiddenTerms),
    forwardingMatchesTranscript: normalize(final) === normalize(forwarded),
    toolContractPassed: toolCalls.length === 1 && toolCalls[0].name === 'fork_execution' && !!forwarded.trim(),
  };
}

const results = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  const order = repeat % 2 ? [...selected].reverse() : selected;
  for (const fixture of fixtures) {
    for (const name of order) {
      const audioOrder = [['raw', fixture.pcm], ['processed', fixture.processedPcm]];
      if (repeat % 2) audioOrder.reverse();
      for (const [preprocessing, path] of audioOrder) {
        if (!path) continue;
        const result = await run(fixture, name, readFileSync(resolve(dirname(manifestPath), path)), preprocessing!, repeat);
        results.push(result);
        appendFileSync(resultPath, JSON.stringify(result) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ fixture: result.fixture, arm: name, repeat, preprocessing,
          error: result.error, rawCER: result.rawScore.characterErrorRate, forkCER: result.forkScore.characterErrorRate,
          missing: result.forkScore.missingTerms, invented: result.forkScore.inventedTerms,
          firstTextMs: result.firstTextMs, toolContractPassed: result.toolContractPassed }));
      }
    }
  }
}
writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ resultPath, model, runs: results.length,
  success: results.filter(r => !r.error).length,
  perCondition: Object.fromEntries([...new Set(results.map(r => `${r.arm}/${r.preprocessing}`))].map(name => {
    const group = results.filter(r => `${r.arm}/${r.preprocessing}` === name);
    const transcribed = group.filter(r => r.raw.trim());
    const forwarded = group.filter(r => r.forwarded.trim());
    return [name, { runs: group.length, errors: group.filter(r => r.error).length,
      missingFinalTranscripts: group.length - transcribed.length,
      missingForwardedTurns: group.length - forwarded.length,
      rawCERWhenPresent: transcribed.length ? transcribed.reduce((sum, r) => sum + r.rawScore.characterErrorRate, 0) / transcribed.length : null,
      forkCERWhenPresent: forwarded.length ? forwarded.reduce((sum, r) => sum + r.forkScore.characterErrorRate, 0) / forwarded.length : null,
      contractFailures: group.filter(r => !r.toolContractPassed).length,
      missingTerms: group.reduce((sum, r) => sum + r.forkScore.missingTerms.length, 0),
      inventedTerms: group.reduce((sum, r) => sum + r.forkScore.inventedTerms.length, 0) }];
  })) }, null, 2), { mode: 0o600 });
console.log(`Private evidence: ${resultPath}`);
if (results.some(result => result.error)) process.exitCode = 1;
