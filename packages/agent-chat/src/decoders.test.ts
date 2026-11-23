import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeDecoder, codexDecoder } from './index.js';
import { AGENT_CHAT_INTERRUPTED_TEXT } from './types.js';

// Every fixture below is synthetic: hand-written records in each CLI's shape.
// No real conversation content is copied into the repository.

const claudeLine = (record: unknown) => JSON.stringify(record);

test('the Claude decoder keeps prose and tool activity and drops model-internal reasoning', () => {
  const prompt = claudeDecoder.decode(claudeLine({
    type: 'user', uuid: 'u1', timestamp: '2026-09-14T02:00:00.000Z',
    sessionId: 's1', message: { role: 'user', content: '重新跑一次测试' },
  }), 'fallback');
  assert.deepEqual(prompt, {
    id: 'u1', role: 'user', timestamp: Date.parse('2026-09-14T02:00:00.000Z'), source: 'transcript',
    blocks: [{ type: 'text', text: '重新跑一次测试' }],
  });

  const reply = claudeDecoder.decode(claudeLine({
    type: 'assistant', uuid: 'a1', timestamp: '2026-09-14T02:00:05.000Z', sessionId: 's1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '私密推理不应出现' },
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pnpm test' } },
      ],
    },
  }), 'fallback');
  assert.equal(reply?.role, 'assistant');
  assert.deepEqual(reply?.blocks, [
    { type: 'text', text: '好的' },
    { type: 'tool-call', name: 'Bash', input: '{"command":"pnpm test"}', callId: 'call-1' },
  ]);
  assert.equal(JSON.stringify(reply).includes('私密推理'), false);

  const toolTurn = claudeDecoder.decode(claudeLine({
    type: 'user', uuid: 'u2', sessionId: 's1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false }] },
  }), 'fallback');
  assert.equal(toolTurn?.role, 'tool');
  assert.deepEqual(toolTurn?.blocks, [{ type: 'tool-result', output: 'ok', callId: 'call-1' }]);
  assert.equal(toolTurn?.timestamp, null);
});

test('the Claude decoder reports an interruption as status and never as a user prompt', () => {
  const byField = claudeDecoder.decode(claudeLine({
    type: 'user', uuid: 'i1', sessionId: 's1', interruptedMessageId: 'msg_1',
    message: { role: 'user', content: '[Request interrupted by user]' },
  }), 'fallback');
  assert.equal(byField?.role, 'system');
  assert.deepEqual(byField?.blocks, [{ type: 'text', text: AGENT_CHAT_INTERRUPTED_TEXT }]);

  const byText = claudeDecoder.decode(claudeLine({
    type: 'user', uuid: 'i2', sessionId: 's1',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  }), 'fallback');
  assert.equal(byText?.role, 'system');
  assert.equal(claudeDecoder.userPromptText(claudeLine({
    type: 'user', uuid: 'i3', sessionId: 's1', interruptedMessageId: 'msg_2',
    message: { role: 'user', content: '[Request interrupted by user]' },
  })), undefined);
});

test('a Claude prompt excludes injected context, sidechains and replayed turns', () => {
  const withReminder = claudeDecoder.decode(claudeLine({
    type: 'user', uuid: 'u3', sessionId: 's1',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\n内部提示\n</system-reminder>' },
        { type: 'text', text: '继续' },
      ],
    },
  }), 'fallback');
  assert.deepEqual(withReminder?.blocks, [{ type: 'text', text: '继续' }]);
  assert.equal(claudeDecoder.userPromptText(claudeLine({
    type: 'user', uuid: 'u3', sessionId: 's1',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>内部提示</system-reminder>' },
        { type: 'text', text: '继续' },
      ],
    },
  })), '继续');

  assert.equal(claudeDecoder.decode(claudeLine({
    type: 'user', uuid: 'u4', sessionId: 's1', isSidechain: true,
    message: { role: 'user', content: '子代理提示' },
  }), 'fallback'), null);
  assert.equal(claudeDecoder.userPromptText(claudeLine({
    type: 'user', uuid: 'u5', sessionId: 's1', isMeta: true,
    message: { role: 'user', content: '回放的上下文' },
  })), undefined);
});

test('the Claude decoder reports the session id a record claims for itself', () => {
  assert.equal(claudeDecoder.sessionIdOf(claudeLine({ type: 'mode', sessionId: 'abc' })), 'abc');
  assert.equal(claudeDecoder.sessionIdOf('not json'), undefined);
});

test('the Codex decoder maps response items, completed items and turn aborts', () => {
  const prompt = codexDecoder.decode(JSON.stringify({
    timestamp: '2026-09-14T03:00:00.000Z', type: 'response_item',
    payload: { id: 'p1', type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续实现' }] },
  }), 'fallback');
  assert.equal(prompt?.role, 'user');
  assert.deepEqual(prompt?.blocks, [{ type: 'text', text: '继续实现' }]);

  const call = codexDecoder.decode(JSON.stringify({
    type: 'response_item',
    payload: { id: 'c1', type: 'function_call', name: 'shell', call_id: 'x1', arguments: '{"cmd":"ls"}' },
  }), 'fallback');
  assert.deepEqual(call?.blocks, [{ type: 'tool-call', name: 'shell', input: '{"cmd":"ls"}', callId: 'x1' }]);

  const output = codexDecoder.decode(JSON.stringify({
    type: 'response_item',
    payload: { id: 'o1', type: 'function_call_output', call_id: 'x1', output: { success: false, content: 'boom' } },
  }), 'fallback');
  assert.deepEqual(output?.blocks, [{ type: 'tool-result', output: 'boom', isError: true, callId: 'x1' }]);

  const aborted = codexDecoder.decode(JSON.stringify({
    type: 'event_msg', payload: { id: 'e1', type: 'turn_aborted' },
  }), 'fallback');
  assert.equal(aborted?.role, 'system');
  assert.deepEqual(aborted?.blocks, [{ type: 'text', text: AGENT_CHAT_INTERRUPTED_TEXT }]);

  // `item_completed` messages are the mirror of `response_item/message`; see
  // the dual-source tests below for why only the canonical side is read.
  const completed = codexDecoder.decode(JSON.stringify({
    type: 'event_msg',
    payload: {
      id: 'e2', type: 'item_completed',
      item: { id: 'i2', type: 'AgentMessage', content: [{ type: 'Text', text: '完成' }] },
    },
  }), 'fallback');
  assert.equal(completed, null);

  assert.equal(codexDecoder.decode(JSON.stringify({
    type: 'response_item', payload: { id: 'r1', type: 'reasoning', text: '内部推理' },
  }), 'fallback'), null);
});

test('one user turn recorded by both Codex sources is one message', () => {
  // Codex writes a prompt twice, and the two records carry freshly generated
  // UUIDs that differ — nothing marks them as the same item, so both used to be
  // drawn. Measured over eight recent rollouts this accounted for every
  // duplicated user turn (156 of them) and no assistant or tool item.
  const canonical = codexDecoder.decode(JSON.stringify({
    type: 'response_item',
    payload: {
      id: 'msg_01a070b1-7fb3-74f1-8dc8-6a6b9a3982c7', type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '你看到了吗？' }],
    },
  }), 'fallback-a');
  assert.equal(canonical?.role, 'user');
  assert.deepEqual(canonical?.blocks, [{ type: 'text', text: '你看到了吗？' }]);

  const echo = codexDecoder.decode(JSON.stringify({
    type: 'event_msg',
    payload: {
      id: 'e9', type: 'item_completed',
      item: {
        id: '01a070b1-7fb3-74f1-8dc8-6a7409c389e9', type: 'UserMessage',
        content: [{ type: 'Text', text: '你看到了吗？' }],
      },
    },
  }), 'fallback-b');
  // The echo is dropped, not merged: merging would have to compare text.
  assert.equal(echo, null);
});

test('two real sends of the same words stay two messages', () => {
  const first = codexDecoder.decode(JSON.stringify({
    type: 'response_item',
    payload: { id: 'msg_01a0709e-de94-7693-8cf3-3aa9f141565c', type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '再来一次' }] },
  }), 'fallback-a');
  const second = codexDecoder.decode(JSON.stringify({
    type: 'response_item',
    payload: { id: 'msg_01a07fc4-ca80-7bc3-b8ea-666862036589', type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '再来一次' }] },
  }), 'fallback-b');
  // Identical text, two genuine turns. Nothing may fold them together.
  assert.notEqual(first?.id, second?.id);
  assert.deepEqual(first?.blocks, second?.blocks);
});

test('an assistant turn recorded by both Codex sources is one message', () => {
  // The screenshot shows assistant replies doubled too. Some rollouts give the
  // two sources the same id and fold on their own; others give different ones
  // and draw both. Only the canonical side is read, so neither shape doubles.
  const canonical = codexDecoder.decode(JSON.stringify({
    type: 'response_item',
    payload: { id: 'msg_01a0aaaa-0000-7000-8000-000000000001', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '好，我以你发的这张图为准。' }] },
  }), 'fallback-a');
  assert.equal(canonical?.role, 'assistant');

  for (const mirrorId of ['msg_01a0aaaa-0000-7000-8000-000000000001', '01a0aaaa-0000-7000-8000-000000000999']) {
    const echo = codexDecoder.decode(JSON.stringify({
      type: 'event_msg',
      payload: { id: 'e1', type: 'item_completed',
        item: { id: mirrorId, type: 'AgentMessage', content: [{ type: 'Text', text: '好，我以你发的这张图为准。' }] } },
    }), 'fallback-b');
    assert.equal(echo, null, `mirror ${mirrorId} must not become a second message`);
  }
});

test('a Codex prompt excludes the environment and instruction preambles', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      id: 'p2', type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: '<environment_context>\ncwd\n</environment_context>' },
        { type: 'input_text', text: '跑一下测试' },
      ],
    },
  });
  assert.equal(codexDecoder.userPromptText(line), '跑一下测试');
  assert.equal(codexDecoder.userPromptText(JSON.stringify({
    type: 'response_item',
    payload: { id: 'p3', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '跑一下测试' }] },
  })), undefined);
  assert.equal(
    codexDecoder.sessionIdOf(JSON.stringify({ type: 'session_meta', payload: { session_id: 'sess-1' } })),
    'sess-1',
  );
  assert.equal(codexDecoder.sessionIdOf(JSON.stringify({ type: 'response_item', payload: { id: 'x' } })), undefined);
});

test('blocks are bounded and an image never carries a host path', () => {
  const long = 'x'.repeat(50_000);
  const reply = claudeDecoder.decode(claudeLine({
    type: 'assistant', uuid: 'a2', sessionId: 's1',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'c2', name: 'Write', input: { body: long } },
        { type: 'image', source: { url: 'https://example.com/a.png' } },
        { type: 'image', path: '/Users/someone/private/shot.png' },
      ],
    },
  }), 'fallback');
  const [call, remote, local] = reply!.blocks;
  assert.equal(call.type === 'tool-call' && call.truncated, true);
  assert.equal(call.type === 'tool-call' && call.input.length <= 4_000, true);
  assert.deepEqual(remote, { type: 'image-ref', url: 'https://example.com/a.png' });
  assert.deepEqual(local, { type: 'image-ref', name: 'shot.png' });
  assert.equal(JSON.stringify(reply).includes('/Users/someone/private'), false);
});
