import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendFileSync } from 'node:fs';
import {
  addVoiceUsageRecord,
  appendVoiceUsage,
  estimateVoiceCostCny,
  readVoiceUsageSummary,
} from './voiceUsage.js';

const usage = {
  model: 'qwen3.5-omni-flash-realtime',
  totalTokens: 377,
  inputTokens: 336,
  outputTokens: 41,
  inputTextTokens: 228,
  inputAudioTokens: 108,
  outputTextTokens: 9,
  outputAudioTokens: 32,
  inputAudioSeconds: 1.5,
  outputAudioSeconds: 0.75,
};

test('voice usage ledger records raw token dimensions and a list-price estimate', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'termbridge-voice-usage-')), 'usage.jsonl');
  const record = appendVoiceUsage(usage, { hostId: 'host-1', clientId: 7, requestId: 'voice-1' }, path);
  assert.equal(record.estimatedCostCny, estimateVoiceCostCny(usage));
  assert.equal(record.usage.inputAudioTokens, 108);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8').trim()), record);
});

test('voice usage summary aggregates valid local records and ignores malformed lines', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'termbridge-voice-summary-')), 'usage.jsonl');
  const first = appendVoiceUsage(usage, { hostId: 'host-1', clientId: 7, requestId: 'voice-1' }, path);
  appendFileSync(path, '{not-json}\n');
  const second = appendVoiceUsage(usage, { hostId: 'host-1', clientId: 7, requestId: 'voice-2' }, path);
  const summary = readVoiceUsageSummary(path);
  assert.equal(summary.responseCount, 2);
  assert.equal(summary.totalTokens, usage.totalTokens * 2);
  assert.equal(summary.estimatedCostCny, first.estimatedCostCny + second.estimatedCostCny);
  assert.equal(summary.source, 'local_estimate');
  assert.deepEqual(addVoiceUsageRecord(readVoiceUsageSummary('/missing/voice-ledger'), first), {
    source: 'local_estimate',
    responseCount: 1,
    estimatedCostCny: first.estimatedCostCny,
    totalTokens: usage.totalTokens,
    inputAudioSeconds: usage.inputAudioSeconds,
    outputAudioSeconds: usage.outputAudioSeconds,
    updatedAt: first.at,
  });
});

test('Volcengine usage is retained without fabricating an unpublished local price', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'termbridge-volc-usage-')), 'usage.jsonl');
  const record = appendVoiceUsage(
    { ...usage, provider: 'volcengine' as const, model: '1.2.1.1' },
    { hostId: 'host-1', clientId: 7, requestId: 'voice-volc-1' },
    path,
  );
  assert.equal(record.provider, 'volcengine');
  assert.equal(record.estimatedCostCny, 0);
  assert.equal(record.usage.totalTokens, usage.totalTokens);
});
