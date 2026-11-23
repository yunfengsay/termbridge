import type { BrainRouteDecision } from '@termbridge/brain';
import type { RealtimeToolCall } from '@termbridge/voice';

export function createToolRouteDecision(input: {
  id: string;
  requestId: string;
  call: RealtimeToolCall;
  output: string;
  now: number;
}): BrainRouteDecision | undefined {
  const action = input.call.name === 'continue_agent'
    ? 'continue_agent' as const
    : input.call.name === 'dispatch_agent'
      ? 'dispatch_agent' as const
      : undefined;
  if (!action) return undefined;

  const result = parseToolOutput(input.output);
  const argument = (name: string): unknown => input.call.arguments[name];
  return {
    id: input.id,
    requestId: input.requestId,
    action,
    outcome: result && result.ok !== false ? 'accepted' : 'rejected',
    createdAt: input.now,
    targetAgentId: action === 'dispatch_agent' ? text(result?.agent) ?? text(argument('agent')) : undefined,
    targetSessionId: action === 'continue_agent'
      ? text(result?.sessionId) ?? text(argument('sessionId'))
      : text(result?.sessionId),
    reason: text(argument('reason')),
    confidence: typeof argument('confidence') === 'number' ? argument('confidence') as number : undefined,
  };
}

export function createAnswerRouteDecision(input: {
  id: string;
  requestId: string;
  now: number;
}): BrainRouteDecision {
  return {
    id: input.id,
    requestId: input.requestId,
    action: 'answer',
    outcome: 'accepted',
    createdAt: input.now,
  };
}

function parseToolOutput(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
