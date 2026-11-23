import assert from 'node:assert/strict';
import test from 'node:test';

import { applyRevisionedTranscriptPatch, reconstructTranscriptPatch } from './transcript-patch.js';

test('reconstructs a sliding transcript while retaining exact line identities', () => {
  const a = { text: 'a' };
  const b = { text: 'b' };
  const c = { text: 'c' };
  const next = reconstructTranscriptPatch([a, b, c], {
    oldStart: 1,
    newStart: 0,
    retainCount: 2,
    before: [],
    after: [{ text: 'd' }],
  });

  assert.equal(next?.[0], b);
  assert.equal(next?.[1], c);
  assert.deepEqual(next?.map((line) => line.text), ['b', 'c', 'd']);
});

test('rejects an invalid retained range so the client can request a full resync', () => {
  assert.equal(reconstructTranscriptPatch([{ text: 'a' }], {
    oldStart: 1,
    newStart: 0,
    retainCount: 1,
    before: [],
    after: [],
  }), undefined);
});

test('rejects an out-of-order base revision and accepts the matching successor', () => {
  const current = [{ text: 'a' }];
  const patch = { oldStart: 0, newStart: 0, retainCount: 1, before: [], after: [{ text: 'b' }] };

  assert.equal(applyRevisionedTranscriptPatch(7, current, 6, 8, patch), undefined);
  assert.deepEqual(applyRevisionedTranscriptPatch(7, current, 7, 8, patch), {
    revision: 8,
    lines: [current[0], { text: 'b' }],
  });
});
