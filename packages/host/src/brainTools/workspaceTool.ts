import type { BrainToolCall } from '@termbridge/brain';
import {
  cleanToolText,
  countNames,
  dateTimestamp,
  inlineArgument,
  isViewItem,
  MAX_RECENT_TASKS,
  MAX_TOOL_TEXT_CHARS,
  MAX_VIEW_ITEMS,
  numberArgument,
  numberTimestamp,
  objectArray,
  objectValue,
  preferredRecordName,
  registerControlTool,
  resultCount,
  sessionSource,
  stringArgument,
  takeIfDifferent,
  viewText,
  type ControlToolRegistration,
  type VoiceToolResult,
  type VoiceToolView,
  type VoiceToolViewItem,
} from './types.js';

const WORKSPACE_VIEWS = ['overview', 'recent', 'tasks', 'agent', 'messages'] as const;
type WorkspaceView = typeof WORKSPACE_VIEWS[number];

export const INSPECT_WORKSPACE_TOOL: ControlToolRegistration = registerControlTool({
  name: 'inspect_workspace',
  readOnly: true,
  description: 'Read authoritative live TermBridge and Herdr state. Select messages for who the user directly messaged and what they sent (read only, never resend); overview for the current Agent roster; recent for completion events; tasks for Global outcomes; agent for one exact session (includes structured transcript turns when available). Message contents are addressed to their recorded recipients, not to the Global assistant.',
  parameters: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: [...WORKSPACE_VIEWS],
        description: 'The workspace view to read.',
      },
      target: {
        type: 'string',
        description: 'Required exact session id for agent; optional task/request/session filter for tasks, or recipient session filter for messages.',
      },
      limit: { type: 'number', description: 'Optional recent completion count, from 1 to 10.' },
    },
    required: ['view'],
    additionalProperties: false,
  },
}, { label: 'Workspace', category: 'context', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    const view = workspaceViewArgument(call);
    const observedAt = environment.now();
    if (view === 'messages') {
      const target = stringArgument(call, 'target', false);
      const events = environment.recentUserMessages?.() ?? [];
      const limit = Math.max(1, Math.min(10, numberArgument(call, 'limit') ?? 5));
      const messages = [...events].filter(m => !target || m.sessionId === target).sort((a, b) => b.sentAt - a.sentAt).slice(0, limit).map(m => ({
        sender: 'user', channel: 'direct_agent', contentIsInstructionForGlobal: false,
        recipient: { kind: 'terminal_agent', sessionId: m.sessionId, name: m.name || m.workspace || m.agent || m.command,
          source: m.source, workspace: m.workspace },
        text: cleanToolText(m.text, 2000), sentAt: new Date(m.sentAt).toISOString(),
        status: 'recorded', note: 'Submission recorded; not proof of delivery acknowledgement or task completion',
      }));
      return { ok: true, view, observedAt: new Date(observedAt).toISOString(), count: messages.length, messages,
        coverage: 'Only captured direct user-to-Agent submissions; absence is unknown, not proof no message was sent.' };
    }
    if (view === 'overview') {
      await environment.refreshAgents();
      const records = environment.listAgents();
      const names = records.map(preferredRecordName);
      const nameCounts = countNames(names);
      const agents = records.map((record, index) => ({
        sessionId: record.sessionId,
        source: record.source,
        name: names[index],
        sameNameCount: nameCounts.get(names[index]) || 1,
        workspace: record.workspace,
        agent: record.agent || record.command,
        status: record.status,
        present: record.present,
        lastSeenAt: new Date(record.lastSeenAt).toISOString(),
        completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : undefined,
        completionAgeSeconds: record.completedAt
          ? Math.max(0, Math.floor((observedAt - record.completedAt) / 1_000))
          : undefined,
        task: cleanToolText(record.preview || record.history.at(-1)?.summary || '', 600) || undefined,
        preview: cleanToolText(record.preview || record.history.at(-1)?.summary || '', 600) || undefined,
      }));
      return {
        ok: true,
        view,
        observedAt: new Date(observedAt).toISOString(),
        count: agents.length,
        agents,
        agentRegistry: environment.listAgentProfiles(),
      };
    }
    if (view === 'recent') {
      await environment.refreshAgents();
      const requested = numberArgument(call, 'limit');
      const limit = Math.max(1, Math.min(10, requested ?? 5));
      const completions = environment.recentCompletions().slice(0, limit).map((completion) => ({
        ...completion,
        completedAt: new Date(completion.completedAt).toISOString(),
        ageSeconds: Math.max(0, Math.floor((observedAt - completion.completedAt) / 1_000)),
        summary: cleanToolText(completion.summary, 1_000),
      }));
      return { ok: true, view, observedAt: new Date(observedAt).toISOString(), count: completions.length, completions };
    }
    if (view === 'tasks') {
      const target = stringArgument(call, 'target', false);
      const all = environment.listTasks();
      const tasks = target
        ? all.filter((task) => (
          task.taskId === target || task.requestId === target || task.sessionId === target
        ))
        : [...all].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_RECENT_TASKS);
      return { ok: true, view, observedAt: new Date(observedAt).toISOString(), count: tasks.length, tasks };
    }
    const target = stringArgument(call, 'target');
    await environment.refreshAgents();
    const record = environment.listAgents().find((candidate) => candidate.sessionId === target);
    if (!record) return { ok: false, view, error: `Agent session ${target} is not available` };
    const transcript = await environment.readAgentTranscript?.(target).catch(() => undefined);
    return {
      ok: true,
      view,
      observedAt: new Date(observedAt).toISOString(),
      agent: {
        sessionId: record.sessionId,
        source: record.source,
        name: preferredRecordName(record),
        workspace: record.workspace,
        agent: record.agent || record.command,
        status: record.status,
        preview: record.preview,
        ...(transcript ? { structuredTranscript: transcript } : {}),
        context: cleanToolText(record.context || '', MAX_TOOL_TEXT_CHARS),
        history: record.history,
      },
    };
  },
  progress: {
    started: (call) => workspaceProgressStarted(workspaceViewArgument(call, false)),
    completed: (call, result) => workspaceProgressCompleted(
      workspaceViewResult(result) || workspaceViewArgument(call, false),
      result,
    ),
    failed: '读取工作区状态失败',
  },
  ui: (call, result) => workspaceToolView(
    workspaceViewResult(result) || workspaceViewArgument(call, false),
    result,
  ),
});

function workspaceViewArgument(call: BrainToolCall): WorkspaceView;
function workspaceViewArgument(call: BrainToolCall, required: false): WorkspaceView | undefined;
function workspaceViewArgument(call: BrainToolCall, required = true): WorkspaceView | undefined {
  const value = stringArgument(call, 'view', required);
  if (WORKSPACE_VIEWS.includes(value as WorkspaceView)) return value as WorkspaceView;
  if (required) throw new Error('view must be overview, recent, tasks, agent, or messages');
  return undefined;
}

function workspaceViewResult(result: VoiceToolResult): WorkspaceView | undefined {
  const value = result.view;
  return typeof value === 'string' && WORKSPACE_VIEWS.includes(value as WorkspaceView)
    ? value as WorkspaceView
    : undefined;
}

function workspaceProgressStarted(view: WorkspaceView | undefined): string {
  switch (view) {
    case 'overview': return '正在刷新 Agent 列表…';
    case 'recent': return '正在读取最近完成的 Agent…';
    case 'tasks': return '正在核对任务状态…';
    case 'messages': return '正在核对消息收件人与原文…';
    case 'agent': return '正在读取 Agent 上下文…';
    default: return '正在读取工作区状态…';
  }
}

function workspaceProgressCompleted(view: WorkspaceView | undefined, result: VoiceToolResult): string {
  switch (view) {
    case 'overview': return `已刷新 ${resultCount(result)} 个 Agent`;
    case 'recent': return `已读取 ${resultCount(result)} 条最近完成记录`;
    case 'tasks': return `已核对 ${resultCount(result)} 个任务`;
    case 'messages': return `已核对 ${resultCount(result)} 条消息记录`;
    case 'agent': {
      const name = inlineArgument(objectValue(result.agent)?.name);
      return name ? `已读取 ${name} 的上下文` : '已读取 Agent 上下文';
    }
    default: return '已读取工作区状态';
  }
}

function workspaceToolView(
  view: WorkspaceView | undefined,
  result: VoiceToolResult,
): VoiceToolView | undefined {
  switch (view) {
    case 'messages': return {
      kind: 'agent_list', title: '消息收件人与原文',
      items: objectArray(result.messages).slice(0, MAX_VIEW_ITEMS).flatMap(message => {
        const recipient = objectValue(message.recipient);
        const item = agentViewItem(recipient);
        if (!item) return [];
        return [{ ...item, id: `${item.id}:${message.sentAt}`.slice(0, 128),
          subtitle: '你 → 此 Agent · 历史记录，未重新发送', detail: viewText(message.text, 600),
          timestamp: typeof message.sentAt === 'string' ? Date.parse(message.sentAt) : undefined }];
      }),
    };
    case 'overview': return {
      kind: 'agent_list',
      title: 'Agents',
      items: objectArray(result.agents).slice(0, MAX_VIEW_ITEMS).map(agentViewItem).filter(isViewItem),
    };
    case 'recent': return {
      kind: 'completion_list',
      title: 'Recently completed',
      items: objectArray(result.completions).slice(0, MAX_VIEW_ITEMS).map(completionViewItem).filter(isViewItem),
    };
    case 'tasks': return {
      kind: 'task_list',
      title: 'Task status',
      items: objectArray(result.tasks).slice(0, MAX_VIEW_ITEMS).map(taskViewItem).filter(isViewItem),
    };
    case 'agent': {
      const item = agentViewItem(objectValue(result.agent));
      return item ? { kind: 'agent', title: 'Agent details', items: [item] } : undefined;
    }
    default: return undefined;
  }
}

function agentViewItem(agent: Record<string, unknown> | undefined): VoiceToolViewItem | undefined {
  if (!agent) return undefined;
  const sessionId = viewText(agent.sessionId, 128);
  if (!sessionId) return undefined;
  const workspace = viewText(agent.workspace, 160);
  const name = viewText(agent.name, 160);
  const agentName = viewText(agent.agent, 100);
  const source = sessionSource(agent.source, sessionId);
  const subtitle = [takeIfDifferent(workspace, name), takeIfDifferent(agentName, name)].filter(Boolean).join(' · ');
  const detail = viewText(agent.task, 600) || viewText(agent.preview, 600);
  const status = viewText(agent.status, 64);
  return {
    id: sessionId,
    title: name || workspace || agentName || sessionId,
    ...(subtitle ? { subtitle } : {}),
    ...(detail ? { detail } : {}),
    ...(status ? { status } : {}),
    sessionId,
    ...(source ? { source } : {}),
  };
}

function completionViewItem(completion: Record<string, unknown>): VoiceToolViewItem | undefined {
  const sessionId = viewText(completion.sessionId, 128);
  if (!sessionId) return undefined;
  const workspace = viewText(completion.workspace, 160);
  const name = viewText(completion.name, 160) || workspace;
  const agentName = viewText(completion.agent, 100);
  const subtitle = [takeIfDifferent(workspace, name), takeIfDifferent(agentName, name)].filter(Boolean).join(' · ');
  const detail = viewText(completion.summary, 600);
  const status = viewText(completion.currentStatus, 64);
  const timestamp = dateTimestamp(completion.completedAt);
  const source = sessionSource(completion.source, sessionId);
  return {
    id: `${sessionId}:${timestamp || 'completion'}`.slice(0, 128),
    title: name || workspace || agentName || sessionId,
    ...(subtitle ? { subtitle } : {}),
    ...(detail ? { detail } : {}),
    ...(status ? { status } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    sessionId,
    ...(source ? { source } : {}),
  };
}

function taskViewItem(task: Record<string, unknown>): VoiceToolViewItem | undefined {
  const id = viewText(task.taskId, 128) || viewText(task.requestId, 128);
  const title = viewText(task.text, 160);
  if (!id || !title) return undefined;
  const agent = viewText(task.agent, 100);
  const sessionId = viewText(task.sessionId, 128);
  const detail = viewText(task.error, 600);
  const status = viewText(task.status, 64);
  const timestamp = numberTimestamp(task.updatedAt);
  const source = sessionId ? sessionSource(undefined, sessionId) : undefined;
  return {
    id,
    title,
    ...(agent ? { subtitle: agent } : {}),
    ...(detail ? { detail } : {}),
    ...(status ? { status } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(source ? { source } : {}),
  };
}
