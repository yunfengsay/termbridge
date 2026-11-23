import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';

// Verify both signatures independently of the publishing tool. The pinned key
// must come from the app being shipped, not from an untrusted network response.
export function verifyAppcast(feed, archive, release, publicKey) {
  const rawKey = Buffer.from(publicKey, 'base64');
  assert.equal(rawKey.length, 32, 'Invalid update public key');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
  const text = feed.toString('utf8');
  const block = text.match(/<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/=]+)\nlength: (\d+)\n-->\n$/);
  assert.ok(block, 'Missing signed feed trailer');
  const length = Number(block[2]);
  assert.equal(feed.length - Buffer.byteLength(block[0]), length, 'Incorrect signed feed length');
  assert.ok(verify(null, feed.subarray(0, length), key, Buffer.from(block[1], 'base64')), 'Invalid feed signature');
  const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  assert.equal(items.length, 1, 'Release feed must describe exactly the shipped release');
  const item = items[0][1];
  assert.ok(item.includes(`<sparkle:version>${release.build}</sparkle:version>`), 'Incorrect build number');
  assert.ok(item.includes(`<sparkle:shortVersionString>${release.version}</sparkle:shortVersionString>`), 'Incorrect display version');
  const enclosure = item.match(/<enclosure\s+([^>]+)>/);
  assert.ok(enclosure, 'Missing update archive');
  const attrs = Object.fromEntries([...enclosure[1].matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  const expectedURL = new URL(release.url ?? `/download/${release.file}`, 'https://termbridge-a0k.pages.dev');
  assert.equal(expectedURL.origin, 'https://termbridge-a0k.pages.dev');
  assert.equal(expectedURL.pathname, `/download/${release.file}`);
  assert.equal(attrs.url, expectedURL.href, 'Update URL does not match release');
  assert.equal(Number(attrs.length), archive.length, 'Incorrect update archive length');
  assert.equal(archive.length, release.size, 'Archive differs from manifest');
  assert.ok(verify(null, archive, key, Buffer.from(attrs['sparkle:edSignature'] ?? '', 'base64')), 'Invalid update archive signature');
}
