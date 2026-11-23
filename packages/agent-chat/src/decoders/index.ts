import type { AgentChatProvider } from '../types.js';
import { claudeDecoder } from './claude.js';
import { codexDecoder } from './codex.js';
import type { TranscriptDecoder } from './decoder.js';

const DECODERS: Record<AgentChatProvider, TranscriptDecoder> = {
  claude: claudeDecoder,
  codex: codexDecoder,
};

export function decoderFor(provider: AgentChatProvider): TranscriptDecoder {
  return DECODERS[provider];
}

export { claudeDecoder, codexDecoder };
export type { TranscriptDecoder, DecodedMessage } from './decoder.js';
