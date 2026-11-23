import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createAndroidArtifactTestReceiver } from '@termbridge/settings';
import { inspectAttachedImages, createImageDescriber } from './imageInspection.js';

const bytes = Buffer.from('synthetic image fixture');
const attachment = { actionId: 'selected-1', deviceId: 'phone-1', assets: [{
  assetId: 'image-1', name: 'fixture.png', mime: 'image/png', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}] };

function setup() {
  let current = true;
  let reads = 0;
  let inferences = 0;
  return {
    counters: () => ({ reads, inferences }),
    revoke: () => { current = false; },
    options: {
      attachment, question: '这是什么？', isCurrent: () => current,
      async readAsset(args: Record<string, unknown>) {
        reads++;
        assert.equal(args.actionId, attachment.actionId);
        assert.equal(args.deviceId, attachment.deviceId);
        assert.equal(args.assetId, 'image-1');
        const crypto = createAndroidArtifactTestReceiver(String(args.clientPublicKey), String(args.salt));
        return { ok: true, data: { encrypted: true, phonePublicKey: crypto.receiverPublicKey,
          ...crypto.encrypt('image-1', 0, bytes), nextOffset: BigInt(bytes.length), size: BigInt(bytes.length),
          sha256: attachment.assets[0].sha256, eof: true } };
      },
      async describe(images: Array<{ url: string }>, question: string) {
        inferences++;
        assert.equal(question, '这是什么？');
        assert.equal(images[0].url, `data:image/png;base64,${bytes.toString('base64')}`);
        return { text: '测试图片', model: 'vision-test' };
      },
    },
  };
}

test('selected encrypted photo reaches vision and returns a JSON-safe result without pixels', async () => {
  const s = setup();
  const result = await inspectAttachedImages(s.options);
  assert.equal(result.text, '测试图片');
  assert.equal(result.status, 'completed');
  assert.deepEqual(s.counters(), { reads: 1, inferences: 1 });
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes('base64'));
});

test('no attachment, stale selection and unselected IDs cannot reach phone or cloud', async () => {
  const s = setup();
  await assert.rejects(inspectAttachedImages({ ...s.options, attachment: undefined }), /attach/i);
  await assert.rejects(inspectAttachedImages({ ...s.options, assetIds: ['other'] }), /selected/i);
  s.revoke();
  await assert.rejects(inspectAttachedImages(s.options), /changed/i);
  assert.deepEqual(s.counters(), { reads: 0, inferences: 0 });
});

test('tampered hash, oversize and discontinuous chunks never reach inference', async () => {
  const s = setup();
  await assert.rejects(inspectAttachedImages({ ...s.options, attachment: { ...attachment,
    assets: [{ ...attachment.assets[0], sha256: 'b'.repeat(64) }] } }), /integrity/i);
  await assert.rejects(inspectAttachedImages({ ...s.options, attachment: { ...attachment,
    assets: [{ ...attachment.assets[0], size: 40 * 1024 * 1024 }] } }), /size/i);
  await assert.rejects(inspectAttachedImages({ ...s.options, readAsset: async args => {
    const response = await s.options.readAsset(args);
    return { ...response, data: { ...response.data, nextOffset: 9007199254740993n } };
  } }), /integer/i);
  assert.equal(s.counters().inferences, 0);
});

test('revocation during inference discards the obsolete answer', async () => {
  const s = setup();
  await assert.rejects(inspectAttachedImages({ ...s.options, describe: async () => {
    s.revoke(); return { text: 'obsolete', model: 'test' };
  } }), /changed/i);
});

test('vision request uses real image_url content and keeps credentials and pixels out of the result', async () => {
  const describe = createImageDescriber({ DASHSCOPE_API_KEY: 'test-secret' }, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'qwen-vl-plus');
    assert.equal(body.messages[1].content[2].image_url.url, 'data:image/png;base64,AAAA');
    assert.equal(body.messages[1].content[0].text, 'what is this');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    return Response.json({ choices: [{ message: { content: 'a picture' } }] });
  });
  assert.deepEqual(await describe([{ assetId: 'test', url: 'data:image/png;base64,AAAA' }], 'what is this', AbortSignal.timeout(1000)),
    { text: 'a picture', model: 'qwen-vl-plus' });
});

test('provider errors never return raw response payloads or claim success', async () => {
  const describe = createImageDescriber({ DASHSCOPE_API_KEY: 'test-secret' }, async () =>
    new Response('private echoed image bytes', { status: 403 }));
  await assert.rejects(describe([], 'what is this', AbortSignal.timeout(1000)), /^Error: Image understanding service returned HTTP 403$/);
});
