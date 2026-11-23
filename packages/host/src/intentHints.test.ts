import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { IntentHints, createJevEvaluator, intentHintMode, intentRequest, type IntentContext,
  type IntentJudgment, type IntentObservation } from './intentHints.js';

const context: IntentContext = { conversationId: 'test', candidates: [
  { sessionId: 'herdr:fixture:1', name: 'voice', agent: 'codex' },
  { sessionId: 'herdr:fixture:2', name: 'canvas', agent: 'claude' },
], history: [{ role: 'brain', text: '最近完成的是 voice。' }] };
const text = '让他提交并 push';
const choice = (value: string, options: Record<string, unknown>, confidence = 1) => ({
  type: 'choice', choice: value, confidence,
  probabilities: Object.fromEntries(Object.keys(options).map(k => [k, k === value ? 1 : 0])),
});
function response(intent = 'delegate', target = 'agent_0') {
  const { questions } = intentRequest(text, context);
  return { model: 'jev-1.13.0', answers: {
    intent: choice(intent, questions.intent.criteria), target: choice(target, questions.target.criteria),
    relation: choice('continuation', questions.relation.criteria),
  }, usage: { input_tokens: 512, output_tokens: 30 } };
}
const mockFetch = (data = response()): typeof fetch => async () => Response.json(data);
const evaluated = () => createJevEvaluator('fixture-key', mockFetch())(text, context, new AbortController().signal);

test('fork reuses accepted-turn context, not its own interim speech; changed scope invalidates it', async () => {
  let calls = 0;
  const observations: IntentObservation[] = [];
  const hints = new IntentHints('hint', async () => { calls++; return evaluated(); }, (_key, value) => observations.push(value));
  hints.start('call', text, context);
  await delay(10);
  const duringReply = { ...context, history: [...context.history, { role: 'assistant', text: '正在处理。' }] };
  const reused = hints.contextForFork('call', text, duringReply);
  hints.start('call', text, reused);
  assert.equal(calls, 1);
  assert.match(hints.hint('call', text, reused), /fixture:1/);
  assert(observations.some(o => o.outcome === 'applied'));
  const switched = { ...duringReply, conversationId: 'new-conversation' };
  assert.deepEqual(hints.contextForFork('call', text, switched), switched);
  assert.equal(hints.hint('call', text, switched), '');
  assert.deepEqual(hints.contextForFork('call', '另一个问题', duringReply), duringReply);
  hints.clearAll();
});

test('provider receives one batch, exact original, bounded context and opaque candidate labels', async () => {
  let calls = 0;
  const evaluate = createJevEvaluator('fixture-key', async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.state.userText, text);
    assert.deepEqual(Object.keys(body.questions), ['intent', 'target', 'relation']);
    assert(!String(init?.body).includes('herdr:fixture'));
    assert(!String(init?.body).includes('fixture-key'));
    return Response.json(response());
  });
  const result = await evaluate(text, context, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(result.targetSessionId, context.candidates[0].sessionId);
  assert.equal(result.inputTokens, 512);
});

test('phone and home are distinct from worker dispatch; discussion and no-match remain available', () => {
  const request = intentRequest('提醒我明天带护照', context);
  for (const key of ['phone', 'home', 'discuss', 'other']) assert(key in request.questions.intent.criteria);
  for (const key of ['none', 'ambiguous']) assert(key in request.questions.target.criteria);
  const bounded = intentRequest(text, { ...context, history: Array.from({ length: 20 }, () => ({ role: 'user', text: 'a'.repeat(1000) })) });
  assert.equal(bounded.state.history.length, 6);
  assert(bounded.state.history.every(m => m.text.length === 600));
});

test('rejects invented targets, invalid distributions, model drift and missing confidence', async () => {
  for (const mutate of [
    (r: ReturnType<typeof response>) => { r.answers.target.choice = 'agent_99'; },
    (r: ReturnType<typeof response>) => { r.answers.target.probabilities.agent_0 = 0.3; },
    (r: ReturnType<typeof response>) => { r.answers.intent.confidence = NaN; },
    (r: ReturnType<typeof response>) => { r.model = 'jev-latest'; },
  ]) {
    const data = response(); mutate(data);
    await assert.rejects(createJevEvaluator('fixture', mockFetch(data))(text, context, new AbortController().signal));
  }
});

test('errors discard provider body; no automatic retries', async () => {
  let calls = 0;
  const evaluate = createJevEvaluator('fixture', async () => {
    calls++; return new Response('secret upstream detail', { status: 429 });
  });
  await assert.rejects(evaluate(text, context, new AbortController().signal), { message: 'Intent provider unavailable' });
  assert.equal(calls, 1);
});

test('response byte limit applies to streamed payloads', async () => {
  const evaluate = createJevEvaluator('fixture', async () => new Response('x'.repeat(64_001)));
  await assert.rejects(evaluate(text, context, new AbortController().signal), /Oversized/);
});

test('registered tools are closed choices; a changed catalog invalidates an existing hint', async () => {
  const withTools = { ...context, tools: [{ name: 'continue_agent', description: 'Forward to an existing terminal worker' }] };
  const request = intentRequest(text, withTools);
  const data = { ...response(), answers: { ...response().answers,
    tool: choice('continue_agent', request.questions.tool!.criteria) } };
  const evaluator = createJevEvaluator('fixture', async () => Response.json(data));
  const hints = new IntentHints('hint', evaluator);
  hints.start('k', text, withTools); await delay(10);
  assert.match(hints.hint('k', text, withTools), /"suggestedTool":"continue_agent"/);
  assert.equal(hints.hint('k', text, { ...withTools, tools: [] }), '');
  hints.clearAll();
  data.answers.tool.choice = 'execute_arbitrary_shell';
  await assert.rejects(evaluator(text, withTools, new AbortController().signal));
});

test('off and missing credentials never evaluate; shadow records but cannot inject', async () => {
  let calls = 0;
  const evaluate = async () => { calls++; return evaluated(); };
  new IntentHints('off', evaluate).start('k', text, context);
  new IntentHints('hint').start('k', text, context);
  assert.equal(calls, 0);
  const observations: IntentObservation[] = [];
  const shadow = new IntentHints('shadow', evaluate, (_, o) => observations.push(o));
  shadow.start('k', text, context); await delay(10);
  assert.equal(calls, 1);
  assert.equal(shadow.hint('k', text, context), '');
  assert.equal(observations[0].outcome, 'ready');
  assert(!JSON.stringify(observations).includes(text));
  shadow.clearAll();
  assert.equal(intentHintMode('true'), 'off');
});

test('hint is nonblocking and usable only for exact turn, scope, candidates and TTL', async () => {
  let now = 0;
  const hints = new IntentHints('hint', evaluated, undefined, 1000, () => now);
  hints.start('k', text, context);
  assert.equal(hints.hint('k', text, context), '');
  await delay(10);
  const hint = hints.hint('k', text, context);
  assert.match(hint, /herdr:fixture:1/);
  assert.match(hint, /not authorization/);
  assert.equal(hints.hint('another-call', text, context), '');
  assert.equal(hints.hint('k', '不要提交', context), '');
  assert.equal(hints.hint('k', text, { ...context, conversationId: 'new' }), '');
  assert.equal(hints.hint('k', text, { ...context, history: [] }), '');
  assert.equal(hints.hint('k', text, { ...context, candidates: [] }), '');
  now = 15001;
  assert.equal(hints.hint('k', text, context), '');
  hints.clearAll();
});

test('duplicate accepted transcript is evaluated once; corrections invalidate in-flight result', async () => {
  let resolve!: (r: IntentJudgment) => void;
  let calls = 0, signal!: AbortSignal;
  const hints = new IntentHints('hint', (_text, _ctx, s) => {
    calls++; signal = s; return new Promise(r => { resolve = r; });
  });
  hints.start('k', text, context); hints.start('k', text, context);
  await delay(0);
  assert.equal(calls, 1);
  hints.invalidateText('k', '不要提交');
  assert(signal.aborted);
  resolve(await evaluated()); await delay(0);
  assert.equal(hints.hint('k', text, context), '');
});

test('timeout cannot hold the conversation; clear prevents late result after hangup', async () => {
  const observed: IntentObservation[] = [];
  const hints = new IntentHints('hint', () => new Promise(() => {}), (_, o) => observed.push(o), 10);
  hints.start('k', text, context);
  await delay(25);
  assert.equal(observed[0].outcome, 'timeout');
  assert.equal(hints.hint('k', text, context), '');
  hints.clearAll();
});

test('low intent confidence discarded; irrelevant low target does not suppress a phone hint', async () => {
  const result = await evaluated();
  result.intent.confidence = 0.4;
  const hints = new IntentHints('hint', async () => result);
  hints.start('k', text, context); await delay(0);
  assert.equal(hints.hint('k', text, context), ''); hints.clearAll();
  result.intent = { ...result.intent, choice: 'phone', confidence: 1 };
  result.target.confidence = 0;
  hints.start('k', text, context); await delay(0);
  assert.match(hints.hint('k', text, context), /"intent":"phone"/);
  assert.doesNotMatch(hints.hint('k', text, context), /herdr:fixture/);
  hints.clearAll();
});

test('concurrency is bounded; diagnostic exceptions are isolated', async () => {
  let calls = 0;
  const hints = new IntentHints('shadow', async () => { calls++; await delay(10); return evaluated(); }, () => { throw new Error('disk'); });
  for (const k of ['a', 'b', 'c']) hints.start(k, text, context);
  await delay(0); assert.equal(calls, 2);
  await delay(25); hints.clearAll();
});
