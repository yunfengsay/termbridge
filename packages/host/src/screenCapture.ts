import { setTimeout as delay } from 'node:timers/promises';
import { jsonSafeValue } from './jsonSafe.js';

/** Wait for actual pixels, not the initial awaiting_user acknowledgement. */
export async function waitForScreenCapture(
  initial: Record<string, unknown>,
  readStatus: (actionId: string) => Promise<unknown>,
  signal?: AbortSignal,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<Record<string, unknown>> {
  let result = initial;
  const deadline = Date.now() + timeoutMs;
  while (['awaiting_user', 'running'].includes(String(result.state))) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) return { ...result, ok: false, retryable: false,
      error: 'Screen capture is still awaiting consent or completion. Do not invent pixels or repeat capture; check this action ID.' };
    await delay(intervalMs, undefined, { signal });
    const value = jsonSafeValue(await readStatus(String(initial.actionId)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, state: 'failed', error: 'Invalid screen capture receipt' };
    }
    result = value as Record<string, unknown>;
  }
  return { ...result, ok: result.state === 'completed' };
}
