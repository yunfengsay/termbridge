import assert from 'node:assert/strict';
import test from 'node:test';
import { voicePresentationReminder } from './voicePresentation.js';
import { waitForScreenCapture } from './screenCapture.js';

test('overlay reminder resolves visual deixis without granting access or triggering speech', () => {
  const reminder = voicePresentationReminder('overlay', 1234);
  assert.match(reminder, /<system-reminder/);
  assert.match(reminder, /这个/);
  assert.match(reminder, /screen.capture/);
  assert.match(reminder, /not screen pixels or capture permission/);
  assert.match(reminder, /do not read it aloud or respond/);
  assert.doesNotMatch(reminder, /Hidden/);
  assert.doesNotMatch(voicePresentationReminder('foreground', 1235), /in a floating overlay/);
});

test('screen capture awaits completed pixels, normalizes BigInts, and preserves handles', async () => {
  let polls = 0;
  const result = await waitForScreenCapture({ actionId: 'phone-capture', state: 'awaiting_user' }, async () => {
    polls++;
    return polls === 1 ? { state: 'running' } : { state: 'completed',
      imageAttachment: { actionId: 'brain-image-capture', assets: [{ size: 128n }] } };
  }, undefined, 1000, 0);
  assert.equal(polls, 2);
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /brain-image-capture/);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('screen capture denial, timeout and abort do not fabricate a completed result', async () => {
  const initial = { actionId: 'phone-capture', state: 'awaiting_user' };
  const denied = await waitForScreenCapture(initial, async () => ({ state: 'denied' }), undefined, 1000, 0);
  assert.equal(denied.ok, false);
  const timeout = await waitForScreenCapture(initial, async () => { throw Error('must not poll'); }, undefined, 0);
  assert.equal(timeout.state, 'awaiting_user');
  assert.equal(timeout.ok, false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(waitForScreenCapture(initial, async () => ({}), abort.signal), { name: 'AbortError' });
});
import { brainImageAttachmentContext, workerTaskWithImageAttachment, voiceImageAttachmentContext, VOICE_IMAGE_ROUTING } from './brainImageAttachments.js';

const attachment = {
  actionId: 'brain-image-1',
  deviceId: 'phone-1',
  assets: [{
    assetId: 'asset-1',
    name: 'photo.jpg',
    mime: 'image/jpeg',
    size: 42,
    sha256: 'a'.repeat(64),
  }],
};

test('image metadata is explicit that the conversation model cannot see pixels', () => {
  const context = brainImageAttachmentContext(attachment);
  assert.match(context, /metadata, not pixels/i);
  assert.match(context, /brain-image-1/);
  assert.match(context, /do not call phone_action/i);
  assert.match(context, /Use inspect_images/);
});

test('voice context routes current image questions to the fork and explicitly clears old selections', () => {
  assert.match(VOICE_IMAGE_ROUTING, /fork_execution/);
  assert.match(voiceImageAttachmentContext(attachment), /brain-image-1/);
  assert.match(voiceImageAttachmentContext(), /supersedes earlier attachment/);
  assert.doesNotMatch(voiceImageAttachmentContext(), /brain-image-1/);
});

test('worker image task carries exact pull and publish routing', () => {
  const task = workerTaskWithImageAttachment('Remove the background', attachment);
  assert.match(task, /Remove the background/);
  assert.match(task, /tb peer photo pull/);
  assert.match(task, /tb peer photo publish/);
  assert.match(task, /phone-1/);
  assert.match(task, /asset-1/);
});

test('tasks without an attachment remain unchanged', () => {
  assert.equal(workerTaskWithImageAttachment('Run tests'), 'Run tests');
  assert.equal(brainImageAttachmentContext(), '');
});
