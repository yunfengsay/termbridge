/**
 * Locate the structured transcript for an already-running Agent session.
 *
 * Two rules hold everywhere here. Herdr's own session reference is preferred:
 * when it reports `kind: 'path'` that path is the authority and nothing is
 * derived. And a derived path is only accepted after the file states the same
 * session id — never because it is the newest file, sits in a matching cwd, or
 * has a promising name. Failing to locate a transcript is a reported downgrade,
 * not a guess. A record that simply has not been written yet is reported as
 * pending rather than failed, so the caller can wait for exactly that file.
 *
 * The on-disk layouts below are a versioned adapter detail. They are internal
 * to this file and never travel to a client.
 */

import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentChatProvider } from '@termbridge/agent-chat';
import { decoderFor } from '@termbridge/agent-chat';

/** Herdr's `agent_session` reference, as its snapshot reports it. */
export interface AgentSessionRef {
  kind?: string;
  source?: string;
  value?: string;
}

export interface LocatedTranscript {
  path: string;
  provider: AgentChatProvider;
}

export interface LocateFailure {
  reason: string;
  /**
   * Nothing contradicts the identity; the record just is not there yet — a
   * session that has not had its first turn writes no file. Only a file that
   * names a different session, or an identity that cannot be one, is final.
   */
  pending?: true;
}

export type LocateResult = LocatedTranscript | LocateFailure;

export function isLocated(result: LocateResult): result is LocatedTranscript {
  return 'path' in result;
}

/** How many leading records may be scanned while verifying a session id. */
const VERIFY_RECORD_LIMIT = 400;
const VERIFY_BYTES = 512 * 1024;
/** Codex stores rollouts under year/month/day; nothing deeper is walked. */
const CODEX_SCAN_DEPTH = 3;
const CODEX_SCAN_DIRS = 8;

export interface LocateOptions {
  provider: AgentChatProvider;
  providerSessionId: string;
  sessionRef?: AgentSessionRef;
  cwd?: string;
  /** Overridable for tests; production always resolves the real home. */
  home?: string;
}

export async function locateTranscript(options: LocateOptions): Promise<LocateResult> {
  const { provider, providerSessionId } = options;
  if (!isSessionId(providerSessionId)) {
    return { reason: '该会话没有可用的 Agent 会话标识，无法定位结构化记录。' };
  }
  const home = options.home ?? homedir();

  // 1. Herdr's own reference wins when it names a file.
  if (options.sessionRef?.kind === 'path' && options.sessionRef.value) {
    const path = options.sessionRef.value;
    const verdict = await verifyTranscript(path, provider, providerSessionId);
    if (verdict === 'match') return { path, provider };
    if (verdict === 'unwritten') return { reason: 'Herdr 报告的记录文件还没有写入内容。', pending: true };
    return { reason: 'Herdr 报告的记录文件与该会话标识不一致，已停用对话模式。' };
  }

  // 2. Derive candidates, then verify each against the session's own id.
  const candidates = provider === 'claude'
    ? await claudeCandidates(home, providerSessionId, options.cwd)
    : await codexCandidates(home, providerSessionId);
  let contradicted = false;
  for (const path of candidates) {
    const verdict = await verifyTranscript(path, provider, providerSessionId);
    if (verdict === 'match') return { path, provider };
    if (verdict === 'mismatch') contradicted = true;
  }
  return {
    reason: provider === 'claude'
      ? '没有找到与该会话标识匹配的 Claude 记录文件。'
      : '没有找到与该会话标识匹配的 Codex 记录文件。',
    ...(contradicted ? {} : { pending: true as const }),
  };
}

/**
 * Claude stores one file per session under a per-workspace directory whose name
 * is the workspace path with separators replaced. The cwd Herdr reports gives
 * the exact directory; a bounded one-level scan covers a session that started
 * in a different directory. Either way the file must claim the same session id.
 */
async function claudeCandidates(home: string, sessionId: string, cwd?: string): Promise<string[]> {
  const root = join(home, '.claude', 'projects');
  const candidates: string[] = [];
  if (cwd) candidates.push(join(root, claudeProjectSlug(cwd), `${sessionId}.jsonl`));
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    const path = join(root, entry, `${sessionId}.jsonl`);
    if (!candidates.includes(path)) candidates.push(path);
  }
  return candidates;
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}

/**
 * Codex names each rollout after its own session id inside a dated directory.
 * Newest dates are visited first purely to shorten the walk — the id inside the
 * file, not its position, is what accepts it.
 *
 * A time-ordered (v7) id names its own day, so that directory is read first.
 * Without it, a resumed session older than the walk's reach would look like one
 * that has not written its record yet, and be shown as an empty conversation.
 */
async function codexCandidates(home: string, sessionId: string): Promise<string[]> {
  const root = join(home, '.codex', 'sessions');
  const found: string[] = [];
  for (const day of codexDaysOf(sessionId)) {
    const directory = join(root, ...day);
    try {
      const name = (await readdir(directory)).find((entry) => entry.endsWith(`${sessionId}.jsonl`));
      if (name) return [join(directory, name)];
    } catch {
      // No rollouts that day; the walk below still runs.
    }
  }
  await walk(root, CODEX_SCAN_DEPTH);
  return found;

  async function walk(directory: string, depth: number): Promise<void> {
    if (found.length > 0) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of names) {
      if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
        found.push(join(directory, entry.name));
        return;
      }
    }
    if (depth <= 0) return;
    let visited = 0;
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      if (visited++ >= CODEX_SCAN_DIRS) return;
      await walk(join(directory, entry.name), depth - 1);
      if (found.length > 0) return;
    }
  }
}

/**
 * The `YYYY/MM/DD` directories a v7 session id can live in. Its leading 48 bits
 * are the creation time; Codex files the rollout under that day in its own
 * local time, so the neighbouring days cover a Host running in another zone.
 */
export function codexDaysOf(sessionId: string): string[][] {
  const hex = sessionId.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || hex[12] !== '7') return [];
  const created = parseInt(hex.slice(0, 12), 16);
  const day = 86_400_000;
  return [created, created - day, created + day].map((at) => {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, '0');
    return [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())];
  });
}

/** Accept only the id shapes both CLIs emit, so no path fragment can slip in. */
function isSessionId(value: string): boolean {
  return /^[0-9a-fA-F][0-9a-fA-F-]{19,79}$/.test(value) && !value.includes('..');
}

/**
 * What a file says about the session it is supposed to hold.
 *
 * `unwritten` covers both an absent file and one that has not yet written a
 * record naming any session — an Agent creates its record lazily, and a file
 * caught mid-creation is empty or holds half a line. Neither contradicts the
 * identity, so neither is final. Only a file that names another session is.
 */
type TranscriptVerdict = 'match' | 'mismatch' | 'unwritten';

/**
 * Confirm the file itself claims this session. Reads a bounded prefix only: the
 * identity record sits at the head of both formats.
 */
async function verifyTranscript(
  path: string,
  provider: AgentChatProvider,
  providerSessionId: string,
): Promise<TranscriptVerdict> {
  const decoder = decoderFor(provider);
  try {
    if (!(await stat(path)).isFile()) return 'mismatch';
  } catch {
    return 'unwritten';
  }
  const stream = createReadStream(path, { start: 0, end: VERIFY_BYTES - 1, encoding: 'utf8' });
  let buffered = '';
  let records = 0;
  let namesAnother = false;
  const verdictOf = (line: string): TranscriptVerdict | undefined => {
    const claimed = decoder.sessionIdOf(line);
    if (claimed === providerSessionId) return 'match';
    if (claimed) namesAnother = true;
    return undefined;
  };
  const settled = (): TranscriptVerdict => (namesAnother ? 'mismatch' : 'unwritten');
  try {
    for await (const chunk of stream) {
      buffered += chunk as string;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (verdictOf(line) === 'match') return 'match';
        if (++records >= VERIFY_RECORD_LIMIT) return settled();
        newline = buffered.indexOf('\n');
      }
    }
    if (buffered && verdictOf(buffered) === 'match') return 'match';
    return settled();
  } catch {
    return settled();
  } finally {
    stream.destroy();
  }
}
