import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VOICE_UPLOAD_DEADLINE_MS,
  formatRecordingElapsed,
  voiceIsTerminal,
  voiceNeedsConfirmation,
  voiceTargetLabel,
  withDeadline
} from '../page/home/voice-flow.js'

test('an unresolved watch upload leaves the pending state within a short deadline', async () => {
  const never = new Promise(() => {})
  const immediately = (callback) => {
    callback()
    return 1
  }

  await assert.rejects(
    withDeadline(never, VOICE_UPLOAD_DEADLINE_MS, immediately, () => {}),
    /deadline_exceeded/
  )
  assert.ok(VOICE_UPLOAD_DEADLINE_MS <= 12000)
})

test('a completed upload clears its watchdog', async () => {
  let cancelled = false
  const result = await withDeadline(Promise.resolve('accepted'), 1000, () => 7, (id) => {
    assert.equal(id, 7)
    cancelled = true
  })

  assert.equal(result, 'accepted')
  assert.equal(cancelled, true)
})

test('voice destination is explicit before recording starts', () => {
  assert.equal(voiceTargetLabel(''), '发送到手机')
  assert.equal(voiceTargetLabel('Build Android client'), '回复通知 · Build Androi')
})

test('recording feedback exposes elapsed time without inventing an input level', () => {
  assert.equal(formatRecordingElapsed(0), '00:00')
  assert.equal(formatRecordingElapsed(11999), '00:11')
})

test('ASR confirmation pauses polling until the user chooses an action', () => {
  assert.equal(voiceNeedsConfirmation('awaiting_confirmation'), true)
  assert.equal(voiceIsTerminal('awaiting_confirmation'), false)
  assert.equal(voiceIsTerminal('rewrite'), true)
  assert.equal(voiceIsTerminal('discarded'), true)
})
