import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendAgentChatMessages,
  boundAgentChatWindow,
  createAgentChatMerger,
  mergeAgentChatMessages,
  replaceAgentChatList,
} from './merge.js';
import type { AgentChatMessage, AgentChatSource } from './types.js';

const message = (id: string, seq: number, source: AgentChatSource = 'transcript'): AgentChatMessage => ({
  id, role: 'user', blocks: [{ type: 'text', text: id }], timestamp: seq, source, seq,
});

test('a reconnect that replays records does not duplicate them', () => {
  const base = [message('a', 1), message('b', 2)];
  const merged = mergeAgentChatMessages(base, [message('b', 2), message('c', 3)]);
  assert.deepEqual(merged.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(base.map((entry) => entry.id), ['a', 'b']);
});

test('a provider record supersedes the client-side echo of the same message', () => {
  const merged = mergeAgentChatMessages([message('a', 1, 'local')], [message('a', 9)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.source, 'transcript');
  const notDowngraded = mergeAgentChatMessages([message('a', 9)], [message('a', 1, 'local')]);
  assert.equal(notDowngraded[0]!.source, 'transcript');
});

test('a long run keeps the client window bounded and its index correct', () => {
  const merger = createAgentChatMerger();
  replaceAgentChatList(merger, [message('a', 1), message('b', 2)]);
  const list = appendAgentChatMessages(merger, [message('c', 3), message('d', 4)], 3);
  assert.deepEqual(list.map((entry) => entry.id), ['b', 'c', 'd']);
  // The rebuilt index must still dedup rather than append a second `d`.
  assert.deepEqual(appendAgentChatMessages(merger, [message('d', 4)], 3).map((entry) => entry.id), ['b', 'c', 'd']);
  assert.deepEqual(boundAgentChatWindow([message('a', 1)], 0).map((entry) => entry.id), ['a']);
  assert.equal(appendAgentChatMessages(merger, []), merger.list);
});
