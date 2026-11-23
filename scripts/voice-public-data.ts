/** Public evaluation only. No private history, microphone, playback, or model training. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: tsx scripts/voice-public-data.ts <private-cache-directory>');
await mkdir(directory, { recursive: true, mode: 0o700 });
function get(url: string, range?: string): Buffer {
  return execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', '--max-time', '30', ...(range ? ['--range', range] : []), url],
    { maxBuffer: 4 * 1024 * 1024, timeout: 130_000 });
}
const repository = 'TheAgenticDataCompany/open-yap-1k';
const revision = JSON.parse(get(`https://huggingface.co/api/datasets/${repository}`).toString()).sha as string;
const base = `https://huggingface.co/datasets/${repository}/resolve/${revision}/`;
const manifest: { revision: string; files: { name: string; bytes: number; sha256: string }[] } = { revision, files: [] };
async function save(name: string, data: Buffer) {
  await writeFile(join(directory, name), data, { mode: 0o600 });
  manifest.files.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
await save('LICENSE.txt', get(`${base}LICENSE.txt`));
await save('metadata.jsonl', get(`${base}metadata.jsonl`));
// Tar is uncompressed: range-walk headers, skip audio payloads, fetch only word-level JSON.
// Do not download 1.9 GB just to inspect pauses. Reject servers ignoring Range.
let offset = 0;
for (let entry = 0; entry < 100; entry++) {
  const header = get(`${base}open-yap-1k-sample.tar?offset=${offset}`, `${offset}-${offset + 511}`);
  if (header.length !== 512) throw new Error('Server did not honor bounded HTTP Range');
  if (header.every(v => v === 0)) break;
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || name.includes('/') || name.includes('..')) throw new Error('Unsupported tar entry');
  if (name.endsWith('.json')) {
    if (size > 2 * 1024 * 1024) throw new Error('Metadata entry too large');
    const body = existsSync(join(directory, name)) ? readFileSync(join(directory, name)) :
      get(`${base}open-yap-1k-sample.tar?offset=${offset + 512}`, `${offset + 512}-${offset + 511 + size}`);
    if (body.length !== size) throw new Error('Incomplete range');
    JSON.parse(body.toString()); await save(name, body); console.log(name, size);
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, revision, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0) }));
