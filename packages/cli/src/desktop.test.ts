import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlMessageSchema } from '@termbridge/protocol';
import { agentChatControl } from './desktop.js';

// The desktop bridge is a forwarder: every field a shell needs back must survive
// the mapping. A field dropped here is invisible until the shell silently
// discards the Host's answer, which is exactly what happened to `generation`.

test('every conversation request keeps the fields its answer is matched by', () => {
  const list = ControlMessageSchema.parse(agentChatControl({ op: 'chat-list', requestId: 'r1' }));
  assert.deepEqual(list, { t: 'agent_chat_list', requestId: 'r1' });

  const subscribe = ControlMessageSchema.parse(agentChatControl({
    op: 'chat-subscribe', requestId: 'r2', conversationId: 'herdr:w1:p1', generation: 4,
  }));
  assert.deepEqual(subscribe, {
    t: 'agent_chat_subscribe', requestId: 'r2', conversationId: 'herdr:w1:p1', generation: 4,
  });

  // The regression: without `generation` the Host cannot echo one, so the shell
  // discards every page it asked for.
  const earlier = ControlMessageSchema.parse(agentChatControl({
    op: 'chat-earlier', requestId: 'r3', conversationId: 'herdr:w1:p1', generation: 4, cursor: 4_096,
  }));
  assert.deepEqual(earlier, {
    t: 'agent_chat_earlier', requestId: 'r3', conversationId: 'herdr:w1:p1', generation: 4, cursor: 4_096,
  });

  const unsubscribe = ControlMessageSchema.parse(agentChatControl({
    op: 'chat-unsubscribe', conversationId: 'herdr:w1:p1',
  }));
  assert.deepEqual(unsubscribe, { t: 'agent_chat_unsubscribe', conversationId: 'herdr:w1:p1' });

  const sent = ControlMessageSchema.parse(agentChatControl({
    op: 'chat-send', requestId: 'r4', conversationId: 'herdr:w1:p1', text: '继续',
  }));
  assert.deepEqual(sent, {
    t: 'agent_chat_send', requestId: 'r4', conversationId: 'herdr:w1:p1', text: '继续',
  });
});

test('a malformed local request is rejected by the schema, not forwarded', () => {
  for (const request of [
    { op: 'chat-earlier', requestId: 'r1', conversationId: 'c', cursor: 0 },          // no generation
    { op: 'chat-earlier', requestId: 'r1', conversationId: 'c', generation: -1, cursor: 0 },
    { op: 'chat-earlier', requestId: 'r1', conversationId: 'c', generation: 1, cursor: -5 },
    { op: 'chat-subscribe', requestId: 'r1', conversationId: 'c' },                    // no generation
    { op: 'chat-send', requestId: 'r1', conversationId: 'c', text: '' },
    { op: 'chat-list' },                                                               // no requestId
  ]) {
    assert.throws(() => ControlMessageSchema.parse(agentChatControl(request)),
      `expected the schema to reject ${JSON.stringify(request)}`);
  }
});
