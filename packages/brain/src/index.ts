import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
export { DEFAULT_GLOBAL_EXECUTION_MODEL } from './models.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type BrainDeliverable,
  type BrainRouteDecision,
  type BrainRunEvent,
  cleanDeliverable,
  cleanRouteDecision,
  cleanRunEvent,
  parseDeclaredDeliverables,
} from './controlPlane.js';
import {
  type ExecutionForkEvent,
  cleanExecutionForkEvent,
} from './executionFork.js';

export type BrainRole = 'user' | 'brain';
export type BrainTaskStatus = 'queued' | 'dispatched' | 'completed' | 'failed' | 'cancelled';

export interface BrainMessage {
  id: string;
  role: BrainRole;
  text: string;
  createdAt: number;
  taskId?: string;
  modality?: 'text' | 'voice';
  voiceStatus?: 'streaming' | 'completed' | 'interrupted';
}

export interface BrainTask {
  taskId: string;
  requestId: string;
  text: string;
  agent: string;
  status: BrainTaskStatus;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  error?: string;
}

export type BrainToolViewKind = 'agent_list' | 'completion_list' | 'task_list' | 'agent' | 'receipt';

export interface BrainToolViewItem {
  id: string;
  title: string;
  subtitle?: string;
  detail?: string;
  status?: string;
  timestamp?: number;
  sessionId?: string;
  source?: 'pty' | 'herdr';
}

export interface BrainToolView {
  kind: BrainToolViewKind;
  title: string;
  items: BrainToolViewItem[];
}

export interface BrainToolResult {
  id: string;
  requestId: string;
  callId: string;
  toolName: string;
  createdAt: number;
  view: BrainToolView;
}

export interface BrainSnapshot {
  /** Model context history; not a chat message and never rendered as a bubble. */
  systemReminders?: Array<{ id: string; requestId: string; text: string; createdAt: number }>;
  messages: BrainMessage[];
  tasks: BrainTask[];
  toolResults?: BrainToolResult[];
  routeDecisions?: BrainRouteDecision[];
  runEvents?: BrainRunEvent[];
  deliverables?: BrainDeliverable[];
  executionEvents?: ExecutionForkEvent[];
}

export interface BrainConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface BrainConversationHistory extends BrainSnapshot, BrainConversationSummary {}

interface BrainState extends BrainSnapshot {
  history: BrainConversationHistory[];
}

interface PersistedBrainState extends BrainState {
  version: 4;
}

export interface BrainStateStore {
  read(): BrainSnapshot | BrainState;
  write(snapshot: BrainState): void;
}

function cleanSnapshot(value: unknown): BrainSnapshot {
  if (!value || typeof value !== 'object') return emptySnapshot();
  const candidate = value as Partial<PersistedBrainState>;
  return {
    messages: Array.isArray(candidate.messages) ? candidate.messages : [],
    systemReminders: Array.isArray(candidate.systemReminders) ? candidate.systemReminders.filter(item =>
      item && typeof item.id === 'string' && typeof item.requestId === 'string' &&
      typeof item.text === 'string' && item.text.length <= 4000 && Number.isSafeInteger(item.createdAt)).slice(-100) : [],
    tasks: Array.isArray(candidate.tasks) ? candidate.tasks : [],
    toolResults: Array.isArray(candidate.toolResults) ? candidate.toolResults : [],
    routeDecisions: Array.isArray(candidate.routeDecisions)
      ? candidate.routeDecisions.map(cleanRouteDecision).filter(isPresent)
      : [],
    runEvents: Array.isArray(candidate.runEvents)
      ? candidate.runEvents.map(cleanRunEvent).filter(isPresent)
      : [],
    deliverables: Array.isArray(candidate.deliverables)
      ? candidate.deliverables.map(cleanDeliverable).filter(isPresent)
      : [],
    executionEvents: Array.isArray(candidate.executionEvents)
      ? candidate.executionEvents.map(cleanExecutionForkEvent).filter(isPresent)
      : [],
  };
}

function emptySnapshot(): BrainSnapshot {
  return {
    messages: [],
    tasks: [],
    toolResults: [],
    routeDecisions: [],
    runEvents: [],
    deliverables: [],
    executionEvents: [],
  };
}

function cleanState(value: unknown): BrainState {
  const snapshot = cleanSnapshot(value);
  const candidate = value && typeof value === 'object' ? value as Partial<PersistedBrainState> : {};
  const history = Array.isArray(candidate.history)
    ? candidate.history.map(cleanConversationHistory).filter((item): item is BrainConversationHistory => Boolean(item))
    : [];
  return { ...snapshot, history: history.slice(-30) };
}

function cleanConversationHistory(value: unknown): BrainConversationHistory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<BrainConversationHistory>;
  const id = compactText(candidate.id ?? '').slice(0, 128);
  const title = compactText(candidate.title ?? '').slice(0, 160);
  if (!id || !title) return undefined;
  const snapshot = cleanSnapshot(candidate);
  const createdAt = finiteTimestamp(candidate.createdAt);
  const updatedAt = Math.max(createdAt, finiteTimestamp(candidate.updatedAt));
  return {
    id,
    title,
    createdAt,
    updatedAt,
    messageCount: snapshot.messages.length,
    ...snapshot,
  };
}

export class MemoryBrainStore implements BrainStateStore {
  private state: BrainState;

  constructor(snapshot: BrainSnapshot | BrainState = emptySnapshot()) {
    this.state = cleanState(snapshot);
  }

  read(): BrainState {
    return structuredClone(this.state);
  }

  write(snapshot: BrainState): void {
    this.state = structuredClone(snapshot);
  }
}

export class JsonBrainStore implements BrainStateStore {
  constructor(private readonly path = process.env.TB_BRAIN_STATE || join(homedir(), '.termbridge', 'brain.json')) {}

  read(): BrainState {
    if (!existsSync(this.path)) return cleanState(undefined);
    try {
      return cleanState(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return cleanState(undefined);
    }
  }

  write(snapshot: BrainState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 4, ...snapshot }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export interface SubmitBrainMessage {
  requestId: string;
  text: string;
  dispatchText?: string;
  brainReply?: string;
  requestedAgent?: string;
  availableAgents: string[];
  /** The conversation layer may already have persisted this user turn. */
  recordUserMessage?: boolean;
  now?: number;
}

export interface BrainPlanner {
  chooseAgent(requestedAgent: string | undefined, availableAgents: string[]): string | undefined;
}

export class DefaultBrainPlanner implements BrainPlanner {
  chooseAgent(requestedAgent: string | undefined, availableAgents: string[]): string | undefined {
    const unique = [...new Set(availableAgents.map((name) => name.trim()).filter((name) => name && name !== 'shell'))];
    if (requestedAgent && unique.includes(requestedAgent)) return requestedAgent;
    return ['codex', 'claude'].find((name) => unique.includes(name)) || unique[0];
  }
}

export class BrainCoordinator {
  private snapshot: BrainSnapshot;
  private history: BrainConversationHistory[];

  constructor(
    private readonly store: BrainStateStore = new JsonBrainStore(),
    private readonly planner: BrainPlanner = new DefaultBrainPlanner(),
  ) {
    const state = cleanState(this.store.read());
    this.snapshot = cleanSnapshot(state);
    this.history = state.history;
    // No realtime generation survives a Host process restart. Keep the last
    // checkpoint, but don't leave its UI or reconstructed context "streaming".
    let recoveredVoice = false;
    for (const snapshot of this.snapshots()) {
      const events = snapshot.executionEvents ?? [];
      const interrupted = new Set(events.filter(event => event.workflow === 'silent').map(event => event.requestId));
      for (const requestId of interrupted) {
        if (events.some(event => event.requestId === requestId &&
          ['fork_completed', 'fork_failed', 'fork_cancelled'].includes(event.phase))) continue;
        const last = [...events].reverse().find(event => event.requestId === requestId)!;
        events.push({ ...last, eventId: `${last.forkId}:restart`.slice(0, 160),
          phase: 'fork_failed', createdAt: Date.now(), summary: 'Host restarted; retry explicitly. Dispatched workers may still be running.' });
        if (!snapshot.messages.some(message => message.id === `${requestId}-brain`)) {
          snapshot.messages.push({ id: `${requestId}-brain`, role: 'brain', createdAt: Date.now(),
            text: 'Host 已重启，本次编排中断。请先查看已派发 Agent 的状态，再决定是否重试。' });
        }
        recoveredVoice = true;
      }
      for (const message of snapshot.messages) {
        if (message.role === 'brain' && message.modality === 'voice' && message.voiceStatus === 'streaming') {
          message.voiceStatus = 'interrupted';
          recoveredVoice = true;
        }
      }
    }
    if (recoveredVoice) this.persist();
  }

  getSnapshot(): BrainSnapshot {
    return structuredClone(this.snapshot);
  }

  appendSystemReminder(requestId: string, text: string, now = Date.now()): void {
    const reminders = this.snapshot.systemReminders ??= [];
    reminders.push({ id: randomUUID(), requestId: requestId.slice(0, 128), text: text.slice(0, 4000), createdAt: now });
    this.persist();
  }

  /** Includes archived conversations so asynchronous receipts can recover after a restart. */
  getConversationToolResults(): BrainToolResult[] {
    return structuredClone(this.snapshots().flatMap((snapshot) => snapshot.toolResults ?? []));
  }

  getHistory(): BrainConversationSummary[] {
    return [...this.history].reverse().map(({ id, title, createdAt, updatedAt, messageCount }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      messageCount,
    }));
  }

  getHistoryConversation(id: string): BrainConversationHistory | undefined {
    const conversation = this.history.find((candidate) => candidate.id === id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  restoreConversation(id: string, now = Date.now()): BrainConversationSummary | undefined {
    const index = this.history.findIndex((candidate) => candidate.id === id);
    if (index < 0) return undefined;
    const restored = this.history[index];
    this.history.splice(index, 1);
    if (hasSnapshotContent(this.snapshot)) {
      this.history.push(createConversationHistory(this.snapshot, now));
    }
    this.snapshot = cleanSnapshot(restored);
    this.persist();
    const { title, createdAt, updatedAt, messageCount } = restored;
    return { id, title, createdAt, updatedAt, messageCount };
  }

  startNewConversation(now = Date.now()): BrainConversationSummary | undefined {
    if (!hasSnapshotContent(this.snapshot)) {
      this.snapshot = emptySnapshot();
      this.persist();
      return undefined;
    }
    const archived = createConversationHistory(this.snapshot, now);
    this.history.push(archived);
    this.snapshot = emptySnapshot();
    this.persist();
    const { id, title, createdAt, updatedAt, messageCount } = archived;
    return { id, title, createdAt, updatedAt, messageCount };
  }

  hasActiveTasks(): boolean {
    return this.snapshots().some((snapshot) => snapshot.tasks.some(
      (task) => task.status === 'queued' || task.status === 'dispatched',
    ));
  }

  clearAllConversations(): boolean {
    if (!hasSnapshotContent(this.snapshot) && this.history.length === 0 &&
        !this.snapshot.systemReminders?.length) return false;
    this.snapshot = emptySnapshot();
    this.history = [];
    this.persist();
    return true;
  }

  findTaskByRequestId(requestId: string): BrainTask | undefined {
    const task = this.snapshots().flatMap((snapshot) => snapshot.tasks)
      .find((candidate) => candidate.requestId === requestId);
    return task ? structuredClone(task) : undefined;
  }

  findTaskById(taskId: string): BrainTask | undefined {
    const task = this.snapshots().flatMap((snapshot) => snapshot.tasks)
      .find((candidate) => candidate.taskId === taskId);
    return task ? structuredClone(task) : undefined;
  }

  findConversationMessage(id: string): BrainMessage | undefined {
    const message = this.snapshots().flatMap((snapshot) => snapshot.messages)
      .find((candidate) => candidate.id === id);
    return message ? structuredClone(message) : undefined;
  }

  appendConversationMessage(input: {
    id: string;
    role: BrainRole;
    text: string;
    modality?: 'text' | 'voice';
    now?: number;
  }): BrainMessage | undefined {
    const text = preserveText(input.text).slice(0, 16_000);
    if (!text) return undefined;
    const existing = this.snapshot.messages.find((message) => message.id === input.id);
    if (existing) return structuredClone(existing);
    const message: BrainMessage = {
      id: input.id,
      role: input.role,
      text,
      createdAt: input.now ?? Date.now(),
      ...(input.modality ? { modality: input.modality } : {}),
    };
    this.snapshot.messages.push(message);
    this.persist();
    return structuredClone(message);
  }

  /** Only live voice drafts may be revised; terminal replies are immutable. */
  upsertVoiceReply(input: {
    id: string; text: string; voiceStatus: 'streaming' | 'completed' | 'interrupted';
  }): BrainMessage | undefined {
    const text = preserveText(input.text).slice(0, 16_000);
    if (!text) return undefined;
    const existing = this.snapshot.messages.find(message => message.id === input.id);
    if (existing && (existing.role !== 'brain' || existing.modality !== 'voice' || existing.voiceStatus !== 'streaming')) {
      return structuredClone(existing);
    }
    const message: BrainMessage = existing ?? {
      id: input.id, role: 'brain', text, modality: 'voice', createdAt: Date.now(),
    };
    message.text = text;
    message.voiceStatus = input.voiceStatus;
    if (!existing) this.snapshot.messages.push(message);
    this.persist();
    return structuredClone(message);
  }

  appendConversationToolResult(input: BrainToolResult): BrainToolResult | undefined {
    const result = cleanToolResult(input);
    if (!result) return undefined;
    const existing = this.snapshot.toolResults?.find((candidate) => candidate.id === result.id);
    if (existing) return structuredClone(existing);
    this.snapshot.toolResults = [...(this.snapshot.toolResults ?? []), result];
    this.persist();
    return structuredClone(result);
  }

  appendExecutionEvent(input: ExecutionForkEvent): ExecutionForkEvent | undefined {
    const event = cleanExecutionForkEvent(input);
    if (!event) return undefined;
    const existing = this.snapshots().flatMap((snapshot) => snapshot.executionEvents ?? [])
      .find((candidate) => candidate.eventId === event.eventId);
    if (existing) return structuredClone(existing);
    this.snapshot.executionEvents = [...(this.snapshot.executionEvents ?? []), event];
    this.persist();
    return structuredClone(event);
  }

  /** Update an asynchronous tool receipt wherever its originating conversation now lives. */
  upsertConversationToolResult(input: BrainToolResult): BrainToolResult | undefined {
    const result = cleanToolResult(input);
    if (!result) return undefined;
    for (const snapshot of this.snapshots()) {
      const index = snapshot.toolResults?.findIndex((candidate) => candidate.id === result.id) ?? -1;
      if (index < 0 || !snapshot.toolResults) continue;
      snapshot.toolResults[index] = result;
      this.persist();
      return structuredClone(result);
    }
    this.snapshot.toolResults = [...(this.snapshot.toolResults ?? []), result];
    this.persist();
    return structuredClone(result);
  }

  /** A durable asynchronous outcome belongs to the receipt's conversation, even after a switch. */
  findToolResultFollowUp(resultId: string): BrainMessage | undefined {
    return this.findConversationMessage(`tool-outcome-${createHash('sha256').update(resultId).digest('hex').slice(0, 32)}`);
  }

  appendToolResultFollowUp(resultId: string, text: string, now = Date.now()): BrainMessage | undefined {
    const snapshot = this.snapshots().find(candidate => candidate.toolResults?.some(result => result.id === resultId));
    const result = snapshot?.toolResults?.find(candidate => candidate.id === resultId);
    const body = preserveText(text).slice(0, 16_000);
    if (!snapshot || !result || !body) return undefined;
    const id = `tool-outcome-${createHash('sha256').update(resultId).digest('hex').slice(0, 32)}`;
    const existing = snapshot.messages.find(message => message.id === id);
    if (existing) return structuredClone(existing);
    const createdAt = Math.max(now, ...snapshot.messages.map(message => message.createdAt + 1));
    const message: BrainMessage = { id, role: 'brain', text: body, createdAt };
    snapshot.messages.push(message);
    // Preserve the fork lifecycle while recording the later native tool outcome.
    const previous = snapshot.executionEvents?.find(event => event.requestId === result.requestId && event.callId === result.callId);
    if (previous) snapshot.executionEvents!.push({
      eventId: id, forkId: previous.forkId, requestId: result.requestId,
      callId: result.callId, toolName: result.toolName, createdAt,
      phase: result.view.items[0]?.status === 'completed' ? 'tool_completed' : 'tool_failed',
      summary: body.slice(0, 512),
    });
    this.persist();
    return structuredClone(message);
  }

  recordRouteDecision(input: BrainRouteDecision): BrainRouteDecision | undefined {
    const decision = cleanRouteDecision(input);
    if (!decision) return undefined;
    const existing = this.snapshots().flatMap((snapshot) => snapshot.routeDecisions ?? [])
      .find((candidate) => candidate.id === decision.id);
    if (existing) return structuredClone(existing);
    this.snapshot.routeDecisions = [...(this.snapshot.routeDecisions ?? []), decision];
    this.persist();
    return structuredClone(decision);
  }

  submit(input: SubmitBrainMessage): BrainTask {
    const existing = this.snapshots().flatMap((snapshot) => snapshot.tasks)
      .find((task) => task.requestId === input.requestId);
    if (existing) return structuredClone(existing);

    const text = preserveText(input.text);
    if (!text) throw new Error('Brain message cannot be empty');
    const dispatchText = preserveText(input.dispatchText ?? input.text);
    if (!dispatchText) throw new Error('Brain dispatch cannot be empty');
    const agent = this.planner.chooseAgent(input.requestedAgent, input.availableAgents);
    if (!agent) throw new Error('No agent is configured on this host');

    const now = input.now ?? Date.now();
    const taskId = `brain-${input.requestId}`;
    const task: BrainTask = {
      taskId,
      requestId: input.requestId,
      text: dispatchText,
      agent,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    if (input.recordUserMessage !== false) {
      this.snapshot.messages.push({ id: input.requestId, role: 'user', text, createdAt: now, taskId });
    }
    const brainReply = compactText(input.brainReply ?? '');
    if (brainReply) {
      this.snapshot.messages.push({
        id: `${taskId}-plan`,
        role: 'brain',
        text: brainReply,
        createdAt: now,
        taskId,
      });
    }
    this.snapshot.tasks.push(task);
    appendRunEvent(this.snapshot, task, 'queued', now);
    this.persist();
    return structuredClone(task);
  }

  bindSession(taskId: string, sessionId: string, now = Date.now()): BrainTask | undefined {
    return this.updateTask(taskId, { sessionId, status: 'dispatched', updatedAt: now }, 'dispatched');
  }

  completeWithoutDispatch(taskId: string, now = Date.now()): BrainTask | undefined {
    return this.updateTask(taskId, { status: 'completed', updatedAt: now }, 'completed');
  }

  finishSession(sessionId: string, exitCode: number, now = Date.now(), resultText?: string): BrainTask | undefined {
    // Session ids are host-process local and restart from sess-1 after every
    // launch. Historical tasks can therefore share an id; only the currently
    // active task is eligible for this process exit.
    const located = this.findTask((candidate) =>
      candidate.sessionId === sessionId &&
      (candidate.status === 'queued' || candidate.status === 'dispatched'));
    if (!located) return undefined;
    const task = located.task;
    const completed = exitCode === 0;
    const updated: BrainTask = {
      ...task,
      status: completed ? 'completed' : 'failed',
      error: completed ? undefined : `Agent exited with code ${exitCode}`,
      updatedAt: now,
    };
    located.snapshot.tasks[located.index] = updated;
    const declared = parseDeclaredDeliverables({
      text: preserveText(resultText ?? '').slice(0, 16_000),
      runId: updated.taskId,
      sessionId,
      now,
    });
    const result = declared.text;
    if (declared.deliverables.length > 0) {
      located.snapshot.deliverables = [
        ...(located.snapshot.deliverables ?? []),
        ...declared.deliverables,
      ];
    }
    appendRunEvent(
      located.snapshot,
      updated,
      completed ? 'completed' : 'failed',
      now,
      completed ? result : updated.error,
    );
    located.snapshot.messages.push({
      id: `${updated.taskId}-result-${now}`,
      role: 'brain',
      text: completed && result
        ? result
        : completed
          ? localizedTaskText(updated.text, `${updated.agent} 已完成这次任务。`, `${updated.agent} finished this run.`)
          : localizedTaskText(
              updated.text,
              `${updated.agent} 未能完成这次任务。`,
              `${updated.agent} stopped before completing the run.`,
            ),
      createdAt: now,
      taskId: updated.taskId,
    });
    this.persist();
    return structuredClone(updated);
  }

  failTask(taskId: string, error: string, now = Date.now()): BrainTask | undefined {
    return this.updateTask(taskId, { status: 'failed', error, updatedAt: now }, 'failed', error);
  }

  cancelTask(taskId: string, now = Date.now()): BrainTask | undefined {
    const task = this.findTaskById(taskId);
    if (!task || (task.status !== 'queued' && task.status !== 'dispatched')) return undefined;
    const updated = this.updateTask(
      taskId,
      { status: 'cancelled', error: undefined, updatedAt: now },
      'cancelled',
      'Cancelled by user',
    );
    if (updated) {
      const located = this.findTask((candidate) => candidate.taskId === taskId);
      located?.snapshot.messages.push({
        id: `${taskId}-cancelled-${now}`,
        role: 'brain',
        text: localizedTaskText(task.text, `${task.agent} 的任务已取消。`, `${task.agent} task cancelled.`),
        createdAt: now,
        taskId,
      });
      this.persist();
    }
    return updated;
  }

  failInterruptedTasks(activeSessionIds: ReadonlySet<string>, now = Date.now()): BrainTask[] {
    const interrupted: BrainTask[] = [];
    for (const snapshot of this.snapshots()) {
      const interruptedIds = new Set(snapshot.tasks.filter(
        (task) =>
          (task.status === 'queued' || task.status === 'dispatched') &&
          (!task.sessionId || !activeSessionIds.has(task.sessionId)),
      ).map((task) => task.taskId));
      if (interruptedIds.size === 0) continue;
      snapshot.tasks = snapshot.tasks.map((task) => {
        if (!interruptedIds.has(task.taskId)) return task;
        const updated = {
          ...task,
          status: 'failed' as const,
          error: 'Host restarted before this run completed',
          updatedAt: now,
        };
        interrupted.push(updated);
        appendRunEvent(snapshot, updated, 'failed', now, updated.error);
        return updated;
      });
      for (const task of interrupted.filter((candidate) => interruptedIds.has(candidate.taskId))) {
        snapshot.messages.push({
          id: `${task.taskId}-interrupted-${now}`,
          role: 'brain',
          text: localizedTaskText(
            task.text,
            `Host 重启中断了 ${task.agent}，你可以重新发送这个请求。`,
            `${task.agent} was interrupted when the host restarted. You can send the request again.`,
          ),
          createdAt: now,
          taskId: task.taskId,
        });
      }
    }
    if (interrupted.length === 0) return [];
    this.persist();
    return structuredClone(interrupted);
  }

  private updateTask(
    taskId: string,
    patch: Partial<BrainTask>,
    eventType?: BrainRunEvent['type'],
    eventSummary?: string,
  ): BrainTask | undefined {
    const located = this.findTask((task) => task.taskId === taskId);
    if (!located) return undefined;
    located.snapshot.tasks[located.index] = { ...located.task, ...patch };
    if (eventType) {
      appendRunEvent(
        located.snapshot,
        located.snapshot.tasks[located.index],
        eventType,
        patch.updatedAt ?? Date.now(),
        eventSummary,
      );
    }
    this.persist();
    return structuredClone(located.snapshot.tasks[located.index]);
  }

  private snapshots(): BrainSnapshot[] {
    return [this.snapshot, ...this.history.map((conversation) => conversation as BrainSnapshot)];
  }

  private findTask(predicate: (task: BrainTask) => boolean): {
    snapshot: BrainSnapshot;
    task: BrainTask;
    index: number;
  } | undefined {
    for (const snapshot of this.snapshots()) {
      const index = snapshot.tasks.findIndex(predicate);
      if (index >= 0) return { snapshot, task: snapshot.tasks[index], index };
    }
    return undefined;
  }

  private persist(): void {
    const bounded: BrainSnapshot = {
      systemReminders: (this.snapshot.systemReminders ?? []).slice(-100),
      messages: this.snapshot.messages.slice(-200),
      tasks: this.snapshot.tasks.slice(-100),
      toolResults: (this.snapshot.toolResults ?? []).slice(-100),
      routeDecisions: (this.snapshot.routeDecisions ?? []).slice(-100),
      runEvents: (this.snapshot.runEvents ?? []).slice(-300),
      deliverables: (this.snapshot.deliverables ?? []).slice(-100),
      executionEvents: (this.snapshot.executionEvents ?? []).slice(-300),
    };
    this.snapshot = bounded;
    this.history = this.history.slice(-30).map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-200),
      tasks: conversation.tasks.slice(-100),
      toolResults: (conversation.toolResults ?? []).slice(-100),
      routeDecisions: (conversation.routeDecisions ?? []).slice(-100),
      runEvents: (conversation.runEvents ?? []).slice(-300),
      deliverables: (conversation.deliverables ?? []).slice(-100),
      executionEvents: (conversation.executionEvents ?? []).slice(-300),
      updatedAt: conversationUpdatedAt(conversation),
      messageCount: Math.min(conversation.messages.length, 200),
    }));
    this.store.write({ ...bounded, history: this.history });
  }
}

function hasSnapshotContent(snapshot: BrainSnapshot): boolean {
  return snapshot.messages.length > 0
    || snapshot.tasks.length > 0
    || (snapshot.toolResults?.length ?? 0) > 0
    || (snapshot.routeDecisions?.length ?? 0) > 0
    || (snapshot.runEvents?.length ?? 0) > 0
    || (snapshot.deliverables?.length ?? 0) > 0
    || (snapshot.executionEvents?.length ?? 0) > 0;
}

function createConversationHistory(snapshot: BrainSnapshot, now: number): BrainConversationHistory {
  const timestamps = [
    ...snapshot.messages.map((item) => item.createdAt),
    ...snapshot.tasks.flatMap((item) => [item.createdAt, item.updatedAt]),
    ...(snapshot.toolResults ?? []).map((item) => item.createdAt),
    ...(snapshot.routeDecisions ?? []).map((item) => item.createdAt),
    ...(snapshot.runEvents ?? []).map((item) => item.createdAt),
    ...(snapshot.deliverables ?? []).map((item) => item.createdAt),
    ...(snapshot.executionEvents ?? []).map((item) => item.createdAt),
  ].filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0);
  const firstUserText = snapshot.messages.find((message) => message.role === 'user')?.text;
  const firstTaskText = snapshot.tasks[0]?.text;
  const title = compactText(firstUserText || firstTaskText || 'Global conversation').slice(0, 80);
  return {
    id: `conversation-${randomUUID()}`,
    title,
    createdAt: timestamps.length > 0 ? Math.min(...timestamps) : now,
    updatedAt: Math.max(now, ...(timestamps.length > 0 ? timestamps : [now])),
    messageCount: snapshot.messages.length,
    ...structuredClone(snapshot),
  };
}

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function conversationUpdatedAt(conversation: BrainConversationHistory): number {
  return Math.max(
    conversation.updatedAt,
    ...conversation.messages.map((item) => item.createdAt),
    ...conversation.tasks.map((item) => item.updatedAt),
    ...(conversation.toolResults ?? []).map((item) => item.createdAt),
    ...(conversation.routeDecisions ?? []).map((item) => item.createdAt),
    ...(conversation.runEvents ?? []).map((item) => item.createdAt),
    ...(conversation.deliverables ?? []).map((item) => item.createdAt),
    ...(conversation.executionEvents ?? []).map((item) => item.createdAt),
  );
}

function appendRunEvent(
  snapshot: BrainSnapshot,
  task: BrainTask,
  type: BrainRunEvent['type'],
  createdAt: number,
  summary?: string,
): void {
  const eventId = `${task.taskId}:${type}`;
  if ((snapshot.runEvents ?? []).some((event) => event.eventId === eventId)) return;
  const event = cleanRunEvent({
    eventId,
    runId: task.taskId,
    requestId: task.requestId,
    type,
    createdAt,
    agentId: task.agent,
    sessionId: task.sessionId,
    summary,
  });
  if (event) snapshot.runEvents = [...(snapshot.runEvents ?? []), event];
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function cleanToolResult(input: BrainToolResult): BrainToolResult | undefined {
  const id = compactText(input.id).slice(0, 128);
  const requestId = compactText(input.requestId).slice(0, 128);
  const callId = compactText(input.callId).slice(0, 128);
  const toolName = compactText(input.toolName).slice(0, 128);
  const title = compactText(input.view.title).slice(0, 160);
  if (!id || !requestId || !callId || !toolName || !title) return undefined;
  const items = input.view.items.slice(0, 8).map((item) => ({
    id: compactText(item.id).slice(0, 128),
    title: compactText(item.title).slice(0, 160),
    ...(item.subtitle ? { subtitle: compactText(item.subtitle).slice(0, 256) } : {}),
    ...(item.detail ? { detail: compactText(item.detail).slice(0, 600) } : {}),
    ...(item.status ? { status: compactText(item.status).slice(0, 64) } : {}),
    ...(typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) && item.timestamp >= 0
      ? { timestamp: Math.floor(item.timestamp) }
      : {}),
    ...(item.sessionId ? { sessionId: compactText(item.sessionId).slice(0, 128) } : {}),
    ...(item.source === 'pty' || item.source === 'herdr' ? { source: item.source } : {}),
  })).filter((item) => item.id && item.title);
  return {
    id,
    requestId,
    callId,
    toolName,
    createdAt: Number.isFinite(input.createdAt) && input.createdAt >= 0 ? Math.floor(input.createdAt) : Date.now(),
    view: { kind: input.view.kind, title, items },
  };
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function preserveText(text: string): string {
  return text.trim();
}

function localizedTaskText(source: string, chinese: string, english: string): string {
  return /\p{Script=Han}/u.test(source) ? chinese : english;
}

export * from './planner.js';
export * from './conversation.js';
export * from './piConversation.js';
export * from './controlPlane.js';
export * from './executionFork.js';
