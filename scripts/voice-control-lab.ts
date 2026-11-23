/** Reproducible cold-start/control benchmark. No recorder, player, cloud, or production data. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { baseModel, probability, train, type Feedback, type Features } from '../packages/voice/src/control/personalization.js';

const directory = resolve(process.argv[2] || 'docs/voice-personalization/qa/control-lab');
await mkdir(directory, { recursive: true });
const dataset: Feedback[] = [];
// Constructed contrasting scenarios, not microphone evidence. Identical acoustic/context features
// can mean opposite things: this intentionally exposes the limits of a scalar control head.
for (let group = 0; group < 40; group++) {
  const session = `00000000-0000-4000-8000-${group.toString().padStart(12, '0')}`;
  const x: Features = [0.70 + (group % 5) * 0.05, 0.15 + (group % 4) * 0.15, (group % 8) / 8, group % 2, 1, group % 3 === 0 ? 1 : 0];
  for (const head of ['addressed', 'finished'] as const) for (const label of [0, 1] as const) {
    dataset.push({ id: `00000000-0000-4000-8000-${(group * 4 + (head === 'finished' ? 2 : 0) + label).toString().padStart(12, '0')}`,
      group: session, at: 0, features: [...x], head, label, source: 'synthetic' });
  }
}
const groups = [...new Set(dataset.map(row => row.group))];
const fit = dataset.filter(row => groups.indexOf(row.group) < 24);
const validation = dataset.filter(row => groups.indexOf(row.group) >= 24 && groups.indexOf(row.group) < 32);
const test = dataset.filter(row => groups.indexOf(row.group) >= 32);
const started = performance.now();
const model = train(fit, 'synthetic-lab-v1', true);
const trainingMs = performance.now() - started;
const times: number[] = [];
let scoreChecksum = 0;
for (let i = 0; i < 20_000; i++) {
  const row = test[i % test.length]; const at = performance.now();
  scoreChecksum += probability(model, row.head, row.features); times.push(performance.now() - at);
}
times.sort((a, b) => a - b);
const evaluate = (rows: Feedback[]) => {
  const scores = rows.map(row => ({ label: row.label, p: probability(model, row.head, row.features) }));
  return { count: rows.length, accuracyAtHalf: scores.filter(row => Number(row.p >= 0.5) === row.label).length / scores.length,
    confidentCoverage: scores.filter(row => row.p >= 0.8 || row.p <= 0.2).length / scores.length,
    brier: scores.reduce((sum, row) => sum + (row.p - row.label) ** 2, 0) / scores.length };
};
const goldenRows: Feedback[] = [{ id: 'a', group: 'g', at: 1, features: [0.9, 0.5, 0.8, 0, 1, 1], head: 'addressed', label: 1, source: 'human' }];
const golden = train(goldenRows, 'v1');
const report = { schema: 1, source: 'synthetic-contrastive', realUserRecordings: 0,
  counts: { total: dataset.length, train: fit.length, validation: validation.length, test: test.length },
  splitUnit: 'whole conversation group, disjoint', seed: 'deterministic-40-groups-v1',
  validation: evaluate(validation), test: evaluate(test), trainingMs,
  inferenceUs: { p50: times[10_000] * 1000, p95: times[19_000] * 1000, p99: times[19_800] * 1000 },
  scoreChecksum, parameterBytesFloat32: 14 * 4, modelJsonBytes: Buffer.byteLength(JSON.stringify(model)),
  acceptance: 'shadow only: identical observations with opposite intentions cannot be separated by this feature head',
  requiredNextData: 'opt-in real interaction corrections plus semantic/learned embeddings; never treat this accuracy as car-noise performance',
  baseline: baseModel(), golden };
await writeFile(join(directory, 'synthetic-feedback.jsonl'), dataset.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ counts: report.counts, test: report.test, trainingMs, inferenceUs: report.inferenceUs, golden: golden.addressed }));
