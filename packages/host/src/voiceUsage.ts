import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RealtimeUsage } from '@termbridge/voice';

export interface VoiceUsageRecord {
  at: string;
  hostId: string;
  clientId: number;
  requestId: string;
  provider: 'bailian' | 'volcengine';
  usage: RealtimeUsage;
  estimatedCostCny: number;
}

export interface VoiceUsageSummary {
  source: 'local_estimate';
  responseCount: number;
  estimatedCostCny: number;
  totalTokens: number;
  inputAudioSeconds: number;
  outputAudioSeconds: number;
  updatedAt?: string;
}

export function appendVoiceUsage(
  usage: RealtimeUsage,
  context: { hostId: string; clientId: number; requestId: string },
  path = process.env.TB_VOICE_USAGE_LEDGER || join(homedir(), '.termbridge', 'voice-usage.jsonl'),
): VoiceUsageRecord {
  const record: VoiceUsageRecord = {
    at: new Date().toISOString(),
    ...context,
    provider: usage.provider ?? 'bailian',
    usage,
    estimatedCostCny: estimateVoiceCostCny(usage),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return record;
}

export function readVoiceUsageSummary(
  path = process.env.TB_VOICE_USAGE_LEDGER || join(homedir(), '.termbridge', 'voice-usage.jsonl'),
): VoiceUsageSummary {
  let summary = emptyVoiceUsageSummary();
  if (!existsSync(path)) return summary;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as VoiceUsageRecord;
      if (!validVoiceUsageRecord(record)) continue;
      summary = addVoiceUsageRecord(summary, record);
    } catch {
      // A partially-written or unrelated line must not break the settings screen.
    }
  }
  return summary;
}

export function addVoiceUsageRecord(
  summary: VoiceUsageSummary,
  record: VoiceUsageRecord,
): VoiceUsageSummary {
  return {
    source: 'local_estimate',
    responseCount: summary.responseCount + 1,
    estimatedCostCny: Number((summary.estimatedCostCny + record.estimatedCostCny).toFixed(8)),
    totalTokens: summary.totalTokens + record.usage.totalTokens,
    inputAudioSeconds: Number((summary.inputAudioSeconds + record.usage.inputAudioSeconds).toFixed(3)),
    outputAudioSeconds: Number((summary.outputAudioSeconds + record.usage.outputAudioSeconds).toFixed(3)),
    updatedAt: record.at,
  };
}

function emptyVoiceUsageSummary(): VoiceUsageSummary {
  return {
    source: 'local_estimate',
    responseCount: 0,
    estimatedCostCny: 0,
    totalTokens: 0,
    inputAudioSeconds: 0,
    outputAudioSeconds: 0,
  };
}

function validVoiceUsageRecord(value: VoiceUsageRecord): boolean {
  return Boolean(
    value &&
    typeof value.at === 'string' &&
    Number.isFinite(value.estimatedCostCny) &&
    value.estimatedCostCny >= 0 &&
    value.usage &&
    Number.isFinite(value.usage.totalTokens) &&
    Number.isFinite(value.usage.inputAudioSeconds) &&
    Number.isFinite(value.usage.outputAudioSeconds),
  );
}

/** Current list-price estimate only; the DashScope bill remains authoritative. */
export function estimateVoiceCostCny(usage: RealtimeUsage): number {
  // Volcengine publishes direct S2S-O usage as combined voice/text tokens, but
  // its public overview does not expose a stable list-price rate. Preserve the
  // usage record without showing a fabricated local cost estimate.
  if (usage.provider === 'volcengine') return 0;
  const inputText = usage.inputTextTokens * 3.3;
  const inputAudio = usage.inputAudioTokens * 27;
  const outputAudio = usage.outputAudioTokens * 107;
  // Realtime audio pricing includes its paired transcript. Pure-text tool output uses the text rate.
  const outputText = usage.outputAudioTokens === 0 ? usage.outputTextTokens * 20 : 0;
  return Number(((inputText + inputAudio + outputText + outputAudio) / 1_000_000).toFixed(8));
}
