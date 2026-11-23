/** Aggregate public experiment evidence; never publish raw turns or weights in the repository. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [first, intermediate, second, out] = process.argv.slice(2);
if (!first || !intermediate || !second || !out) throw new Error('Usage: voice-training-report <round1> <round2-domain> <round2-language> <out-json>');
async function report(directory: string, checked: boolean) {
  const load = async (name: string) => JSON.parse(await readFile(join(directory, name), 'utf8'));
  const manifest = await load('manifest.json'), frozen = await load('frozen.json');
  let check;
  if (checked) {
    const { rows: _rows, ...summary } = await load('check.json'); check = summary;
    // Only correct provenance wording in the publication, never recompute consumed test scores.
    if (manifest.dataset === 'ASLP-lab/Easy-Turn-Testset') check.caveat = 'Public Chinese transcription metadata; publisher human labels. No audio, English, owner/DDSD or private-device acceptance.';
  }
  return { manifest, frozen, check: check ?? { status: 'not-tested', reason: 'Development coverage failed; preserve fresh holdout for revised calibration.' } };
}
const reports = await Promise.all([report(first, true), report(intermediate, false), report(second, true)]);
await writeFile(out, JSON.stringify({ at: new Date().toISOString(), candidateFits: reports.reduce((n, r) => n + r.frozen.candidates.length, 0),
  uniqueWeights: new Set(reports.flatMap(r => r.frozen.candidates.map((c: { modelHash: string }) => c.modelHash))).size,
  independentChecks: 2, reports, production: 'unchanged; all trained public models remain shadow/rejected' }, null, 2));
console.log(out);
