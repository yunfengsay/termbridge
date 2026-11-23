import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptDesktop, openDesktop } from './desktopCrypto.js';
const secret = 'desktop-test-secret-do-not-use';
test('desktop accepts the configured four-character connection password and still rejects wrong credentials', async () => {
  const handshake = await openDesktop('2468', 'mini');
  await assert.rejects(acceptDesktop('8642', 'mini', handshake.open), /authentication/);
  const host = await acceptDesktop('2468', 'mini', handshake.open);
  const client = await handshake.finish(host.ready);
  const packet = await client.seal(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await host.cipher.open(packet), new Uint8Array([1, 2, 3]));
  await assert.rejects(openDesktop('', 'mini'));
});
test('desktop handshake binds Host and keys; duplex packets reject replay and cross-session substitution', async () => {
  const first = await openDesktop(secret, 'host-1');
  await assert.rejects(acceptDesktop(secret, 'host-2', first.open));
  await assert.rejects(acceptDesktop('another-long-test-secret', 'host-1', first.open));
  const server = await acceptDesktop(secret, 'host-1', first.open);
  const client = await first.finish(server.ready);
  const packet = await client.seal(new TextEncoder().encode('pointer event'));
  assert.equal(new TextDecoder().decode(await server.cipher.open(packet)), 'pointer event');
  await assert.rejects(server.cipher.open(packet), /replay/);
  assert.equal(new TextDecoder().decode(await client.open(await server.cipher.seal(new TextEncoder().encode('frame')))), 'frame');
  const other = await openDesktop(secret, 'host-1');
  await assert.rejects(other.finish(server.ready));
  client.close(); await assert.rejects(client.seal(new Uint8Array()));
});
test('ciphertext tampering poisons the session and never releases unauthenticated data', async () => {
  const first = await openDesktop(secret, 'host'); const server = await acceptDesktop(secret, 'host', first.open); const client = await first.finish(server.ready);
  const packet = await client.seal(new Uint8Array([1, 2, 3]));
  await assert.rejects(server.cipher.open({ ...packet, data: 'AAAA' }));
  await assert.rejects(server.cipher.open(packet));
});
