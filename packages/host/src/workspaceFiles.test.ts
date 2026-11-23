import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceFiles } from './workspaceFiles.js';

function fixture(): { files: WorkspaceFiles; root: string; memory: string } {
  const dir = mkdtempSync(join(tmpdir(), 'termbridge-workspace-files-'));
  const root = join(dir, 'code');
  const memory = join(dir, 'memory.md');
  mkdirSync(join(root, 'termbridge'), { recursive: true });
  writeFileSync(join(root, 'termbridge', 'README.md'), '# TermBridge\nSafe project context.');
  writeFileSync(join(root, '.env'), 'SECRET=do-not-read');
  writeFileSync(memory, '# Memory\nUse concise code.');
  return { files: new WorkspaceFiles(root, memory), root, memory };
}

test('workspace files lists safe project entries and reads bounded text plus Memory', async () => {
  const { files } = fixture();
  const listed = await files.execute('list', '.');
  assert.deepEqual(listed.entries, [{ name: 'termbridge', type: 'directory' }]);

  const read = await files.execute('read', 'termbridge/README.md');
  assert.equal(read.text, '# TermBridge\nSafe project context.');
  assert.equal(read.truncated, false);

  const memory = await files.execute('read', '@memory');
  assert.equal(memory.text, '# Memory\nUse concise code.');
});

test('workspace files blocks traversal, secrets, binary data, and escaping symlinks', async () => {
  const { files, root, memory } = fixture();
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  symlinkSync(memory, join(root, 'outside.md'));

  await assert.rejects(files.execute('read', '../memory.md'), /outside the configured project root/i);
  await assert.rejects(files.execute('read', '.env'), /sensitive/i);
  await assert.rejects(files.execute('read', 'binary.dat'), /binary/i);
  await assert.rejects(files.execute('read', 'outside.md'), /outside the configured project root/i);
});
