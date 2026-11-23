import assert from 'node:assert/strict';
import test from 'node:test';
import { fitTurnText, normalizedTurn, parseTurnTextModel, scoreTurnText, textVerdict } from './turnTextModel.js';

test('actual fitting learns completion labels, survives JSON, and cannot become an active authorizer', () => {
  const rows = Array.from({ length: 80 }, (_, i) => i % 2 ?
    { text: '我想问的是', context: '', label: 0 as const } : { text: '任务完成了吗', context: '', label: 1 as const });
  const model = parseTurnTextModel(JSON.parse(JSON.stringify(fitTurnText(rows, 'suffix', 8))));
  assert.ok(scoreTurnText(model, rows[0].text)! > .7);
  assert.ok(scoreTurnText(model, rows[1].text)! < .3);
  assert.equal(scoreTurnText(model, '任务完成了吗？'), scoreTurnText(model, '任务完成了吗'));
  assert.equal(normalizedTurn(' Agent，OK? '), 'agentok');
  assert.equal(scoreTurnText(model, ''), undefined);
  assert.equal(scoreTurnText(model, 'a'.repeat(321)), undefined);
  assert.equal(textVerdict(undefined, { wait: .1, respond: .9 }), 'fallback');
  assert.equal(textVerdict(.95, { wait: .99, respond: .9 }), 'fallback');
  assert.throws(() => parseTurnTextModel({ ...model, mode: 'active' }));
  assert.throws(() => parseTurnTextModel({ ...model, weights: [NaN] }));
});
