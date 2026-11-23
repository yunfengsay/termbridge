import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendVoiceDiagnostic, safeVoiceDiagnosticError } from './voiceDiagnostics.js';

test('voice diagnostics are JSON-safe and omit sensitive or content fields', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'termbridge-voice-diagnostics-')), 'events.jsonl');
  appendVoiceDiagnostic({
    event: 'ready',
    requestId: 'voice-1',
    provider: 'volcengine',
    model: '1.2.1.1',
    fields: {
      connectLatencyMs: 420,
      eventId: 9_223_372_036_854_775_807n,
      transcriptText: 'must not be logged',
      accessToken: 'must-not-leak',
    },
  }, path);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal(record.provider, 'volcengine');
  assert.equal(record.eventId, '9223372036854775807');
  assert.equal(record.connectLatencyMs, 420);
  assert.equal(record.transcriptText, undefined);
  assert.equal(record.accessToken, undefined);
});

test('voice diagnostic errors redact credential-shaped values', () => {
  assert.equal(
    safeVoiceDiagnosticError(new Error('AccessToken=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop')),
    'AccessToken=[redacted]',
  );
});
