import { stat } from 'node:fs/promises';
import { decoderFor, type AgentChatMessage, type AgentChatProvider } from '@termbridge/agent-chat';
import { isLocated, locateTranscript, type AgentSessionRef } from '../agentChat/transcriptLocator.js';
import { readTranscriptRange } from '../agentChat/incrementalReader.js';

export interface StructuredAgentTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text?: string;
  tools?: string[];
  hasError?: boolean;
  timestamp?: string;
}

export interface StructuredAgentTranscript {
  provider: AgentChatProvider;
  recentTurns: StructuredAgentTurn[];
}

const TAIL_WINDOW_BYTES = 96 * 1024;
const MAX_TURNS = 6;
const MAX_TEXT_PER_TURN = 600;

/**
 * Reads a bounded structured tail of a Claude/Codex Herdr session's transcript
 * using the verified Agent Chat locator and decoders (no terminal scraping, no
 * raw paths, no model reasoning, and no credentials).
 */
export async function readStructuredAgentTranscript(input: {
  agent?: string;
  providerSessionId?: string;
  sessionRef?: AgentSessionRef;
  cwd?: string;
  home?: string;
}): Promise<StructuredAgentTranscript | undefined> {
  const provider = normalizeProvider(input.agent);
  if (!provider || !input.providerSessionId) return undefined;

  const located = await locateTranscript({
    provider,
    providerSessionId: input.providerSessionId,
    sessionRef: input.sessionRef,
    cwd: input.cwd,
    home: input.home,
  });
  if (!isLocated(located)) return undefined;

  try {
    const info = await stat(located.path);
    if (!info.isFile() || info.size === 0) return undefined;
    const start = Math.max(0, info.size - TAIL_WINDOW_BYTES);
    const { lines } = await readTranscriptRange(located.path, start, info.size);
    const decoder = decoderFor(provider);
    const decoded: AgentChatMessage[] = [];
    for (const entry of lines) {
      const message = decoder.decode(entry.line, `${provider}:${entry.offset}`);
      if (message) decoded.push({ ...message, seq: entry.offset });
    }
    if (decoded.length === 0) return undefined;
    const recentTurns = decoded.slice(-MAX_TURNS).map(summarizeMessage).filter(Boolean) as StructuredAgentTurn[];
    return recentTurns.length > 0 ? { provider, recentTurns } : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProvider(agent: string | undefined): AgentChatProvider | undefined {
  const lower = agent?.trim().toLowerCase();
  if (lower === 'codex' || lower === 'claude') return lower;
  return undefined;
}

function summarizeMessage(message: AgentChatMessage): StructuredAgentTurn | undefined {
  const textParts: string[] = [];
  const tools: string[] = [];
  let hasError = false;
  for (const block of message.blocks) {
    if (block.type === 'text') {
      const trimmed = block.text.trim();
      if (trimmed) textParts.push(trimmed);
    } else if (block.type === 'tool-call') {
      tools.push(block.name);
    } else if (block.type === 'tool-result') {
      if (block.isError) hasError = true;
    } else if (block.type === 'image-ref') {
      textParts.push('[image]');
    }
  }
  const text = textParts.join('\n').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_PER_TURN);
  if (!text && tools.length === 0) return undefined;
  return {
    role: message.role,
    ...(text ? { text } : {}),
    ...(tools.length > 0 ? { tools: [...new Set(tools)].slice(0, 8) } : {}),
    ...(hasError ? { hasError: true } : {}),
    ...(typeof message.timestamp === 'number' ? { timestamp: new Date(message.timestamp).toISOString() } : {}),
  };
}
