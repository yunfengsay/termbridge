import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionCount, isAttentionStatus, sortWorkInbox } from '../page/home/work-inbox.js'

test('work inbox keeps actionable alerts ahead of newer completions', () => {
  const alerts = [
    { id: 'done', status: 'done', occurredAt: 30 },
    { id: 'blocked', status: 'blocked', occurredAt: 10 },
    { id: 'approval', status: 'approval', occurredAt: 20 },
    { id: 'older-done', status: 'done', occurredAt: 5 }
  ]

  assert.deepEqual(sortWorkInbox(alerts).map((item) => item.id), ['approval', 'blocked', 'done', 'older-done'])
  assert.equal(attentionCount(alerts), 2)
  assert.equal(isAttentionStatus('failed'), true)
  assert.equal(isAttentionStatus('working'), false)
})
