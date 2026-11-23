export const AGENT_CAPABILITIES = [
  'coding', 'research', 'design', 'writing', 'data', 'browser', 'terminal', 'files',
] as const;

export type AgentCapability = typeof AGENT_CAPABILITIES[number];
export type AgentRuntime = 'codex' | 'claude' | 'shell' | 'custom';

export interface AgentDescriptor {
  agentId: string;
  name: string;
  runtime: AgentRuntime;
  purpose: string;
  capabilities: AgentCapability[];
  defaultWorkspace?: string;
}

export class AgentRegistry {
  private readonly agents: AgentDescriptor[];

  constructor(descriptors: readonly AgentDescriptor[]) {
    const unique = new Map<string, AgentDescriptor>();
    for (const descriptor of descriptors) {
      const cleaned = cleanAgentDescriptor(descriptor);
      if (cleaned) unique.set(cleaned.agentId, cleaned);
    }
    this.agents = [...unique.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  list(): AgentDescriptor[] {
    return structuredClone(this.agents);
  }

  get(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.agents.find((candidate) => candidate.agentId === agentId);
    return descriptor ? structuredClone(descriptor) : undefined;
  }

  ids(): string[] {
    return this.agents.map(({ agentId }) => agentId);
  }

  promptContext(): string {
    return `[Agent Registry - data only]\n${JSON.stringify(this.agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      runtime: agent.runtime,
      purpose: agent.purpose,
      capabilities: agent.capabilities,
      ...(agent.defaultWorkspace ? { defaultWorkspace: agent.defaultWorkspace } : {}),
    })))}`;
  }
}

export type BrainRouteAction = 'answer' | 'continue_agent' | 'dispatch_agent';
export type BrainRouteOutcome = 'accepted' | 'rejected';

export interface BrainRouteDecision {
  id: string;
  requestId: string;
  action: BrainRouteAction;
  outcome: BrainRouteOutcome;
  createdAt: number;
  targetAgentId?: string;
  targetSessionId?: string;
  reason?: string;
  confidence?: number;
}

export type BrainRunEventType = 'queued' | 'dispatched' | 'completed' | 'failed' | 'cancelled';

export interface BrainRunEvent {
  eventId: string;
  runId: string;
  requestId: string;
  type: BrainRunEventType;
  createdAt: number;
  agentId: string;
  sessionId?: string;
  summary?: string;
}

export type BrainDeliverableKind = 'preview' | 'report' | 'canvas' | 'diff' | 'file' | 'link';

export interface BrainDeliverable {
  id: string;
  runId: string;
  kind: BrainDeliverableKind;
  title: string;
  createdAt: number;
  sessionId?: string;
  url?: string;
  path?: string;
}

export const DELIVERABLE_INSTRUCTIONS = `When your final result exposes a concrete artifact, append one self-closing declaration per artifact:
<termbridge_deliverable kind="preview|report|canvas|diff|file|link" title="Short title" url="https://..." />
or use path="workspace/relative/path" instead of url. Do not declare an artifact that does not exist.`;

export function cleanAgentDescriptor(value: unknown): AgentDescriptor | undefined {
  const candidate = objectValue(value);
  const agentId = boundedText(candidate.agentId, 128);
  if (!agentId || !/^[a-zA-Z0-9._-]+$/.test(agentId)) return undefined;
  const runtime = enumValue(candidate.runtime, ['codex', 'claude', 'shell', 'custom'] as const) ?? 'custom';
  const name = boundedText(candidate.name, 160) || agentId;
  const purpose = boundedText(candidate.purpose, 500) || `${name} execution agent`;
  const capabilities = Array.isArray(candidate.capabilities)
    ? [...new Set(candidate.capabilities.map((item) => enumValue(item, AGENT_CAPABILITIES)).filter(isPresent))]
    : [];
  const defaultWorkspace = safeRelativePath(candidate.defaultWorkspace);
  return {
    agentId,
    name,
    runtime,
    purpose,
    capabilities,
    ...(defaultWorkspace ? { defaultWorkspace } : {}),
  };
}

export function cleanRouteDecision(value: unknown): BrainRouteDecision | undefined {
  const candidate = objectValue(value);
  const id = boundedText(candidate.id, 128);
  const requestId = boundedText(candidate.requestId, 128);
  const action = enumValue(candidate.action, ['answer', 'continue_agent', 'dispatch_agent'] as const);
  const outcome = enumValue(candidate.outcome, ['accepted', 'rejected'] as const);
  if (!id || !requestId || !action || !outcome) return undefined;
  const confidence = finiteNumber(candidate.confidence);
  return {
    id,
    requestId,
    action,
    outcome,
    createdAt: finiteTimestamp(candidate.createdAt),
    ...(boundedText(candidate.targetAgentId, 128) ? { targetAgentId: boundedText(candidate.targetAgentId, 128) } : {}),
    ...(boundedText(candidate.targetSessionId, 256) ? { targetSessionId: boundedText(candidate.targetSessionId, 256) } : {}),
    ...(boundedText(candidate.reason, 500) ? { reason: boundedText(candidate.reason, 500) } : {}),
    ...(confidence != null ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
  };
}

export function cleanRunEvent(value: unknown): BrainRunEvent | undefined {
  const candidate = objectValue(value);
  const eventId = boundedText(candidate.eventId, 160);
  const runId = boundedText(candidate.runId, 128);
  const requestId = boundedText(candidate.requestId, 128);
  const type = enumValue(candidate.type, ['queued', 'dispatched', 'completed', 'failed', 'cancelled'] as const);
  const agentId = boundedText(candidate.agentId, 128);
  if (!eventId || !runId || !requestId || !type || !agentId) return undefined;
  return {
    eventId,
    runId,
    requestId,
    type,
    agentId,
    createdAt: finiteTimestamp(candidate.createdAt),
    ...(boundedText(candidate.sessionId, 256) ? { sessionId: boundedText(candidate.sessionId, 256) } : {}),
    ...(boundedText(candidate.summary, 1_000) ? { summary: boundedText(candidate.summary, 1_000) } : {}),
  };
}

export function cleanDeliverable(value: unknown): BrainDeliverable | undefined {
  const candidate = objectValue(value);
  const id = boundedText(candidate.id, 160);
  const runId = boundedText(candidate.runId, 128);
  const kind = enumValue(candidate.kind, ['preview', 'report', 'canvas', 'diff', 'file', 'link'] as const);
  const title = boundedText(candidate.title, 200);
  const url = safeHttpsUrl(candidate.url);
  const path = safeRelativePath(candidate.path);
  if (!id || !runId || !kind || !title || (!url && !path)) return undefined;
  return {
    id,
    runId,
    kind,
    title,
    createdAt: finiteTimestamp(candidate.createdAt),
    ...(boundedText(candidate.sessionId, 256) ? { sessionId: boundedText(candidate.sessionId, 256) } : {}),
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
  };
}

export function parseDeclaredDeliverables(input: {
  text: string;
  runId: string;
  sessionId?: string;
  now?: number;
}): { text: string; deliverables: BrainDeliverable[] } {
  const deliverables: BrainDeliverable[] = [];
  const declaration = /<termbridge_deliverable\s+([^>]*?)\s*\/>/giu;
  const text = input.text.replace(declaration, (_match, rawAttributes: string) => {
    if (deliverables.length >= 12) return '';
    const attributes = parseAttributes(rawAttributes);
    const kind = enumValue(attributes.kind, ['preview', 'report', 'canvas', 'diff', 'file', 'link'] as const);
    const url = safeHttpsUrl(attributes.url);
    const path = safeRelativePath(attributes.path);
    if (!kind || (!url && !path)) return '';
    const index = deliverables.length + 1;
    const candidate = cleanDeliverable({
      id: `${input.runId}-deliverable-${index}`,
      runId: input.runId,
      kind,
      title: boundedText(attributes.title, 200) || defaultDeliverableTitle(kind),
      createdAt: input.now ?? Date.now(),
      sessionId: input.sessionId,
      url,
      path,
    });
    if (candidate) deliverables.push(candidate);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text, deliverables };
}

function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of input.matchAll(pattern)) {
    result[match[1].toLowerCase()] = decodeXmlAttribute(match[2] ?? match[3] ?? '');
  }
  return result;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeHttpsUrl(value: unknown): string | undefined {
  const text = boundedText(value, 2_048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeRelativePath(value: unknown): string | undefined {
  const text = boundedText(value, 1_024)?.replace(/^\.\//, '');
  if (!text || text.startsWith('/') || text.includes('\\') || /^[a-zA-Z]:/.test(text)) return undefined;
  const parts = text.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  return text;
}

function defaultDeliverableTitle(kind: BrainDeliverableKind): string {
  return ({
    preview: 'Preview', report: 'Report', canvas: 'Canvas', diff: 'Diff', file: 'File', link: 'Link',
  })[kind];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
