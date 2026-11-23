import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BailianRealtimeConversation } from '../omni-realtime.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() {}
  event(value: object) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  count(type: string) { return this.sent.filter(value => JSON.parse(value).type === type).length; }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('empty provider ASR final releases pending input; complete speech is judged after 1.8s total silence', async () => {
  const socket = new Socket(); const submitted: string[] = [];
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await tick();
  };
  const conversation = new BailianRealtimeConversation({
    apiKey: 'fixture', url: 'wss://example.invalid', model: 'fixture', instructions: 'fixture',
    sendKeyword: 'send', turnMode: 'semantic', turnJudge: async () => 'respond', socketFactory: () => socket,
    turnClock: { now: () => now, later: (fn, ms) => { const id = ++serial; timers.set(id, {at: now + ms, fn}); return id; }, cancel: id => { timers.delete(id as number); } },
    callbacks: {
      onReady() {}, onTranscript() {}, onTurnSubmitted: text => submitted.push(text), onText() {}, onAudio() {},
      onResponseStarted() {}, onResponseFinished() {}, onFinished() {}, onError: error => assert.fail(error.message), onToolCall: async () => '{}',
    },
  });
  try {
    socket.emit('open'); socket.event({type: 'session.updated'});
    assert.equal(JSON.parse(socket.sent[0]).session.turn_detection.silence_duration_ms, 1400);
    for (const [id, transcript] of [['noise', ''], ['owner', '现在有多少 Agent 在运行？']]) {
      socket.event({type: 'input_audio_buffer.speech_started', item_id: id});
      socket.event({type: 'input_audio_buffer.speech_stopped', item_id: id});
      socket.event({type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript});
    }
    await advance(399); assert.equal(submitted.length, 0);
    await advance(1); assert.deepEqual(submitted, ['现在有多少 Agent 在运行？']);
    assert.equal(socket.count('response.create'), 1);
  } finally { conversation.close(); }
});
function harness() {
  const socket = new Socket();
  const finish: Array<(value: string) => void> = [];
  const conversation = new BailianRealtimeConversation({
    apiKey: 'fixture', url: 'wss://example.invalid', model: 'fixture', instructions: 'fixture',
    sendKeyword: 'send', turnMode: 'semantic', socketFactory: () => socket,
    callbacks: {
      onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onText() {}, onAudio() {},
      onResponseStarted() {}, onResponseFinished() {}, onFinished() {},
      onError: error => assert.fail(error.message),
      onToolCall: () => new Promise(resolve => finish.push(resolve)),
    },
  });
  socket.emit('open'); socket.event({ type: 'session.updated' });
  const tool = (id: string) => socket.event({ type: 'response.function_call_arguments.done',
    call_id: id, name: 'inspect_workspace', arguments: '{}' });
  return { socket, conversation, finish, tool };
}

test('tool completion persists its receipt but cannot interrupt newer speech', async () => {
  const h = harness();
  h.tool('old-tool');
  h.socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'next-input' });
  h.finish[0]!('{"ok":true}'); await tick();
  assert.equal(h.socket.count('conversation.item.create'), 1, 'receipt must not disappear');
  assert.equal(h.socket.count('response.create'), 0, 'do not speak over the user');
  h.conversation.append(new Uint8Array(1024));
  assert.equal(h.socket.count('input_audio_buffer.append'), 1, 'new speech must keep flowing');
  h.socket.event({ type: 'input_audio_buffer.speech_stopped' }); await tick();
  assert.equal(h.socket.count('response.create'), 0, 'cloud owns the next semantic response');
  h.socket.event({ type: 'response.created', response: { id: 'next-response' } });
  h.socket.event({ type: 'response.done', response: { id: 'next-response' } }); await tick();
  assert.equal(h.socket.count('response.create'), 0, 'new response already includes the receipt');
  h.conversation.close();
});

test('explicit cancel invalidates late tool continuations even between responses', async () => {
  const h = harness(); h.tool('pending'); h.conversation.cancelResponse();
  h.finish[0]!('{"ok":true}'); await tick();
  assert.equal(h.socket.count('conversation.item.create'), 1);
  assert.equal(h.socket.count('response.create'), 0);
  h.conversation.close();
});

test('multiple same-tick tool results share one continuation request', async () => {
  const h = harness(); h.tool('a'); h.tool('b');
  h.finish.forEach(resolve => resolve('{"ok":true}')); await tick();
  assert.equal(h.socket.count('conversation.item.create'), 2);
  assert.equal(h.socket.count('response.create'), 1);
  h.conversation.close();
});

test('tool result arriving during an answer waits for that answer to finish', async () => {
  const h = harness(); h.tool('pending');
  h.socket.event({ type: 'response.created', response: { id: 'speaking' } });
  h.finish[0]!('{"ok":true}'); await tick();
  assert.equal(h.socket.count('response.create'), 0);
  h.socket.event({ type: 'response.done', response: { id: 'speaking' } }); await tick();
  assert.equal(h.socket.count('response.create'), 1);
  h.conversation.close();
});

test('controlled turn authorizes provider speech plus tool responses, but not the next uncommitted utterance', async () => {
  const socket = new Socket(); let calls = 0, submits = 0, audio = 0, text = 0;
  const timers = new Map<number, () => void>(); let nextId = 0;
  const conversation = new BailianRealtimeConversation({
    apiKey: 'fixture', url: 'wss://example.invalid', model: 'fixture', instructions: 'fixture',
    sendKeyword: 'send', turnMode: 'semantic', turnJudge: async () => 'respond',
    experimentalTurnContinuation: true,
    tools: [{ name: 'fork_execution', description: 'fixture', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    turnClock: { now: () => 0, later: fn => { const id = ++nextId; timers.set(id, fn); return id; }, cancel: id => { timers.delete(id as number); } },
    socketFactory: () => socket,
    callbacks: {
      onReady() {}, onTranscript() {}, onTurnSubmitted() { submits++; }, onText() { text++; }, onAudio() { audio++; },
      onResponseStarted() {}, onResponseFinished() {}, onFinished() {}, onError: e => assert.fail(e.message),
      onToolCall: async call => { assert.equal(call.arguments.text, '查询现在运行的任务'); calls++; return '{"ok":true}'; },
    },
  });
  socket.emit('open'); socket.event({ type: 'session.updated' });
  assert.equal(JSON.parse(socket.sent[0]).session.turn_detection.create_response, false);
  assert.equal(JSON.parse(socket.sent[0]).session.turn_detection.type, 'server_vad', 'Host owns semantics; provider only segments acoustics');
  assert.deepEqual(JSON.parse(socket.sent[0]).session.tools.map((tool: { function: { name: string } }) => tool.function.name), ['fork_execution']);
  socket.event({ type: 'response.audio.delta', delta: 'AAAA' });
  socket.event({ type: 'response.text.delta', delta: 'unsolicited' });
  assert.equal(audio, 0); assert.equal(text, 0, 'no event may leak before an authorized response lifecycle');
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '查询现在运行的任务' });
  assert.equal(submits, 0);
  [...timers.values()][0](); await tick();
  assert.equal(submits, 1); assert.equal(socket.count('response.create'), 1);
  socket.event({ type: 'response.created', response: { id: 'preamble' } });
  socket.event({ type: 'response.created', response: { id: 'tool-phase' } });
  socket.event({ type: 'response.function_call_arguments.done', response_id: 'tool-phase', call_id: 'c', name: 'fork_execution', arguments: '{"text":"truncated model paraphrase"}' });
  await tick(); assert.equal(calls, 1); assert.equal(socket.count('response.cancel'), 0);
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'b' });
  socket.event({ type: 'response.created', response: { id: 'unsolicited' } });
  socket.event({ type: 'response.function_call_arguments.done', response_id: 'unsolicited', call_id: 'bad', name: 'fixture', arguments: '{}' });
  await tick(); assert.equal(calls, 1); assert.equal(socket.count('response.cancel'), 1);
  conversation.close();
});

test('one-shot clarification leaves Omni input untouched; barge-in aborts TTS and retains the thought', async () => {
  const socket = new Socket(); let now = 0, serial = 0, starts = 0, interrupted = 0, calls = 0, audio = 0;
  let finishSpeech!: (pcm: Uint8Array) => void; let speechSignal!: AbortSignal;
  const timers = new Map<number, { at: number; fn: () => void }>(); const submissions: string[] = [];
  const advance = async (ms: number) => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); };
  const conversation = new BailianRealtimeConversation({
    apiKey: 'fixture', url: 'wss://example.invalid', model: 'fixture', instructions: 'fixture',
    sendKeyword: 'send', turnMode: 'semantic', socketFactory: () => socket,
    tools: [{ name: 'fork_execution', description: 'fixture', parameters: {} }],
    speakClarification: (_text, signal) => { speechSignal = signal; return new Promise(resolve => { finishSpeech = resolve; }); },
    turnClock: { now: () => now, later: (fn, ms) => { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id; }, cancel: id => { timers.delete(id as number); } },
    turnJudge: async ({ segments }) => segments.length > 1 ? 'respond' : { decision: 'wait', clarification: '你想问最近的哪方面？' },
    callbacks: {
      onReady() {}, onTranscript() {}, onText() {}, onAudio() { audio++; }, onFinished() {},
      onTurnSubmitted: text => submissions.push(text), onResponseStarted: () => { starts++; },
      onResponseFinished: status => { if (status === 'interrupted') interrupted++; },
      onError: error => assert.fail(error.message), onToolCall: async () => { calls++; return '{}'; },
    },
  });
  socket.emit('open'); socket.event({ type: 'session.updated' });
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '我最近的' });
  await advance(1600); await advance(5000); // 1.4s provider + 1.6s semantic wait + 5s clarification wait.
  assert.equal(socket.count('response.create'), 0); assert.equal(submissions.length, 0);
  socket.event({ type: 'response.function_call_arguments.done', response_id: 'question', call_id: 'illegal', name: 'fork_execution', arguments: '{}' });
  await tick(); assert.equal(calls, 0); assert.equal(starts, 1);
  assert.equal(socket.count('conversation.item.create'), 0, 'no fabricated tool receipt or user message');
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'b' });
  assert.equal(interrupted, 1); assert.equal(socket.count('response.cancel'), 0, 'TTS is not a provider response');
  assert(speechSignal.aborted); finishSpeech(new Uint8Array(4800)); await tick(); assert.equal(audio, 0, 'late TTS cannot play over new speech');
  conversation.append(new Uint8Array(1024)); assert.equal(socket.count('input_audio_buffer.append'), 1);
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'b' });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Agent是什么' });
  await advance(400); assert.deepEqual(submissions, ['我最近的 Agent是什么']);
  await advance(20_000); assert.equal(socket.count('response.create'), 1, 'only the completed thought authorizes Omni');
  conversation.close(); assert.equal(timers.size, 0);
});

test('cached provider answer is suppressed; Host fallback and a late tool phase share one real execution', async () => {
  const socket = new Socket(); const timers: (() => void)[] = []; const heard: string[] = [];
  const calls: { callId: string; origin?: string; arguments: Record<string, unknown> }[] = [];
  let resolve!: (result: string) => void;
  const conversation = new BailianRealtimeConversation({
    apiKey: 'fixture', url: 'wss://example.invalid', model: 'fixture', instructions: 'fixture', sendKeyword: 'send',
    turnMode: 'semantic', turnJudge: async () => 'respond',
    turnClock: { now: () => 0, later: fn => { timers.push(fn); return fn; }, cancel() {} },
    tools: [{ name: 'fork_execution', description: 'fixture', parameters: {} }], socketFactory: () => socket,
    callbacks: { onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onAudio() {}, onResponseStarted() {},
      onResponseFinished() {}, onFinished() {}, onText: text => heard.push(text), onError: error => assert.fail(error.message),
      onToolCall: call => { calls.push(call); return new Promise(done => { resolve = done; }); },
    },
  });
  socket.emit('open'); socket.event({ type: 'session.updated' });
  socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
  socket.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '最近的Agent在干什么' });
  timers[0](); await tick();
  socket.event({ type: 'response.created', response: { id: 'cached' } });
  socket.event({ type: 'response.text.done', response_id: 'cached', text: 'unverified cached status' });
  socket.event({ type: 'response.done', response: { id: 'cached', status: 'completed' } });
  await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].origin, 'host_control');
  assert.match(calls[0].callId, /^host-turn-/); assert.equal(heard.length, 0);
  socket.event({ type: 'response.function_call_arguments.done', call_id: 'late-real-provider-call', name: 'fork_execution', arguments: '{"text":"truncated"}' });
  await tick(); assert.equal(calls.length, 1, 'a second provider id cannot execute the task again');
  resolve('{"ok":true,"answer":"真实工具结果"}'); await tick();
  assert.deepEqual(heard, ['真实工具结果']);
  const outputs = socket.sent.map(s => JSON.parse(s)).filter(e => e.item?.type === 'function_call_output');
  assert.equal(outputs.length, 1); assert.equal(outputs[0].item.call_id, 'late-real-provider-call', 'never fabricate a provider call id for Host fallback');
  conversation.close();
});
