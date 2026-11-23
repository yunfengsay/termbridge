import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrainConversationInput, BrainConversationService } from '@termbridge/brain';
import { createTurnJudge } from './voiceTurnJudge.js';
test('cloud judge gets bounded history + raw segments, but cannot call tools or rewrite raw input', async () => {
  let received: BrainConversationInput | undefined;
  const service: BrainConversationService = { provider: 'bailian', model: 'fixture', runtime: 'pi',
    async respond(input) { received = input; return { provider: 'bailian', model: 'fixture', text: '{"decision":"respond","intent":"查询最近任务"}', toolCalls: [] }; } };
  const judge = createTurnJudge(service, () => Array.from({ length: 50 }, () => ({ role: 'user', content: 'x'.repeat(2000) })));
  const segments = ['我最近的', 'Agent 是什么'];
  const result = await judge({ segments, signal: new AbortController().signal });
  assert.deepEqual(result, { decision: 'respond', intent: '查询最近任务' });
  assert.deepEqual(segments, ['我最近的', 'Agent 是什么']);
  assert.deepEqual(received!.tools, []);
  const context = JSON.parse(received!.messages[0].content);
  assert.equal(context.history.length, 4); assert.equal(context.history[0].content.length, 500);
  assert.deepEqual(context.segments, segments);
  await assert.rejects(received!.onToolCall({ callId: 'bad', name: 'dispatch_agent', arguments: {} }), /cannot execute/);
});

test('a clarification stays separate from raw speech and is included in the next judgement', async () => {
  let received: BrainConversationInput | undefined;
  const service: BrainConversationService = { provider: 'bailian', model: 'fixture', runtime: 'pi',
    async respond(input) { received = input; return { provider: 'bailian', model: 'fixture', text: '{"decision":"wait","clarification":"你想查最近的哪方面？"}', toolCalls: [] }; } };
  const judge = createTurnJudge(service, () => []);
  const verdict = await judge({ segments: ['我最近的'], signal: new AbortController().signal });
  assert.deepEqual(verdict, { decision: 'wait', clarification: '你想查最近的哪方面？' });
  await judge({ segments: ['我最近的', 'Agent是什么'], clarification: '你想查最近的哪方面？', signal: new AbortController().signal });
  const input = JSON.parse(received!.messages[0].content);
  assert.deepEqual(input.segments, ['我最近的', 'Agent是什么']); assert.equal(input.clarification, '你想查最近的哪方面？');
});

test('clarification has a chronological boundary and is not duplicated as ordinary history', async () => {
  let received: BrainConversationInput | undefined;
  const question = '您想让我做什么呢？';
  const service: BrainConversationService = { provider: 'bailian', model: 'fixture', runtime: 'pi',
    async respond(input) { received = input; return { provider: 'bailian', model: 'fixture',
      text: '{"decision":"respond","intent":"确认交流是否正常"}', toolCalls: [] }; } };
  const judge = createTurnJudge(service, () => [
    { role: 'user', content: '之前讨论 Agent' }, { role: 'assistant', content: question },
  ]);
  const segments = ['你现在在听', '在听我说话吗？'];
  await judge({ segments, clarification: question, clarificationAfterSegment: 1, signal: new AbortController().signal });
  const input = JSON.parse(received!.messages[0].content);
  assert.deepEqual(input.segments, segments, 'do not deduplicate speech words or rewrite ASR');
  assert.equal(input.clarificationAfterSegment, 1);
  assert.deepEqual(input.history, [{ role: 'user', content: '之前讨论 Agent' }]);
});

test('invalid model output is unavailable, not a semantic WAIT; diagnostics contain no speech', async () => {
  for (const text of ['null', 'not json', '{"decision":"unknown"}', '{"decision":"wait"}']) {
    const records: unknown[] = [];
    const service: BrainConversationService = { provider: 'bailian', model: 'fixture', runtime: 'pi',
      async respond() { return { provider: 'bailian', model: 'fixture', text, toolCalls: [] }; } };
    const judge = createTurnJudge(service, () => [], fields => records.push(fields));
    const result = judge({ segments: ['private-speech'], clarification: 'private-question', clarificationAfterSegment: 1,
      signal: new AbortController().signal });
    if (text.includes('"wait"')) assert.equal(await result, 'wait');
    else await assert.rejects(result, /invalid verdict/);
    assert.equal(records.length, 1);
    assert.doesNotMatch(JSON.stringify(records), /private/);
    assert.equal((records[0] as { segmentCount: number }).segmentCount, 1);
  }
});
