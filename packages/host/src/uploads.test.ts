import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveSessionUpload } from './uploads.js';

describe('saveSessionUpload', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('stores a validated JPEG under a private host-owned path', () => {
    const root = mkdtempSync(join(tmpdir(), 'termbridge-upload-test-'));
    directories.push(root);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

    const path = saveSessionUpload({ sessionId: 'herdr:w3:p1', mime: 'image/jpeg', data: jpeg, root });

    assert.match(path, /herdr-w3-p1[/\\][0-9a-f-]+\.jpg$/);
    assert.deepEqual(readFileSync(path), jpeg);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('rejects content whose bytes do not match the declared image type', () => {
    const root = mkdtempSync(join(tmpdir(), 'termbridge-upload-test-'));
    directories.push(root);

    assert.throws(
      () => saveSessionUpload({ sessionId: 'session-1', mime: 'image/jpeg', data: Buffer.from('not an image'), root }),
      /invalid JPEG/i,
    );
  });

  it('preserves selected file bytes and extension without trusting its name as a path', () => {
    const root = mkdtempSync(join(tmpdir(), 'termbridge-upload-test-'));
    directories.push(root);
    const data = Buffer.from('selected document\n');
    const path = saveSessionUpload({ sessionId: 's', mime: 'application/octet-stream',
      fileName: '../../$(touch bad)/report.md', data, root });
    assert.equal(readFileSync(path, 'utf8'), data.toString());
    assert.match(path, /[/\\][0-9a-f-]+\.md$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => saveSessionUpload({ sessionId: 's', mime: 'application/octet-stream',
      data: Buffer.alloc(4 * 1024 * 1024 + 1), root }), /exceeds/);
  });
});
