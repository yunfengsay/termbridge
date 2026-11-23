import assert from 'node:assert/strict';
import test from 'node:test';
import { BrainCoordinator, MemoryBrainStore } from '@termbridge/brain';
import { PhoneActionTimeline } from './phoneActionTimeline.js';
import type { PhoneActionEvent } from './phoneActions.js';

const event: PhoneActionEvent = {
  eventId: 'event', actionId: 'phone-tool', requestId: 'request', callId: 'call',
  toolResultId: 'tool', deviceId: 'phone', action: 'alarm.create', state: 'completed',
  summary: '已打开系统闹钟确认页', createdAt: 200,
};
for (const early of [true, false]) test(`alarm approval adds a fresh reply, completion before model reply=${early}`, () => {
  const store = new MemoryBrainStore();
  const brain = new BrainCoordinator(store);
  const timeline = new PhoneActionTimeline(brain);
  brain.appendConversationMessage({ id: 'request', role: 'user', text: '定一个十点半的闹铃' });
  timeline.begin('request');
  if (early) timeline.accept(event);
  brain.appendConversationMessage({ id: 'request-brain', role: 'brain', text: '点一下确认即可创建' });
  timeline.finish('request');
  if (!early) timeline.accept(event);
  assert.match(brain.getSnapshot().messages.at(-1)!.text, /已收到.*确认/);
  assert.match(brain.getSnapshot().messages.at(-1)!.text, /以.*时钟.*为准/);
  timeline.accept({ ...event, eventId: 'recovered', createdAt: 300 });
  assert.equal(brain.getSnapshot().messages.length, 3);
  assert.equal(new BrainCoordinator(store).getSnapshot().messages.length, 3);
  timeline.accept({ ...event, eventId: 'stale', state: 'awaiting_user', createdAt: 100 });
  assert.equal(brain.getSnapshot().toolResults![0].view.items[0].status, 'completed');
});

test('late phone completion remains in its original conversation after switching and restart', () => {
  const store = new MemoryBrainStore();
  let brain = new BrainCoordinator(store);
  brain.appendConversationMessage({ id: 'request', role: 'user', text: '闹钟' });
  new PhoneActionTimeline(brain).accept({ ...event, state: 'awaiting_user', summary: '请确认', createdAt: 100 });
  const archived = brain.startNewConversation()!;
  brain = new BrainCoordinator(store);
  new PhoneActionTimeline(brain).accept(event);
  assert.equal(brain.getSnapshot().messages.length, 0);
  assert.match(brain.getHistoryConversation(archived.id)!.messages.at(-1)!.text, /已收到.*确认/);
});

test('failed and denied actions produce honest follow-ups without claiming success', () => {
  for (const state of ['failed', 'denied', 'cancelled', 'expired'] as const) {
    const brain = new BrainCoordinator(new MemoryBrainStore());
    new PhoneActionTimeline(brain).accept({ ...event, state, summary: '未完成', error: '原因' });
    assert.match(brain.getSnapshot().messages.at(-1)!.text, /未完成.*原因/);
  }
});

test('phone clock behind Host does not suppress confirmation', () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const timeline = new PhoneActionTimeline(brain);
  timeline.accept({ ...event, state: 'awaiting_user', summary: '请确认', createdAt: 9999 });
  timeline.accept(event);
  assert.equal(brain.getSnapshot().toolResults![0].view.items[0].status, 'completed');
  assert.match(brain.getSnapshot().messages.at(-1)!.text, /已收到/);
});
