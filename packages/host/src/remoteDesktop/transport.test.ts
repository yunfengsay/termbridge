import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDesktop, acceptDesktop } from '@termbridge/protocol';
import { sendDesktopPacket } from './transport.js';

test('a congested desktop transport waits for its write instead of dropping a partial framebuffer', async () => {
  const open = await openDesktop('transport-test-secret', 'host');
  const { cipher } = await acceptDesktop('transport-test-secret', 'host', open.open);
  const packet = await cipher.seal(new Uint8Array([0, 1, 2]));
  let complete: ((error?: Error) => void) | undefined, settled = false;
  const transport = { readyState: 1, bufferedAmount: 3 * 1024 * 1024,
    send(_data: Buffer, callback: (error?: Error) => void) { complete = callback; } };
  const pending = sendDesktopPacket(transport, 7, packet).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(complete);
  complete(); await pending; assert.equal(settled, true);
  const failed = sendDesktopPacket(transport, 7, packet);
  complete(new Error('socket closed')); await assert.rejects(failed, /socket closed/);
  transport.readyState = 3;
  await assert.rejects(sendDesktopPacket(transport, 7, packet), /disconnected/);
  cipher.close();
});
