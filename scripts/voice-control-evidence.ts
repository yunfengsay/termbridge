/** Collect only the explicitly authored, file/pipe experiment reports. Never scans user history. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const files = process.argv.slice(2);
assert(files.length > 0 && files.length <= 30, 'Supply label=/path/to/synthetic/report.json arguments');
const output = resolve('docs/voice-personalization/qa/pipe-replay');
await mkdir(output, { recursive: true });
const manifest = [];
for (const argument of files) {
  const split = argument.indexOf('=');
  const label = argument.slice(0, split), path = argument.slice(split + 1);
  assert(split > 0 && /^[a-z0-9-]{1,64}$/.test(label));
  const raw = await readFile(path, 'utf8');
  const source = JSON.parse(raw);
  const semantic = source.provenance === 'authored synthetic text, not recorded private history';
  assert(semantic || source.provenance === 'synthetic file-only experiment, not user/car recordings');
  assert(Array.isArray(source.rows) && source.rows.length <= (semantic ? 100 : 2));
  const rows = source.rows.map((row: Record<string, unknown>) => {
    if (semantic) return Object.fromEntries(['name', 'segments', 'clarification', 'history', 'expected', 'verdict', 'raw', 'error', 'latencyMs', 'passed']
      .filter(key => key in row).map(key => [key, row[key]]));
    assert(row.fixture === 'synthetic-Tingting');
    return Object.fromEntries(['adaptive', 'productionFork', 'turns', 'communicationCheck', 'replayInitialWait', 'forks', 'providerSilenceMs', 'judge', 'fixture', 'firstAudioMs', 'pauseMs',
      'secondStartsMs', 'submitted', 'answer', 'outputBytes', 'responseCount', 'judgeCalls',
      'fixtureToolCompletions', 'finished', 'failure', 'prematureResponses', 'accepted', 'checks', 'events']
      .filter(key => key in row).map(key => [key, row[key]]));
  });
  // Input reports are ours, with authored phrases and a mock tool. No paths, credentials or PCM.
  const evidence = { label, provenance: source.provenance, sourceSha256: createHash('sha256').update(raw).digest('hex'),
    at: source.at, model: source.model, pcm: source.pcm, outputPolicy: 'discarded; never played', rows };
  await writeFile(resolve(output, `${label}.json`), JSON.stringify(evidence, null, 2));
  manifest.push({ label, sha256: evidence.sourceSha256, rows: rows.length });
}
const previous = await readFile(resolve(output, 'manifest.json'), 'utf8').then(text => JSON.parse(text).manifest)
  .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const merged = [...new Map([...previous, ...manifest].map(row => [row.label, row])).values()];
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ schema: 1,
  rawPersonalRecordings: 0, realDeviceTests: 0, note: 'Small development set; failed experiments retained. Not an independent accuracy benchmark.', manifest: merged }, null, 2));
console.log(JSON.stringify({ reports: manifest.length, directory: output }));
