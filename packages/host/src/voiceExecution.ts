import { createHash } from 'node:crypto';

/** A late/missing subtitle must not merge two different provider tool calls.
 * Hash the tuple rather than truncate a suffix on a possibly 128-character id. */
export function voiceExecutionRequestId(voiceRequestId: string, callId: string): string {
  return `voice-exec-${createHash('sha256').update(JSON.stringify([voiceRequestId, callId])).digest('hex')}`;
}
