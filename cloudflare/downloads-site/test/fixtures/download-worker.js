import { onRequest } from '../../functions/download/[file].js';

const artifact = {
  file: 'test.apk', size: 6, type: 'application/vnd.android.package-archive',
  sha256: 'test-hash', parts: [{ file: 'a.part', size: 3 }, { file: 'b.part', size: 3 }],
};
export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');
    let cancelled = false;
    let partsFetched = 0;
    let background;
    const response = await onRequest({
      request,
      params: { file: decodeURIComponent(url.pathname.split('/').at(-1)) },
      waitUntil(promise) { background = promise; ctx.waitUntil(promise); },
      env: { ASSETS: { async fetch(assetUrl) {
        const name = new URL(assetUrl).pathname.split('/').at(-1);
        if (name === 'manifest.json') {
          if (mode === 'manifest-fail') return new Response('', { status: 404 });
          return Response.json({
            android: { ...artifact, size: mode === 'cancel' ? 1_000_000_000 : artifact.size },
            macos: { ...artifact, file: 'TermBridge.zip', type: 'application/zip' },
          });
        }
        partsFetched++;
        if (mode === 'cancel') return new Response(new ReadableStream({
          pull(controller) { controller.enqueue(new Uint8Array(4096)); },
          cancel() { cancelled = true; },
        }));
        if (name === 'a.part') return new Response('abc');
        // First part succeeds: exercise failure after the HTTP response begins.
        if (mode === 'part-fail') return new Response('', { status: 404 });
        if (mode === 'short-part') return new Response('de');
        if (mode === 'long-part') return new Response('defg');
        return new Response('def');
      } } },
    });
    if (mode === 'cancel') {
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
      await background;
      return Response.json({ cancelled, partsFetched });
    }
    return response;
  },
};
