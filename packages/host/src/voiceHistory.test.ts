import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeVoiceReplyDraft } from './voiceHistory.js';

test('realtime voice deltas become one labelled durable reply', () => {
  const reply = new RealtimeVoiceReplyDraft();
  reply.start();
  reply.update('已经', false);
  reply.update('处理完成。', false);
  reply.update('已经处理完成。', true);

  assert.deepEqual(reply.finish('call-1'), {
    id: 'call-1-voice-brain-1',
    role: 'brain',
    text: '已经处理完成。',
    modality: 'voice',
    voiceStatus: 'completed',
  });
  assert.equal(reply.finish('call-1'), undefined, 'a repeated finish does not duplicate history');
});

test('an empty final event keeps streamed voice text', () => {
  const reply = new RealtimeVoiceReplyDraft();
  reply.start();
  reply.update('火山流式回复', false);
  reply.update('', true);
  assert.equal(reply.finish('call-2')?.text, '火山流式回复');
});

test('late final text cannot reopen a finished response', () => {
  const reply = new RealtimeVoiceReplyDraft();
  reply.start();
  reply.update('上一轮', true);
  reply.finish('call');
  reply.update('上一轮', true);
  assert.equal(reply.finish('call'), undefined);
});

test('streaming checkpoints and interrupted finish share one durable identity', () => {
  const reply = new RealtimeVoiceReplyDraft();
  reply.start();
  reply.update('已经收到', false);
  const partial = reply.checkpoint('call');
  reply.update('你的问题', false);
  const stopped = reply.finish('call', 'interrupted');
  assert.equal(partial?.id, stopped?.id);
  assert.equal(partial?.voiceStatus, 'streaming');
  assert.equal(stopped?.voiceStatus, 'interrupted');
  assert.equal(stopped?.text, '已经收到你的问题');
});
