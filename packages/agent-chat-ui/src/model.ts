/**
 * The presentation model for one conversation: what a row IS, before anything
 * knows how to draw it. Kept free of the DOM so every shell — Windows WebView2
 * today, the phone and Mac later — renders the same rows, and so the grouping
 * rules can be tested without a browser.
 *
 * The layout follows the product rule: what the Agent is doing now, what it is
 * asking, and where the result went, stay visible; raw tool payloads are one
 * click away.
 */

import type {
  AgentChatBlock,
  AgentChatCapabilities,
  AgentChatDeliveryState,
  AgentChatMessage,
  AgentChatStatus,
  AgentChatToolCallBlock,
  AgentChatToolResultBlock,
} from '@termbridge/agent-chat';
import { AGENT_CHAT_INTERRUPTED_TEXT } from '@termbridge/agent-chat';

/**
 * What a tool card may say, and what each claim rests on.
 *
 * There is no "probably finished". A call is only `done`/`failed` because the
 * provider recorded a result, only `running` because the conversation is
 * actually working, and `unknown` when a historic call has no result and the
 * turn is over — which is the truth, and is not a spinner that never stops.
 */
export type ToolState = 'running' | 'done' | 'failed' | 'unknown';

export type TranscriptRow =
  | { kind: 'prose'; id: string; role: 'user' | 'assistant'; text: string; timestamp: number | null }
  | { kind: 'image'; id: string; role: 'user' | 'assistant'; url?: string; name?: string; alt?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: string; output?: string; state: ToolState; truncated: boolean }
  | { kind: 'status'; id: string; text: string }
  /**
   * The Agent is working and nothing else says so.
   *
   * Driven only by the conversation's own status, and suppressed when a tool
   * card is already showing a running spinner, so one fact is shown once. It
   * carries no text: a standing sentence was what made the old header noisy.
   */
  | { kind: 'working'; id: string }
  /**
   * The message the user just sent, carried with its own receipt.
   *
   * It lives next to the message it describes. A single band above the
   * transcript cannot say which send it means once there has been more than
   * one, and stacks with every other notice competing for the same strip.
   */
  | { kind: 'pending'; id: string; text: string; state: AgentChatDeliveryState; error?: string };

/** One preview line for a tool card's collapsed state. */
export function toolSummary(name: string, input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (!compact) return name;
  const parsed = readCommonArgument(compact);
  const detail = parsed ?? compact;
  return detail.length > 120 ? `${detail.slice(0, 119)}…` : detail;
}

/**
 * Most tools carry one field a person actually recognises — a command, a path,
 * a pattern. Showing that instead of the whole JSON is the difference between a
 * readable row and a wall of braces.
 */
function readCommonArgument(input: string): string | undefined {
  if (!input.startsWith('{')) return undefined;
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    record = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Turn the message list into rows, pairing each tool call with the result that
 * answered it. A call with no result is `pending`: the turn is still running, or
 * it was interrupted before the tool reported. Nothing here infers success —
 * only a result the provider recorded can mark a tool finished.
 */
export interface BuildRowsOptions {
  /** The conversation's own status: the only basis for calling a tool running. */
  status?: AgentChatStatus;
  /**
   * A local send awaiting its receipt, rendered after everything recorded.
   *
   * `messageId` is the record the Host observed this exact request as. Once
   * that message is in the list the local row is redundant and goes, whichever
   * of the two arrived first. Matching on text instead would merge two genuine
   * sends of the same words into one.
   */
  pending?: { id: string; text: string; state: AgentChatDeliveryState; error?: string; messageId?: string };
}

export function buildRows(messages: readonly AgentChatMessage[], options: BuildRowsOptions = {}): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const toolRowByCallId = new Map<string, Extract<TranscriptRow, { kind: 'tool' }>>();
  const unmatchedResults: Array<{ block: AgentChatToolResultBlock; row: TranscriptRow }> = [];
  /**
   * The message that last said anything about each tool card.
   *
   * A card keeps the id of the record that created it so the DOM stays stable,
   * but whether it is still running is a question about the newest record for
   * that call — a restated call in a later message must not leave the card
   * looking like it belongs to an older turn.
   */
  const latestMessageForRow = new Map<Extract<TranscriptRow, { kind: 'tool' }>, string>();

  for (const message of messages) {
    if (message.role === 'system') {
      const text = message.blocks.find((block) => block.type === 'text');
      rows.push({ kind: 'status', id: message.id, text: text?.type === 'text' ? text.text : AGENT_CHAT_INTERRUPTED_TEXT });
      continue;
    }
    message.blocks.forEach((block, index) => {
      const id = `${message.id}:${index}`;
      if (block.type === 'text') {
        if (!block.text.trim()) return;
        rows.push({
          kind: 'prose',
          id,
          role: message.role === 'user' ? 'user' : 'assistant',
          text: block.text,
          timestamp: message.timestamp,
        });
        return;
      }
      if (block.type === 'image-ref') {
        rows.push({
          kind: 'image',
          id,
          role: message.role === 'user' ? 'user' : 'assistant',
          ...(block.url ? { url: block.url } : {}),
          ...(block.name ? { name: block.name } : {}),
          ...(block.alt ? { alt: block.alt } : {}),
        });
        return;
      }
      if (block.type === 'tool-call') {
        // A provider may restate a call it already recorded. The same callId is
        // the same invocation, so it updates that card instead of stacking a
        // second one beside its own result. Two calls that merely share
        // arguments have different callIds and stay two cards.
        const existing = block.callId ? toolRowByCallId.get(block.callId) : undefined;
        if (existing) {
          existing.name = block.name;
          existing.summary = toolSummary(block.name, block.input);
          existing.input = block.input;
          existing.truncated = existing.truncated || block.truncated === true;
          latestMessageForRow.set(existing, message.id);
          return;
        }
        const row = toolRow(id, block);
        rows.push(row);
        latestMessageForRow.set(row, message.id);
        if (block.callId) toolRowByCallId.set(block.callId, row);
        // A result can legitimately arrive before its call is decoded when a
        // window opens mid-turn; reconcile those instead of dropping them.
        const early = block.callId
          ? unmatchedResults.findIndex((result) => result.block.callId === block.callId)
          : -1;
        if (early >= 0) {
          const match = unmatchedResults[early]!;
          applyResult(row, match.block);
          rows.splice(rows.indexOf(match.row), 1);
          unmatchedResults.splice(early, 1);
        }
        return;
      }
      const target = block.callId ? toolRowByCallId.get(block.callId) : undefined;
      if (target) {
        applyResult(target, block);
        latestMessageForRow.set(target, message.id);
        return;
      }
      // A result whose call has not been decoded yet, repeated. The second one
      // belongs to the same invocation, so it updates the card standing in for
      // it rather than adding another beside it.
      const priorOrphan = block.callId
        ? unmatchedResults.find((entry) => entry.block.callId === block.callId)
        : undefined;
      if (priorOrphan && priorOrphan.row.kind === 'tool') {
        applyResult(priorOrphan.row, block);
        priorOrphan.block = block;
        latestMessageForRow.set(priorOrphan.row, message.id);
        return;
      }
      const orphan: TranscriptRow = {
        kind: 'tool',
        id,
        name: '工具结果',
        summary: firstLine(block.output),
        input: '',
        output: block.output,
        state: block.isError === true ? 'failed' : 'done',
        truncated: block.truncated === true,
      };
      rows.push(orphan);
      if (orphan.kind === 'tool') latestMessageForRow.set(orphan, message.id);
      if (block.callId) unmatchedResults.push({ block, row: orphan });
    });
  }
  /**
   * A call with no recorded result is only "running" if this conversation is
   * working *and* nothing was recorded after it. A global working flag does not
   * mean every unanswered call is live: once the transcript moved on, that call
   * was never answered, which is unknown — and a spinner that outlives its own
   * turn is worse than saying so.
   */
  const lastId = messages.at(-1)?.id;
  const live = options.status === 'working';
  for (const row of rows) {
    if (row.kind !== 'tool' || row.state !== 'running') continue;
    // Asked of the newest record for this call, not of the card's own id: a
    // call restated in a later message is still the latest thing said about it.
    const fromLastMessage = lastId !== undefined && latestMessageForRow.get(row) === lastId;
    if (!live || !fromLastMessage) row.state = 'unknown';
  }
  const reconciled = options.pending?.messageId !== undefined
    && messages.some((message) => message.id === options.pending!.messageId);
  // Only when the status says so, and only when no running tool already shows
  // it. This never reflects the connection or an unconfirmed send — those are
  // different facts with their own places.
  if (options.status === 'working' && !rows.some((row) => row.kind === 'tool' && row.state === 'running')) {
    rows.push({ kind: 'working', id: 'working' });
  }
  if (options.pending && !reconciled) {
    rows.push({
      kind: 'pending',
      id: `pending:${options.pending.id}`,
      text: options.pending.text,
      state: options.pending.state,
      ...(options.pending.error ? { error: options.pending.error } : {}),
    });
  }
  return rows;
}

function toolRow(id: string, block: AgentChatToolCallBlock): Extract<TranscriptRow, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    name: block.name,
    summary: toolSummary(block.name, block.input),
    input: block.input,
    truncated: block.truncated === true,
    state: 'running',
  };
}

function applyResult(row: Extract<TranscriptRow, { kind: 'tool' }>, block: AgentChatToolResultBlock): void {
  row.output = block.output;
  // Only the provider's own error flag means failure. Tool output that happens
  // to contain the word "success" is not a protocol.
  row.state = block.isError === true ? 'failed' : 'done';
  row.truncated = row.truncated || block.truncated === true;
}

function firstLine(output: string): string {
  const line = output.split('\n').find((entry) => entry.trim()) ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** The short chip beside a message, as opposed to the sentence below. */
export function deliveryChip(state: AgentChatDeliveryState): string {
  switch (state) {
    case 'accepted': return '发送中';
    case 'delivered': return '已送达';
    case 'observed': return 'Agent 已收到';
    case 'uncertain': return '结果未知';
    case 'failed': return '未发送';
  }
}

/** What a tool card's state chip reads, given only what was recorded. */
export function toolStateLabel(state: ToolState): string {
  switch (state) {
    case 'running': return '执行中';
    case 'done': return '完成';
    case 'failed': return '失败';
    case 'unknown': return '状态未知';
  }
}

/** What the composer shows for a send, so no state is silently optimistic. */
export function deliveryLabel(state: AgentChatDeliveryState): string {
  switch (state) {
    case 'accepted': return '正在发送…';
    case 'delivered': return '已送达，等待 Agent 确认';
    case 'observed': return 'Agent 已收到';
    case 'uncertain': return '结果未知，请在终端确认后再决定是否重发';
    case 'failed': return '发送失败，可以重试';
  }
}

/** A send that reached the Agent's input channel must never be auto-retried. */
export function canRetry(state: AgentChatDeliveryState): boolean {
  return state === 'failed';
}

export function statusLabel(status: AgentChatStatus): string {
  switch (status) {
    case 'loading': return '正在读取记录…';
    case 'ready': return '可以继续对话';
    case 'working': return 'Agent 正在处理';
    case 'empty': return '这个会话还没有内容';
    case 'unavailable': return '对话模式不可用';
  }
}

/** The one-line explanation shown beside a control the adapter cannot perform. */
export function capabilityNotice(capabilities: AgentChatCapabilities): string | undefined {
  if (capabilities.degraded) return capabilities.degraded;
  if (!capabilities.send) return '这个会话现在不能从对话模式发送消息。';
  return undefined;
}

/** True when the incoming event belongs to the view the user is looking at. */
export function isCurrentGeneration(event: { generation: number }, current: number): boolean {
  return event.generation === current;
}

export function blockText(block: AgentChatBlock): string {
  return block.type === 'text' ? block.text : '';
}
