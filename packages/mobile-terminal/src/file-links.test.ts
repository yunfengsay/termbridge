import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findFilePathLinks,
  looksLikeFilePath,
  safeSessionFilePath,
} from './external-links.js';
import { linkWrappedUnderlinedFilePaths } from './mobile-transcript.js';

test('safeSessionFilePath decodes file:// URIs and rejects unsafe schemes', () => {
  assert.equal(safeSessionFilePath('file:///Users/alice/repo/App.kt'), '/Users/alice/repo/App.kt');
  assert.equal(safeSessionFilePath('file:///Users/alice/my%20file.png#L10'), '/Users/alice/my file.png');
  assert.equal(safeSessionFilePath('~/artifacts/demo.png'), '~/artifacts/demo.png');
  assert.equal(safeSessionFilePath('apps/android-host/app/src/main/AndroidManifest.xml'), 'apps/android-host/app/src/main/AndroidManifest.xml');
  for (const rejected of [
    'javascript:alert(1)',
    'https://example.com/a.png',
    'data:text/plain,hi',
    'content://media/1',
    'intent://foo',
    '//evil.example/a',
    'file://remote.host/etc/passwd',
    'a\\b.kt',
  ]) {
    assert.equal(safeSessionFilePath(rejected), undefined, rejected);
  }
});

test('findFilePathLinks extracts bare workspace and home file paths without matching HTTP URLs', () => {
  const line = 'See https://example.com/apps/a.kt and ~/artifacts/08-demo.png, (apps/android-host/app/src/main/AndroidManifest.xml:12).';
  const links = findFilePathLinks(line);
  assert.deepEqual(links.map((item) => item.file), [
    '~/artifacts/08-demo.png',
    'apps/android-host/app/src/main/AndroidManifest.xml:12',
  ]);
  assert.equal(looksLikeFilePath('not-a-path'), false);
  assert.equal(looksLikeFilePath('apps/android-host/'), false);
});

test('linkWrappedUnderlinedFilePaths joins multi-line wrapped underlined file paths from Herdr', () => {
  const u = 'color:#79A8D8;text-decoration:underline';
  const lines = linkWrappedUnderlinedFilePaths([
    { spans: [{ text: '验收（见 ' }, { text: '~/canvas-private/artifacts/macos-', style: u }] },
    { spans: [{ text: 'showcase-cloud-sync-20261123/08-live-', style: u }] },
    { spans: [{ text: 'stream-dual-ingest.png', style: u }, { text: '），继续。' }] },
    { spans: [{ text: '权限 (' }, { text: 'apps/android-', style: u }] },
    { spans: [{ text: 'host/app/src/main/java/com/bytespost/canva', style: u }] },
    { spans: [{ text: 's/next/AndroidStreamManager.kt', style: u }, { text: ')' }] },
  ]);

  const expectedPng = '~/canvas-private/artifacts/macos-showcase-cloud-sync-20261123/08-live-stream-dual-ingest.png';
  assert.equal(lines[0].spans[1].file, expectedPng);
  assert.equal(lines[1].spans[0].file, expectedPng);
  assert.equal(lines[2].spans[0].file, expectedPng);
  assert.equal(lines[2].spans[1].file, undefined);

  const expectedKt = 'apps/android-host/app/src/main/java/com/bytespost/canvas/next/AndroidStreamManager.kt';
  assert.equal(lines[3].spans[1].file, expectedKt);
  assert.equal(lines[4].spans[0].file, expectedKt);
  assert.equal(lines[5].spans[0].file, expectedKt);
});
