/**
 * Codex JSONL record → conversation message.
 *
 * Adapted from Orca `src/main/native-chat/transcript-line-decoders-codex.ts`
 * at revision 55b33920180efa188a19dfb7fac0fc993f10a922.
 * Copyright (c) 2026 Lovecast Inc. — MIT. See THIRD_PARTY_NOTICES.md.
 */

import { AGENT_CHAT_INTERRUPTED_TEXT, type AgentChatBlock } from '../types.js';
import { asRecord, extractString, parseJsonObject, timestampMs } from '../values.js';
import {
  contentBlocks,
  imageRefBlock,
  isInjectedContextBlock,
  textBlock,
  toolInputPreview,
  toolResultOutput,
} from './blocks.js';
import type { DecodedMessage, TranscriptDecoder } from './decoder.js';

const TURN_ABORTED = 'turn_aborted';

export const codexDecoder: TranscriptDecoder = {
  provider: 'codex',
  decode: decodeCodexLine,
  sessionIdOf: codexSessionId,
  userPromptText: codexUserPromptText,
};

/** Codex states its own thread id in the `session_meta` header record. */
function codexSessionId(line: string): string | undefined {
  const record = parseJsonObject(line);
  if (record?.type !== 'session_meta') return undefined;
  const payload = asRecord(record.payload);
  return extractString(payload?.session_id) ?? extractString(payload?.id);
}

function decodeCodexLine(line: string, fallbackId: string): DecodedMessage | null {
  const record = parseJsonObject(line);
  if (!record) return null;
  const timestamp = timestampMs(record.timestamp);
  const payload = asRecord(record.payload);
  if (!payload) {
    const id = extractString(record.id) ?? fallbackId;
    return record.type === 'message' ? responseItem(record, id, timestamp) : null;
  }
  const id = extractString(payload.id) ?? fallbackId;
  if (record.type === 'response_item') return responseItem(payload, id, timestamp);
  if (record.type === 'event_msg') return eventMessage(payload, id, timestamp);
  return null;
}

function responseItem(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null,
): DecodedMessage | null {
  if (payload.type === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
    if (!role) return null;
    const decoded = contentBlocks(payload.content);
    const blocks = role === 'user' ? decoded.filter((block) => !isInjectedContextBlock(block)) : decoded;
    return blocks.length > 0 ? { id, role, blocks, timestamp, source: 'transcript' } : null;
  }
  if (
    payload.type === 'function_call'
    || payload.type === 'local_shell_call'
    || payload.type === 'custom_tool_call'
  ) {
    const name = extractString(payload.name) ?? 'tool';
    const callId = extractString(payload.call_id);
    const preview = toolInputPreview(callInput(payload));
    return {
      id,
      role: 'assistant',
      blocks: [{
        type: 'tool-call',
        name,
        input: preview.input,
        ...(callId ? { callId } : {}),
        ...(preview.truncated ? { truncated: true } : {}),
      }],
      timestamp,
      source: 'transcript',
    };
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const callId = extractString(payload.call_id);
    return {
      id,
      role: 'tool',
      blocks: [toolResult(payload.output, callId)],
      timestamp,
      source: 'transcript',
    };
  }
  // `reasoning` is deliberately unhandled — see AGENT_CHAT_ROLES.
  return null;
}

function eventMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null,
): DecodedMessage | null {
  if (payload.type === TURN_ABORTED) {
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: AGENT_CHAT_INTERRUPTED_TEXT }],
      timestamp,
      source: 'transcript',
    };
  }
  if (payload.type === 'item_completed') return completedItem(payload, id, timestamp);
  // `user_message` and `agent_message` are the other echo of the same turn, and
  // they double in exactly the same way `item_completed` did — a real prompt was
  // shown twice and confirmed twice, so one send produced two receipts.
  // `response_item/message` is the single source for both roles; only events
  // that carry something no response item does are read here.
  return null;
}

function completedItem(
  payload: Record<string, unknown>,
  fallbackId: string,
  timestamp: number | null,
): DecodedMessage | null {
  const item = asRecord(payload.item);
  if (!item) return null;
  const id = extractString(item.id) ?? fallbackId;
  const blocks = turnItemBlocks(item.content);
  if (blocks.length === 0) return null;
  // A user turn is deliberately not read from here.
  //
  // Codex records the same prompt twice: once as `response_item/message` with
  // role user, and once as this `item_completed/UserMessage`. The two carry
  // freshly generated UUIDs that differ, so nothing identifies them as one item
  // and every prompt was drawn twice. Measured across eight recent rollouts:
  // 156 duplicated user turns, every one of them this pair, and no assistant or
  // tool item duplicated at all.
  //
  // `response_item` is the canonical side — it carries structured content
  // including images, and it is what delivery confirmation matches against — so
  // this echo is dropped rather than merged. Merging would have to compare text,
  // and two genuine sends of the same words must stay two messages.
  //
  // The same holds for an assistant turn. In some rollouts the two sources do
  // agree on the identifier and fold together on their own; in others — the one
  // the user photographed among them — they do not, and every reply was drawn
  // twice. Rather than depend on which shape a given Codex build writes,
  // `response_item` is the single source for both roles.
  //
  // The cost is stated plainly: a rollout that recorded messages *only* as
  // `item_completed` would show none. No such rollout was observed, and the
  // alternative is comparing text, which cannot tell a mirrored record from a
  // user sending the same words twice.
  return null;
}

function turnItemBlocks(content: unknown): AgentChatBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: AgentChatBlock[] = [];
  for (const value of content) {
    const item = asRecord(value);
    if (!item) continue;
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = extractString(item.text);
      if (text) blocks.push(textBlock(text));
      continue;
    }
    if (type === 'image' || type === 'input_image' || type === 'local_image') {
      const block = imageRefBlock(item);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

/**
 * The argument payload is previewed exactly as it arrived. Decoding it here
 * would change the shape every consumer sees, so the bounded string is all a
 * client gets and any consumer needing structure re-parses it itself.
 */
function callInput(payload: Record<string, unknown>): unknown {
  if (payload.arguments !== undefined) return payload.arguments;
  return payload.input ?? payload.action ?? null;
}

function toolResult(output: unknown, callId: string | undefined): AgentChatBlock {
  const record = asRecord(output);
  const isError = record?.success === false || record?.is_error === true;
  const result = toolResultOutput(record?.content ?? record?.output ?? output);
  return {
    type: 'tool-result',
    output: result.output,
    ...(isError ? { isError: true } : {}),
    ...(callId ? { callId } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

/** See `TranscriptDecoder.userPromptText`. */
export function codexUserPromptText(line: string): string | undefined {
  const decoded = decodeCodexLine(line, 'probe');
  if (!decoded || decoded.role !== 'user') return undefined;
  if (!decoded.blocks.every((block) => block.type === 'text')) return undefined;
  return decoded.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}
