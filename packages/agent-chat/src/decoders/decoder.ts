import type { AgentChatMessage, AgentChatProvider } from '../types.js';

/** A message before the Host assigns it a conversation sequence number. */
export type DecodedMessage = Omit<AgentChatMessage, 'seq'>;

/**
 * One provider's versioned record format. Everything version-specific lives
 * behind this interface: the record layout is an adapter's internal detail and
 * must never become part of the cross-platform wire contract.
 */
export interface TranscriptDecoder {
  provider: AgentChatProvider;
  /** Decode one JSONL line, or null when the record carries nothing to show. */
  decode(line: string, fallbackId: string): DecodedMessage | null;
  /** The session id the record claims, used to verify a located file. */
  sessionIdOf(line: string): string | undefined;
  /**
   * The text of a genuine typed user prompt in this record, if any. Delivery
   * confirmation matches against this, never against arbitrary message text.
   */
  userPromptText(line: string): string | undefined;
}
