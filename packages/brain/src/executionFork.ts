export interface BrainToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Safe for concurrent execution when a turn invokes multiple read-only tools. */
  readOnly?: boolean;
}

export interface BrainToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type BrainToolCategory = 'context' | 'web' | 'files' | 'device' | 'agent';
export type BrainToolExecution = 'direct' | 'worker';
export type BrainToolApproval = 'none' | 'device';

/** Public, safe metadata derived from the Host's authoritative tool registry. */
export interface BrainToolDescriptor {
  name: string;
  label: string;
  description: string;
  category: BrainToolCategory;
  execution: BrainToolExecution;
  approval: BrainToolApproval;
}

export type ExecutionForkPhase =
  | 'fork_started'
  | 'model_started'
  | 'model_completed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'fork_completed'
  | 'fork_cancelled'
  | 'fork_failed';

/** Durable UI-facing lifecycle fact. It deliberately excludes prompts, secrets and model reasoning. */
export interface ExecutionForkEvent {
  workflow?: 'standard' | 'silent';
  eventId: string;
  forkId: string;
  requestId: string;
  phase: ExecutionForkPhase;
  createdAt: number;
  model?: string;
  turn?: number;
  callId?: string;
  toolName?: string;
  summary?: string;
}

export interface ExecutionForkObserver {
  onEvent(event: ExecutionForkEvent): void | Promise<void>;
}

export interface ExecutionForkContext {
  forkId: string;
  requestId: string;
  observer?: ExecutionForkObserver;
}

export function cleanExecutionForkEvent(value: unknown): ExecutionForkEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ExecutionForkEvent>;
  const eventId = compact(candidate.eventId, 160);
  const forkId = compact(candidate.forkId, 128);
  const requestId = compact(candidate.requestId, 128);
  const phase = candidate.phase;
  if (!eventId || !forkId || !requestId || !isExecutionForkPhase(phase)) return undefined;
  const createdAt = finiteNonNegativeInteger(candidate.createdAt);
  if (createdAt === undefined) return undefined;
  return {
    eventId,
    forkId,
    requestId,
    phase,
    ...(candidate.workflow === 'silent' || candidate.workflow === 'standard' ? { workflow: candidate.workflow } : {}),
    createdAt,
    ...(compact(candidate.model, 128) ? { model: compact(candidate.model, 128) } : {}),
    ...(finiteNonNegativeInteger(candidate.turn) !== undefined
      ? { turn: finiteNonNegativeInteger(candidate.turn) }
      : {}),
    ...(compact(candidate.callId, 128) ? { callId: compact(candidate.callId, 128) } : {}),
    ...(compact(candidate.toolName, 128) ? { toolName: compact(candidate.toolName, 128) } : {}),
    ...(compact(candidate.summary, 512) ? { summary: compact(candidate.summary, 512) } : {}),
  };
}

function isExecutionForkPhase(value: unknown): value is ExecutionForkPhase {
  return value === 'fork_started'
    || value === 'model_started'
    || value === 'model_completed'
    || value === 'tool_started'
    || value === 'tool_completed'
    || value === 'tool_failed'
    || value === 'fork_completed'
    || value === 'fork_cancelled'
    || value === 'fork_failed';
}

function compact(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
