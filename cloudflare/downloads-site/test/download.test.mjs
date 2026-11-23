import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

// Node's Response preserves a manually set Content-Length on any stream.
// Test over HTTP in workerd, which drops it unless the stream has a fixed length.
const server = createTestHarness({ workers: [{ config: {
  name: 'download-test',
  main: fileURLToPath(new URL('./fixtures/download-worker.js', import.meta.url)),
  compatibility_date: '2026-09-04',
} }] });
let origin;
before(async () => { origin = (await server.listen()).url; }, { timeout: 15_000 });
after(async () => { await server.close(); });
function request({ method = 'GET', file = 'test.apk', mode = '', headers = {} } = {}) {
  const url = new URL(`/download/${encodeURIComponent(file)}`, origin);
  url.searchParams.set('mode', mode);
  return fetch(url, { method, headers, signal: AbortSignal.timeout(10_000) });
}

test('HTTP download reports total size and streams parts in order', async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="test.apk"');
  assert.equal(await response.text(), 'abcdef');
});
test('HEAD reports size without opening a part', async () => {
  const response = await request({ method: 'HEAD', mode: 'part-fail' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(await response.text(), '');
});
test('unknown files and arbitrary paths are rejected', async () => {
  assert.equal((await request({ file: 'unknown.apk' })).status, 404);
  assert.equal((await request({ file: '../secret' })).status, 404);
});
test('unsupported methods and unavailable manifests fail explicitly', async () => {
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal((await request({ mode: 'manifest-fail' })).status, 503);
});
for (const mode of ['part-fail', 'short-part', 'long-part']) {
  test(`${mode} terminates the download instead of returning partial success`, async () => {
    await assert.rejects(async () => {
      const response = await request({ mode });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.arrayBuffer();
    });
  });
}
test('matching ETag returns not modified', async () => {
  assert.equal((await request({ headers: { 'If-None-Match': '"test-hash"' } })).status, 304);
});
test('client cancellation stops the active part and does not fetch later parts', async () => {
  const response = await request({ mode: 'cancel' });
  assert.deepEqual(await response.json(), { cancelled: true, partsFetched: 1 });
});
test('Mac artifacts use the same stream with their own filename and MIME', async () => {
  const response = await request({ file: 'TermBridge.zip' });
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="TermBridge.zip"');
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(await response.text(), 'abcdef');
});
