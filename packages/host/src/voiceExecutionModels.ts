import { PiBailianBrainConversationService, DEFAULT_GLOBAL_EXECUTION_MODEL, type BrainConversationService } from '@termbridge/brain';
import type { SilentModelTier } from './silentExecution.js';

export const DEFAULT_VOICE_EXECUTION_MODEL = DEFAULT_GLOBAL_EXECUTION_MODEL;

/** Voice execution only: realtime audio, turn judging and Global text keep their own models. */
export function createVoiceExecutionConversations(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.TB_VOICE_EXECUTION_MODEL?.trim() || DEFAULT_VOICE_EXECUTION_MODEL;
  const create = (timeoutMs: number) => new PiBailianBrainConversationService({
    apiKey, model, baseUrl: env.DASHSCOPE_BASE_URL, timeoutMs, enableThinking: false,
  });
  return { standard: create(45_000), advanced: create(180_000), deep: create(300_000) };
}

export function selectExecutionConversation(
  input: { voiceKey?: string; workflow?: 'standard' | 'silent'; modelTier?: SilentModelTier },
  services: {
    voice: ReturnType<typeof createVoiceExecutionConversations>;
    text: BrainConversationService | undefined;
    silent: Record<SilentModelTier, BrainConversationService> | undefined;
  },
): BrainConversationService | undefined {
  const tier = input.workflow === 'silent' ? input.modelTier ?? 'advanced' : 'standard';
  if (input.voiceKey !== undefined) return services.voice?.[tier];
  return tier === 'standard' ? services.text : services.silent?.[tier];
}
