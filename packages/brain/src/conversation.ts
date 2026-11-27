import {
  PiBailianBrainConversationService,
  type PiBailianBrainConversationOptions,
} from './piConversation.js';
import type {
  BrainToolCall,
  BrainToolDefinition,
  ExecutionForkContext,
} from './executionFork.js';

export type BrainConversationRole = 'user' | 'assistant';

export interface BrainConversationMessage {
  role: BrainConversationRole;
  content: string;
  /** Compact structured summary of verified tool outcomes produced on this assistant turn. */
  toolSummary?: string;
}

export interface BrainConversationInput {
  signal?: AbortSignal;
  instructions: string;
  messages: BrainConversationMessage[];
  tools: BrainToolDefinition[];
  onToolCall(call: BrainToolCall, signal?: AbortSignal): Promise<string>;
  /** Optional incremental text delta callback for streaming Global text replies. */
  onTextDelta?(delta: string, fullText: string): void;
  execution?: ExecutionForkContext;
}

export interface BrainConversationToolResult {
  call: BrainToolCall;
  output: string;
}

export interface BrainConversationResult {
  text: string;
  provider: 'bailian';
  model: string;
  toolCalls: BrainConversationToolResult[];
}

export interface BrainConversationService {
  readonly provider: 'bailian';
  readonly model: string;
  readonly runtime: 'pi';
  respond(input: BrainConversationInput): Promise<BrainConversationResult>;
}

/** Compatibility name for consumers; the implementation is now Pi-backed. */
export { PiBailianBrainConversationService as BailianBrainConversationService };
export type BailianBrainConversationOptions = PiBailianBrainConversationOptions;

export function createBrainConversationService(
  env: NodeJS.ProcessEnv = process.env,
): BrainConversationService | undefined {
  const provider = (env.TB_BRAIN_PROVIDER || 'bailian').trim().toLowerCase();
  if (provider === 'local') {
    throw new Error('Global Brain does not support a local conversation provider; use Bailian tools to delegate work');
  }
  if (provider !== 'bailian' && provider !== 'auto') {
    throw new Error(`Unknown TB_BRAIN_PROVIDER ${provider}`);
  }
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const enableThinking = env.TB_BRAIN_THINKING
    ? ['on', 'true', '1'].includes(env.TB_BRAIN_THINKING.trim().toLowerCase())
    : false;
  return new PiBailianBrainConversationService({
    apiKey,
    baseUrl: env.DASHSCOPE_BASE_URL,
    model: env.TB_BRAIN_MODEL,
    timeoutMs: positiveInteger(env.TB_BRAIN_TIMEOUT_MS),
    enableThinking,
  });
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
