/** Trainable text control baseline, not ASR, speaker identity, or task authorization. */
export type TextFeatures = 'body' | 'suffix' | 'context';
export type TextExample = { text: string; context: string; label: 0 | 1 };
export type TurnTextModel = {
  schema: 1; mode: 'shadow'; features: TextFeatures; dimensions: 32768;
  weights: number[]; bias: number; epochs: number; seed: number;
};
export type TextThresholds = { wait: number; respond: number };
const DIMENSIONS = 32768;
/** Deliberately remove ASR punctuation and label/template metadata from the input. */
export function normalizedTurn(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
function hash(text: string): number {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return n >>> 0;
}
function vector(text: string, context: string, mode: TextFeatures): [number, number][] {
  const features = new Map<number, number>();
  function add(key: string, value = 1) {
    const id = hash(key) % DIMENSIONS;
    // Binary ngrams: repeated noise/words do not amplify a feature indefinitely.
    features.set(id, Math.max(features.get(id) ?? 0, value));
  }
  function grams(value: string, prefix: string, weight: number) {
    const chars = Array.from(normalizedTurn(value));
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= chars.length; i++) add(prefix + chars.slice(i, i + n).join(''), weight);
    for (const word of normalizedTurn(value).match(/[a-z0-9]+/g) ?? []) add(prefix + 'w:' + word, weight);
  }
  grams(text.slice(-320), 't:', 1);
  if (mode !== 'body') {
    const chars = Array.from(normalizedTurn(text));
    for (let n = 1; n <= Math.min(8, chars.length); n++) add('end:' + chars.slice(-n).join(''), 3);
    const words = normalizedTurn(text).match(/[a-z0-9]+/g) ?? [];
    for (let n = 1; n <= Math.min(3, words.length); n++) add('end-word:' + words.slice(-n).join(' '), 3);
  }
  if (mode === 'context') grams(context.slice(-200), 'ctx:', .4);
  const norm = Math.sqrt([...features.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  return [...features].map(([id, value]) => [id, value / norm]);
}
function sigmoid(value: number) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value)))); }
function dot(weights: ArrayLike<number>, bias: number, features: [number, number][]) {
  for (const [id, value] of features) bias += weights[id] * value;
  return sigmoid(bias);
}
export function fitTurnText(rows: TextExample[], features: TextFeatures, epochs: number, seed = 908): TurnTextModel {
  if (rows.length < 4 || rows.length > 20_000 || ![0, 1].every(label => rows.some(row => row.label === label)) ||
      !Number.isInteger(epochs) || epochs < 1 || epochs > 100) throw new Error('Invalid bounded text training set');
  const vectors = rows.map(row => vector(row.text, row.context, features));
  const weights = new Float64Array(DIMENSIONS), squared = new Float64Array(DIMENSIONS).fill(.01);
  let bias = 0, biasSquared = .01, state = seed >>> 0;
  const order = rows.map((_, i) => i);
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const index of order) {
      const error = dot(weights, bias, vectors[index]) - rows[index].label;
      biasSquared += error * error; bias -= .15 * error / Math.sqrt(biasSquared);
      for (const [id, value] of vectors[index]) {
        const gradient = error * value + .0001 * weights[id];
        squared[id] += gradient * gradient; weights[id] -= .15 * gradient / Math.sqrt(squared[id]);
      }
    }
  }
  return { schema: 1, mode: 'shadow', features, dimensions: DIMENSIONS, epochs, seed,
    weights: Array.from(weights, value => Math.fround(value)), bias };
}
export function parseTurnTextModel(value: unknown): TurnTextModel {
  const model = value as TurnTextModel;
  if (!model || model.schema !== 1 || model.mode !== 'shadow' || model.dimensions !== DIMENSIONS ||
      !['body', 'suffix', 'context'].includes(model.features) || !Number.isFinite(model.bias) ||
      !Number.isInteger(model.epochs) || model.epochs < 1 || model.epochs > 100 || !Number.isSafeInteger(model.seed) ||
      !Array.isArray(model.weights) || model.weights.length !== DIMENSIONS || !model.weights.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('Invalid shadow text model');
  }
  return model;
}
export function scoreTurnText(model: TurnTextModel, text: string, context = ''): number | undefined {
  // OOD/oversize inputs need the existing cloud judge, never silent truncation + acceptance.
  if (!normalizedTurn(text) || text.length > 320 || !/[\p{Script=Han}a-z]/iu.test(text)) return undefined;
  return dot(model.weights, model.bias, vector(text, context, model.features));
}
export function textVerdict(score: number | undefined, thresholds: TextThresholds): 'wait' | 'respond' | 'fallback' {
  if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1 ||
      !Number.isFinite(thresholds.wait) || !Number.isFinite(thresholds.respond) || thresholds.wait >= thresholds.respond) return 'fallback';
  if (thresholds.wait >= 0 && score <= thresholds.wait) return 'wait';
  if (thresholds.respond <= 1 && score >= thresholds.respond) return 'respond';
  return 'fallback';
}
