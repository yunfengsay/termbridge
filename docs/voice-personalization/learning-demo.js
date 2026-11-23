// Educational, synthetic, memory-only example. Not a production DDSD model.
(() => {
  'use strict';
  const FEATURES = Object.freeze([0.8, 0.3, -0.6]);
  const BASE_LOGIT = 0.4;
  const RATE = 0.25;
  const REGULARIZATION = 0.08;
  const MAX_STEPS = 8;
  const sigmoid = value => 1 / (1 + Math.exp(-value));
  const initial = () => ({ weights: [0, 0, 0], bias: 0, steps: 0 });

  function score(state) {
    return sigmoid(BASE_LOGIT + state.bias + FEATURES.reduce(
      (sum, value, index) => sum + value * state.weights[index], 0,
    ));
  }

  function update(state, label) {
    if (label !== 0 && label !== 1) throw new TypeError('A synthetic binary label is required');
    if (state.steps >= MAX_STEPS) return state;
    const error = score(state) - label;
    const gradient = state.weights.map((weight, index) => error * FEATURES[index] + REGULARIZATION * weight);
    gradient.push(error + REGULARIZATION * state.bias);
    const scale = Math.max(1, Math.hypot(...gradient));
    const values = [...state.weights, state.bias].map((weight, index) => weight - RATE * gradient[index] / scale);
    if (!values.every(Number.isFinite)) throw new RangeError('Non-finite demonstration parameters');
    return { weights: values.slice(0, 3), bias: values[3], steps: state.steps + 1 };
  }

  globalThis.VoiceLearningDemo = Object.freeze({ initial, score, update, maxSteps: MAX_STEPS });
})();
