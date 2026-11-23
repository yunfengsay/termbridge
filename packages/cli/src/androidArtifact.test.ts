import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAndroidArtifactSender,
  createAndroidArtifactTestReceiver,
  describeAndroidArtifact,
  readAndroidArtifactChunks,
} from './androidArtifact.js';
import { androidPeerRetryAction } from './peer.js';

describe('Android artifact transport', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('describes and chunks an APK without loading the whole file', () => {
    const root = mkdtempSync(join(tmpdir(), 'tb-android-artifact-'));
    roots.push(root);
    const path = join(root, 'app debug.apk');
    const content = Buffer.from('APK'.repeat(80_000));
    writeFileSync(path, content);

    const descriptor = describeAndroidArtifact(path);
    const chunks = [...readAndroidArtifactChunks(path, 64 * 1024)];

    assert.equal(descriptor.name, 'app-debug.apk');
    assert.equal(descriptor.size, content.length);
    assert.equal(descriptor.sha256.length, 64);
    assert.deepEqual(Buffer.concat(chunks.map((chunk) => chunk.data)), content);
    assert.deepEqual(chunks.map((chunk) => chunk.offset), [0, 65_536, 131_072, 196_608]);
  });

  it('encrypts every chunk end to end with authenticated offsets', () => {
    const sender = createAndroidArtifactSender();
    const receiver = createAndroidArtifactTestReceiver(sender.senderPublicKey, sender.salt);
    const plaintext = Buffer.from('signed apk bytes');
    const encrypted = sender.encrypt(receiver.receiverPublicKey, 'artifact-1', 4096, plaintext);

    assert.deepEqual(
      receiver.decrypt('artifact-1', 4096, plaintext.length, encrypted.iv, encrypted.ciphertext),
      plaintext,
    );
    assert.throws(
      () => receiver.decrypt('artifact-1', 0, plaintext.length, encrypted.iv, encrypted.ciphertext),
      /authenticate|auth|bad decrypt/i,
    );
  });

  it('decrypts a phone-to-CLI chunk with the same authenticated channel', () => {
    const client = createAndroidArtifactSender();
    const phone = createAndroidArtifactTestReceiver(client.senderPublicKey, client.salt);
    const plaintext = Buffer.from('selected photo bytes');
    const encrypted = phone.encrypt('asset-1', 8192, plaintext);

    assert.deepEqual(
      client.decrypt(phone.receiverPublicKey, 'asset-1', 8192, plaintext.length, encrypted.iv, encrypted.ciphertext),
      plaintext,
    );
    assert.throws(
      () => client.decrypt(phone.receiverPublicKey, 'asset-1', 0, plaintext.length, encrypted.iv, encrypted.ciphertext),
      /authenticate|auth|bad decrypt/i,
    );
  });

  it('resumes an APK upload after transient peer disconnects', () => {
    assert.equal(androidPeerRetryAction('artifact.chunk', 'no client attached to this session', false), 'retry');
    assert.equal(androidPeerRetryAction('artifact.chunk', 'tool timed out after 35000ms', false), 'retry');
    assert.equal(androidPeerRetryAction('artifact.chunk', 'artifact chunk offset mismatch', true), 'accepted');
    assert.equal(androidPeerRetryAction('artifact.commit', 'artifact upload is not active', true), 'accepted');
    assert.equal(androidPeerRetryAction('phone.photo.publish.chunk', 'edited photo chunk offset mismatch', true), 'accepted');
    assert.equal(androidPeerRetryAction('phone.photo.publish.commit', 'edited photo upload is not active', true), 'accepted');
    assert.equal(androidPeerRetryAction('artifact.chunk', 'APK SHA-256 verification failed', true), 'fail');
  });
});
