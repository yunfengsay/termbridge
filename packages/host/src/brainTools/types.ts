import type {
  AgentDescriptor,
  BrainTask,
  BrainToolCall,
  BrainToolDefinition,
  BrainToolDescriptor,
} from '@termbridge/brain';
import type { AgentCompletionEvent, AgentContextRecord, AgentUserMessageEvent } from '../contextIndex.js';
import type { WorkspaceFileAction, WorkspaceFileOptions } from '../workspaceFiles.js';
import type { PhoneActionRequest } from '../phoneActions.js';
import type { StructuredAgentTranscript } from '../brain/agentTranscriptSummary.js';

export const MAX_TOOL_TEXT_CHARS = 16_000;
export const MAX_RECENT_TASKS = 20;
export const MAX_VIEW_ITEMS = 8;

export interface VoiceToolViewItem {
  id: string;
  title: string;
  subtitle?: string;
  detail?: string;
  status?: string;
  timestamp?: number;
  sessionId?: string;
  source?: 'pty' | 'herdr';
}

export interface VoiceToolView {
  kind: 'agent_list' | 'completion_list' | 'task_list' | 'agent' | 'receipt';
  title: string;
  items: VoiceToolViewItem[];
}

export type BrainMemoryAction = 'read' | 'search' | 'upsert' | 'remove';

export interface ControlToolEnvironment {
  now(): number;
  refreshAgents(): Promise<void>;
  listAgents(): AgentContextRecord[];
  listAgentProfiles(): AgentDescriptor[];
  recentCompletions(): AgentCompletionEvent[];
  recentUserMessages?(): AgentUserMessageEvent[];
  /** Optional verified structured transcript tail for a Claude/Codex session. */
  readAgentTranscript?(sessionId: string): Promise<StructuredAgentTranscript | undefined>;
  listTasks(): BrainTask[];
  searchWeb(query: string): Promise<Record<string, unknown>>;
  inspectImages(question: string, assetIds?: string[]): Promise<Record<string, unknown>>;
  workspaceFiles(action: WorkspaceFileAction, path: string, options?: WorkspaceFileOptions): Promise<Record<string, unknown>>;
  brainMemory?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  phoneAction(request: PhoneActionRequest, callId: string): Promise<Record<string, unknown>>;
  homeAssistant(args: Record<string, unknown>, callId: string): Promise<Record<string, unknown>>;
  dispatchAgent(task: string, agent: string | undefined, callId: string): Promise<Record<string, unknown>>;
  continueAgent(sessionId: string, text: string): Promise<Record<string, unknown>>;
  cancelExecution(id: string): Promise<Record<string, unknown>>;
  completionReviews?(): Promise<Record<string, unknown>>;
  toolScript?(args: Record<string, unknown>, callId: string): Promise<Record<string, unknown>>;
}

export interface ControlToolProgress {
  phase: 'started' | 'completed' | 'failed';
  summary: string;
}

export type VoiceToolResult = Record<string, unknown>;

export interface ControlToolRegistration {
  definition: BrainToolDefinition;
  descriptor: BrainToolDescriptor;
  execute(environment: ControlToolEnvironment, call: BrainToolCall): Promise<VoiceToolResult>;
  progress: {
    started(call: BrainToolCall): string;
    completed(call: BrainToolCall, result: VoiceToolResult): string;
    failed: string;
  };
  /** Optional native presentation for a successful result. */
  ui?: (call: BrainToolCall, result: VoiceToolResult) => VoiceToolView | undefined;
}

export function registerControlTool(
  definition: BrainToolDefinition,
  descriptor: Omit<BrainToolDescriptor, 'name' | 'description'>,
  behavior: Omit<ControlToolRegistration, 'definition' | 'descriptor'>,
): ControlToolRegistration {
  return {
    definition,
    descriptor: { name: definition.name, description: definition.description, ...descriptor },
    ...behavior,
  };
}

export function resultCount(result: VoiceToolResult): number {
  return typeof result.count === 'number' && Number.isFinite(result.count)
    ? Math.max(0, Math.floor(result.count))
    : 0;
}

export function stringArgument(call: BrainToolCall, name: string, required = true): string {
  const value = typeof call.arguments[name] === 'string' ? call.arguments[name].trim() : '';
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

export function numberArgument(call: BrainToolCall, name: string): number | undefined {
  const value = call.arguments[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

export function isViewItem(item: VoiceToolViewItem | undefined): item is VoiceToolViewItem {
  return Boolean(item);
}

export function viewText(value: unknown, maxChars: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars)
    : '';
}

export function sessionSource(value: unknown, sessionId: string): 'pty' | 'herdr' | undefined {
  if (value === 'pty' || value === 'herdr') return value;
  return sessionId.startsWith('herdr:') ? 'herdr' : undefined;
}

export function dateTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return numberTimestamp(value);
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function numberTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function inlineArgument(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    : '';
}

export function cleanToolText(value: string, maxChars: number): string {
  return value.replace(/\u0000/g, '').slice(-maxChars);
}

export function preferredRecordName(record: AgentContextRecord): string {
  return record.name || record.workspace || record.agent || record.command || record.sessionId;
}

export function countNames(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return counts;
}

export function takeIfDifferent(value: string, other: string): string {
  return value && value.toLocaleLowerCase() !== other.toLocaleLowerCase() ? value : '';
}
