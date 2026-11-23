import { PiBailianBrainConversationService, DEFAULT_GLOBAL_EXECUTION_MODEL } from '@termbridge/brain';

export type SilentModelTier = 'advanced' | 'deep';

/** Host-owned allowlist: clients select a tier, never an endpoint or credential. */
export function createSilentConversations(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.TB_SILENT_MODEL?.trim() || DEFAULT_GLOBAL_EXECUTION_MODEL;
  return {
    advanced: new PiBailianBrainConversationService({ apiKey, model, baseUrl: env.DASHSCOPE_BASE_URL,
      timeoutMs: 180_000, enableThinking: false }),
    deep: new PiBailianBrainConversationService({ apiKey, model: env.TB_SILENT_DEEP_MODEL?.trim() || model,
      baseUrl: env.DASHSCOPE_BASE_URL, timeoutMs: 300_000, enableThinking: false }),
  };
}

/** Jobs belong to the Global conversation, not the transient phone connection. */
export class SilentExecutions {
  private readonly active = new Map<string, AbortController>();
  start(requestId: string): AbortSignal {
    if (this.active.has(requestId)) throw new Error('Silent request is already running');
    const controller = new AbortController();
    this.active.set(requestId, controller);
    return controller.signal;
  }
  cancel(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort(new Error('Cancelled by user; already dispatched workers are independent tasks'));
    return true;
  }
  finish(requestId: string): void { this.active.delete(requestId); }
}
