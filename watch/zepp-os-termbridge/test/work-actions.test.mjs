import assert from 'node:assert/strict'
import test from 'node:test'
import { actionsForStatus } from '../page/home/work-actions.js'

test('approval-like states never expose a direct approve action', () => {
  const actions = actionsForStatus('approval').map((item) => item.id)
  assert.deepEqual(actions, ['summarize', 'snooze', 'handoff', 'stop'])
  assert.equal(actions.includes('approve'), false)
  assert.equal(actions.includes('retry'), false)
})

test('failed work exposes bounded recovery actions', () => {
  assert.deepEqual(
    actionsForStatus('failed').map((item) => item.id),
    ['summarize', 'retry', 'continue', 'snooze', 'handoff', 'stop']
  )
})

test('completed work can be summarized, continued, or handed off', () => {
  assert.deepEqual(actionsForStatus('done').map((item) => item.id), ['summarize', 'continue', 'handoff'])
})
