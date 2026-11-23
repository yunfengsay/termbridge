import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BailianVoiceService,
  createVoiceService,
  createVoiceServices,
  decodeVolcengineFrame,
  encodeVolcengineAudioEvent,
  encodeVolcengineJsonEvent,
  VolcengineVoiceService,
  VOLCENGINE_EVENTS,
} from './index.js';
import { reconcileTechnicalTranscript } from './transcript-vocabulary.js';

test('identified responses persist interrupted text and ignore stale events after a new response', () => {
  const socket = new FakeRealtimeSocket();
  let draft = '';
  const saved: Array<{ text: string; voiceStatus: string }> = [];
  const service = new BailianVoiceService({ apiKey: 'test', realtimeSocketFactory: () => socket });
  const conversation = service.startRealtimeConversation({ instructions: 'test', sendKeyword: '发送', turnMode: 'semantic' }, {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onAudio() {}, onFinished() {},
    onText(text, final) { draft = final ? text : draft + text; },
    onResponseStarted() { draft = ''; },
    onResponseFinished(status) { if (draft) saved.push({ text: draft, voiceStatus: status ?? 'completed' }); draft = ''; },
    onError(error) { assert.fail(error.message); }, onToolCall: async () => '{}',
  });
  const emit = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.emit('open'); emit({ type: 'session.updated' });
  emit({ type: 'response.created', response: { id: 'r1' } });
  emit({ type: 'response.text.delta', response_id: 'r1', delta: '旧回答说到一半' });
  emit({ type: 'response.created', response: { id: 'r2' } });
  emit({ type: 'response.text.done', response_id: 'r1', text: '不应串入的旧回答' });
  emit({ type: 'response.done', response: { id: 'r1' } });
  emit({ type: 'response.text.delta', response_id: 'r2', delta: '新回答也说到一半' });
  conversation.close();
  emit({ type: 'response.text.done', response_id: 'r2', text: '挂断后的迟到文字' });
  assert.deepEqual(saved.map(({text, voiceStatus}) => ({text, voiceStatus})), [
    { text: '旧回答说到一半', voiceStatus: 'interrupted' },
    { text: '新回答也说到一半', voiceStatus: 'interrupted' },
  ]);
});

test('unfinished speech waits silently, joins only an explicit continuation, and leaves new topics intact', async () => {
  const socket = new FakeRealtimeSocket();
  const calls: string[] = [];
  const service = new BailianVoiceService({ apiKey: 'test', realtimeSocketFactory: () => socket });
  const conversation = service.startRealtimeConversation({ instructions: 'test', sendKeyword: '发送', turnMode: 'semantic', experimentalTurnContinuation: true,
    tools: [{ name: 'fork_execution', description: 'execute', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
  }, {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onAudio() {}, onFinished() {}, onText() {},
    onResponseStarted() {}, onResponseFinished() {}, onError(error) { assert.fail(error.message); },
    onToolCall: async call => { calls.push(String(call.arguments.text)); return '{}'; },
  });
  socket.emit('open'); socket.emit('message', Buffer.from('{"type":"session.updated"}'));
  let id = 0;
  const tool = async (name: string, args: object) => {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done',
      call_id: `c${++id}`, name, arguments: JSON.stringify(args) })));
    await new Promise(resolve => setImmediate(resolve));
  };
  await tool('wait_for_user', { text: '我最近的。' });
  assert.deepEqual(calls, []);
  assert.equal(socket.sent.filter(text => text.includes('response.create')).length, 0);
  await tool('fork_execution', { text: 'Agent 是什么？', continues_previous: true });
  assert.deepEqual(calls, ['我最近的。\nAgent 是什么？']);
  await tool('wait_for_user', { text: '我最近的。' });
  await tool('fork_execution', { text: '不说这个了，查看今天日历', continues_previous: false });
  assert.equal(calls[1], '不说这个了，查看今天日历');
  conversation.close();
});

class FakeRealtimeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }
}

test('image context replaces passively without synthetic turns or post-hangup updates', () => {
  const socket = new FakeRealtimeSocket();
  const service = new BailianVoiceService({ apiKey: 'test', realtimeSocketFactory: () => socket });
  const conversation = service.startRealtimeConversation({ instructions: 'base policy', sendKeyword: '发送', turnMode: 'semantic' }, {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onAudio() {}, onFinished() {}, onText() {},
    onResponseStarted() {}, onResponseFinished() {},
    onError(error) { assert.fail(error.message); }, onToolCall: async () => '{}',
  });
  conversation.setImageContext!('selected image-1');
  socket.emit('open'); socket.emit('message', Buffer.from('{"type":"session.updated"}'));
  conversation.setImageContext!('selected image-2');
  let last = JSON.parse(socket.sent.at(-1)!);
  assert.equal(last.type, 'session.update');
  assert.match(last.session.instructions, /base policy/);
  assert.match(last.session.instructions, /image-2/);
  assert.doesNotMatch(last.session.instructions, /image-1/);
  conversation.setImageContext!('no attachments');
  last = JSON.parse(socket.sent.at(-1)!);
  assert.match(last.session.instructions, /no attachments/);
  assert.doesNotMatch(last.session.instructions, /image-[12]/);
  assert.ok(socket.sent.every(s => !['response.create', 'conversation.item.create'].includes(JSON.parse(s).type)));
  conversation.setSystemReminder!('<system-reminder>overlay</system-reminder>');
  const reminder = JSON.parse(socket.sent.at(-1)!);
  assert.equal(reminder.type, 'session.update');
  assert.match(reminder.session.instructions, /system-reminder/);
  assert.match(reminder.session.instructions, /base policy/);
  assert.ok(socket.sent.every(s => !['response.create', 'conversation.item.create'].includes(JSON.parse(s).type)));
  conversation.setSystemReminder!('<system-reminder>foreground</system-reminder>');
  assert.doesNotMatch(JSON.parse(socket.sent.at(-1)!).session.instructions, /overlay/);
  conversation.close();
  const count = socket.sent.length;
  conversation.setImageContext!('after hangup');
  conversation.setSystemReminder!('after hangup');
  assert.equal(socket.sent.length, count);
});

class FakeBinaryRealtimeSocket {
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  closed = false;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }
}

test('Bailian voice service transcribes in-memory WAV audio', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const service = new BailianVoiceService({
    apiKey: 'private-test-key',
    asrModel: 'test-asr',
    request: async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-test-key');
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ text: '你好 Brain' }] } }] },
      }));
    },
  });

  const text = await service.transcribe({
    audio: new Uint8Array(64).fill(7),
    mime: 'audio/wav',
    locale: 'zh-CN',
  });

  assert.equal(text, '你好 Brain');
  assert.equal(requestBody?.model, 'test-asr');
  const json = JSON.stringify(requestBody);
  assert.match(json, /data:audio\/wav;base64/);
  assert.match(json, /"language":"zh"/);
  assert.doesNotMatch(json, /private-test-key/);
});

test('Bailian voice service synthesizes and downloads WAV audio', async () => {
  const wav = Uint8Array.from([82, 73, 70, 70, 8, 0, 0, 0, 87, 65, 86, 69]);
  let requestBody: Record<string, unknown> | undefined;
  let requests = 0;
  const service = new BailianVoiceService({
    apiKey: 'test-key',
    ttsModel: 'test-tts',
    ttsVoice: 'Serena',
    request: async (url, init) => {
      requests += 1;
      if (requests === 1) {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ output: { audio: { url: 'https://example.test/audio.wav' } } }));
      }
      assert.equal(String(url), 'https://example.test/audio.wav');
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    },
  });

  const result = await service.synthesize({ text: '你好 Termbridge', locale: 'zh-CN' });

  assert.deepEqual(result.audio, wav);
  assert.equal(result.mime, 'audio/wav');
  assert.equal(result.sampleRate, 24_000);
  assert.deepEqual(requestBody, {
    model: 'test-tts',
    input: { text: '你好 Termbridge', voice: 'Serena', language_type: 'Chinese' },
  });
});

test('Bailian voice service accepts inline Base64 audio', async () => {
  const service = new BailianVoiceService({
    apiKey: 'test-key',
    request: async () => new Response(JSON.stringify({
      output: { audio: { data: Buffer.from('wav-bytes').toString('base64') } },
    })),
  });
  const result = await service.synthesize({ text: 'hello' });
  assert.equal(Buffer.from(result.audio).toString(), 'wav-bytes');
});

test('Bailian voice service searches the web through the Responses API', async () => {
  let requestUrl = '';
  let requestBody: Record<string, unknown> | undefined;
  const service = new BailianVoiceService({
    apiKey: 'search-private-key',
    searchUrl: 'https://example.test/compatible-mode/v1/responses',
    searchModel: 'search-model',
    request: async (url, init) => {
      requestUrl = String(url);
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer search-private-key');
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'TermBridge 最新发布是 0.1.23。',
            annotations: [
              { type: 'url_citation', title: 'npm', url: 'https://www.npmjs.com/package/termbridge' },
              { type: 'url_citation', title: 'duplicate', url: 'https://www.npmjs.com/package/termbridge' },
              { type: 'url_citation', title: 'unsafe', url: 'file:///private/result' },
            ],
          }],
        }],
      }));
    },
  });

  const result = await service.searchWeb({ query: '  TermBridge\n最新版本  ' });

  assert.equal(requestUrl, 'https://example.test/compatible-mode/v1/responses');
  assert.equal(requestBody?.model, 'search-model');
  assert.deepEqual(requestBody?.tools, [{ type: 'web_search' }]);
  assert.match(JSON.stringify(requestBody?.input), /TermBridge 最新版本/);
  assert.equal(result.text, 'TermBridge 最新发布是 0.1.23。');
  assert.deepEqual(result.sources, [{ title: 'npm', url: 'https://www.npmjs.com/package/termbridge' }]);
  assert.doesNotMatch(JSON.stringify(requestBody), /search-private-key/);
});

test('Bailian web search rejects empty queries and sanitizes invalid responses', async () => {
  const service = new BailianVoiceService({
    apiKey: 'private-key',
    request: async () => new Response('private-key invalid', { status: 502 }),
  });
  await assert.rejects(service.searchWeb({ query: '   ' }), /query is empty/);
  await assert.rejects(
    service.searchWeb({ query: 'current release' }),
    (error: Error) => error.message === 'Web search failed with HTTP 502',
  );
});

test('Bailian voice service only permits HTTP downloads from DashScope result storage', async () => {
  const service = new BailianVoiceService({
    apiKey: 'test-key',
    request: async () => new Response(JSON.stringify({
      output: { audio: { url: 'http://attacker.test/audio.wav' } },
    })),
  });
  await assert.rejects(service.synthesize({ text: 'hello' }), /insecure audio URL/);
});

test('voice service factory is BYOK and preserves legacy ASR variables', () => {
  assert.equal(createVoiceService({}), undefined);
  const service = createVoiceService({
    DASHSCOPE_API_KEY: 'test-key',
    TB_BRAIN_ASR_MODEL: 'legacy-model',
    TB_VOICE_TTS_MODEL: 'tts-model',
  });
  assert.equal(service?.provider, 'bailian');
});

test('voice service factory selects Volcengine S2S-O while auto keeps Bailian as the default', () => {
  const service = createVoiceService({
    TB_VOICE_PROVIDER: 'volcengine',
    VOLCENGINE_S2S_APP_ID: 'volc-app',
    VOLCENGINE_S2S_ACCESS_TOKEN: 'volc-token',
    DASHSCOPE_API_KEY: 'bailian-key',
  });
  assert.ok(service instanceof VolcengineVoiceService);
  assert.equal(service.provider, 'volcengine');
  assert.throws(
    () => createVoiceService({ TB_VOICE_PROVIDER: 'volcengine', VOLCENGINE_S2S_APP_ID: 'volc-app' }),
    /requires VOLCENGINE_S2S_API_KEY or legacy APP ID \+ Access Token/,
  );
  assert.equal(createVoiceService({ TB_VOICE_PROVIDER: 'auto', DASHSCOPE_API_KEY: 'bailian-key' })?.provider, 'bailian');
  assert.equal(createVoiceService({
    DASHSCOPE_API_KEY: 'bailian-key',
    VOLCENGINE_S2S_API_KEY: 'volc-speech-key',
  })?.provider, 'bailian');
});

test('voice service set exposes both providers for per-call A/B selection', () => {
  const services = createVoiceServices({
    TB_VOICE_PROVIDER: 'bailian',
    DASHSCOPE_API_KEY: 'bailian-key',
    VOLCENGINE_S2S_APP_ID: 'volc-app',
    VOLCENGINE_S2S_ACCESS_TOKEN: 'volc-token',
  });
  assert.deepEqual(services.availableProviders, ['bailian', 'volcengine']);
  assert.equal(services.select()?.provider, 'bailian');
  assert.equal(services.select('auto')?.provider, 'bailian');
  assert.equal(services.select('volcengine')?.provider, 'volcengine');
  assert.equal(services.select('volcengine')?.realtimeModelId, '1.2.1.1');
  assert.equal(services.select('bailian')?.realtimeModelId, 'qwen3.5-omni-flash-realtime');
});

test('voice service factory prefers Volcengine Realtime Voice 3.0 API keys', () => {
  const services = createVoiceServices({
    TB_VOICE_PROVIDER: 'bailian',
    DASHSCOPE_API_KEY: 'bailian-key',
    VOLCENGINE_S2S_API_KEY: 'volc-speech-key',
  });
  assert.deepEqual(services.availableProviders, ['bailian', 'volcengine']);
  assert.equal(services.select('volcengine')?.realtimeModelId, '1.2.6.1');
});

test('Volcengine Realtime Voice 3.0 uses JSON events, tool results, and streaming PCM', async () => {
  const socket = new FakeRealtimeSocket();
  let headers: Record<string, string> = {};
  const transcripts: Array<{ text: string; final: boolean }> = [];
  const audio: Uint8Array[] = [];
  const states: string[] = [];
  const service = new VolcengineVoiceService({
    apiKey: 'private-speech-key',
    realtimeSocketFactory: (_url, options) => {
      headers = options.headers as Record<string, string>;
      return socket;
    },
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'You are the TermBridge voice frontend.',
    sendKeyword: '发送',
    technicalTerms: ['TermBridge', 'Codex'],
    turnMode: 'semantic',
    tools: [{
      name: 'fork_execution',
      description: 'Delegate the task.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }],
  }, {
    onReady: () => states.push('ready'),
    onTranscript: (text, final) => transcripts.push({ text, final }),
    onTurnSubmitted: () => undefined,
    onText: () => undefined,
    onAudio: (chunk) => audio.push(chunk),
    onResponseStarted: () => states.push('responding'),
    onResponseFinished: () => states.push('listening'),
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => JSON.stringify({ ok: true, answer: 'done' }),
  });

  socket.emit('open');
  const create = JSON.parse(socket.sent[0] || '{}');
  assert.equal(create.type, 'session.create');
  assert.equal(create.session.model, '1.2.6.1');
  assert.deepEqual(create.session.audio.input.format, { type: 'pcm', rate: 16_000 });
  assert.deepEqual(create.session.audio.output.format, { type: 'pcm_s16le', rate: 24_000 });
  assert.deepEqual(create.session.extension.asr.extra.context.hotwords, [
    { word: 'TermBridge' },
    { word: 'Codex' },
  ]);
  assert.deepEqual(headers, { 'X-Api-Key': 'private-speech-key' });

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { id: 's1' } })));
  conversation.append(new Uint8Array(1_280).fill(7));
  const appendEvents = socket.sent.slice(1).map((item) => JSON.parse(item));
  assert.deepEqual(appendEvents.map((event) => event.type), [
    'input_audio_buffer.append',
    'input_audio_buffer.append',
  ]);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'u1',
    delta: '让 Codex',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'u1',
    transcript: '让 Codex 检查项目',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ call_id: 'call_1', name: 'fork_execution', arguments: '{"text":"检查项目"}' }],
  })));
  await new Promise((resolve) => setImmediate(resolve));
  const toolResult = JSON.parse(socket.sent.at(-1) || '{}');
  assert.equal(toolResult.type, 'conversation.item.create');
  assert.equal(toolResult.items[0].call_id, 'call_1');
  assert.equal(toolResult.items[0].role, 'tool');

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.started' })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_audio.delta',
    delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
  })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', usage: {} })));
  assert.deepEqual(transcripts, [
    { text: '让 Codex', final: false },
    { text: '让 Codex 检查项目', final: true },
  ]);
  assert.deepEqual(audio.map((chunk) => [...chunk]), [[1, 0, 2, 0]]);
  assert.deepEqual(states, ['ready', 'responding', 'listening']);
});

test('Volcengine S2S-O streams binary PCM and speaks the existing execution fork result', async () => {
  const socket = new FakeBinaryRealtimeSocket();
  let headers: Record<string, string> = {};
  const transcripts: Array<{ text: string; final: boolean }> = [];
  const answers: Array<{ text: string; final: boolean }> = [];
  const audio: Uint8Array[] = [];
  const states: string[] = [];
  const toolCalls: Array<{ name: string; text: unknown }> = [];
  const service = new VolcengineVoiceService({
    appId: 'volc-app-id',
    accessToken: 'private-volc-token',
    model: '1.2.1.1',
    speaker: 'zh_female_vv_jupiter_bigtts',
    realtimeSocketFactory: (_url, options) => {
      headers = options.headers as Record<string, string>;
      return socket;
    },
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'You are the TermBridge speech frontend.',
    sendKeyword: '发送',
    technicalTerms: ['TermBridge', 'Codex'],
    turnMode: 'semantic',
    outputAudioEnabled: true,
    tools: [{
      name: 'fork_execution',
      description: 'Run the semantic execution fork.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }],
  }, {
    onReady: () => states.push('ready'),
    onTranscript: (text, final) => transcripts.push({ text, final }),
    onTurnSubmitted: () => undefined,
    onText: (text, final) => answers.push({ text, final }),
    onAudio: (data) => audio.push(data),
    onResponseStarted: () => states.push('responding'),
    onResponseFinished: () => states.push('listening'),
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async (call) => {
      toolCalls.push({ name: call.name, text: call.arguments.text });
      return JSON.stringify({ ok: true, answer: '已经交给 Codex 处理。' });
    },
  });

  socket.emit('open');
  const startConnection = decodeVolcengineFrame(binary(socket.sent[0]));
  assert.equal(startConnection.event, VOLCENGINE_EVENTS.startConnection);
  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(VOLCENGINE_EVENTS.connectionStarted, {})));
  const startSession = decodeVolcengineFrame(binary(socket.sent[1]));
  assert.equal(startSession.event, VOLCENGINE_EVENTS.startSession);
  assert.ok(startSession.sessionId);
  assert.deepEqual((startSession.json as any).asr.extra.context.hotwords, [
    { word: 'TermBridge' },
    { word: 'Codex' },
  ]);
  assert.equal((startSession.json as any).dialog.extra.model, '1.2.1.1');
  assert.equal((startSession.json as any).dialog.extra.input_mod, 'keep_alive');
  assert.equal((startSession.json as any).tts.audio_config.format, 'pcm_s16le');
  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(
    VOLCENGINE_EVENTS.sessionStarted,
    { dialog_id: 'dialog-1' },
    startSession.sessionId,
  )));

  conversation.append(new Uint8Array(1_280).fill(7));
  const audioFrames = socket.sent.slice(2).map((item) => decodeVolcengineFrame(binary(item)));
  assert.deepEqual(audioFrames.map((frame) => frame.event), [
    VOLCENGINE_EVENTS.taskRequest,
    VOLCENGINE_EVENTS.taskRequest,
  ]);
  assert.deepEqual(audioFrames.map((frame) => frame.payload.length), [640, 640]);

  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(
    VOLCENGINE_EVENTS.asrInfo,
    { question_id: 'question-1' },
    startSession.sessionId,
  )));
  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(
    VOLCENGINE_EVENTS.asrResponse,
    { results: [{ text: '让 Codex 检查项目', is_interim: false }] },
    startSession.sessionId,
  )));
  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(
    VOLCENGINE_EVENTS.asrEnded,
    {},
    startSession.sessionId,
  )));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(toolCalls, [{ name: 'fork_execution', text: '让 Codex 检查项目' }]);
  assert.deepEqual(transcripts, [
    { text: '让 Codex 检查项目', final: false },
    { text: '让 Codex 检查项目', final: true },
  ]);
  assert.deepEqual(answers, [{ text: '已经交给 Codex 处理。', final: true }]);
  const ttsRequests = socket.sent
    .map((item) => typeof item === 'string' ? undefined : decodeVolcengineFrame(item))
    .filter((frame) => frame?.event === VOLCENGINE_EVENTS.chatTtsText);
  assert.equal(ttsRequests.length, 2);
  assert.deepEqual(ttsRequests.map((frame) => frame?.json), [
    { start: true, content: '已经交给 Codex 处理。', end: false },
    { start: false, content: '', end: true },
  ]);

  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(
    VOLCENGINE_EVENTS.ttsSentenceStart,
    { tts_type: 'chat_tts_text' },
    startSession.sessionId,
  )));
  socket.emit('message', Buffer.from(encodeVolcengineAudioEvent(
    VOLCENGINE_EVENTS.ttsAudio,
    Uint8Array.from([1, 0, 2, 0]),
    startSession.sessionId,
  )));
  socket.emit('message', Buffer.from(encodeVolcengineJsonEvent(
    VOLCENGINE_EVENTS.ttsEnded,
    {},
    startSession.sessionId,
  )));

  assert.deepEqual(states, ['ready', 'responding', 'listening']);
  assert.deepEqual(audio.map((chunk) => [...chunk]), [[1, 0, 2, 0]]);
  assert.equal(headers['X-Api-App-ID'], 'volc-app-id');
  assert.equal(headers['X-Api-Access-Key'], 'private-volc-token');
  assert.doesNotMatch(Buffer.concat(
    socket.sent
      .filter((item): item is Uint8Array => typeof item !== 'string')
      .map((item) => Buffer.from(item)),
  ).toString(), /private-volc-token/);
});

function binary(value: string | Uint8Array | undefined): Uint8Array {
  assert.ok(value instanceof Uint8Array);
  return value;
}

test('Bailian voice errors never expose response bodies or credentials', async () => {
  const service = new BailianVoiceService({
    apiKey: 'private-key',
    request: async () => new Response('not-json private-key', { status: 502 }),
  });
  await assert.rejects(
    service.synthesize({ text: 'hello' }),
    (error: Error) => error.message === 'Voice synthesis failed with HTTP 502',
  );
});

test('Bailian realtime voice streams PCM and returns live text plus final text', () => {
  const socket = new FakeRealtimeSocket();
  let authorization = '';
  const updates: Array<{ text: string; final: boolean }> = [];
  const service = new BailianVoiceService({
    apiKey: 'realtime-private-key',
    realtimeSocketFactory: (_url, options) => {
      authorization = String((options.headers as Record<string, string>).Authorization);
      return socket;
    },
  });
  const stream = service.startRealtimeTranscription('zh-CN', {
    onText: (text, final) => updates.push({ text, final }),
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
  });

  socket.emit('open');
  stream.append(Uint8Array.from([1, 0, 2, 0]));
  assert.equal(socket.sent.length, 1, 'audio waits for session.updated');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  stream.commit();
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.text',
    text: '查看',
    stash: ' Agent',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '查看 Agent',
  })));

  assert.equal(authorization, 'Bearer realtime-private-key');
  assert.match(socket.sent[0], /"turn_detection":null/);
  assert.match(socket.sent[0], /"corpus":\{"text":"发送"\}/);
  assert.match(socket.sent[1], /input_audio_buffer.append/);
  assert.match(socket.sent[2], /input_audio_buffer.commit/);
  assert.deepEqual(updates, [
    { text: '查看 Agent', final: false },
    { text: '查看 Agent', final: true },
  ]);
  assert.doesNotMatch(socket.sent.join(''), /realtime-private-key/);
});

test('dictation hints and ASR completion never start conversational voice or TTS', () => {
  const socket = new FakeRealtimeSocket();
  let finished = false;
  const updates: string[] = [];
  const service = new BailianVoiceService({ apiKey: 'test', realtimeSocketFactory: () => socket });
  const stream = service.startRealtimeTranscription('zh-CN', {
    onText: text => updates.push(text), onError: error => assert.fail(error.message), onFinished: () => { finished = true; },
  }, ['Agent', 'Skill', '提交任务']);
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  stream.append(Uint8Array.from([1, 0, 2, 0]));
  stream.commit();
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '查看 Agent' })));
  assert.equal(finished, false, 'sentence pause is not session completion or task submission');
  stream.finish();
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.finished' })));
  assert.equal(finished, true);
  assert.deepEqual(updates, ['查看 Agent']);
  const session = JSON.parse(socket.sent[0]).session;
  assert.deepEqual(session.modalities, ['text']);
  assert.equal(session.input_audio_transcription.corpus.text, 'Agent、Skill、提交任务');
  assert.ok(!socket.sent.some(raw => /response.create|synthesize/.test(raw)));
});

test('Bailian Omni conversation waits for the send keyword and streams tool-aware audio', async () => {
  const socket = new FakeRealtimeSocket();
  const transcripts: Array<{ text: string; final: boolean }> = [];
  const textUpdates: Array<{ text: string; final: boolean }> = [];
  const audio: Uint8Array[] = [];
  const toolCalls: string[] = [];
  const submittedTurns: string[] = [];
  const usages: Array<{ inputAudioTokens: number; outputAudioSeconds: number }> = [];
  let realtimeUrl = '';
  const service = new BailianVoiceService({
    apiKey: 'omni-private-key',
    realtimeSocketFactory: (url) => {
      realtimeUrl = url;
      return socket;
    },
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'You are the TermBridge voice Brain.',
    sendKeyword: '发送',
  }, {
    onReady: () => undefined,
    onTranscript: (text, final) => transcripts.push({ text, final }),
    onTurnSubmitted: (text) => submittedTurns.push(text),
    onText: (text, final) => textUpdates.push({ text, final }),
    onAudio: (chunk) => audio.push(chunk),
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onUsage: (usage) => usages.push(usage),
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async (call) => {
      toolCalls.push(String(call.arguments.task));
      return JSON.stringify({ ok: true, requestId: 'brain-tool-1' });
    },
  });

  socket.emit('open');
  assert.match(realtimeUrl, /model=qwen3\.5-omni-flash-realtime/);
  assert.match(socket.sent[0], /"turn_detection":null/);
  assert.match(socket.sent[0], /"sample_rate":24000/);
  assert.match(socket.sent[0], /dispatch_agent/);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  conversation.append(Uint8Array.from([1, 0, 2, 0]));
  conversation.commit();
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    text: '先看看',
    stash: '现在有多少 Agent',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '先看看现在有多少 Agent',
  })));
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 0);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '交给 Codex 检查，发送。',
  })));
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 1);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.audio.delta',
    delta: Buffer.from([9, 8, 7, 6]).toString('base64'),
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.audio_transcript.delta',
    delta: '已经交给',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    name: 'dispatch_agent',
    arguments: JSON.stringify({ task: '检查测试' }),
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.done',
    response: {
      usage: {
        total_tokens: 10,
        input_tokens: 7,
        output_tokens: 3,
        input_tokens_details: { text_tokens: 5, audio_tokens: 2 },
        output_tokens_details: { text_tokens: 1, audio_tokens: 2 },
      },
    },
  })));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(transcripts.map((item) => item.text), [
    '先看看现在有多少 Agent',
    '先看看现在有多少 Agent',
    '交给 Codex 检查，发送。',
  ]);
  assert.deepEqual(textUpdates, [{ text: '已经交给', final: false }]);
  assert.deepEqual([...audio[0]], [9, 8, 7, 6]);
  assert.deepEqual(toolCalls, ['检查测试']);
  assert.deepEqual(submittedTurns, ['先看看现在有多少 Agent 交给 Codex 检查']);
  assert.equal(usages[0]?.inputAudioTokens, 2);
  assert.equal(usages[0]?.outputAudioSeconds, 4 / (24_000 * 2));
  assert.match(socket.sent.at(-2) || '', /function_call_output/);
  assert.match(socket.sent.at(-1) || '', /response.create/);
  assert.doesNotMatch(socket.sent.join(''), /omni-private-key/);
});

test('Bailian Omni executes a replayed call id only once, including while pending', async () => {
  const socket = new FakeRealtimeSocket();
  const service = new BailianVoiceService({ apiKey: 'test-key', realtimeSocketFactory: () => socket });
  let finish!: (output: string) => void;
  let calls = 0;
  const conversation = service.startRealtimeConversation({ instructions: 'test', sendKeyword: '发送' }, {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onText() {}, onAudio() {},
    onResponseStarted() {}, onResponseFinished() {}, onFinished() {},
    onError(error) { assert.fail(error.message); },
    onToolCall() { calls++; return new Promise(resolve => { finish = resolve; }); },
  });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  const emitCall = (callId: string) => socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: callId,
    name: 'fork_execution', arguments: '{"text":"查看日历"}',
  })));
  emitCall('call-1');
  emitCall('call-1');
  assert.equal(calls, 1);
  finish('{"ok":true}');
  await new Promise(resolve => setImmediate(resolve));
  emitCall('call-1');
  assert.equal(calls, 1);
  assert.equal(socket.sent.filter(text => text.includes('function_call_output')).length, 1);
  emitCall('call-2');
  assert.equal(calls, 2, 'separate calls must not share a transcript-sequence identity');
  conversation.close();
  finish('{"ok":true}');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.sent.filter(text => text.includes('function_call_output')).length, 1,
    'closing a call must not resume its audio when a worker finishes');
});

test('Bailian Omni preserves an evidenced technical term when the final ASR rescoring is phonetic', () => {
  const socket = new FakeRealtimeSocket();
  const transcripts: Array<{ text: string; final: boolean }> = [];
  const submittedTurns: string[] = [];
  let responseStarts = 0;
  const service = new BailianVoiceService({
    apiKey: 'omni-private-key',
    realtimeSocketFactory: () => socket,
  });
  service.startRealtimeConversation({
    instructions: 'Technical voice conversation.',
    sendKeyword: '发送',
    turnMode: 'semantic',
    technicalTerms: ['Skill'],
  }, {
    onReady: () => undefined,
    onTranscript: (text, final) => transcripts.push({ text, final }),
    onTurnSubmitted: (text) => submittedTurns.push(text),
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => { responseStarts += 1; },
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => JSON.stringify({ ok: true }),
  });

  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'turn-skill',
    text: '',
    stash: 'Skill你会理解为什么',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'turn-skill',
    transcript: 'scale你会理解为什么。',
  })));

  assert.deepEqual(transcripts, [
    { text: 'Skill你会理解为什么', final: false },
    { text: 'Skill你会理解为什么。', final: true },
  ]);
  assert.deepEqual(submittedTurns, ['Skill你会理解为什么。']);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
  assert.equal(responseStarts, 0);
  assert.match(socket.sent.at(-3) || '', /response\.cancel/);
  assert.match(socket.sent.at(-2) || '', /Authoritative transcript correction/);
  assert.match(socket.sent.at(-2) || '', /Skill你会理解为什么/);
  assert.match(socket.sent.at(-1) || '', /response\.create/);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: {} })));
  assert.equal(responseStarts, 0);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
  assert.equal(responseStarts, 1);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: {} })));
  assert.match(socket.sent.at(-1) || '', /Technical voice conversation/);
  assert.doesNotMatch(socket.sent.at(-1) || '', /Authoritative transcript correction/);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'turn-real-scale',
    text: '',
    stash: '把界面 scale 到两倍',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'turn-real-scale',
    transcript: '把界面 scale 到两倍。',
  })));
  assert.deepEqual(transcripts.slice(-2), [
    { text: '把界面 scale 到两倍', final: false },
    { text: '把界面 scale 到两倍。', final: true },
  ]);
  assert.equal(submittedTurns.at(-1), '把界面 scale 到两倍。');
});

test('technical vocabulary never becomes an unevidenced special-case replacement table', () => {
  assert.equal(reconcileTechnicalTranscript('帮我检查茶香连接', [], ['NAS']), '帮我检查茶香连接');
  assert.equal(
    reconcileTechnicalTranscript('帮我检查茶香连接', [], ['NAS=茶香|纳斯']),
    '帮我检查茶香连接',
  );
});

test('Bailian Omni errors expose only a sanitized provider code', () => {
  const socket = new FakeRealtimeSocket();
  const errors: string[] = [];
  const service = new BailianVoiceService({
    apiKey: 'secret-key',
    realtimeSocketFactory: () => socket,
  });
  service.startRealtimeConversation({ instructions: 'test', sendKeyword: '发送' }, {
    onReady: () => undefined,
    onTranscript: () => undefined,
    onTurnSubmitted: () => undefined,
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => errors.push(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'error',
    error: { code: 'bad/request', message: 'upstream body secret-key' },
  })));

  assert.deepEqual(errors, ['Realtime Brain failed (badrequest)']);
  assert.doesNotMatch(errors.join(''), /upstream|secret-key/);
});

test('Bailian Omni call mode submits every utterance without a send keyword and exposes host tools', () => {
  const socket = new FakeRealtimeSocket();
  const submitted: string[] = [];
  const service = new BailianVoiceService({
    apiKey: 'call-mode-key',
    realtimeSocketFactory: () => socket,
  });
  service.startRealtimeConversation({
    instructions: 'Phone call mode',
    sendKeyword: '发送',
    turnMode: 'automatic',
    tools: [{
      name: 'list_agents',
      description: 'List current TermBridge Agents.',
      parameters: { type: 'object', properties: {} },
    }],
  }, {
    onReady: () => undefined,
    onTranscript: () => undefined,
    onTurnSubmitted: (text) => submitted.push(text),
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('open');
  assert.match(socket.sent[0] || '', /list_agents/);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '现在有多少 Agent？',
  })));

  assert.deepEqual(submitted, ['现在有多少 Agent？']);
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 1);
});

test('Bailian Omni switches between text-only and spoken replies without reconnecting', () => {
  const socket = new FakeRealtimeSocket();
  const service = new BailianVoiceService({
    apiKey: 'text-mode-key',
    realtimeSocketFactory: () => socket,
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'Phone call mode',
    sendKeyword: '发送',
    turnMode: 'semantic',
    outputAudioEnabled: false,
  }, {
    onReady: () => undefined,
    onTranscript: () => undefined,
    onTurnSubmitted: () => undefined,
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0] || '{}').session.modalities, ['text']);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));

  conversation.setOutputAudioEnabled(true);
  assert.deepEqual(JSON.parse(socket.sent.at(-1) || '{}').session.modalities, ['text', 'audio']);

  const updateCount = socket.sent.length;
  conversation.setOutputAudioEnabled(true);
  assert.equal(socket.sent.length, updateCount, 'reselecting the active mode is a no-op');

  conversation.setOutputAudioEnabled(false);
  assert.deepEqual(JSON.parse(socket.sent.at(-1) || '{}').session.modalities, ['text']);
});

test('Bailian Omni call mode rejects playback echo before it interrupts or starts a response', () => {
  const socket = new FakeRealtimeSocket();
  const transcripts: string[] = [];
  const rejected: string[] = [];
  const submitted: string[] = [];
  const service = new BailianVoiceService({
    apiKey: 'call-mode-key',
    realtimeSocketFactory: () => socket,
  });
  service.startRealtimeConversation({
    instructions: 'Phone call mode',
    sendKeyword: '发送',
    turnMode: 'automatic',
  }, {
    onReady: () => undefined,
    onTranscript: (text, final) => { if (final) transcripts.push(text); },
    shouldSubmitTurn: (text) => text !== '刚才的播放回声',
    onTurnRejected: (text) => rejected.push(text),
    onTurnSubmitted: (text) => submitted.push(text),
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '刚才的播放回声',
  })));
  assert.deepEqual(rejected, ['刚才的播放回声']);
  assert.deepEqual(transcripts, []);
  assert.equal(socket.sent.filter((item) => item.includes('response.cancel')).length, 0);
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 0);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '这是用户真正的插话',
  })));
  assert.deepEqual(submitted, ['这是用户真正的插话']);
  assert.deepEqual(transcripts, ['这是用户真正的插话']);
  assert.equal(socket.sent.filter((item) => item.includes('response.cancel')).length, 1);
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 1);
});

test('Bailian Omni semantic call delegates endpointing and follow-up responses to the server', async () => {
  const socket = new FakeRealtimeSocket();
  const submitted: string[] = [];
  const transcripts: Array<{ text: string; final: boolean }> = [];
  const service = new BailianVoiceService({
    apiKey: 'semantic-call-key',
    realtimeSocketFactory: () => socket,
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'Natural phone call mode',
    sendKeyword: '发送',
    turnMode: 'semantic',
    tools: [{
      name: 'inspect_workspace',
      description: 'Inspect live Agents.',
      parameters: { type: 'object', properties: {} },
    }],
  }, {
    onReady: () => undefined,
    onTranscript: (text, final) => transcripts.push({ text, final }),
    onTurnSubmitted: (text) => submitted.push(text),
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{"ok":true}',
  });

  socket.emit('open');
  const sessionUpdate = JSON.parse(socket.sent[0] || '{}');
  assert.deepEqual(sessionUpdate.session.turn_detection, {
    type: 'semantic_vad',
    threshold: 0.5,
    silence_duration_ms: 1_400,
    create_response: true,
    interrupt_response: true,
  });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  conversation.commit();
  assert.equal(socket.sent.some((item) => item.includes('input_audio_buffer.commit')), false);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.text',
    item_id: 'semantic-turn',
    text: '我现在',
    stash: '说完了',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'semantic-turn',
    transcript: '我现在说完了',
  })));
  assert.deepEqual(transcripts, [
    { text: '我现在说完了', final: false },
    { text: '我现在说完了', final: true },
  ]);
  assert.deepEqual(submitted, ['我现在说完了']);
  assert.equal(socket.sent.some((item) => item.includes('response.create')), false);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'call-semantic',
    name: 'inspect_workspace',
    arguments: '{}',
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.some((item) => item.includes('function_call_output')), true);
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 1);
});

test('Bailian Omni native barge-in keeps interrupted speech as the next semantic turn', () => {
  const socket = new FakeRealtimeSocket();
  const submitted: string[] = [];
  let responsesStarted = 0;
  let responsesFinished = 0;
  const service = new BailianVoiceService({
    apiKey: 'native-barge-in-key',
    realtimeSocketFactory: () => socket,
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'Natural phone call mode',
    sendKeyword: '发送',
    turnMode: 'semantic',
  }, {
    onReady: () => undefined,
    onTranscript: () => undefined,
    onTurnSubmitted: (text) => submitted.push(text),
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => { responsesStarted += 1; },
    onResponseFinished: () => { responsesFinished += 1; },
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
  conversation.append(Uint8Array.from([1, 0, 2, 0]));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_started' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: {} })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '先停一下，继续听我的新方案',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));

  assert.deepEqual(submitted, ['先停一下，继续听我的新方案']);
  assert.equal(responsesStarted, 2);
  assert.equal(responsesFinished, 1);
  assert.equal(socket.sent.filter((item) => item.includes('response.cancel')).length, 0);
  assert.equal(socket.sent.filter((item) => item.includes('response.create')).length, 0);
});

test('Bailian Omni injects Host events as user messages after the active response finishes', () => {
  const socket = new FakeRealtimeSocket();
  const service = new BailianVoiceService({
    apiKey: 'host-event-key',
    realtimeSocketFactory: () => socket,
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'TermBridge Voice Brain',
    sendKeyword: '发送',
    turnMode: 'semantic',
  }, {
    onReady: () => undefined,
    onTranscript: () => undefined,
    onTurnSubmitted: () => undefined,
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  const idleCount = socket.sent.length;
  conversation.injectUserMessage('<termbridge_system_event>first</termbridge_system_event>');
  assert.equal(socket.sent.length, idleCount + 2);
  const firstItem = JSON.parse(socket.sent.at(-2) || '{}');
  assert.equal(firstItem.type, 'conversation.item.create');
  assert.equal(firstItem.item.role, 'user');
  assert.equal(firstItem.item.content[0].type, 'input_text');
  assert.match(firstItem.item.content[0].text, /first/);

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
  const activeCount = socket.sent.length;
  conversation.injectUserMessage('<termbridge_system_event>second</termbridge_system_event>');
  assert.equal(socket.sent.length, activeCount);

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));
  assert.equal(socket.sent.length, activeCount + 2);
  assert.match(socket.sent.at(-2) || '', /second/);
});

test('Bailian Omni holds a Host event while the user is speaking', () => {
  const socket = new FakeRealtimeSocket();
  const service = new BailianVoiceService({
    apiKey: 'host-event-key',
    realtimeSocketFactory: () => socket,
  });
  const conversation = service.startRealtimeConversation({
    instructions: 'TermBridge Voice Brain',
    sendKeyword: '发送',
    turnMode: 'semantic',
  }, {
    onReady: () => undefined,
    onTranscript: () => undefined,
    onTurnSubmitted: () => undefined,
    onText: () => undefined,
    onAudio: () => undefined,
    onResponseStarted: () => undefined,
    onResponseFinished: () => undefined,
    onError: (error) => assert.fail(error.message),
    onFinished: () => undefined,
    onToolCall: async () => '{}',
  });

  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_started' })));
  const speakingCount = socket.sent.length;
  conversation.injectUserMessage('<termbridge_system_event>queued</termbridge_system_event>');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' })));
  assert.equal(socket.sent.length, speakingCount);

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));
  assert.equal(socket.sent.length, speakingCount + 2);
  assert.match(socket.sent.at(-2) || '', /queued/);
});
