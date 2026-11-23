import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { learningStatus } from './voiceLearning.js';
test('CLI training status does not disclose phone identity or reviewed text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-learning-status-'));
  try {
    await writeFile(join(dir, `${'a'.repeat(64)}.json`), JSON.stringify({ samples: [{ text: 'private-speech' }],
      result: { t: 'voice_learning_result', requestId: randomUUID(), revision: 1, status: 'completed' } }));
    const result = await learningStatus(dir);
    assert.equal(result.profiles[0].status, 'completed');
    assert.doesNotMatch(JSON.stringify(result), /private-speech/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
