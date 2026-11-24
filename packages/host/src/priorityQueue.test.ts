import assert from 'node:assert/strict';
import test from 'node:test';
import { PriorityRelaySender, type PrioritySink } from './priorityQueue.js';

test('PriorityRelaySender delivers high-priority interactive frames ahead of queued bulk frames', () => {
  const sent: string[] = [];
  const sink: PrioritySink = {
    readyState: 1,
    bufferedAmount: 512 * 1024, // Simulate congested socket during large transfer
    send(data) {
      sent.push(data.toString('utf8'));
    },
  };

  const sender = new PriorityRelaySender(() => sink);
  sender.enqueue(Buffer.from('bulk-1'), 'bulk');
  sender.enqueue(Buffer.from('bulk-2'), 'bulk');
  assert.equal(sent.length, 0);
  assert.equal(sender.pendingBulk, 2);

  // Interactive terminal output arrives while bulk frames are backed up -> must jump ahead.
  sender.enqueue(Buffer.from('pty-key-echo'), 'high');
  sender.flush();
  assert.deepEqual(sent, ['pty-key-echo']);
  assert.equal(sender.pendingBulk, 2);

  // Once socket buffer drains below high-water mark, bulk resumes cleanly in order.
  (sink as { bufferedAmount: number }).bufferedAmount = 0;
  sender.flush();
  assert.deepEqual(sent, ['pty-key-echo', 'bulk-1', 'bulk-2']);
  sender.clear();
});

test('PriorityRelaySender sends immediately with zero queueing when link is uncongested', () => {
  const sent: string[] = [];
  const sink: PrioritySink = {
    readyState: 1,
    bufferedAmount: 0,
    send(data) { sent.push(data.toString('utf8')); },
  };
  const sender = new PriorityRelaySender(() => sink);
  sender.enqueue(Buffer.from('fast-pty'), 'high');
  sender.enqueue(Buffer.from('fast-bulk'), 'bulk');
  assert.deepEqual(sent, ['fast-pty', 'fast-bulk']);
  assert.equal(sender.pendingHigh, 0);
  assert.equal(sender.pendingBulk, 0);
});
