import { open } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { AgentChatProvider } from '@termbridge/agent-chat';
import {
  claimedSessionId,
  forgetIdentityTranscript,
  locateIdentityTranscript,
  type AgentTranscriptIdentity,
} from './agentTranscriptLinks.js';

/** Unique files kept per conversation. More than this is not a review any more. */
const MAX_PATHS = 5_000;
const READ_BYTES = 4 * 1024 * 1024;
const VERIFY_BYTES = 512 * 1024;
/** A single record larger than this is skipped rather than buffered. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const CACHE_LIMIT = 64;
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

interface TranscriptState {
  path: string;
  /** dev:ino. A replaced record starts over instead of continuing at an old offset. */
  file: string;
  offset: number;
  pending: Buffer;
  /** Codex states its working directory per turn; relative patch paths use the latest. */
  cwd?: string;
  paths: Set<string>;
}

/**
 * The files an Agent changed during its conversation, read from its own
 * transcript: Codex file-change items and patches, Claude edit tools. Shell
 * commands that happen to write files are not guessed at. Reading continues
 * from where the previous call stopped, so a long conversation is parsed once.
 */
export class ConversationFiles {
  private readonly states = new Map<string, TranscriptState>();

  constructor(private readonly options: { home?: string } = {}) {}

  async touchedPaths(identity: AgentTranscriptIdentity): Promise<string[]> {
    const target = await locateIdentityTranscript(identity, this.options).catch(() => undefined);
    if (!target) return [];
    try {
      const handle = await open(target.path, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) return [];
        const file = `${info.dev}:${info.ino}`;
        let state = this.states.get(target.key);
        if (!state || state.path !== target.path || state.file !== file || info.size < state.offset) {
          const prefix = Buffer.alloc(Math.min(info.size, VERIFY_BYTES));
          const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
          const claimed = claimedSessionId(prefix.subarray(0, bytesRead).toString('utf8'), target.provider);
          // An unwritten record has no claim yet and nothing to report either.
          if (!claimed || (target.sessionId && claimed !== target.sessionId)) return [];
          state = { path: target.path, file, offset: 0, pending: Buffer.alloc(0), paths: new Set() };
          this.remember(target.key, state);
        }
        while (state.offset < info.size) {
          const chunk = Buffer.alloc(Math.min(READ_BYTES, info.size - state.offset));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.offset);
          if (bytesRead === 0) break;
          state.offset += bytesRead;
          this.consume(state, chunk.subarray(0, bytesRead), target.provider);
        }
        return [...state.paths];
      } finally {
        await handle.close();
      }
    } catch {
      forgetIdentityTranscript(target.key);
      this.states.delete(target.key);
      return [];
    }
  }

  /** Lines are split on the newline byte, which never occurs inside a UTF-8 sequence. */
  private consume(state: TranscriptState, chunk: Buffer, provider: AgentChatProvider): void {
    let data = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
      this.record(state, data.subarray(start, end).toString('utf8'), provider);
      start = end + 1;
    }
    data = data.subarray(start);
    // An oversized partial record is dropped; the next newline starts fresh.
    state.pending = data.length > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(data);
  }

  private record(state: TranscriptState, line: string, provider: AgentChatProvider): void {
    if (state.paths.size >= MAX_PATHS || !line.trim()) return;
    let record: unknown;
    try { record = JSON.parse(line); } catch { return; }
    const found = provider === 'codex' ? codexPaths(record, state) : claudePaths(record);
    for (const path of found) {
      if (state.paths.size >= MAX_PATHS) break;
      const absolute = absolutePath(path, provider === 'codex' ? state.cwd : cwdOf(record));
      if (absolute) state.paths.add(absolute);
    }
  }

  private remember(key: string, state: TranscriptState): void {
    this.states.delete(key);
    this.states.set(key, state);
    if (this.states.size > CACHE_LIMIT) this.states.delete(this.states.keys().next().value!);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function cwdOf(record: unknown): string | undefined {
  const cwd = asObject(record)?.cwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

function absolutePath(path: string, cwd: string | undefined): string | undefined {
  const value = path.trim();
  if (!value || value.length > 4_096 || value.includes('\0')) return undefined;
  if (isAbsolute(value)) return normalize(value);
  return cwd && isAbsolute(cwd) ? resolve(cwd, value) : undefined;
}

/** Paths named by `*** Add/Update/Delete File:` and `*** Move to:` headers. */
export function patchPaths(patch: string): string[] {
  return [...patch.matchAll(PATCH_HEADER)].map(match => match[1].trim()).filter(Boolean);
}

function codexPaths(raw: unknown, state: TranscriptState): string[] {
  const record = asObject(raw);
  const payload = asObject(record?.payload);
  if (!record || !payload) return [];
  if ((record.type === 'turn_context' || record.type === 'session_meta') && typeof payload.cwd === 'string') {
    state.cwd = payload.cwd;
    return [];
  }
  if (record.type === 'event_msg') {
    // Current Codex: one completed item per applied change set, keyed by path.
    if (payload.type === 'item_completed') {
      const item = asObject(payload.item);
      if (item?.type !== 'FileChange' || item.status === 'failed') return [];
      return changeSetPaths(item.changes);
    }
    // Earlier Codex reported the same change set as patch events.
    if (payload.type === 'patch_apply_end' && payload.success === false) return [];
    if (payload.type === 'patch_apply_begin' || payload.type === 'patch_apply_end') return changeSetPaths(payload.changes);
    return [];
  }
  if (record.type === 'response_item') {
    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && typeof payload.input === 'string') {
      return patchPaths(payload.input);
    }
    if (payload.type === 'function_call' && typeof payload.arguments === 'string'
      && (payload.name === 'apply_patch' || payload.name === 'shell')) {
      let args: unknown;
      try { args = JSON.parse(payload.arguments); } catch { return []; }
      const values = asObject(args);
      const command = Array.isArray(values?.command) ? values.command : [];
      const patch = [values?.input, values?.patch, ...(command.includes('apply_patch') ? command : [])]
        .filter((value): value is string => typeof value === 'string' && value.includes('*** Begin Patch'));
      return patch.flatMap(patchPaths);
    }
  }
  return [];
}

function changeSetPaths(raw: unknown): string[] {
  const changes = asObject(raw);
  if (!changes) return [];
  return Object.entries(changes).flatMap(([path, change]) => {
    const moved = asObject(change)?.move_path;
    return typeof moved === 'string' ? [path, moved] : [path];
  });
}

function claudePaths(raw: unknown): string[] {
  const record = asObject(raw);
  if (record?.type !== 'assistant') return [];
  const content = asObject(record.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = asObject(part);
    if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !CLAUDE_EDIT_TOOLS.has(block.name)) return [];
    const input = asObject(block.input);
    const path = input?.file_path ?? input?.notebook_path;
    return typeof path === 'string' ? [path] : [];
  });
}
