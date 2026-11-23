/** A control head, NOT ASR, a speaker verifier, or a semantic DDSD encoder.
 * Features are bounded observations. Cloud transcripts are never training targets here.
 * Cold-start output is advisory; only explicit, reviewed feedback trains a personal head.
 */
export const FEATURES = ['speech', 'duration', 'pause', 'playback', 'recent', 'wake'] as const;
export type Features = [number, number, number, number, number, number];
export type Head = 'addressed' | 'finished';
export type Feedback = {
  id: string; group: string; at: number; features: Features;
  head: Head; label: 0 | 1; source: 'human' | 'synthetic';
};
export type PersonalModel = {
  schema: 1; version: string; samples: number; mode: 'shadow';
  addressed: number[]; finished: number[];
};

export function baseModel(): PersonalModel {
  return { schema: 1, version: 'base-v1', samples: 0, mode: 'shadow', addressed: Array(7).fill(0), finished: Array(7).fill(0) };
}
export function probability(model: PersonalModel, head: Head, x: Features): number {
  validateFeatures(x);
  const w = model[head];
  if (w.length !== 7 || w.some(v => !Number.isFinite(v))) throw new Error('Invalid control model');
  const logit = x.reduce((sum, v, i) => sum + v * w[i + 1], w[0]);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))));
}
export function validateFeatures(x: readonly number[]): asserts x is Features {
  if (x.length !== 6 || x.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('Invalid control features');
}

/** Full bounded replay makes correction/deletion reversible. No gradient accumulation on retry. */
export function train(samples: readonly Feedback[], version: string, includeSynthetic = false): PersonalModel {
  const rows = [...new Map(samples.map(row => [row.id, row])).values()]
    .filter(row => includeSynthetic || row.source === 'human').sort((a, b) => a.id.localeCompare(b.id));
  if (rows.length > 500) throw new Error('Control dataset limit exceeded');
  const model = baseModel();
  for (const row of rows) {
    validateFeatures(row.features);
    if ((row.label !== 0 && row.label !== 1) || !['addressed', 'finished'].includes(row.head)) throw new Error('Invalid feedback');
  }
  for (let epoch = 0; epoch < 12; epoch++) {
    for (const row of rows) {
      const error = row.label - probability(model, row.head, row.features);
      const w = model[row.head];
      for (let i = 0; i < w.length; i++) {
        const feature = i === 0 ? 1 : row.features[i - 1];
        w[i] = Math.max(-4, Math.min(4, w[i] + 0.12 * (error * feature - 0.005 * w[i])));
      }
    }
  }
  return { ...model, version, samples: rows.length };
}

/** Missing context/insufficient confidence means wait, not permission to upload or execute. */
export function recommendation(model: PersonalModel, x: Features) {
  const addressed = probability(model, 'addressed', x);
  const finished = probability(model, 'finished', x);
  return { addressed, finished, action: addressed >= 0.8 && finished >= 0.8 ? 'candidate' : 'wait',
    pauseMs: Math.round(1400 + (1 - finished) * 2100), mode: 'shadow' as const };
}
