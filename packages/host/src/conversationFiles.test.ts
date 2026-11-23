import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationFiles, patchPaths } from './conversationFiles.js';

const codexId = '44444444-4444-4444-8444-444444444444';
const claudeId = '55555555-5555-4555-8555-555555555555';
const line = (value: unknown) => JSON.stringify(value) + '\n';

test('Codex file changes, older patch events and apply_patch calls all name their files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-conversation-codex-'));
  try {
    const path = join(home, 'rollout.jsonl');
    await writeFile(path, [
      line({ type: 'session_meta', payload: { id: codexId, cwd: '/work/app' } }),
      line({ type: 'turn_context', payload: { cwd: '/work/app', model: 'x' } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed',
        changes: { '/work/app/src/a.ts': { type: 'update', unified_diff: '@@', move_path: '/work/app/src/b.ts' } } } } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'failed',
        changes: { '/work/app/never.ts': { type: 'add', content: '' } } } } }),
      line({ type: 'event_msg', payload: { type: 'patch_apply_end', success: true,
        changes: { '/work/other/README.md': { update: {} } } } }),
      line({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: docs/new.md\n+hello\n*** Delete File: /work/app/old.txt\n*** End Patch' } }),
      line({ type: 'response_item', payload: { type: 'function_call', name: 'shell',
        arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Update File: lib/x.py\n*** End Patch'] }) } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'rm -rf build' } } }),
    ].join(''));
    const identity = { agent: 'codex', agentSessionId: codexId, agentSessionRef: { kind: 'path', value: path } };
    const files = new ConversationFiles({ home });
    assert.deepEqual((await files.touchedPaths(identity)).sort(), [
      '/work/app/docs/new.md', '/work/app/lib/x.py', '/work/app/old.txt',
      '/work/app/src/a.ts', '/work/app/src/b.ts', '/work/other/README.md',
    ]);

    // Later turns are read from where the last call stopped, including a
    // record that was only half written the first time.
    const next = line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange',
      status: 'completed', changes: { '/work/app/later.ts': { type: 'add', content: 'x' } } } } });
    await appendFile(path, next.slice(0, 40));
    assert.equal((await files.touchedPaths(identity)).includes('/work/app/later.ts'), false);
    await appendFile(path, next.slice(40));
    assert.equal((await files.touchedPaths(identity)).includes('/work/app/later.ts'), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Claude edit tools name their files; reads and shell commands do not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-conversation-claude-'));
  try {
    const path = join(home, 'session.jsonl');
    const tool = (name: string, input: Record<string, unknown>) => line({ type: 'assistant', sessionId: claudeId, cwd: '/repo',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: name, name, input }] } });
    await writeFile(path, [
      line({ type: 'user', sessionId: claudeId, cwd: '/repo', message: { role: 'user', content: 'hi' } }),
      tool('Edit', { file_path: '/repo/src/main.swift', old_string: 'a', new_string: 'b' }),
      tool('Write', { file_path: 'notes/plan.md', content: '#' }),
      tool('MultiEdit', { file_path: '/repo/src/other.swift', edits: [] }),
      tool('NotebookEdit', { notebook_path: '/repo/analysis.ipynb', new_source: '' }),
      tool('Read', { file_path: '/repo/README.md' }),
      tool('Bash', { command: 'echo hi > /repo/generated.txt' }),
    ].join(''));
    const files = new ConversationFiles({ home });
    const identity = { agent: 'claude', agentSessionId: claudeId, agentSessionRef: { kind: 'path', value: path } };
    assert.deepEqual((await files.touchedPaths(identity)).sort(), [
      '/repo/analysis.ipynb', '/repo/notes/plan.md', '/repo/src/main.swift', '/repo/src/other.swift',
    ]);
    // A different session id named by Herdr never borrows this record.
    assert.deepEqual(await files.touchedPaths({ ...identity, agentSessionId: codexId.replace(/4/g, '6') }), []);
    // A replaced record at the same path starts over instead of keeping old files.
    await writeFile(path, line({ type: 'user', sessionId: claudeId, cwd: '/repo', message: { role: 'user', content: 'new' } }));
    assert.deepEqual(await files.touchedPaths(identity), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('patch headers include moves and ignore patch bodies', () => {
  assert.deepEqual(patchPaths([
    '*** Begin Patch', '*** Update File: a.txt', '*** Move to: b.txt', '+*** Add File: not-a-header.txt', '*** End Patch',
  ].join('\n')), ['a.txt', 'b.txt']);
});
