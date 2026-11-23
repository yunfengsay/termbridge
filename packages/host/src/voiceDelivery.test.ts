import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceActionOutcomes, BrainSnapshotDelivery, agentDeliveryReceipts } from './voiceDelivery.js';
import { BailianVoiceService } from '@termbridge/voice';

test('fork success and old message records never count as a current send receipt', () => {
  assert.deepEqual(agentDeliveryReceipts([{ call: { callId: 'query', name: 'inspect_workspace', arguments: { view: 'messages' } },
    output: JSON.stringify({ ok: true, messages: [{ status: 'sent', sessionId: 'old' }] }) }]), []);
  const receipts = agentDeliveryReceipts([
    { call: { callId: 'send', name: 'continue_agent', arguments: {} }, output: '{"ok":true,"status":"sent","sessionId":"target"}' },
    { call: { callId: 'bad', name: 'continue_agent', arguments: {} }, output: 'not JSON' },
    { call: { callId: 'pending', name: 'dispatch_agent', arguments: {} }, output: '{"ok":true,"status":"queued"}' },
  ]);
  assert.equal(receipts[0].sessionId, 'target');
  assert.equal(receipts[0].status, 'sent');
  assert.equal(receipts[1].ok, false);
  assert.equal(receipts[1].status, 'unknown');
  assert.equal(receipts[2].status, 'queued');
});

test('real Omni adapter: phone completion plus fork completion creates one continuation', async () => {
  const sent: string[] = [];
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  const socket = { readyState: 1, send: (data: string) => sent.push(data), close() {},
    on(event: string, listener: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]); return this;
    } };
  const emit = (event: object) => listeners.get('message')?.forEach(fn => fn(Buffer.from(JSON.stringify(event))));
  const outcomes = new VoiceActionOutcomes();
  let tools = 0;
  const service = new BailianVoiceService({ apiKey: 'fixture', realtimeSocketFactory: () => socket });
  const conversation = service.startRealtimeConversation({ instructions: 'test', turnMode: 'semantic', sendKeyword: '发送',
    tools: [{ name: 'fork_execution', description: 'execute', parameters: { type: 'object', properties: {} } }],
  }, {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onAudio() {}, onFinished() {}, onText() {},
    onResponseStarted() {}, onResponseFinished() {}, onError(error) { assert.fail(error.message); },
    async onToolCall() {
      tools++; outcomes.begin('fork', 'call'); outcomes.track('action', 'fork');
      const result = await outcomes.wait('action', { state: 'running' });
      return JSON.stringify({ result, phoneOutcomes: outcomes.finish('fork') });
    },
  });
  listeners.get('open')?.forEach(fn => fn()); emit({ type: 'session.updated' });
  emit({ type: 'response.created', response: { id: 'initial' } });
  emit({ type: 'response.function_call_arguments.done', call_id: 'tool', name: 'fork_execution', arguments: '{}' });
  await new Promise(resolve => setImmediate(resolve));
  const notify = (state: string) => {
    if (outcomes.accept('action', { state, actionId: 'action', events: [] })) conversation.injectUserMessage?.('phone completed');
  };
  notify('running'); notify('completed');
  await new Promise(resolve => setImmediate(resolve));
  emit({ type: 'response.done', response: { id: 'initial' } });
  emit({ type: 'response.created', response: { id: 'answer' } });
  notify('completed');
  emit({ type: 'response.done', response: { id: 'answer' } });
  assert.equal(tools, 1);
  assert.equal(sent.map(s => JSON.parse(s)).filter(e => e.type === 'response.create').length, 1);
  assert.equal(sent.map(s => JSON.parse(s)).filter(e => e.item?.type === 'function_call_output').length, 1);
  conversation.close(); outcomes.close('call');
});

test('one terminal outcome has one speech owner, independent of receipt order', async () => {
  for (const early of [true, false]) {
    const outcomes = new VoiceActionOutcomes();
    outcomes.begin('fork', 'call'); outcomes.track('action', 'fork');
    const terminal = { actionId: 'action', state: 'completed', data: { events: [] } };
    if (early) assert.equal(outcomes.accept('action', terminal), false);
    const waiting = outcomes.wait('action', { state: 'running' }, 100);
    if (!early) assert.equal(outcomes.accept('action', terminal), false);
    assert.deepEqual(await waiting, terminal);
    assert.deepEqual(outcomes.finish('fork'), [terminal]);
    assert.equal(outcomes.accept('action', terminal), false);
    outcomes.close('call');
  }
});
test('awaiting approval returns immediately; one late completion may notify, never running', async () => {
  const outcomes = new VoiceActionOutcomes(); outcomes.begin('fork', 'call'); outcomes.track('action', 'fork');
  assert.deepEqual(await outcomes.wait('action', { state: 'awaiting_user' }), { state: 'awaiting_user' });
  assert.deepEqual(outcomes.finish('fork'), []);
  assert.equal(outcomes.accept('action', { state: 'running' }), false);
  assert.equal(outcomes.accept('action', { state: 'completed' }), true);
  assert.equal(outcomes.accept('action', { state: 'completed' }), false);
  outcomes.close('call');
});
test('running receipt timeout is pending, terminal in finishing fork is folded into its response', async () => {
  const outcomes = new VoiceActionOutcomes(); outcomes.begin('fork', 'call'); outcomes.track('action', 'fork');
  assert.deepEqual(await outcomes.wait('action', { state: 'running' }, 5), { state: 'running' });
  assert.equal(outcomes.accept('action', { state: 'completed' }), false);
  assert.equal(outcomes.finish('fork').length, 1);
  assert.equal(outcomes.accept('action', { state: 'completed' }), false);
  outcomes.close('call');
});
test('hangup releases waiters, no speech from old call; unrelated action remains eligible', async () => {
  const outcomes = new VoiceActionOutcomes(); outcomes.begin('fork', 'call'); outcomes.track('action', 'fork');
  const waiting = outcomes.wait('action', { state: 'running' }, 10_000);
  outcomes.close('call');
  assert.equal((await waiting).state, 'cancelled');
  assert.equal(outcomes.accept('action', { state: 'completed' }), false);
  assert.equal(outcomes.accept('other', { state: 'completed' }), true);
});
test('call streams bypass full snapshots; hangup delivers exactly one latest snapshot', () => {
  const sent: number[] = []; let active = true;
  const delivery = new BrainSnapshotDelivery(id => active, id => sent.push(id), 10_000);
  for (let i = 0; i < 100; i++) delivery.request(1);
  assert.deepEqual(sent, []);
  active = false; delivery.flush(1);
  assert.deepEqual(sent, [1]);
  delivery.flush(1); assert.deepEqual(sent, [1]); delivery.close(1);
});
test('burst updates are coalesced; disconnect discards pending snapshot', async () => {
  let sent = 0;
  const delivery = new BrainSnapshotDelivery(() => false, () => sent++, 5);
  for (let i = 0; i < 100; i++) delivery.request(1);
  await new Promise(r => setTimeout(r, 15)); assert.equal(sent, 1);
  delivery.request(1); delivery.close(1);
  await new Promise(r => setTimeout(r, 15)); assert.equal(sent, 1);
});
