import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyAppcast } from '../scripts/verify-appcast.mjs';

function fixture(expanded = false) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const archive = Buffer.from('signed fixture archive');
  const release = { version: '0.3.9', build: '13', file: 'TermBridge.zip', size: archive.length };
  const signature = data => sign(null, data, privateKey).toString('base64');
  const xml = Buffer.from(`<rss><channel><item><sparkle:version>13</sparkle:version><sparkle:shortVersionString>0.3.9</sparkle:shortVersionString><enclosure url="https://termbridge-a0k.pages.dev/download/TermBridge.zip" length="${archive.length}" sparkle:edSignature="${signature(archive)}"${expanded ? "></enclosure>" : "/>"}</item></channel></rss>\n`);
  const feed = Buffer.concat([xml, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${signature(xml)}\nlength: ${xml.length}\n-->\n`)]);
  return { feed, archive, release, publicRaw };
}
test('accepts a signed feed whose archive matches the release', () => {
  const f = fixture(); verifyAppcast(f.feed, f.archive, f.release, f.publicRaw);
});
test('rejects changed feed, wrong key and changed archive independently', () => {
  const f = fixture();
  assert.throws(() => verifyAppcast(Buffer.from(f.feed.toString().replace('0.3.9', '9.9.9')), f.archive, f.release, f.publicRaw), /feed signature/);
  assert.throws(() => verifyAppcast(f.feed, f.archive, f.release, fixture().publicRaw), /feed signature/);
  const changed = Buffer.from(f.archive); changed[0] ^= 1;
  assert.throws(() => verifyAppcast(f.feed, changed, f.release, f.publicRaw), /archive signature/);
});
test('rejects a validly signed feed that points at a different published release', () => {
  const f = fixture();
  for (const update of [{ build: '14' }, { version: '0.4.0' }, { file: 'other.zip' }, { size: 1 }]) {
    assert.throws(() => verifyAppcast(f.feed, f.archive, { ...f.release, ...update }, f.publicRaw));
  }
});

test('accepts the expanded enclosure produced by generate_appcast', () => {
  const f = fixture(true); verifyAppcast(f.feed, f.archive, f.release, f.publicRaw);
});
