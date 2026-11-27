import assert from 'node:assert/strict';
import test from 'node:test';
import { HomeActions } from './homeActions.js';
import {
  createVoiceToolView,
  createVoiceToolHandler,
  finishVoiceToolProgress,
  GLOBAL_BRAIN_TOOL_CATALOG,
  startVoiceToolProgress,
  VOICE_BRAIN_TOOL_REGISTRATIONS,
  VOICE_BRAIN_TOOLS,
  type VoiceToolEnvironment,
} from './voiceTools.js';

test('voice tools register optional native UI beside their execution behavior', () => {
  const inspectWorkspace = VOICE_BRAIN_TOOL_REGISTRATIONS.find(
    ({ definition }) => definition.name === 'inspect_workspace',
  );
  assert.equal(typeof inspectWorkspace?.ui, 'function');
  assert.equal('ui' in VOICE_BRAIN_TOOLS[0], false);
  assert.deepEqual(
    GLOBAL_BRAIN_TOOL_CATALOG.map(({ name, category, execution }) => ({ name, category, execution })),
    [
      { name: 'completion_reviews', category: 'agent', execution: 'direct' },
      { name: 'tool_script', category: 'agent', execution: 'direct' },
      { name: 'inspect_images', category: 'context', execution: 'direct' },
      { name: 'inspect_workspace', category: 'context', execution: 'direct' },
      { name: 'search_web', category: 'web', execution: 'direct' },
      { name: 'workspace_files', category: 'files', execution: 'direct' },
      { name: 'brain_memory', category: 'context', execution: 'direct' },
      { name: 'phone_action', category: 'device', execution: 'direct' },
      { name: 'home_assistant', category: 'device', execution: 'direct' },
      { name: 'cancel_execution', category: 'agent', execution: 'direct' },
      { name: 'continue_agent', category: 'agent', execution: 'worker' },
      { name: 'dispatch_agent', category: 'agent', execution: 'worker' },
    ],
  );
});

test('inspect_images runs through the shared harness and returns a native receipt', async () => {
  const call = { callId: 'image-read', name: 'inspect_images', arguments: { question: '这是什么？', assetIds: ['image-1'] } };
  const output = await createVoiceToolHandler(environment())(call);
  const result = JSON.parse(output);
  assert.equal(result.status, 'completed');
  assert.equal(result.question, '这是什么？');
  assert.deepEqual(result.assetIds, ['image-1']);
  assert.equal(createVoiceToolView(call, output)?.kind, 'receipt');
  assert.equal(finishVoiceToolProgress(call, output).phase, 'completed');
});

function environment(): VoiceToolEnvironment {
  return {
    now: () => 60_003,
    refreshAgents: async () => undefined,
    recentCompletions: () => [{
      sessionId: 'herdr:w1:p1', source: 'herdr', name: 'TermBridge', workspace: 'termbridge', agent: 'codex',
      command: 'codex', completedAt: 3, currentStatus: 'working', summary: '上一轮已经安装完成',
    }],
    listAgents: () => [{
      sessionId: 'herdr:w1:p1',
      source: 'herdr',
      name: 'TermBridge',
      workspace: 'termbridge',
      command: 'codex',
      agent: 'codex',
      status: 'working',
      preview: '正在修复语音链路',
      context: '完整执行上下文',
      firstSeenAt: 1,
      lastSeenAt: 2,
      statusChangedAt: 1,
      present: true,
      history: [],
    }],
    listAgentProfiles: () => [{
      agentId: 'codex',
      name: 'Codex',
      runtime: 'codex',
      purpose: 'Implement and review software changes.',
      capabilities: ['coding', 'terminal', 'files'],
    }],
    listTasks: () => [{
      taskId: 'task-1', requestId: 'request-1', sessionId: 'herdr:w1:p1', text: '修复语音',
      agent: 'codex', status: 'dispatched', createdAt: 1, updatedAt: 2,
    }],
    searchWeb: async (query) => ({
      ok: true,
      text: `搜索结果：${query}`,
      sources: [{ title: 'TermBridge', url: 'https://example.test/termbridge' }],
    }),
    workspaceFiles: async (action, path) => action === 'list'
      ? { ok: true, action, path, entries: [{ name: 'termbridge', type: 'directory' }] }
      : { ok: true, action, path, text: '# TermBridge', truncated: false },
    phoneAction: async (request) => ({
      ok: true,
      actionId: 'phone-action-1',
      action: request.action,
      state: 'awaiting_user',
      summary: request.action === 'photo.edit' ? '请选择照片' : '请在手机上确认',
    }),
    inspectImages: async (question, assetIds) => ({ ok: true, question, assetIds, text: '图片内容', status: 'completed' }),
    dispatchAgent: async (task, agent) => ({ ok: true, task, agent }),
    homeAssistant: async () => ({ ok: false, code: 'not_configured', retryable: false }),
    continueAgent: async (sessionId, text) => ({ ok: true, sessionId, text }),
    cancelExecution: async (id) => ({ ok: true, id, kind: 'worker_task', status: 'cancelled' }),
  };
}

test('HA tool uses the shared text/voice result and receipt UI, with execution-side policy', async () => {
  let calls = 0;
  const service = new HomeActions({
    enabled: true, baseUrl: 'http://127.0.0.1:8123',
    entities: [{ entityId: 'light.study', name: '书房灯', purpose: '只读状态' }],
  }, { TB_HA_TOKEN: 'mock-ha-token' }, async () => {
    calls++;
    return Response.json({ entity_id: 'light.study', state: 'off' });
  });
  const handle = createVoiceToolHandler({ ...environment(), homeAssistant: (args) => service.execute(args) });
  const call = { callId: 'ha-read-1', name: 'home_assistant', arguments: { action: 'state', entityId: 'light.study' } };
  const output = await handle(call);
  assert.equal(JSON.parse(output).ok, true);
  assert.equal(finishVoiceToolProgress(call, output).phase, 'completed');
  assert.deepEqual(createVoiceToolView(call, output), {
    kind: 'receipt', title: 'Home Assistant', items: [{ id: 'light.study', title: '书房灯', subtitle: 'off' }],
  });
  const denied = JSON.parse(await handle({ ...call, arguments: { ...call.arguments, approved: true } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.retryable, false);
  assert.equal(calls, 1);
});

test('voice Brain exposes one deep workspace reader plus explicit mutation tools', async () => {
  assert.deepEqual(VOICE_BRAIN_TOOLS.map((tool) => tool.name), [
    'completion_reviews',
    'tool_script',
    'inspect_images', 'inspect_workspace', 'search_web', 'workspace_files', 'brain_memory', 'phone_action', 'home_assistant', 'cancel_execution', 'continue_agent', 'dispatch_agent',
  ]);
  const handle = createVoiceToolHandler(environment());
  const roster = JSON.parse(await handle({
    callId: '1', name: 'inspect_workspace', arguments: { view: 'overview' },
  }));
  assert.equal(roster.view, 'overview');
  assert.equal(roster.count, 1);
  assert.equal(roster.agents[0].name, 'TermBridge');
  assert.equal(roster.agents[0].sameNameCount, 1);
  assert.equal(roster.agents[0].task, '正在修复语音链路');
  assert.equal(roster.agents[0].status, 'working');
  assert.equal(roster.agentRegistry[0].purpose, 'Implement and review software changes.');
  const recent = JSON.parse(await handle({
    callId: 'recent', name: 'inspect_workspace', arguments: { view: 'recent', limit: 1 },
  }));
  assert.equal(recent.view, 'recent');
  assert.equal(recent.observedAt, '1970-01-01T00:01:00.003Z');
  assert.equal(recent.completions[0].ageSeconds, 60);
  assert.equal(recent.completions[0].summary, '上一轮已经安装完成');
  const task = JSON.parse(await handle({
    callId: '2', name: 'inspect_workspace', arguments: { view: 'tasks', target: 'task-1' },
  }));
  assert.equal(task.view, 'tasks');
  assert.equal(task.tasks[0].requestId, 'request-1');
  const context = JSON.parse(await handle({
    callId: '3', name: 'inspect_workspace', arguments: { view: 'agent', target: 'herdr:w1:p1' },
  }));
  assert.equal(context.view, 'agent');
  assert.equal(context.agent.context, '完整执行上下文');
  const search = JSON.parse(await handle({
    callId: 'search', name: 'search_web', arguments: { query: 'TermBridge latest release' },
  }));
  assert.equal(search.text, '搜索结果：TermBridge latest release');
  assert.equal(search.sources[0].url, 'https://example.test/termbridge');
  const files = JSON.parse(await handle({
    callId: 'files', name: 'workspace_files', arguments: { action: 'read', path: '@memory' },
  }));
  assert.equal(files.text, '# TermBridge');
  const phone = JSON.parse(await handle({
    callId: 'phone',
    name: 'phone_action',
    arguments: { action: 'photo.edit', instructions: '统一调色', maxItems: 6 },
  }));
  assert.equal(phone.state, 'awaiting_user');
  assert.equal(phone.action, 'photo.edit');
  const cancelled = JSON.parse(await handle({
    callId: 'cancel', name: 'cancel_execution', arguments: { id: 'task-1' },
  }));
  assert.equal(cancelled.id, 'task-1');
  assert.equal(cancelled.status, 'cancelled');
  const continued = JSON.parse(await handle({
    callId: '4', name: 'continue_agent', arguments: { sessionId: 'herdr:w1:p1', text: '继续测试' },
  }));
  assert.equal(continued.text, '继续测试');
  const dispatched = JSON.parse(await handle({
    callId: '5', name: 'dispatch_agent', arguments: { task: '运行测试', agent: 'codex' },
  }));
  assert.equal(dispatched.agent, 'codex');
});

test('message history is a read-only addressed event view, not an instruction or dispatch', async () => {
  const env = environment();
  let sends = 0;
  env.continueAgent = async () => { sends++; return { ok: true }; };
  env.recentUserMessages = () => [{ sessionId: 'fixture-canvas', source: 'pty', name: 'canvas-rendering',
    command: 'codex', text: '不要再问，直接做', sentAt: 1000 }];
  const output = JSON.parse(await createVoiceToolHandler(env)({ callId: 'message-query', name: 'inspect_workspace', arguments: { view: 'messages' } }));
  assert.equal(output.ok, true);
  assert.equal(output.messages[0].recipient.sessionId, 'fixture-canvas');
  assert.equal(output.messages[0].contentIsInstructionForGlobal, false);
  assert.equal(output.messages[0].sender, 'user');
  assert.equal(output.messages[0].text, '不要再问，直接做');
  assert.equal(sends, 0);
});

test('phone action exposes a multi-photo native authorization card', async () => {
  const call = {
    callId: 'phone-photo',
    name: 'phone_action',
    arguments: { action: 'photo.edit', instructions: '统一调色', maxItems: 8 },
  };
  const output = await createVoiceToolHandler(environment())(call);
  assert.deepEqual(startVoiceToolProgress(call), {
    phase: 'started',
    summary: '正在等待你在手机上选择照片…',
  });
  assert.equal(createVoiceToolView(call, output)?.items[0]?.status, 'awaiting_user');
});

test('calendar list serializes MessagePack bigint ids and timestamps without losing fields', async () => {
  const tools = environment();
  tools.phoneAction = async () => ({
    ok: true,
    actionId: 'phone-calendar-list',
    action: 'calendar.list',
    state: 'completed',
    summary: '已读取 1 个日历事件',
    events: [{
      eventId: 9_007_199_254_740_993n,
      title: '测试日程',
      startsAt: 1_725_399_944_000n,
      endsAt: 1_725_403_544_000n,
    }],
  });

  const output = await createVoiceToolHandler(tools)({
    callId: 'calendar-list-bigint',
    name: 'phone_action',
    arguments: {
      action: 'calendar.list',
      startsAt: '2024-09-04T00:00:00+08:00',
      endsAt: '2024-09-05T00:00:00+08:00',
    },
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, true);
  assert.deepEqual(result.events[0], {
    eventId: '9007199254740993',
    title: '测试日程',
    startsAt: 1_725_399_944_000,
    endsAt: 1_725_403_544_000,
  });
});

test('phone action schema tells the model the calendar contract without requiring an end time from the user', () => {
  const phone = VOICE_BRAIN_TOOLS.find((tool) => tool.name === 'phone_action');
  assert.ok(phone);
  assert.match(phone.description, /calendar\.create requires title and startsAt/i);
  assert.match(phone.description, /call it instead of claiming the action is running/i);
  const properties = phone.parameters.properties as Record<string, { description?: string; maximum?: number }>;
  assert.match(properties.endsAt?.description || '', /optional.*defaults to 30 minutes/i);
  assert.match(properties.durationMinutes?.description || '', /calendar\.create duration/i);
  assert.equal(properties.maxItems?.maximum, 3);
  assert.match(phone.description, /photo\.count returns only an aggregate/i);
  assert.match(phone.description, /photo\.fetch grants at most three/i);
});

test('workspace files validates one small read-only interface', async () => {
  const handle = createVoiceToolHandler(environment());
  const invalidAction = JSON.parse(await handle({
    callId: '1', name: 'workspace_files', arguments: { action: 'write', path: 'README.md' },
  }));
  assert.equal(invalidAction.ok, false);
  const missingPath = JSON.parse(await handle({
    callId: '2', name: 'workspace_files', arguments: { action: 'read' },
  }));
  assert.equal(missingPath.ok, false);
});

test('voice Brain rejects unavailable sessions and oversized instructions', async () => {
  const handle = createVoiceToolHandler(environment());
  const unavailable = JSON.parse(await handle({
    callId: '1', name: 'inspect_workspace', arguments: { view: 'agent', target: 'missing' },
  }));
  assert.equal(unavailable.ok, false);
  const oversized = JSON.parse(await handle({
    callId: '2', name: 'continue_agent', arguments: { sessionId: 'herdr:w1:p1', text: 'x'.repeat(16_001) },
  }));
  assert.equal(oversized.ok, false);
});

test('voice tool progress exposes a useful started and completed process without raw payloads', () => {
  const call = { callId: 'recent', name: 'inspect_workspace', arguments: { view: 'recent' } };
  assert.deepEqual(startVoiceToolProgress(call), {
    phase: 'started',
    summary: '正在读取最近完成的 Agent…',
  });
  assert.deepEqual(finishVoiceToolProgress(call, JSON.stringify({ ok: true, count: 2, completions: [] })), {
    phase: 'completed',
    summary: '已读取 2 条最近完成记录',
  });
  assert.deepEqual(finishVoiceToolProgress(call, JSON.stringify({ ok: false, error: 'private detail' })), {
    phase: 'failed',
    summary: '读取工作区状态失败',
  });
});

test('web search progress reports its long-running phase and bounded source count', () => {
  const call = { callId: 'search', name: 'search_web', arguments: { query: 'latest docs' } };
  assert.deepEqual(startVoiceToolProgress(call), {
    phase: 'started',
    summary: '正在搜索网页…',
  });
  assert.deepEqual(finishVoiceToolProgress(call, JSON.stringify({
    ok: true,
    text: 'result',
    sources: [{ url: 'https://example.test/one' }, { url: 'https://example.test/two' }],
  })), {
    phase: 'completed',
    summary: '搜索完成，找到 2 个来源',
  });
});

test('voice tool results become bounded native Agent cards with stable navigation ids', () => {
  const agents = createVoiceToolView(
    { callId: 'agents', name: 'inspect_workspace', arguments: { view: 'overview' } },
    JSON.stringify({
      ok: true,
      view: 'overview',
      agents: Array.from({ length: 12 }, (_, index) => ({
        sessionId: `herdr:w${index}:p1`,
        source: 'herdr',
        name: index < 2 ? 'TermBridge' : `Agent ${index}`,
        workspace: index === 0 ? 'termbridge' : `workspace-${index}`,
        agent: 'codex',
        status: index === 0 ? 'working' : 'done',
        preview: index === 0 ? '正在实现 Voice 工具卡片' : `result-${index}`,
      })),
    }),
  );

  assert.equal(agents?.kind, 'agent_list');
  assert.equal(agents?.items.length, 8);
  assert.deepEqual(agents?.items[0], {
    id: 'herdr:w0:p1',
    title: 'TermBridge',
    subtitle: 'codex',
    detail: '正在实现 Voice 工具卡片',
    status: 'working',
    sessionId: 'herdr:w0:p1',
    source: 'herdr',
  });
  assert.doesNotMatch(agents?.items[0]?.subtitle || '', /herdr:/);
});

test('recent completions and task tools become displayable cards without arbitrary tool payloads', () => {
  const completions = createVoiceToolView(
    { callId: 'recent', name: 'inspect_workspace', arguments: { view: 'recent' } },
    JSON.stringify({
      ok: true,
      view: 'recent',
      completions: [{
        sessionId: 'herdr:w9:p1', source: 'herdr', workspace: 'phone-brain', agent: 'codex',
        currentStatus: 'working', completedAt: '2026-08-29T03:12:00.000Z', summary: '安装完成',
      }],
    }),
  );
  assert.equal(completions?.kind, 'completion_list');
  assert.equal(completions?.items[0]?.sessionId, 'herdr:w9:p1');
  assert.equal(completions?.items[0]?.timestamp, Date.parse('2026-08-29T03:12:00.000Z'));
  assert.equal(completions?.items[0]?.detail, '安装完成');

  const invalid = createVoiceToolView(
    { callId: 'bad', name: 'inspect_workspace', arguments: { view: 'agent', target: 'secret' } },
    JSON.stringify({ ok: false, error: 'private upstream payload' }),
  );
  assert.equal(invalid, undefined);
});

test('inspect workspace validates its view and exact Agent target', async () => {
  const handle = createVoiceToolHandler(environment());
  const missingView = JSON.parse(await handle({ callId: '1', name: 'inspect_workspace', arguments: {} }));
  assert.equal(missingView.ok, false);
  const unknownView = JSON.parse(await handle({
    callId: '2', name: 'inspect_workspace', arguments: { view: 'everything' },
  }));
  assert.equal(unknownView.ok, false);
  const missingTarget = JSON.parse(await handle({
    callId: '3', name: 'inspect_workspace', arguments: { view: 'agent' },
  }));
  assert.equal(missingTarget.ok, false);
});

test('shared HA control forwards Host call identity and shows acceptance rather than physical completion', async () => {
  let identity = '';
  const service = new HomeActions({
    enabled: true, baseUrl: 'http://127.0.0.1:8123',
    entities: [{ entityId: 'light.study', name: '书房灯', purpose: '照明', control: { equipment: 'light', commands: ['on'] } }],
  }, { TB_HA_TOKEN: 'fixture' }, async (_url, init) => Response.json(init?.method === 'POST' ? [] : { entity_id: 'light.study', state: 'off' }));
  const handle = createVoiceToolHandler({ ...environment(), homeAssistant: (args, callId) => {
    identity = callId;
    return service.execute(args, `request:${callId}`);
  } });
  const call = { callId: 'ha-control-1', name: 'home_assistant', arguments: { action: 'control', entityId: 'light.study', command: 'on' } };
  const output = await handle(call);
  assert.equal(identity, call.callId);
  assert.equal(JSON.parse(output).physicalVerified, false);
  assert.match(finishVoiceToolProgress(call, output).summary, /已接受.*未验收/);
  assert.deepEqual(createVoiceToolView(call, output), {
    kind: 'receipt', title: 'Home Assistant', items: [{ id: 'light.study', title: '书房灯', subtitle: '指令已接受 · 实物未验收' }],
  });
});
