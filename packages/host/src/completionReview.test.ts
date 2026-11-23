import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCompletion } from './completionReview.js';
test('evidence review tool boundary rejects writes, shell and private files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-review-files-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'result.md'), '# Evidence'); await writeFile(join(dir, '.env'), 'secret');
  const result = await reviewCompletion({ runtime: 'pi', provider: 'bailian', model: 'test', respond: async request => {
    assert.deepEqual(request.tools.map(tool => tool.name), ['review_files']);
    const call = (name: string, operation: string, path: string) => request.onToolCall({ callId: 'test', name, arguments: { operation, path } });
    assert.match(await call('review_files', 'read', 'result.md'), /# Evidence/);
    assert.match(await call('review_files', 'read', '.env'), /unavailable/);
    assert.match(await call('review_files', 'read', '../outside.md'), /unavailable/);
    await assert.rejects(call('review_files', 'write', 'result.md'));
    await assert.rejects(call('bash', 'read', 'result.md'));
    return { text: 'Needs tests', provider: 'bailian', model: 'test', toolCalls: [] };
  } }, { event: { sessionId: 'a', source: 'pty', command: 'codex', currentStatus: 'done', completedAt: 1, summary: 'Done' }, candidates: [] }, dir, new AbortController().signal);
  assert.equal(result, 'Needs tests');
});
