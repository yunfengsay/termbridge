/** Publish bounded, non-private aggregate evidence, not downloaded transcripts or user profiles. */
import { readFile, writeFile } from 'node:fs/promises';
const [publicPath, personalPath] = process.argv.slice(2);
if (!publicPath || !personalPath) throw new Error('Supply public evaluation and isolated personal fixture reports');
const publicReport = JSON.parse(await readFile(publicPath, 'utf8'));
const personal = JSON.parse(await readFile(personalPath, 'utf8'));
const semantic = publicReport.semantic;
const latency = semantic.rows.map((row: { latencyMs: number }) => row.latencyMs).sort((a: number, b: number) => a - b);
const result = {
  at: new Date().toISOString(),
  openYap: publicReport.publicData,
  semantic: { repository: semantic.repository, revision: semantic.revision, sha256: semantic.sha256,
    model: semantic.model, tested: semantic.tested, passed: semantic.passed,
    errors: semantic.rows.filter((row: { decision: string }) => row.decision === 'error').length,
    latencyMs: { p50: latency[Math.floor(latency.length * .5)], p95: latency[Math.floor(latency.length * .95)] },
    caveat: semantic.caveat },
  personalization: { model: personal.model, fixtures: personal.rows.length,
    passed: personal.rows.filter((row: { passed: boolean }) => row.passed).length,
    provenance: personal.provenance,
    ablation: personal.rows.map((row: { index: number; before: unknown; after: unknown; unrelated: string; deleted: unknown; revoked: string; passed: boolean }) => ({
      case: row.index, baseline: row.before, learned: row.after, unrelatedExamples: row.unrelated,
      afterRevocation: row.deleted, receipt: row.revoked, passed: row.passed,
    })),
    caveat: 'Engineered exact-context negative rules, not a generalized DDSD accuracy benchmark. Three fixture groups are not three real user conversations.' },
};
await writeFile('docs/voice-personalization/qa/public-learning.json', JSON.stringify(result, null, 2));
