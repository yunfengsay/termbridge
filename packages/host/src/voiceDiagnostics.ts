import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type VoiceDiagnosticValue = string | number | boolean | null | undefined;

export interface VoiceDiagnosticEvent {
  event: string;
  requestId?: string;
  clientId?: number;
  provider?: 'bailian' | 'volcengine';
  model?: string;
  fields?: Readonly<Record<string, VoiceDiagnosticValue | bigint>>;
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_STRING_CHARS = 512;

export function appendVoiceDiagnostic(
  event: VoiceDiagnosticEvent,
  path = process.env.TB_VOICE_DIAGNOSTICS_LOG ||
    join(homedir(), '.termbridge', 'logs', 'voice-events.jsonl'),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && statSync(path).size >= MAX_LOG_BYTES) truncateSync(path, 0);
  const record = {
    at: new Date().toISOString(),
    event: safeString(event.event, 80),
    ...(event.requestId ? { requestId: safeString(event.requestId, 128) } : {}),
    ...(Number.isSafeInteger(event.clientId) ? { clientId: event.clientId } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: safeString(event.model, 128) } : {}),
    ...safeFields(event.fields),
  };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

export function safeVoiceDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  return safeString(message, MAX_STRING_CHARS)
    .replace(/(token|key|secret|authorization)[=: ]+[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_\-.]{40,}/g, '[redacted]');
}

function safeFields(
  fields: VoiceDiagnosticEvent['fields'],
): Record<string, string | number | boolean | null> {
  if (!fields) return {};
  const result: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, value] of Object.entries(fields)) {
    const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
    if (!key || /token|secret|key|authorization|audio|text|prompt/i.test(key)) continue;
    if (typeof value === 'bigint') result[key] = value.toString();
    else if (typeof value === 'string') result[key] = safeString(value, MAX_STRING_CHARS);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean' || value === null) result[key] = value;
  }
  return result;
}

function safeString(value: string, max: number): string {
  return value.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}
