import assert from 'node:assert/strict';
import test from 'node:test';

test('system reminders persist and archive independently of visible chat messages', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  brain.appendConversationMessage({ id: 'u-screen', role: 'user', text: '这是什么' });
  brain.appendSystemReminder('call-screen', '<system-reminder>overlay</system-reminder>', 1234);
  assert.equal(brain.getSnapshot().messages.length, 1);
  assert.equal(new BrainCoordinator(store).getSnapshot().systemReminders?.length, 1);
  const archived = brain.startNewConversation()!;
  assert.equal(brain.getHistoryConversation(archived.id)?.systemReminders?.length, 1);
  assert.equal(brain.getSnapshot().systemReminders?.length ?? 0, 0);
  brain.clearAllConversations();
  assert.equal(brain.getHistory().length, 0);
});
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { BrainToolCall, ExecutionForkEvent } from './executionFork.js';
import { ControlMessageSchema } from '@termbridge/protocol';
import {
  BailianBrainConversationService,
  BrainCoordinator,
  createBrainConversationService,
  DefaultBrainPlanner,
  inferThinkingFormat,
  JsonBrainStore,
  MemoryBrainStore,
  PiBailianBrainConversationService,
  parseDeclaredDeliverables,
} from './index.js';

test('silent wire contracts restrict model tiers and preserve terminal receipts', () => {
  assert.equal(ControlMessageSchema.parse({ t: 'brain_send', requestId: 'silent-1', text: '检查项目',
    workflow: 'silent', modelTier: 'deep' }).t, 'brain_send');
  assert.equal(ControlMessageSchema.safeParse({ t: 'brain_send', requestId: 'silent-1', text: '检查项目',
    workflow: 'silent', modelTier: 'arbitrary-endpoint' }).success, false);
  assert.equal(ControlMessageSchema.parse({ t: 'brain_text_result', requestId: 'silent-1',
    status: 'cancelled', text: 'cancelled' }).t, 'brain_text_result');
});

test('Host restart terminalizes interrupted silent jobs without restarting workers', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  brain.appendExecutionEvent({ eventId: 'silent:1', forkId: 'fork-silent', requestId: 'silent',
    phase: 'fork_started', createdAt: 1, workflow: 'silent' });
  const restored = new BrainCoordinator(store).getSnapshot();
  assert.equal(restored.executionEvents?.at(-1)?.phase, 'fork_failed');
  assert.equal(restored.messages.at(-1)?.id, 'silent-brain');
  assert.equal(new BrainCoordinator(store).getSnapshot().executionEvents?.length, 2);
});

for (const action of ['cancel', 'timeout'] as const) {
  test(`Pi ${action} settles immediately while a tool is pending and suppresses late events`, async () => {
    const faux = createFauxCore({ api: 'openai-completions', provider: 'bailian', models: [{ id: 'test' }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('inspect_workspace', {}, { id: 'slow-tool' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('obsolete answer')]),
    ]);
    const controller = new AbortController();
    const events: ExecutionForkEvent[] = [];
    let release!: (value: string) => void;
    let started!: () => void;
    let toolSignal: AbortSignal | undefined;
    const toolStarted = new Promise<void>(resolve => { started = resolve; });
    const output = new Promise<string>(resolve => { release = resolve; });
    const service = new PiBailianBrainConversationService({ apiKey: 'test', model: 'test',
      timeoutMs: action === 'timeout' ? 120 : 5000, streamFn: faux.streamSimple });
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      const response = service.respond({ signal: controller.signal, instructions: 'Test',
        messages: [{ role: 'user', content: 'Read state' }],
        tools: [{ name: 'inspect_workspace', description: 'Read', parameters: { type: 'object', properties: {} } }],
        onToolCall: async (_call, signal) => { toolSignal = signal; started(); return output; },
        execution: { forkId: 'fork-test', requestId: 'request-test', observer: { onEvent: event => { events.push(event); } } },
      });
      const settled = assert.rejects(response, action === 'cancel' ? /cancelled/ : /timed out/);
      await toolStarted;
      if (action === 'cancel') controller.abort();
      await settled;
      assert.equal(toolSignal?.aborted, true);
      assert.equal(events.at(-1)?.phase, action === 'cancel' ? 'fork_cancelled' : 'fork_failed');
      const count = events.length;
      release('{"ok":true}');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(events.length, count, 'late tool must not reopen a terminal job');
      assert.equal(faux.state.callCount, 1, 'no next model turn after cancellation');
    } finally { clearTimeout(keepAlive); release?.('{"ok":false}'); }
  });
}

test('voice checkpoints upsert one history message and a terminal response cannot be reopened', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  brain.upsertVoiceReply({ id: 'voice', text: '前半句', voiceStatus: 'streaming' });
  brain.upsertVoiceReply({ id: 'voice', text: '前半句，后半句', voiceStatus: 'interrupted' });
  brain.upsertVoiceReply({ id: 'voice', text: '迟到的旧文字', voiceStatus: 'streaming' });
  const messages = new BrainCoordinator(store).getSnapshot().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '前半句，后半句');
  assert.equal(messages[0].voiceStatus, 'interrupted');
});

test('Host restart preserves the last voice checkpoint as interrupted', () => {
  const store = new MemoryBrainStore();
  new BrainCoordinator(store).upsertVoiceReply({ id: 'crashed-call', text: '保留已收到的前半句', voiceStatus: 'streaming' });
  const restored = new BrainCoordinator(store).getSnapshot().messages;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].voiceStatus, 'interrupted');
  assert.equal(restored[0].text, '保留已收到的前半句');
  assert.equal(new BrainCoordinator(store).getSnapshot().messages[0].voiceStatus, 'interrupted');
});

test('Bailian text Brain answers directly with the configured default cloud model', async () => {
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'bailian',
    models: [{ id: 'deepseek-v4.1-flash' }],
  });
  faux.setResponses([fauxAssistantMessage([fauxText('当前有 2 个 Agent 在运行。')])]);
  const service = new BailianBrainConversationService({
    apiKey: 'private-test-key',
    streamFn: faux.streamSimple,
  });

  const result = await service.respond({
    instructions: 'You are TermBridge Brain.',
    messages: [{ role: 'user', content: '现在有多少 Agent 在运行？' }],
    tools: [],
    onToolCall: async () => assert.fail('direct conversation must not invoke a worker tool'),
  });

  assert.equal(result.text, '当前有 2 个 Agent 在运行。');
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(service.runtime, 'pi');
});

test('Global Brain factory never falls back to a local coding agent', () => {
  assert.equal(createBrainConversationService({}), undefined);
  const service = createBrainConversationService({ DASHSCOPE_API_KEY: 'test-key' });
  assert.ok(service instanceof PiBailianBrainConversationService);
  assert.equal(service.runtime, 'pi');
  assert.throws(
    () => createBrainConversationService({ TB_BRAIN_PROVIDER: 'local', DASHSCOPE_API_KEY: 'test-key' }),
    /does not support a local conversation provider/i,
  );
});

test('Pi text Brain owns the registered tool loop while Bailian remains the provider', async () => {
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'bailian',
    models: [{ id: 'test-small-model' }],
  });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('inspect_workspace', { view: 'overview' }, { id: 'call-overview' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('有 1 个 Agent 正在工作。')]),
  ]);
  const service = new PiBailianBrainConversationService({
    apiKey: 'test-key',
    model: 'test-small-model',
    streamFn: faux.streamSimple,
  });
  const calls: BrainToolCall[] = [];
  const events: ExecutionForkEvent[] = [];

  const result = await service.respond({
    instructions: 'Use live tools for current state.',
    messages: [
      { role: 'user', content: '之前问过一次' },
      { role: 'assistant', content: '我会重新读取实时状态。' },
      { role: 'user', content: '现在有多少 Agent？' },
    ],
    tools: [{
      name: 'inspect_workspace',
      description: 'Read live state.',
      parameters: { type: 'object', properties: { view: { type: 'string' } }, required: ['view'] },
    }],
    onToolCall: async (call) => {
      calls.push(call);
      return '{"ok":true,"count":1}';
    },
    execution: {
      forkId: 'fork-test',
      requestId: 'request-test',
      observer: { onEvent: (event) => { events.push(event); } },
    },
  });

  assert.equal(result.text, '有 1 个 Agent 正在工作。');
  assert.equal(result.provider, 'bailian');
  assert.equal(result.model, 'test-small-model');
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(calls, [{
    callId: 'call-overview',
    name: 'inspect_workspace',
    arguments: { view: 'overview' },
  }]);
  assert.deepEqual(result.toolCalls, [{ call: calls[0], output: '{"ok":true,"count":1}' }]);
  assert.deepEqual(events.map(({ phase, turn }) => ({ phase, turn })), [
    { phase: 'fork_started', turn: undefined },
    { phase: 'model_started', turn: 1 },
    { phase: 'model_completed', turn: 1 },
    { phase: 'model_started', turn: 2 },
    { phase: 'model_completed', turn: 2 },
    { phase: 'fork_completed', turn: undefined },
  ]);
});

test('Pi execution fork repairs a failed tool attempt and continues until success', async () => {
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'bailian',
    models: [{ id: 'test-small-model' }],
  });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('inspect_workspace', { view: 'unknown' }, { id: 'call-invalid' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('inspect_workspace', { view: 'overview' }, { id: 'call-repaired' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('修正参数后读取成功，当前有 2 个 Agent。')]),
  ]);
  const service = new PiBailianBrainConversationService({
    apiKey: 'test-key',
    model: 'test-small-model',
    streamFn: faux.streamSimple,
  });
  const calls: BrainToolCall[] = [];

  const result = await service.respond({
    instructions: 'Retry recoverable failures with corrected arguments.',
    messages: [{ role: 'user', content: '现在有多少 Agent？' }],
    tools: [{
      name: 'inspect_workspace',
      description: 'Read live state.',
      parameters: { type: 'object', properties: { view: { type: 'string' } }, required: ['view'] },
    }],
    onToolCall: async (call) => {
      calls.push(call);
      return call.arguments.view === 'overview'
        ? '{"ok":true,"count":2}'
        : '{"ok":false,"retryable":true,"failureKind":"invalid_request","error":"unknown view"}';
    },
  });

  assert.equal(faux.state.callCount, 3);
  assert.deepEqual(calls.map((call) => call.arguments.view), ['unknown', 'overview']);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.text, '修正参数后读取成功，当前有 2 个 Agent。');
});

test('coordinator persists idempotent execution fork events', () => {
  const store = new MemoryBrainStore();
  const coordinator = new BrainCoordinator(store);
  const event: ExecutionForkEvent = {
    eventId: 'fork-1:1',
    forkId: 'fork-1',
    requestId: 'request-1',
    phase: 'tool_started',
    createdAt: 123,
    model: 'qwen3.8-flash',
    callId: 'call-1',
    toolName: 'inspect_workspace',
    summary: '正在读取工作区',
  };
  assert.deepEqual(coordinator.appendExecutionEvent(event), event);
  assert.deepEqual(coordinator.appendExecutionEvent({ ...event, summary: 'retry' }), event);
  assert.deepEqual(new BrainCoordinator(store).getSnapshot().executionEvents, [event]);
});

test('planner honors an available explicit agent and otherwise prefers codex', () => {
  const planner = new DefaultBrainPlanner();
  assert.equal(planner.chooseAgent('claude', ['codex', 'claude']), 'claude');
  assert.equal(planner.chooseAgent(undefined, ['shell', 'claude', 'codex']), 'codex');
  assert.equal(planner.chooseAgent(undefined, ['shell']), undefined);
});

test('coordinator deduplicates retried requests and persists the task lifecycle', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  const first = brain.submit({
    requestId: 'req-1',
    text: '  Fix   the Android list  ',
    requestedAgent: 'codex',
    availableAgents: ['codex', 'claude'],
    now: 100,
  });
  const retried = brain.submit({
    requestId: 'req-1',
    text: 'ignored retry',
    availableAgents: ['claude'],
    now: 200,
  });
  assert.deepEqual(retried, first);
  assert.equal(brain.getSnapshot().messages.length, 1);
  assert.equal(first.text, 'Fix   the Android list');

  const dispatched = brain.bindSession(first.taskId, 'sess-9', 300);
  assert.equal(dispatched?.status, 'dispatched');
  assert.equal(dispatched?.sessionId, 'sess-9');

  const completed = brain.finishSession(
    'sess-9',
    0,
    400,
    'The Android list is fixed.\n<termbridge_deliverable kind="preview" title="Android preview" url="https://example.test/app" />',
  );
  assert.equal(completed?.status, 'completed');
  assert.equal(brain.getSnapshot().messages.at(-1)?.role, 'brain');
  assert.equal(brain.getSnapshot().messages.at(-1)?.text, 'The Android list is fixed.');
  assert.deepEqual(brain.getSnapshot().runEvents?.map(({ type }) => type), [
    'queued', 'dispatched', 'completed',
  ]);
  assert.deepEqual(brain.getSnapshot().deliverables?.map(({ kind, title, url }) => ({ kind, title, url })), [{
    kind: 'preview',
    title: 'Android preview',
    url: 'https://example.test/app',
  }]);
  const messageCount = brain.getSnapshot().messages.length;
  assert.equal(brain.finishSession('sess-9', 0, 500, 'duplicate'), undefined);
  assert.equal(brain.getSnapshot().messages.length, messageCount);

  const reloaded = new BrainCoordinator(store).getSnapshot();
  assert.equal(reloaded.tasks[0].status, 'completed');
  assert.equal(reloaded.runEvents?.length, 3);
});

test('coordinator records one durable route decision per tool call', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const decision = {
    id: 'route-1',
    requestId: 'request-1',
    action: 'dispatch_agent' as const,
    outcome: 'accepted' as const,
    createdAt: 123,
    targetAgentId: 'codex',
    reason: 'The request needs a code change.',
    confidence: 0.91,
  };
  assert.deepEqual(brain.recordRouteDecision(decision), decision);
  assert.deepEqual(brain.recordRouteDecision({ ...decision, reason: 'retry' }), decision);
  assert.deepEqual(brain.getSnapshot().routeDecisions, [decision]);
});

test('Deliverables require explicit safe declarations', () => {
  const parsed = parseDeclaredDeliverables({
    text: [
      'Preview: http://unsafe.example/app',
      '<termbridge_deliverable kind="preview" title="Unsafe" url="http://unsafe.example/app" />',
      '<termbridge_deliverable kind="file" title="Traversal" path="../secret" />',
      '<termbridge_deliverable kind="report" title="Report" path="docs/report.md" />',
    ].join('\n'),
    runId: 'run-1',
    sessionId: 'sess-1',
    now: 500,
  });
  assert.equal(parsed.deliverables.length, 1);
  assert.equal(parsed.deliverables[0]?.path, 'docs/report.md');
  assert.equal(parsed.deliverables[0]?.sessionId, 'sess-1');
  assert.match(parsed.text, /http:\/\/unsafe\.example/);
  assert.doesNotMatch(parsed.text, /termbridge_deliverable/);
});

test('coordinator rejects empty messages and missing agent configuration', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  assert.throws(
    () => brain.submit({ requestId: 'empty', text: '  ', availableAgents: ['codex'] }),
    /cannot be empty/,
  );
  assert.throws(
    () => brain.submit({ requestId: 'no-agent', text: 'hello', availableAgents: [] }),
    /No agent/,
  );
});

test('coordinator stores a model acknowledgement and fails interrupted runs after restart', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  const task = brain.submit({
    requestId: 'planned',
    text: 'review it',
    dispatchText: 'Review the Android implementation and run its tests.',
    brainReply: 'I will route the review to codex.',
    requestedAgent: 'codex',
    availableAgents: ['codex'],
    now: 100,
  });
  brain.bindSession(task.taskId, 'lost-session', 200);

  const restarted = new BrainCoordinator(store);
  const failed = restarted.failInterruptedTasks(new Set(), 300);
  assert.equal(failed[0]?.status, 'failed');
  assert.match(failed[0]?.error ?? '', /restarted/);
  assert.equal(restarted.getSnapshot().messages[1]?.role, 'brain');
  assert.match(restarted.getSnapshot().messages.at(-1)?.text ?? '', /interrupted/);
});

test('Pi executes read-only tools concurrently while serializing batches with mutations', async () => {
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'bailian',
    models: [{ id: 'deepseek-v4.1-flash' }],
  });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('read_a', {}, { id: 'r-1' }),
      fauxToolCall('read_b', {}, { id: 'r-2' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('read_a', {}, { id: 'r-3' }),
      fauxToolCall('write_c', {}, { id: 'w-1' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('完成')]),
  ]);

  let inFlight = 0;
  let maxConcurrentReadOnly = 0;
  let maxConcurrentWithWrite = 0;
  let round = 1;
  const service = new PiBailianBrainConversationService({
    apiKey: 'test-key',
    streamFn: faux.streamSimple,
  });

  const result = await service.respond({
    instructions: 'Parallel read-only test',
    messages: [{ role: 'user', content: 'run tools' }],
    tools: [
      { name: 'read_a', description: 'Read A', parameters: { type: 'object', properties: {} }, readOnly: true },
      { name: 'read_b', description: 'Read B', parameters: { type: 'object', properties: {} }, readOnly: true },
      { name: 'write_c', description: 'Write C', parameters: { type: 'object', properties: {} }, readOnly: false },
    ],
    onToolCall: async (call) => {
      if (call.callId === 'r-3') round = 2;
      inFlight += 1;
      if (round === 1) maxConcurrentReadOnly = Math.max(maxConcurrentReadOnly, inFlight);
      else maxConcurrentWithWrite = Math.max(maxConcurrentWithWrite, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return '{"ok":true}';
    },
  });

  assert.equal(result.text, '完成');
  assert.equal(maxConcurrentReadOnly, 2, 'read-only batch should run concurrently');
  assert.equal(maxConcurrentWithWrite, 1, 'batch containing mutating tool must run sequentially');
});

test('Pi streams incremental text deltas and keeps fork_completed strictly after async model_completed observers', async () => {
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'bailian',
    models: [{ id: 'deepseek-v4.1-flash' }],
  });
  faux.setResponses([fauxAssistantMessage([fauxText('第一段，第二段。')])]);
  const deltas: string[] = [];
  const fullSnapshots: string[] = [];
  const phases: string[] = [];
  const service = new PiBailianBrainConversationService({
    apiKey: 'test-key',
    streamFn: faux.streamSimple,
  });

  const result = await service.respond({
    instructions: 'Stream test',
    messages: [
      { role: 'user', content: '查一下状态' },
      { role: 'assistant', content: '查到了', toolSummary: 'inspect_workspace: 2 agents (herdr:w1:p1)' },
      { role: 'user', content: '详细说说' },
    ],
    tools: [],
    onToolCall: async () => '{}',
    onTextDelta: (delta, full) => {
      deltas.push(delta);
      fullSnapshots.push(full);
    },
    execution: {
      forkId: 'fork-stream',
      requestId: 'req-stream',
      observer: {
        onEvent: async (event) => {
          if (event.phase === 'model_completed') await new Promise((resolve) => setTimeout(resolve, 15));
          phases.push(event.phase);
        },
      },
    },
  });

  assert.equal(result.text, '第一段，第二段。');
  assert.equal(deltas.join(''), '第一段，第二段。');
  assert.equal(fullSnapshots.at(-1), '第一段，第二段。');
  assert.deepEqual(phases, ['fork_started', 'model_started', 'model_completed', 'fork_completed']);
  assert.equal(inferThinkingFormat('deepseek-v4.1-flash'), 'deepseek');
  assert.equal(inferThinkingFormat('qwen3.8-max'), 'qwen');
  assert.equal(inferThinkingFormat('gpt-4.1'), 'openai');
});

test('JsonBrainStore splits archived history and coalesces debounced async writes without data loss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-brain-store-'));
  try {
    const file = join(dir, 'brain.json');
    const historyFile = join(dir, 'brain-history.json');
    const store = new JsonBrainStore(file, { debounceMs: 30 });
    const coordinator = new BrainCoordinator(store);
    coordinator.appendConversationMessage({ id: 'u1', role: 'user', text: 'first conversation', now: 100 });
    coordinator.startNewConversation(200);
    for (let i = 0; i < 10; i += 1) {
      coordinator.appendExecutionEvent({
        eventId: `fork-1:${i}`,
        forkId: 'fork-1',
        requestId: 'req-1',
        phase: 'tool_started',
        createdAt: 300 + i,
      });
    }
    coordinator.appendConversationMessage({ id: 'u2', role: 'user', text: 'active conversation', now: 400 });
    await coordinator.flush();

    assert.equal(existsSync(file), true);
    assert.equal(existsSync(historyFile), true);
    const activeJson = JSON.parse(readFileSync(file, 'utf8')) as { history?: unknown; messages?: unknown[] };
    assert.equal(activeJson.history, undefined, 'active brain.json should not duplicate archived history');
    assert.equal(activeJson.messages?.length, 1);

    const reloaded = new BrainCoordinator(new JsonBrainStore(file));
    assert.equal(reloaded.getSnapshot().messages[0]?.text, 'active conversation');
    assert.equal(reloaded.getHistory().length, 1);
    assert.equal(reloaded.getHistoryConversation(reloaded.getHistory()[0]!.id)?.messages[0]?.text, 'first conversation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('brain_text_delta validates streaming text delta payloads', () => {
  const parsed = ControlMessageSchema.parse({
    t: 'brain_text_delta',
    requestId: 'req-1',
    delta: '你好',
    text: '你好',
    final: false,
  });
  assert.equal(parsed.t, 'brain_text_delta');
});

test('coordinator completes an authoritative control-plane answer without a session', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const task = brain.submit({
    requestId: 'answer-only',
    text: '刚才我给哪个 Agent 发了消息？',
    brainReply: '最近发给 herdr:wA:p1。',
    availableAgents: ['codex'],
    now: 100,
  });
  const completed = brain.completeWithoutDispatch(task.taskId, 110);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.sessionId, undefined);
  assert.equal(brain.getSnapshot().messages.length, 2);
});

test('completion ignores a historical task when a restarted host reuses its session id', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const historical = brain.submit({
    requestId: 'before-restart',
    text: 'old task',
    availableAgents: ['codex'],
    now: 100,
  });
  brain.bindSession(historical.taskId, 'sess-1', 110);
  brain.failTask(historical.taskId, 'Host restarted', 120);

  const current = brain.submit({
    requestId: 'after-restart',
    text: 'new task',
    availableAgents: ['codex'],
    now: 200,
  });
  brain.bindSession(current.taskId, 'sess-1', 210);

  const finished = brain.finishSession('sess-1', 0, 220, 'new result');
  assert.equal(finished?.taskId, current.taskId);
  assert.equal(finished?.status, 'completed');
  assert.equal(brain.getSnapshot().messages.at(-1)?.text, 'new result');
});

test('voice conversation messages are durable and idempotent', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  brain.appendConversationMessage({ id: 'voice-user-1', role: 'user', text: '检查 Agent' });
  brain.appendConversationMessage({ id: 'voice-user-1', role: 'user', text: '重复消息' });
  brain.appendConversationMessage({
    id: 'voice-brain-1',
    role: 'brain',
    text: '我来处理。',
    modality: 'voice',
  });

  assert.deepEqual(brain.getSnapshot().messages.map((message) => message.text), [
    '检查 Agent',
    '我来处理。',
  ]);
  assert.equal(brain.getSnapshot().messages.at(-1)?.modality, 'voice');
});

test('tool-dispatched tasks do not duplicate the Global user turn', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  brain.appendConversationMessage({ id: 'global-turn-1', role: 'user', text: '帮我修复语音问题' });
  brain.submit({
    requestId: 'global-turn-1-tool-call-1',
    text: '修复 Android 语音中断',
    requestedAgent: 'codex',
    availableAgents: ['codex'],
    recordUserMessage: false,
  });

  assert.deepEqual(brain.getSnapshot().messages.map((message) => message.text), ['帮我修复语音问题']);
  assert.equal(brain.getSnapshot().tasks[0]?.text, '修复 Android 语音中断');
});

test('voice tool cards are durable, bounded, and idempotent conversation events', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  const result = {
    id: 'voice-1-tool-call-1',
    requestId: 'voice-1',
    callId: 'call-1',
    toolName: 'list_agents',
    createdAt: 150,
    view: {
      kind: 'agent_list' as const,
      title: 'Agents',
      items: [{
        id: 'herdr:wA:p1', title: 'termbridge', status: 'working',
        sessionId: 'herdr:wA:p1', source: 'herdr' as const,
      }],
    },
  };

  brain.appendConversationToolResult(result);
  brain.appendConversationToolResult({ ...result, view: { ...result.view, title: 'duplicate' } });

  const reloaded = new BrainCoordinator(store).getSnapshot();
  assert.equal(reloaded.toolResults?.length, 1);
  assert.equal(reloaded.toolResults?.[0]?.view.title, 'Agents');
  assert.equal(reloaded.toolResults?.[0]?.view.items[0]?.sessionId, 'herdr:wA:p1');
});

test('asynchronous phone receipts update the originating archived conversation', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const pending = {
    id: 'phone-tool-1',
    requestId: 'voice-1',
    callId: 'call-1',
    toolName: 'phone_action',
    createdAt: 150,
    view: {
      kind: 'receipt' as const,
      title: 'Photos',
      items: [{ id: 'action-1', title: 'Select photos', status: 'awaiting_user' }],
    },
  };
  brain.appendConversationMessage({ id: 'voice-1', role: 'user', text: '修改这些照片', now: 100 });
  brain.appendConversationToolResult(pending);
  brain.startNewConversation(200);

  brain.upsertConversationToolResult({
    ...pending,
    createdAt: 250,
    view: {
      ...pending.view,
      items: [{ id: 'action-1', title: 'Select photos', status: 'completed' }],
    },
  });

  assert.equal(brain.getSnapshot().toolResults?.length, 0);
  const archived = brain.getHistory()[0];
  assert.equal(
    brain.getHistoryConversation(archived?.id ?? '')?.toolResults?.[0]?.view.items[0]?.status,
    'completed',
  );
});

test('new Global conversation archives the current timeline and survives reload', () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  brain.appendConversationMessage({ id: 'user-1', role: 'user', text: 'Review the Android voice flow', now: 100 });
  brain.appendConversationMessage({ id: 'brain-1', role: 'brain', text: 'I will check it.', now: 200 });

  const archived = brain.startNewConversation(300);
  assert.equal(archived?.title, 'Review the Android voice flow');
  assert.deepEqual(brain.getSnapshot().messages, []);
  assert.equal(brain.getHistory()[0]?.messageCount, 2);

  const restarted = new BrainCoordinator(store);
  const conversation = restarted.getHistoryConversation(archived?.id ?? '');
  assert.deepEqual(conversation?.messages.map((message) => message.text), [
    'Review the Android voice flow',
    'I will check it.',
  ]);
});

test('restoring Global history makes it current and archives the previous conversation', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  brain.appendConversationMessage({ id: 'old', role: 'user', text: 'Continue the old plan', now: 100 });
  const archived = brain.startNewConversation(200);
  brain.appendConversationMessage({ id: 'current', role: 'user', text: 'Current conversation', now: 300 });

  const restored = brain.restoreConversation(archived?.id ?? '', 400);

  assert.equal(restored?.id, archived?.id);
  assert.deepEqual(brain.getSnapshot().messages.map((message) => message.text), ['Continue the old plan']);
  assert.deepEqual(brain.getHistory().map((conversation) => conversation.title), ['Current conversation']);
  assert.equal(brain.restoreConversation('missing'), undefined);
});

test('clearing Global removes the current timeline and every archived conversation', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  brain.appendConversationMessage({ id: 'old', role: 'user', text: 'Old conversation', now: 100 });
  brain.startNewConversation(200);
  brain.appendConversationMessage({ id: 'current', role: 'user', text: 'Temporary draft', now: 300 });

  assert.equal(brain.clearAllConversations(), true);
  assert.equal(brain.clearAllConversations(), false);
  assert.deepEqual(brain.getSnapshot().messages, []);
  assert.deepEqual(brain.getHistory(), []);
});

test('an archived dispatched task still records its later completion', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const task = brain.submit({
    requestId: 'archived-run',
    text: 'Run the tests',
    availableAgents: ['codex'],
    now: 100,
  });
  brain.bindSession(task.taskId, 'sess-archived', 150);
  const archived = brain.startNewConversation(200);

  assert.equal(brain.finishSession('sess-archived', 0, 300, 'All tests passed.')?.status, 'completed');
  const history = brain.getHistoryConversation(archived?.id ?? '');
  assert.equal(history?.tasks[0]?.status, 'completed');
  assert.equal(history?.messages.at(-1)?.text, 'All tests passed.');
});

test('a dispatched task can be cancelled by stable task id and receives a terminal event', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const task = brain.submit({
    requestId: 'cancel-run',
    text: 'Run a long task',
    availableAgents: ['codex'],
    now: 100,
  });
  brain.bindSession(task.taskId, 'sess-cancel', 150);

  const cancelled = brain.cancelTask(task.taskId, 200);

  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(brain.findTaskById(task.taskId)?.status, 'cancelled');
  assert.equal(brain.getSnapshot().runEvents?.at(-1)?.type, 'cancelled');
  assert.match(brain.getSnapshot().messages.at(-1)?.text ?? '', /取消|cancelled/i);
  assert.equal(brain.cancelTask(task.taskId, 300), undefined);
});
