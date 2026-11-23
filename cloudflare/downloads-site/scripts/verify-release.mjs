import { verifyAppcast } from './verify-appcast.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(`${dist}/downloads/manifest.json`, 'utf8'));
const html = await readFile(`${dist}/index.html`, 'utf8');
assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'Unresolved release template');
assert.equal(await readFile(`${dist}/downloads/index.html`, 'utf8'), html);
// Windows is optional; when a release ships it, it is verified exactly like the rest.
const streamed = ['android', 'macos', ...(manifest.windows?.file ? ['windows'] : [])];
for (const platform of streamed) {
  const item = manifest[platform];
  assert.ok(html.includes(`href="${item.url}"`));
  const hash = createHash('sha256'); let total = 0;
  for (const part of item.parts) {
    const bytes = await readFile(`${dist}/downloads/${part.file}`);
    assert.ok(bytes.length < 25 * 1024 * 1024);
    assert.equal(bytes.length, part.size); assert.equal(sha(bytes), part.sha256);
    hash.update(bytes); total += bytes.length;
  }
  assert.equal(total, item.size); assert.equal(hash.digest('hex'), item.sha256);
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate IDs');
for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  if (href.startsWith('#')) assert.ok(ids.includes(href.slice(1)), `Broken anchor: ${href}`);
  else if (href.startsWith('/') && !href.startsWith('/download/')) {
    if (href !== '/') await readFile(dist + href);
  } else if (href.startsWith('https://')) assert.ok(['https://registry.npmjs.org/', 'https://www.npmjs.com/'].some(origin => href.startsWith(origin)));
}
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await walk(`${path}/${entry.name}`);
    else {
      assert.ok(!/^(\.env|\.DS_Store)|\.(pem|key|p12|keystore)$/i.test(entry.name), 'Private file in output');
      const bytes = await readFile(`${path}/${entry.name}`);
      assert.ok(bytes.length < 25 * 1024 * 1024, 'Pages asset too large');
      if (/\.(?:html|js|css|json|txt)$/.test(entry.name)) assert.ok(!/tb1_[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9]{20,}|-----BEGIN .*PRIVATE KEY-----/.test(bytes.toString()), 'Credential-like text in public output');
    }
  }
}
await walk(dist);
const checksums = await readFile(`${dist}/downloads/checksums.txt`, 'utf8');
for (const platform of ['cli', ...streamed]) assert.ok(checksums.includes(`${manifest[platform].sha256}  ${manifest[platform].file}`));
console.log('Release verified: artifact sizes, SHA-256, links, requirements, and public output.');

if (manifest.macos.updateFeed) {
  const archive = Buffer.concat(await Promise.all(manifest.macos.parts.map(p => readFile(`${dist}/downloads/${p.file}`))));
  verifyAppcast(await readFile(`${dist}/appcast.xml`), archive, manifest.macos, manifest.macos.updatePublicKey);
  console.log('Update feed and archive signatures verified.');
}
