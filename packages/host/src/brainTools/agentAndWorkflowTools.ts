import {
  inlineArgument,
  MAX_TOOL_TEXT_CHARS,
  registerControlTool,
  sessionSource,
  stringArgument,
  viewText,
  type ControlToolRegistration,
} from './types.js';

export const COMPLETION_REVIEWS_TOOL: ControlToolRegistration = registerControlTool({
  name: 'completion_reviews',
  readOnly: true,
  description: 'Read completion routing and independent evidence-review receipts, stable completion IDs, missing evidence and user decisions. Reported completion is not verified success. Cancel a pending review with cancel_execution. Only explicit client UI confirmation can dispatch a terminal reviewer; this tool cannot approve it.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}, { label: 'Completion reviews', category: 'agent', execution: 'direct', approval: 'none' }, {
  async execute(environment) { return environment.completionReviews?.() ?? { ok: false, error: 'Completion reviews unavailable' }; },
  progress: { started: () => '正在查询校验结果…', completed: () => '校验结果已返回', failed: '校验结果不可用' },
});

export const TOOL_SCRIPT_TOOL: ControlToolRegistration = registerControlTool({
  name: 'tool_script',
  readOnly: false,
  description: 'List/show reusable tool workflows, save a draft, or run an exact locally reviewed digest. Scripts call existing tools with their normal permissions. Cannot approve scripts or run arbitrary code. Pending means dispatched/awaiting approval, not completed work.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'show', 'save', 'run'] },
    offset: { type: 'integer', minimum: 0, description: 'Optional catalog offset for list; follow nextOffset for more. show retrieves the full input schema.' },
    id: { type: 'string' }, digest: { type: 'string' },
    inputs: { type: 'object', description: 'Typed workflow input values' },
    script: { type: 'object', description: 'Draft JSON: formatVersion:1, id, version, description, inputs:{name:{type,description}}, steps:[{id,tool,arguments}]. References: {"$input":"name"} or {"$result":"earlier_step","path":["field"]}. No shell, loops or nested tool_script.' },
  }, required: ['action'], additionalProperties: false },
}, { label: 'Saved workflows', category: 'agent', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    if (!environment.toolScript) return { ok: false, error: 'Tool scripts unavailable on this Host', retryable: false };
    return environment.toolScript(call.arguments, call.callId);
  },
  progress: {
    started: () => '正在处理工具脚本…',
    completed: (_call, result) => `工具脚本：${viewText(result.status, 64) || '已读取'}`,
    failed: '工具脚本未完成',
  },
  ui: (call, result) => ({ kind: 'receipt', title: '工具脚本', items: [{
    id: viewText(result.runId, 128) || call.callId,
    title: viewText(result.scriptId, 64) || viewText(result.id, 64) || '工具脚本',
    status: viewText(result.status, 64) || 'completed',
    subtitle: viewText(result.runId, 128),
  }] }),
});

export const CANCEL_EXECUTION_TOOL: ControlToolRegistration = registerControlTool({
  name: 'cancel_execution',
  readOnly: false,
  description: 'Stop one running TermBridge execution by its exact taskId, actionId, runId, or sessionId. Use when the user says stop, cancel, abort, or no longer wants the currently running action. Prefer the most recent matching running id from context; never pretend a completed native mutation was undone.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Exact running taskId, phone actionId, runId, or sessionId shown by a previous tool result or workspace task.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
}, { label: 'Cancel execution', category: 'agent', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    return environment.cancelExecution(stringArgument(call, 'id'));
  },
  progress: {
    started: () => '正在终止任务…',
    completed: (_call, result) => inlineArgument(result.summary) || '任务已终止',
    failed: '终止任务失败',
  },
  ui: (call, result) => {
    const id = viewText(result.id, 128) || viewText(call.arguments.id, 128);
    if (!id) return undefined;
    return {
      kind: 'receipt',
      title: 'Execution stopped',
      items: [{
        id,
        title: viewText(result.kind, 80) || 'Execution',
        status: viewText(result.status, 64) || 'cancelled',
        ...(viewText(result.sessionId, 128) ? { sessionId: viewText(result.sessionId, 128) } : {}),
      }],
    };
  },
});

export const CONTINUE_AGENT_TOOL: ControlToolRegistration = registerControlTool({
  name: 'continue_agent',
  readOnly: false,
  description: 'Send a follow-up instruction to an already running TermBridge or Herdr Agent session.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Exact session id returned by inspect_workspace.' },
      text: { type: 'string', description: 'Instruction to send to that Agent.' },
      reason: { type: 'string', description: 'Brief reason this existing Agent is the correct target.' },
      confidence: { type: 'number', description: 'Routing confidence from 0 to 1.' },
    },
    required: ['sessionId', 'text'],
    additionalProperties: false,
  },
}, { label: 'Continue Agent', category: 'agent', execution: 'worker', approval: 'none' }, {
  async execute(environment, call) {
    const sessionId = stringArgument(call, 'sessionId');
    const text = stringArgument(call, 'text');
    if (text.length > MAX_TOOL_TEXT_CHARS) throw new Error('The follow-up instruction is too large');
    await environment.refreshAgents();
    return environment.continueAgent(sessionId, text);
  },
  progress: {
    started: () => '正在发送继续指令…',
    completed: (_call, result) => {
      const name = inlineArgument(result.name);
      return name ? `继续指令已发送给 ${name}` : '继续指令已发送';
    },
    failed: '发送继续指令失败',
  },
  ui: (call, result) => {
    const sessionId = viewText(result.sessionId, 128) || viewText(call.arguments.sessionId, 128);
    if (!sessionId) return undefined;
    const source = sessionSource(result.source, sessionId);
    const name = viewText(result.name, 160) || 'Agent';
    return {
      kind: 'receipt',
      title: 'Command sent',
      items: [{
        id: sessionId,
        title: name,
        status: viewText(result.status, 64) || 'sent',
        sessionId,
        ...(source ? { source } : {}),
      }],
    };
  },
});

export const DISPATCH_AGENT_TOOL: ControlToolRegistration = registerControlTool({
  name: 'dispatch_agent',
  readOnly: false,
  description: 'Create a new task with a configured worker Agent (such as agy, codex, or claude). Use this instead of claiming execution work was performed in the conversation model.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Complete standalone task for the local worker.' },
      agent: { type: 'string', description: 'Optional configured Agent preset such as agy, codex, or claude.' },
      reason: { type: 'string', description: 'Brief reason this Agent profile is the correct target.' },
      confidence: { type: 'number', description: 'Routing confidence from 0 to 1.' },
    },
    required: ['task'],
    additionalProperties: false,
  },
}, { label: 'Dispatch Agent', category: 'agent', execution: 'worker', approval: 'none' }, {
  async execute(environment, call) {
    const task = stringArgument(call, 'task');
    const agent = stringArgument(call, 'agent', false);
    if (task.length > MAX_TOOL_TEXT_CHARS) throw new Error('The Agent task is too large');
    return environment.dispatchAgent(task, agent, call.callId);
  },
  progress: {
    started: () => '正在派发新的 Agent 任务…',
    completed: (_call, result) => {
      const target = inlineArgument(result.agent) || inlineArgument(result.sessionId);
      return target ? `任务已派发给 ${target}` : 'Agent 任务已派发';
    },
    failed: '派发 Agent 任务失败',
  },
  ui: (_call, result) => {
    const id = viewText(result.taskId, 128) || viewText(result.requestId, 128);
    if (!id) return undefined;
    const agent = viewText(result.agent, 160) || 'Agent';
    return {
      kind: 'receipt',
      title: 'Task dispatched',
      items: [{ id, title: agent, subtitle: id, status: viewText(result.status, 64) || 'dispatched' }],
    };
  },
});
