import assert from 'node:assert/strict';
import test from 'node:test';
import { PersonalExamples, type PersonalExample } from './personalExamples.js';
const row = (id: string, text: string, label: 0 | 1 = 1): PersonalExample => ({ id, group: id, text, head: 'finished', label });
test('reviewed text retrieves relevant bilingual examples without editing the transcript', () => {
  const model = new PersonalExamples([row('a', '我最近的 Agent 是什么'), row('b', '我最近的', 0), row('c', 'open the calendar')]);
  assert.equal(model.hints('我最近的Agent是什么')[0].text, '我最近的 Agent 是什么');
  assert.equal(model.hints('open calendar')[0].text, 'open the calendar');
  assert.deepEqual(model.hints('天气预报'), []);
  assert.equal(new PersonalExamples([]).hints('我最近的').length, 0);
});
test('deletion is full replay, conflicting labels retained, holdout never sees its conversation', () => {
  const rows = [row('a', '我最近的', 0), row('b', '我最近的', 1)];
  assert.equal(new PersonalExamples(rows).hints('我最近的').length, 2);
  assert.equal(new PersonalExamples(rows.slice(1)).hints('我最近的')[0].label, 1);
  assert.deepEqual(new PersonalExamples(rows.map(row => ({ ...row, group: 'same-call' }))).evaluate(),
    { groups: 1, tested: 2, matched: 0, correct: 0 });
  assert.deepEqual(new PersonalExamples(rows).evaluate(), { groups: 2, tested: 2, matched: 2, correct: 0 });
});
test('rules require independent calls, exact current context, and no contradictory review', () => {
  const rows = ['a', 'b', 'c'].map(id => ({ ...row(id, 'nice', 0), head: 'addressed' as const, context: '我正在连麦' }));
  const model = new PersonalExamples(rows);
  assert.equal(model.rule('nice', '我正在连麦'), 'ignore'); assert.equal(model.rules, 1);
  assert.equal(model.rule('nice?', '我正在连麦'), undefined, 'a changed expression is not silently ignored');
  assert.equal(model.rule('助手，nice是什么意思', '我正在连麦'), undefined);
  assert.equal(model.rule('nice', '刚才那个任务完成了'), undefined);
  assert.equal(new PersonalExamples(rows.slice(1)).rule('nice', '我正在连麦'), undefined);
  assert.equal(new PersonalExamples(rows.map(row => ({ ...row, group: 'same' }))).rule('nice', '我正在连麦'), undefined);
  assert.equal(new PersonalExamples([...rows, { ...rows[0], id: 'd', label: 1 }]).rule('nice', '我正在连麦'), undefined);
});
