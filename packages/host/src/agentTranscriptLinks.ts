import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { decoderFor, type AgentChatProvider } from '@termbridge/agent-chat';
import { isLocated, locateTranscript, type AgentSessionRef } from './agentChat/transcriptLocator.js';
import { safeExternalHttpUrl } from './httpLinks.js';

export interface TranscriptLink {
  text: string;
  href: string;
}

export interface AgentTranscriptIdentity {
  agent?: string;
  agentSessionId?: string;
  agentSessionRef?: AgentSessionRef & { agent?: string };
  cwd?: string;
}

const READ_TAIL_BYTES = 8 * 1024 * 1024;
const VERIFY_BYTES = 512 * 1024;
const MAX_MESSAGES = 64;
const MAX_LINKS = 200;
const CACHE_LIMIT = 128;
const rolloutPaths = new Map<string, string>();
const cachedLinks = new Map<string, { stamp: string; links: TranscriptLink[] }>();

/** The exact record file Herdr identifies for an Agent, before its contents are checked. */
export interface IdentityTranscript {
  provider: AgentChatProvider;
  path: string;
  /** The provider session id the record must state, when the identity names one. */
  sessionId?: string;
  key: string;
}

/**
 * Find the record for an Agent identity without guessing. A path-valued Herdr
 * reference is used as given; an id is located and verified by the locator.
 * The caller still checks the session id the file itself states.
 */
export async function locateIdentityTranscript(
  identity: AgentTranscriptIdentity,
  options: { home?: string } = {},
): Promise<IdentityTranscript | undefined> {
  const provider = (identity.agentSessionRef?.agent ?? identity.agent)?.toLowerCase();
  if (provider !== 'codex' && provider !== 'claude') return undefined;
  const reference = identity.agentSessionRef;
  const sessionId = validSessionId(identity.agentSessionId) ? identity.agentSessionId
    : reference?.kind === 'id' && validSessionId(reference.value) ? reference.value : undefined;
  const namedPath = reference?.kind === 'path' ? reference.value : undefined;
  // A path-valued Herdr reference is not a UUID. Its own record header supplies
  // the identity; never guess a file from cwd or the newest conversation.
  if (namedPath ? !isAbsolute(namedPath) : !sessionId) return undefined;
  const key = JSON.stringify([provider, options.home ?? homedir(), sessionId, namedPath]);
  let path = namedPath ?? rolloutPaths.get(key);
  if (!path) {
    const located = await locateTranscript({ provider, providerSessionId: sessionId!,
      sessionRef: reference, cwd: identity.cwd, home: options.home });
    if (!isLocated(located)) return undefined;
    path = located.path;
    remember(rolloutPaths, key, path);
  }
  return { provider, path, sessionId, key };
}

/** Forget a located record that turned out to be unreadable or not this session's. */
export function forgetIdentityTranscript(key: string): void {
  rolloutPaths.delete(key);
}

/** The session id a record states in its leading lines, if it states one. */
export function claimedSessionId(prefix: string, provider: AgentChatProvider): string | undefined {
  const decoder = decoderFor(provider);
  return prefix.split('\n').slice(0, 400).map(line => decoder.sessionIdOf(line)).find(id => validSessionId(id));
}

/** Recover only web-link metadata from the exact record identified by Herdr. */
export async function resolveLocalAgentTranscriptLinks(
  identity: AgentTranscriptIdentity,
  options: { home?: string } = {},
): Promise<TranscriptLink[]> {
  let target: IdentityTranscript | undefined;
  try {
    target = await locateIdentityTranscript(identity, options);
    if (!target) return [];
    const { provider, path, sessionId, key: identityKey } = target;
    const handle = await open(path, 'r');
    try {
      const file = await handle.stat();
      if (!file.isFile()) return [];
      const stamp = `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
      const prior = cachedLinks.get(identityKey);
      if (prior?.stamp === stamp) return prior.links;
      const prefix = Buffer.alloc(Math.min(file.size, VERIFY_BYTES));
      const { bytesRead: prefixBytes } = await handle.read(prefix, 0, prefix.length, 0);
      const claimed = claimedSessionId(prefix.subarray(0, prefixBytes).toString('utf8'), provider);
      if (!claimed || (sessionId && claimed !== sessionId)) return [];
      const length = Math.min(file.size, READ_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, file.size - length);
      let tail = buffer.subarray(0, bytesRead).toString('utf8');
      if (file.size > length) tail = tail.slice(Math.max(0, tail.indexOf('\n') + 1));
      const links = linksFromRolloutTail(tail, provider);
      remember(cachedLinks, identityKey, { stamp, links });
      return links;
    } finally { await handle.close(); }
  } catch {
    if (target) {
      forgetIdentityTranscript(target.key);
      cachedLinks.delete(target.key);
    }
    return [];
  }
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export function extractMarkdownHttpLinks(text: string): TranscriptLink[] {
  const links: TranscriptLink[] = [];
  const seen = new Set<string>();
  const pattern = /\[([^\]\r\n]{1,256})\]\((https?:\/\/[^\s)]+)\)/giu;
  for (const match of text.matchAll(pattern)) {
    const label = match[1].trim();
    const href = safeExternalHttpUrl(match[2]);
    if (!label || !href) continue;
    const key = `${label}\u0000${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: label, href });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function linksFromRolloutTail(tail: string, provider: AgentChatProvider): TranscriptLink[] {
  const texts: string[] = [];
  const lines = tail.split('\n');
  const decoder = decoderFor(provider);
  for (let index = lines.length - 1; index >= 0 && texts.length < MAX_MESSAGES; index -= 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (record?.channel === 'analysis' || record?.payload?.channel === 'analysis') continue;
      const message = decoder.decode(lines[index], String(index));
      if (message?.role !== 'assistant') continue;
      for (const block of message.blocks) {
        if (block.type === 'text') texts.push(block.text);
      }
    } catch {
      // A concurrently-written final JSONL line is retried after the file grows.
    }
  }
  return extractMarkdownHttpLinks(texts.join('\n'));
}

function validSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{20,80}$/i.test(value);
}
