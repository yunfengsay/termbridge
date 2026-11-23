/**
 * Claude Code JSONL record → conversation message.
 *
 * Adapted from Orca `src/main/native-chat/transcript-line-decoders-claude.ts`
 * at revision 55b33920180efa188a19dfb7fac0fc993f10a922.
 * Copyright (c) 2026 Lovecast Inc. — MIT. See THIRD_PARTY_NOTICES.md.
 */

import { AGENT_CHAT_INTERRUPTED_TEXT, type AgentChatBlock, type AgentChatRole } from '../types.js';
import { asRecord, extractString, parseJsonObject, timestampMs } from '../values.js';
import { contentBlocks, isInjectedContextBlock } from './blocks.js';
import type { DecodedMessage, TranscriptDecoder } from './decoder.js';

/** Claude's injected interrupt prompt. Shown as status, never as a user turn. */
const INTERRUPT_TEXT = '[Request interrupted';

export const claudeDecoder: TranscriptDecoder = {
  provider: 'claude',
  decode: decodeClaudeLine,
  sessionIdOf: claudeSessionId,
  userPromptText: claudeUserPromptText,
};

/** The session id a Claude record states for itself, used to verify a path. */
function claudeSessionId(line: string): string | undefined {
  return extractString(parseJsonObject(line)?.sessionId);
}

function decodeClaudeLine(line: string, fallbackId: string): DecodedMessage | null {
  const record = parseJsonObject(line);
  if (!record) return null;
  const type = record.type;
  if (type !== 'user' && type !== 'assistant') return null;
  if (record.isSidechain === true) return null;
  const timestamp = timestampMs(record.timestamp);
  const message = asRecord(record.message);
  const id = extractString(record.uuid) ?? extractString(message?.id) ?? fallbackId;

  if (isInterruptRecord(record, message)) {
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: AGENT_CHAT_INTERRUPTED_TEXT }],
      timestamp,
      source: 'transcript',
    };
  }

  const decoded = contentBlocks(message?.content);
  if (decoded.length === 0) return null;

  // Claude marks replayed or injected turns structurally. Their tool results are
  // genuine output and stay; the injected prose around them is model context.
  const injected = type === 'user'
    && (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true);
  const blocks = injected
    ? decoded.filter((block) => block.type === 'tool-result')
    : type === 'user' ? decoded.filter((block) => !isInjectedContextBlock(block)) : decoded;
  if (blocks.length === 0) return null;

  return { id, role: claudeRole(type, blocks), blocks, timestamp, source: 'transcript' };
}

function isInterruptRecord(
  record: Record<string, unknown>,
  message: Record<string, unknown> | null,
): boolean {
  if (extractString(record.interruptedMessageId)) return true;
  const content = message?.content;
  if (typeof content === 'string') return content.startsWith(INTERRUPT_TEXT);
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const block = asRecord(item);
    return block?.type === 'text' && (extractString(block.text) ?? '').startsWith(INTERRUPT_TEXT);
  });
}

/** A user record carrying only tool results is the tool lane, not a prompt. */
function claudeRole(type: 'user' | 'assistant', blocks: AgentChatBlock[]): AgentChatRole {
  if (type === 'assistant') return 'assistant';
  return blocks.every((block) => block.type === 'tool-result') ? 'tool' : 'user';
}

/**
 * The user prompt text of a decoded record, for delivery confirmation. Only a
 * genuine typed prompt qualifies: a tool lane or an injected turn must never
 * satisfy a pending send.
 */
export function claudeUserPromptText(line: string): string | undefined {
  const record = parseJsonObject(line);
  if (record?.type !== 'user' || record.isSidechain === true) return undefined;
  if (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true) return undefined;
  if (isInterruptRecord(record, asRecord(record.message))) return undefined;
  const blocks = contentBlocks(asRecord(record.message)?.content)
    .filter((block) => !isInjectedContextBlock(block));
  if (blocks.length === 0 || !blocks.every((block) => block.type === 'text')) return undefined;
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}
