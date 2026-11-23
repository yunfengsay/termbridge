/**
 * Record → block mapping shared by the Claude and Codex decoders, so schema
 * drift in either CLI has one place to be absorbed.
 *
 * Adapted from Orca `src/main/native-chat/transcript-record-blocks.ts` at
 * revision 55b33920180efa188a19dfb7fac0fc993f10a922.
 * Copyright (c) 2026 Lovecast Inc. — MIT. See THIRD_PARTY_NOTICES.md.
 *
 * TB differences: tool input is bounded to a display string here rather than
 * passed through as an opaque value, an image block never carries a Host
 * filesystem path — a remote client cannot open one and it leaks the Host —
 * and model-internal reasoning blocks are dropped instead of rendered.
 */

import type {
  AgentChatBlock,
  AgentChatImageRefBlock,
  AgentChatToolResultBlock,
} from '../types.js';
import { asRecord, boundText, extractString } from '../values.js';

/** Per-block wire budgets. A transcript row can be megabytes; a card cannot. */
export const MAX_TOOL_INPUT_CHARS = 4_000;
export const MAX_TOOL_OUTPUT_CHARS = 8_000;
export const MAX_TEXT_CHARS = 24_000;

export function textBlock(text: string): AgentChatBlock {
  return { type: 'text', text: boundText(text, MAX_TEXT_CHARS).text };
}

/** Render an arbitrary tool argument payload as a bounded preview string. */
export function toolInputPreview(value: unknown): { input: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : stringifySafely(value);
  const bounded = boundText(text, MAX_TOOL_INPUT_CHARS);
  return { input: bounded.text, truncated: bounded.truncated };
}

/** Coerce an arbitrary tool-result payload into a single bounded output string. */
export function toolResultOutput(value: unknown): { output: string; truncated: boolean } {
  const bounded = boundText(flattenResult(value), MAX_TOOL_OUTPUT_CHARS);
  return { output: bounded.text, truncated: bounded.truncated };
}

function flattenResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    if (record) {
      const text = extractString(record.text) ?? extractString(record.content);
      if (text) return text;
    }
    return value === undefined || value === null ? '' : stringifySafely(value);
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const record = asRecord(item);
    const text = extractString(record?.text) ?? extractString(record?.content);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function stringifySafely(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Build blocks from one Anthropic-shaped content array (string or block[]). */
export function contentBlocks(content: unknown): AgentChatBlock[] {
  if (typeof content === 'string') return content.trim() ? [textBlock(content)] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AgentChatBlock[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) blocks.push(textBlock(item));
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const block = contentBlock(record);
    if (block) blocks.push(block);
  }
  return blocks;
}

function contentBlock(record: Record<string, unknown>): AgentChatBlock | null {
  switch (record.type) {
    case 'text':
    case 'input_text':
    case 'output_text': {
      const text = extractString(record.text);
      return text ? textBlock(text) : null;
    }
    // `thinking` is deliberately unhandled: model-internal reasoning never
    // reaches a client. It falls through to the default and is dropped.
    case 'tool_use': {
      const name = extractString(record.name) ?? 'tool';
      const callId = extractString(record.id);
      const preview = toolInputPreview(record.input);
      return {
        type: 'tool-call',
        name,
        input: preview.input,
        ...(callId ? { callId } : {}),
        ...(preview.truncated ? { truncated: true } : {}),
      };
    }
    case 'tool_result':
      return toolResultBlock(record);
    case 'image':
      return imageRefBlock(record);
    default:
      return null;
  }
}

function toolResultBlock(record: Record<string, unknown>): AgentChatToolResultBlock {
  const result = toolResultOutput(record.content);
  const callId = extractString(record.tool_use_id);
  return {
    type: 'tool-result',
    output: result.output,
    ...(record.is_error === true ? { isError: true } : {}),
    ...(callId ? { callId } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

/**
 * Only an http(s) URL the provider itself recorded survives. Base64 payloads
 * and local paths become a named placeholder the client renders as "image".
 */
export function imageRefBlock(record: Record<string, unknown>): AgentChatImageRefBlock | null {
  const source = asRecord(record.source);
  const url = httpUrl(extractString(source?.url) ?? extractString(record.url) ?? extractString(record.image_url));
  const alt = extractString(record.alt);
  const name = extractString(record.name) ?? fileName(extractString(record.path));
  if (!url && !name && !alt) return { type: 'image-ref' };
  return {
    type: 'image-ref',
    ...(url ? { url } : {}),
    ...(name ? { name } : {}),
    ...(alt ? { alt } : {}),
  };
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Skill expansions, environment preambles and system reminders are model
 * context that the provider stores inside a user turn. They are not what the
 * person typed, so they are excluded from both display and prompt matching.
 */
export function isInjectedContextBlock(block: AgentChatBlock): boolean {
  if (block.type !== 'text') return false;
  const head = block.text.trimStart().slice(0, 32).toLowerCase();
  return head.startsWith('<skill>')
    || head.startsWith('<environment_context>')
    || head.startsWith('<user_instructions>')
    || head.startsWith('<system-reminder>')
    || head.startsWith('<command-name>')
    || head.startsWith('<local-command-stdout>');
}

/** A basename is display context; the directory it sat in is not. */
function fileName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = path.split(/[\\/]/).pop();
  return name && name.length <= 120 ? name : undefined;
}
