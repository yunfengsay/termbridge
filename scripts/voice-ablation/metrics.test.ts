import assert from 'node:assert/strict';
import test from 'node:test';
import { errorRate, normalize, score } from './metrics.js';

test('ignore formatting, not semantic or technical substitutions', () => {
  assert.equal(normalize('Term Bridge，LLM。'), 'termbridgellm');
  assert.equal(errorRate('请打开 Codex。', '请打开 codex'), 0);
  assert(errorRate('Skill', '缩放') > 0);
  assert.equal(errorRate('你好', ''), 1);
});
test('negative samples penalize invented vocabulary and missing terms separately', () => {
  assert.deepEqual(score('缩放图片', 'Skill图片', [], ['Skill']).inventedTerms, ['Skill']);
  assert.deepEqual(score('Codex Agent', 'Codex', ['Codex', 'Agent'], []).missingTerms, ['Agent']);
  assert.equal(errorRate('甲', '甲乙丙'), 2);
});
