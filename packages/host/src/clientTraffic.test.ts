import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientTraffic } from './clientTraffic.js';

const session = { sessionId: 'herdr:w1:p1', command: 'codex', source: 'herdr' as const,
  cols: 80, rows: 24, viewers: 1, createdAt: 1, status: 'working', preview: 'private changing text' };

test('legacy is unchanged; background blocks snapshots, not voice or Peer', () => {
  const policy = new ClientTraffic();
  assert.equal(policy.allows('brain_snapshot_result'), true);
  policy.configure(true, true);
  for (const type of ['brain_snapshot_result', 'brain_execution_event', 'brain_text_delta']) assert.equal(policy.allows(type), false);
  for (const type of ['brain_voice_audio', 'tool_request', 'phone_action_event_ack', 'brain_accepted']) {
    assert.equal(policy.allows(type), true);
  }
  policy.configure(false, false);
  assert.equal(policy.allows('brain_snapshot_result'), true);
});

test('baseline, no output churn, completion once, new subscription gets baseline', () => {
  const policy = new ClientTraffic();
  policy.configure(true, true);
  const baseline = policy.notificationSnapshot([session]);
  assert.ok(baseline);
  assert.equal('preview' in baseline[0], false);
  assert.equal(policy.notificationSnapshot([{ ...session, preview: 'more output', viewers: 4 }]), undefined);
  const done = { ...session, status: 'done', completedAt: 10 };
  assert.equal(policy.notificationSnapshot([done])?.[0].completedAt, 10);
  assert.equal(policy.notificationSnapshot([done]), undefined);
  assert.deepEqual(policy.notificationSnapshot([]), []);
  policy.configure(false, false);
  policy.configure(true, true);
  assert.ok(policy.notificationSnapshot([done]));
});
