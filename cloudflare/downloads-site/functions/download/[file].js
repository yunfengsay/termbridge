// Serve only artifacts in the public release manifest, streaming Pages-sized parts.
function assetUrl(request, file) {
  return new URL(`/downloads/${encodeURIComponent(file)}`, request.url);
}
async function streamParts(request, env, artifact, writable) {
  try {
    for (const part of artifact.parts) {
      const chunk = await env.ASSETS.fetch(assetUrl(request, part.file));
      if (!chunk.ok || !chunk.body) {
        await chunk.body?.cancel();
        throw new Error('Artifact part unavailable');
      }
      // Keep byte forwarding inside the runtime. A JS read/enqueue loop over a
      // large release can exhaust Pages CPU time and terminate the HTTP stream.
      await chunk.body.pipeTo(writable, { preventClose: true });
    }
    const writer = writable.getWriter();
    try { await writer.close(); } finally { writer.releaseLock(); }
  } catch (error) {
    // pipeTo releases its lock and propagates client cancellation to the active
    // part. Stop here; never fetch the remaining parts after a failed transfer.
    await writable.abort(error).catch(() => {});
    throw error;
  }
}
export async function onRequest(context) {
  const { request, env, params } = context;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  try {
    const response = await env.ASSETS.fetch(assetUrl(request, 'manifest.json'));
    if (!response.ok) throw new Error('Release manifest unavailable');
    const manifest = await response.json();
    const artifact = [manifest.android, manifest.macos, manifest.windows].find(item => item?.file === String(params.file));
    if (!artifact) return new Response('Not found', { status: 404 });
    const headers = {
      'Content-Type': artifact.type,
      'Content-Disposition': `attachment; filename="${artifact.file}"`,
      'Content-Length': String(artifact.size),
      'Cache-Control': 'public, max-age=3600',
      'ETag': `"${artifact.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { headers });
    if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers });
    // Workers ignores Content-Length on arbitrary ReadableStreams. A fixed-length
    // response gives updaters a total and makes a short download fail at HTTP level
    // instead of appearing complete and later failing signature verification.
    const { readable, writable } = new FixedLengthStream(artifact.size);
    context.waitUntil(streamParts(request, env, artifact, writable).catch(error => {
      console.error('Artifact download failed', artifact.file, error.message);
    }));
    return new Response(readable, { headers });
  } catch {
    return new Response('Download temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
