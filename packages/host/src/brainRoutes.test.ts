import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnswerRouteDecision, createToolRouteDecision } from './brainRoutes.js';

test('tool routes capture target, reason, confidence, and authoritative outcome', () => {
  const decision = createToolRouteDecision({
    id: 'route-1',
    requestId: 'request-1',
    call: {
      callId: 'call-1',
      name: 'dispatch_agent',
      arguments: { agent: 'claude', reason: 'Design review', confidence: 0.8 },
    },
    output: JSON.stringify({ ok: true, agent: 'codex', sessionId: 'sess-1' }),
    now: 100,
  });
  assert.equal(decision?.action, 'dispatch_agent');
  assert.equal(decision?.targetAgentId, 'codex');
  assert.equal(decision?.targetSessionId, 'sess-1');
  assert.equal(decision?.reason, 'Design review');
  assert.equal(decision?.confidence, 0.8);
  assert.equal(decision?.outcome, 'accepted');
});

test('malformed mutation output is a rejected route and read tools are not routes', () => {
  const base = { id: 'route-2', requestId: 'request-2', now: 200 };
  assert.equal(createToolRouteDecision({
    ...base,
    call: { callId: 'call-2', name: 'continue_agent', arguments: { sessionId: 'herdr:w1:p1' } },
    output: 'not json',
  })?.outcome, 'rejected');
  assert.equal(createToolRouteDecision({
    ...base,
    call: { callId: 'call-3', name: 'inspect_workspace', arguments: { view: 'overview' } },
    output: '{}',
  }), undefined);
  assert.equal(createAnswerRouteDecision(base).action, 'answer');
});
