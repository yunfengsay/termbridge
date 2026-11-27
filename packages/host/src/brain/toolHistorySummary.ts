import type {
  BrainConversationMessage,
  BrainMessage,
  BrainToolResult,
} from '@termbridge/brain';
import { selectVoiceContextMessages } from '../voicePrompt.js';

const MAX_TOOL_SUMMARY_CHARS = 900;
const MAX_TURNS_WITH_TOOL_SUMMARIES = 3;

/**
 * Builds bounded conversation messages for Pi while retaining compact structured
 * tool-result summaries for the most recent assistant turns so multi-turn follow-ups
 * remember exact sessionIds, file paths, and tool outcomes.
 */
export function buildConversationHistoryMessages(
  messages: BrainMessage[],
  toolResults: BrainToolResult[] = [],
  currentInputText: string,
  extraSummariesByRequest?: ReadonlyMap<string, string>,
): BrainConversationMessage[] {
  const selected = selectVoiceContextMessages(messages).slice(-12);
  const byRequest = new Map<string, BrainToolResult[]>();
  for (const result of toolResults) {
    const list = byRequest.get(result.requestId) ?? [];
    list.push(result);
    byRequest.set(result.requestId, list);
  }

  // Only annotate the last few assistant turns to keep token usage lean.
  const assistantIndices: number[] = [];
  selected.forEach((message, index) => {
    if (message.role === 'brain') assistantIndices.push(index);
  });
  const recentAssistantSet = new Set(assistantIndices.slice(-MAX_TURNS_WITH_TOOL_SUMMARIES));

  const out: BrainConversationMessage[] = selected.map((message, index) => {
    if (message.role !== 'brain') {
      return { role: 'user', content: message.text };
    }
    let toolSummary: string | undefined;
    if (recentAssistantSet.has(index)) {
      const requestId = requestIdFromBrainMessageId((message as BrainMessage).id);
      if (requestId) {
        toolSummary = formatTurnToolSummary(
          byRequest.get(requestId),
          extraSummariesByRequest?.get(requestId),
        );
      }
    }
    return {
      role: 'assistant',
      content: message.text,
      ...(toolSummary ? { toolSummary } : {}),
    };
  });

  const trimmed = currentInputText.trim();
  if (out.at(-1)?.role !== 'user' || out.at(-1)?.content !== trimmed) {
    out.push({ role: 'user', content: trimmed });
  }
  return out;
}

/** Compact one-turn summary recorded right after a fork completes (captures tools without UI cards like workspace_files / search_web / brain_memory). */
export function summarizeForkToolCalls(
  toolCalls: ReadonlyArray<{ call: { name: string; arguments: Record<string, unknown> }; output: string }>,
): string | undefined {
  if (toolCalls.length === 0) return undefined;
  const lines: string[] = [];
  for (const { call, output } of toolCalls.slice(-6)) {
    const parsed = safeJson(output);
    const ok = parsed?.ok !== false;
    const detail = summarizeToolOutcome(call.name, call.arguments, parsed);
    lines.push(`- ${call.name} (${ok ? 'ok' : 'failed'}): ${detail}`);
  }
  const joined = lines.join('\n').trim();
  return joined ? joined.slice(0, MAX_TOOL_SUMMARY_CHARS) : undefined;
}

function formatTurnToolSummary(
  results: BrainToolResult[] | undefined,
  extraSummary: string | undefined,
): string | undefined {
  if (extraSummary) return extraSummary.slice(0, MAX_TOOL_SUMMARY_CHARS);
  if (!results || results.length === 0) return undefined;
  const lines = results.slice(-4).map((result) => {
    const items = result.view.items.slice(0, 4).map((item) => {
      const idPart = item.sessionId ? ` [${item.sessionId}]` : '';
      const statusPart = item.status ? ` (${item.status})` : '';
      return `${item.title}${idPart}${statusPart}`;
    });
    return `- ${result.toolName}: ${items.join('; ') || result.view.title}`;
  });
  const joined = lines.join('\n').trim();
  return joined ? joined.slice(0, MAX_TOOL_SUMMARY_CHARS) : undefined;
}

function requestIdFromBrainMessageId(id: string | undefined): string | undefined {
  if (!id || !id.endsWith('-brain')) return undefined;
  return id.slice(0, -'-brain'.length) || undefined;
}

function summarizeToolOutcome(
  toolName: string,
  args: Record<string, unknown>,
  parsed: Record<string, unknown> | undefined,
): string {
  if (!parsed) return 'returned non-JSON';
  if (parsed.ok === false) return String(parsed.error || 'failed').slice(0, 140);
  if (toolName === 'workspace_files') {
    const action = String(parsed.action || args.action || 'read');
    const path = String(parsed.path || args.path || '');
    if (action === 'search') {
      const matches = Array.isArray(parsed.matches) ? parsed.matches.slice(0, 4) as Array<{ path?: string; line?: number }> : [];
      return `search "${String(parsed.query || '')}" in ${path} -> ${Number(parsed.count ?? 0)} hits (${matches.map((m) => `${m.path}:${m.line}`).join(', ')})`;
    }
    if (action === 'read') {
      const range = parsed.startLine ? ` L${parsed.startLine}-${parsed.endLine}` : '';
      return `read ${path}${range}`;
    }
    return `${action} ${path}`;
  }
  if (toolName === 'inspect_workspace') {
    const view = String(parsed.view || args.view || '');
    if (view === 'overview' && Array.isArray(parsed.agents)) {
      const agents = (parsed.agents as Array<{ name?: string; sessionId?: string; status?: string }>).slice(0, 5)
        .map((a) => `${a.name || a.sessionId}[${a.sessionId}](${a.status})`);
      return `overview (${parsed.count}): ${agents.join(', ')}`;
    }
    if (view === 'agent' && parsed.agent && typeof parsed.agent === 'object') {
      const a = parsed.agent as { name?: string; sessionId?: string; status?: string };
      return `agent ${a.name || a.sessionId}[${a.sessionId}] (${a.status})`;
    }
    return `${view} (count=${Number(parsed.count ?? 0)})`;
  }
  if (toolName === 'brain_memory') {
    return `${String(args.action || 'memory')} ${String(parsed.section || args.query || '')}`.trim();
  }
  if (toolName === 'search_web') {
    return `query="${String(args.query || '').slice(0, 80)}"`;
  }
  if (toolName === 'continue_agent') {
    return `sent to ${String(parsed.name || parsed.sessionId || args.sessionId || '')}`;
  }
  if (toolName === 'dispatch_agent') {
    return `dispatched ${String(parsed.agent || '')} task=${String(parsed.taskId || '')}`;
  }
  return String(parsed.status || parsed.summary || 'ok').slice(0, 140);
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
