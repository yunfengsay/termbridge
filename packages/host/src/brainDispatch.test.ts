import assert from 'node:assert/strict';
import test from 'node:test';
import { ExistingAgentDispatchTracker } from './brainDispatch.js';
import { voiceExecutionRequestId } from './voiceExecution.js';

test('voice execution identity is independent of transcript arrival order and long session ids', () => {
  const session = 'voice-' + 'x'.repeat(128);
  const first = voiceExecutionRequestId(session, 'call-1');
  assert.equal(first, voiceExecutionRequestId(session, 'call-1'));
  assert.notEqual(first, voiceExecutionRequestId(session, 'call-2'));
  assert.notEqual(first, voiceExecutionRequestId('another-session', 'call-1'));
  assert.notEqual(voiceExecutionRequestId('a-b', 'c'), voiceExecutionRequestId('a', 'b-c'));
  assert.match(first, /^voice-exec-[a-f0-9]{64}$/);
  assert.ok(first.length <= 128);
});

test('existing Agent dispatch completes after a working-to-idle transition', () => {
  const tracker = new ExistingAgentDispatchTracker();
  tracker.begin({ taskId: 'brain-1', sessionId: 'herdr:wA:p1', status: 'idle', revision: 10 });

  assert.deepEqual(tracker.evaluate([{ id: 'herdr:wA:p1', status: 'working', revision: 11 }]), []);
  assert.deepEqual(tracker.evaluate([{ id: 'herdr:wA:p1', status: 'idle', revision: 12 }]), [
    { type: 'completed', taskId: 'brain-1', sessionId: 'herdr:wA:p1' },
  ]);
});

test('existing Agent dispatch detects a fast completion between polls', () => {
  const tracker = new ExistingAgentDispatchTracker();
  tracker.begin({ taskId: 'brain-fast', sessionId: 'herdr:wA:p1', status: 'idle', revision: 20 });

  assert.deepEqual(tracker.evaluate([{ id: 'herdr:wA:p1', status: 'done', revision: 22 }]), [
    { type: 'completed', taskId: 'brain-fast', sessionId: 'herdr:wA:p1' },
  ]);
});

test('existing Agent dispatch rejects concurrent work on one pane and fails when it disappears', () => {
  const tracker = new ExistingAgentDispatchTracker();
  tracker.begin({ taskId: 'brain-1', sessionId: 'herdr:wA:p1', status: 'idle', revision: 1 });
  assert.throws(
    () => tracker.begin({ taskId: 'brain-2', sessionId: 'herdr:wA:p1', status: 'idle', revision: 1 }),
    /already has a Brain task/,
  );
  assert.deepEqual(tracker.evaluate([]), [
    { type: 'missing', taskId: 'brain-1', sessionId: 'herdr:wA:p1' },
  ]);
});
