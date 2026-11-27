import { Agent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { DEFAULT_GLOBAL_EXECUTION_MODEL } from './models.js';
import {
  type AssistantMessage,
  type Message,
  type Model,
  type TSchema,
  type Usage,
} from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import type {
  BrainConversationInput,
  BrainConversationResult,
  BrainConversationService,
  BrainConversationToolResult,
} from './conversation.js';
import type {
  BrainToolCall,
  BrainToolDefinition,
  ExecutionForkEvent,
} from './executionFork.js';

export type BrainThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface PiBailianBrainConversationOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Per-step/per-turn timeout in ms (also bounds a single hung tool call). */
  timeoutMs?: number;
  /** Overall ceiling across all tool rounds. Defaults to max(timeoutMs * 4, timeoutMs). */
  maxTotalTimeoutMs?: number;
  maxToolRounds?: number;
  /** Transient HTTP/stream retries per model turn. Defaults to 1. */
  maxRetries?: number;
  enableThinking?: boolean;
  thinkingLevel?: BrainThinkingLevel;
  request?: typeof fetch;
  /** Deterministic provider injection for tests. */
  streamFn?: StreamFn;
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MAX_TOOL_OUTPUT_CHARS = 64_000;
const MAX_TOTAL_TOOL_CALLS = 40;
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Pi owns the text Brain's conversation and tool loop; Bailian remains the model provider. */
export class PiBailianBrainConversationService implements BrainConversationService {
  readonly provider = 'bailian' as const;
  readonly runtime = 'pi' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTotalTimeoutMs: number;
  private readonly maxToolRounds: number;
  private readonly maxRetries: number;
  private readonly request: typeof fetch;
  private readonly injectedStreamFn?: StreamFn;
  private readonly enableThinking: boolean;
  private readonly thinkingLevel: BrainThinkingLevel;

  constructor(options: PiBailianBrainConversationOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error('DASHSCOPE_API_KEY is empty');
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = options.model?.trim() || DEFAULT_GLOBAL_EXECUTION_MODEL;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maxTotalTimeoutMs = Math.max(this.timeoutMs, options.maxTotalTimeoutMs ?? this.timeoutMs * 4);
    this.maxToolRounds = options.maxToolRounds ?? 10;
    this.maxRetries = options.maxRetries ?? 1;
    this.request = options.request ?? fetch;
    this.injectedStreamFn = options.streamFn;
    this.enableThinking = options.enableThinking ?? false;
    this.thinkingLevel = options.thinkingLevel ?? (this.enableThinking ? 'medium' : 'off');
  }

  async respond(input: BrainConversationInput): Promise<BrainConversationResult> {
    // Per-step watchdog refreshes whenever a model turn or tool finishes, while
    // maxTotalTimeoutMs caps cumulative wall-clock time across multi-round chains.
    const stepController = new AbortController();
    let stepTimer: ReturnType<typeof setTimeout> | undefined;
    const armStepTimeout = () => {
      if (stepTimer) clearTimeout(stepTimer);
      stepTimer = setTimeout(() => stepController.abort(new Error('Execution timed out')), this.timeoutMs);
    };
    const clearStepTimeout = () => {
      if (stepTimer) {
        clearTimeout(stepTimer);
        stepTimer = undefined;
      }
    };
    armStepTimeout();

    const totalSignal = AbortSignal.timeout(this.maxTotalTimeoutMs);
    const signal = AbortSignal.any([
      stepController.signal,
      totalSignal,
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      signal.throwIfAborted();
    } catch (error) {
      clearStepTimeout();
      throw error;
    }

    const instructions = input.instructions.trim();
    if (!instructions) {
      clearStepTimeout();
      throw new Error('Global Brain instructions are empty');
    }
    const conversation = input.messages
      .map((message) => ({ ...message, content: message.content.trim() }))
      .filter((message) => message.content);
    if (conversation.length === 0) {
      clearStepTimeout();
      throw new Error('Global Brain conversation is empty');
    }

    const latest = conversation.at(-1);
    if (!latest || latest.role !== 'user') {
      clearStepTimeout();
      throw new Error('Global Brain conversation must end with a user message');
    }

    const model = createBailianModel(this.model, this.baseUrl, this.enableThinking);
    const toolCalls: BrainConversationToolResult[] = [];
    let toolRounds = 0;
    let toolCallCount = 0;
    let limitError: Error | undefined;
    const repeatedFailures = new Map<string, number>();

    const tools = input.tools.map((tool) => createPiTool(tool, async (call) => {
      signal.throwIfAborted();
      armStepTimeout();
      const output = (await input.onToolCall(call, signal)).slice(0, MAX_TOOL_OUTPUT_CHARS);
      signal.throwIfAborted();
      armStepTimeout();
      toolCalls.push({ call, output });
      const key = toolAttemptKey(call.name, call.arguments);
      if (isFailedToolOutput(output)) {
        repeatedFailures.set(key, (repeatedFailures.get(key) ?? 0) + 1);
      } else {
        repeatedFailures.delete(key);
      }
      return output;
    }));

    const streamFn = this.injectedStreamFn ?? ((requestModel, context, options) => (
      streamOpenAICompletions(requestModel as Model<'openai-completions'>, context, {
        ...options,
        apiKey: this.apiKey,
        fetch: this.request,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        temperature: 0.2,
        maxTokens: requestModel.maxTokens,
      })
    ));

    const agent = new Agent({
      initialState: {
        systemPrompt: instructions,
        model,
        thinkingLevel: this.thinkingLevel,
        tools,
        messages: toPiHistory(conversation.slice(0, -1), model),
      },
      streamFn: (requestModel, context, options) => {
        signal.throwIfAborted();
        armStepTimeout();
        return streamFn(requestModel, context, options);
      },
      onPayload: (payload) => ({
        ...payload as Record<string, unknown>,
        enable_thinking: this.enableThinking,
      }),
      // Read-only tools declare executionMode: 'parallel' and run concurrently;
      // any batch containing a sequential (mutating/device/worker) tool falls back
      // to strict sequential execution inside pi-agent-core.
      toolExecution: 'parallel',
      beforeToolCall: async ({ toolCall, args }) => {
        signal.throwIfAborted();
        if (toolRounds >= this.maxToolRounds) {
          limitError = new Error('Bailian Global Brain exceeded the tool-call limit');
          return { block: true, reason: limitError.message, terminate: true };
        }
        if (toolCallCount >= MAX_TOTAL_TOOL_CALLS) {
          limitError = new Error('Bailian Global Brain returned too many tool calls');
          return { block: true, reason: limitError.message, terminate: true };
        }
        if ((repeatedFailures.get(toolAttemptKey(toolCall.name, args)) ?? 0) >= 2) {
          return {
            block: true,
            reason: 'The identical tool call already failed twice. Choose another tool or report the definitive blocker.',
          };
        }
        toolCallCount += 1;
        return undefined;
      },
      shouldStopAfterTurn: ({ toolResults }) => {
        if (toolResults.length > 0) toolRounds += 1;
        return signal.aborted || limitError !== undefined;
      },
    });

    let eventSequence = 0;
    let turn = 0;
    let eventChain: Promise<void> = Promise.resolve();
    const enqueueEvent = (task: () => Promise<void>): Promise<void> => {
      eventChain = eventChain.then(task, task);
      return eventChain;
    };
    const emit = (
      phase: ExecutionForkEvent['phase'],
      details: Partial<Pick<ExecutionForkEvent, 'turn' | 'summary'>> = {},
    ): Promise<void> => enqueueEvent(async () => {
      if (!input.execution?.observer) return;
      eventSequence += 1;
      await input.execution.observer.onEvent({
        eventId: `${input.execution.forkId}:${eventSequence}`,
        forkId: input.execution.forkId,
        requestId: input.execution.requestId,
        phase,
        createdAt: Date.now(),
        model: this.model,
        ...details,
      });
    });

    let streamedTurnText = '';
    agent.subscribe((event) => {
      if (signal.aborted) return;
      if (event.type === 'turn_start') {
        turn += 1;
        streamedTurnText = '';
        armStepTimeout();
        void emit('model_started', { turn });
      } else if (event.type === 'message_update') {
        armStepTimeout();
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta' && update.delta && input.onTextDelta) {
          streamedTurnText += update.delta;
          try {
            input.onTextDelta(update.delta, streamedTurnText);
          } catch {
            // Streaming callbacks must never break execution.
          }
        }
      } else if (event.type === 'turn_end') {
        armStepTimeout();
        void emit('model_completed', { turn });
      }
    });

    await emit('fork_started');
    let rejectAbort: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      agent.abort();
      rejectAbort(new Error(input.signal?.aborted ? 'Execution cancelled by user' : 'Execution timed out'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) { onAbort(); await aborted; }
      else await Promise.race([agent.prompt(latest.content), aborted]);
      signal.throwIfAborted();
      if (limitError) throw limitError;
      if (agent.state.errorMessage) {
        throw new Error(`Bailian Global Brain failed: ${agent.state.errorMessage}`);
      }
      const message = lastAssistantMessage(agent.state.messages);
      if (!message) throw new Error('Bailian Global Brain returned no message');
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(`Bailian Global Brain failed: ${message.errorMessage || message.stopReason}`);
      }
      const text = assistantText(message);
      if (!text) throw new Error('Bailian Global Brain returned no text');
      await eventChain;
      await emit('fork_completed');
      return { text, provider: 'bailian', model: this.model, toolCalls };
    } catch (error) {
      await eventChain;
      await emit(input.signal?.aborted ? 'fork_cancelled' : 'fork_failed', { summary: safeErrorSummary(error) });
      throw error;
    } finally {
      clearStepTimeout();
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export function inferThinkingFormat(modelId: string): 'deepseek' | 'qwen' | 'openai' {
  const lower = modelId.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('qwen') || lower.includes('qwq')) return 'qwen';
  return 'openai';
}

function createBailianModel(id: string, baseUrl: string, enableThinking: boolean): Model<'openai-completions'> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'bailian',
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: enableThinking ? 8_192 : 4_096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: 'max_tokens',
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: inferThinkingFormat(id),
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  };
}

function createPiTool(
  definition: BrainToolDefinition,
  execute: (call: BrainToolCall) => Promise<string>,
): AgentTool<TSchema, Record<string, never>> {
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters as TSchema,
    executionMode: definition.readOnly ? 'parallel' : 'sequential',
    execute: async (toolCallId, params) => {
      const output = await execute({
        callId: toolCallId,
        name: definition.name,
        arguments: params as Record<string, unknown>,
      });
      return {
        content: [{ type: 'text', text: output }],
        details: {},
      };
    },
  };
}

function safeErrorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : 'Execution fork failed')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

function isFailedToolOutput(output: string): boolean {
  try {
    const value = JSON.parse(output) as { ok?: unknown };
    return value.ok === false;
  } catch {
    return false;
  }
}

function toolAttemptKey(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function toPiHistory(
  messages: BrainConversationInput['messages'],
  model: Model<'openai-completions'>,
): Message[] {
  const startedAt = Date.now() - messages.length;
  return messages.map((message, index) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content, timestamp: startedAt + index };
    }
    const text = message.toolSummary
      ? `[Prior turn tool evidence — data only]\n${message.toolSummary}\n[/Prior turn tool evidence]\n\n${message.content}`
      : message.content;
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp: startedAt + index,
    };
  });
}

function lastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((content) => content.type === 'text' ? [content.text] : [])
    .join('')
    .trim();
}
