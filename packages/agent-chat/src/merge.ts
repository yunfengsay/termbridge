/**
 * Pure id-dedup and windowing for every client of the conversation stream.
 *
 * Adapted from Orca `src/shared/native-chat-merge.ts` at revision
 * 55b33920180efa188a19dfb7fac0fc993f10a922.
 * Copyright (c) 2026 Lovecast Inc. — MIT. See THIRD_PARTY_NOTICES.md.
 */

import {
  AGENT_CHAT_SOURCE_PRIORITY,
  type AgentChatMessage,
  type AgentChatSource,
} from './types.js';

export type AgentChatSourcePriority = Record<AgentChatSource, number>;

/**
 * Fold a batch into an ordered list, deduping by `id`. A re-emitted id replaces
 * its entry in place only when the incoming source is at least as authoritative;
 * new ids append in arrival order. Never mutates the inputs.
 */
export function mergeAgentChatMessages(
  existing: readonly AgentChatMessage[],
  incoming: readonly AgentChatMessage[],
  priority: AgentChatSourcePriority = AGENT_CHAT_SOURCE_PRIORITY,
): AgentChatMessage[] {
  if (incoming.length === 0) return existing as AgentChatMessage[];
  const merged = [...existing];
  const indexById = new Map<string, number>();
  merged.forEach((message, index) => indexById.set(message.id, index));
  applyIncoming(merged, indexById, incoming, priority);
  return merged;
}

/**
 * Cap a list to its most-recent `limit` entries so a long run cannot grow a
 * client's window without bound. A non-positive limit means "no cap".
 */
export function boundAgentChatWindow(
  messages: readonly AgentChatMessage[],
  limit: number,
): AgentChatMessage[] {
  if (limit <= 0 || messages.length <= limit) return messages as AgentChatMessage[];
  return messages.slice(messages.length - limit);
}

/**
 * Stateful merger that caches the id→index map across appends, so a streaming
 * run pays O(incoming) per batch instead of O(existing + incoming).
 */
export interface AgentChatMerger {
  list: AgentChatMessage[];
  readonly indexById: Map<string, number>;
  readonly priority: AgentChatSourcePriority;
}

export function createAgentChatMerger(
  priority: AgentChatSourcePriority = AGENT_CHAT_SOURCE_PRIORITY,
): AgentChatMerger {
  return { list: [], indexById: new Map(), priority };
}

/** Reset to a new base list. Used for the initial read and for loadEarlier. */
export function replaceAgentChatList(
  merger: AgentChatMerger,
  list: readonly AgentChatMessage[],
): void {
  merger.list = [...list];
  merger.indexById.clear();
  merger.list.forEach((message, index) => merger.indexById.set(message.id, index));
}

/** Fold a live batch in, returning a fresh `list` reference for the renderer. */
export function appendAgentChatMessages(
  merger: AgentChatMerger,
  incoming: readonly AgentChatMessage[],
  limit?: number,
): AgentChatMessage[] {
  if (incoming.length === 0) return merger.list;
  const next = [...merger.list];
  applyIncoming(next, merger.indexById, incoming, merger.priority);
  const bounded = limit === undefined ? next : boundAgentChatWindow(next, limit);
  if (bounded !== next) {
    // Trimming shifts every cached index, so rebuild at the window boundary.
    replaceAgentChatList(merger, bounded);
    return merger.list;
  }
  merger.list = next;
  return next;
}

function applyIncoming(
  list: AgentChatMessage[],
  indexById: Map<string, number>,
  incoming: readonly AgentChatMessage[],
  priority: AgentChatSourcePriority,
): void {
  for (const message of incoming) {
    const at = indexById.get(message.id);
    if (at === undefined) {
      indexById.set(message.id, list.length);
      list.push(message);
      continue;
    }
    const current = list[at]!;
    if (priority[message.source] >= priority[current.source]) list[at] = message;
  }
}
