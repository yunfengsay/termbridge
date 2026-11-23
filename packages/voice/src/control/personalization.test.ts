import assert from 'node:assert/strict';
import test from 'node:test';
import { baseModel, probability, train, recommendation, type Feedback } from './personalization.js';

const positive: Feedback = { id: 'a', group: 'g1', at: 1, features: [0.9, 0.5, 0.8, 0, 1, 1], head: 'addressed', label: 1, source: 'human' };
test('explicit feedback changes only its head; deletion/retry is exactly reversible', () => {
  const model = train([positive], 'v1');
  assert(probability(model, 'addressed', positive.features) > 0.5);
  assert.equal(probability(model, 'finished', positive.features), 0.5);
  assert.deepEqual(train([positive, positive], 'v1'), model);
  assert.deepEqual(train([], 'base-v1'), baseModel());
  const corrected = train([{ ...positive, label: 0 }], 'v2');
  assert(probability(corrected, 'addressed', positive.features) < 0.5);
});
test('teachers/synthetic labels cannot silently train a personal production model', () => {
  assert.equal(train([{ ...positive, source: 'synthetic' }], 'v1').samples, 0);
  assert.equal(train([{ ...positive, source: 'synthetic' }], 'lab', true).samples, 1);
});
test('bounded model never grants audio permission; malformed vectors are rejected', () => {
  assert.equal(recommendation(baseModel(), positive.features).action, 'wait');
  assert.throws(() => probability(baseModel(), 'addressed', [NaN, 0, 0, 0, 0, 0]));
  const model = train(Array.from({ length: 500 }, (_, i) => ({ ...positive, id: String(i) })), 'v2');
  assert(model.addressed.every(w => Number.isFinite(w) && Math.abs(w) <= 4));
  assert.equal(model.mode, 'shadow');
});
