export const VOICE_UPLOAD_DEADLINE_MS = 12000
export const VOICE_STATUS_DEADLINE_MS = 8000
export const VOICE_TURN_DEADLINE_MS = 120000

export function voiceNeedsConfirmation(state) {
  return String(state || '') === 'awaiting_confirmation'
}

export function voiceIsTerminal(state) {
  return ['done', 'error', 'rewrite', 'discarded'].includes(String(state || ''))
}

export function withDeadline(promise, delayMs, schedule = setTimeout, cancel = clearTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeoutId = schedule(() => {
      if (settled) return
      settled = true
      reject(new Error('deadline_exceeded'))
    }, delayMs)

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        cancel(timeoutId)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        cancel(timeoutId)
        reject(error)
      }
    )
  })
}

export function voiceTargetLabel(title) {
  const compactTitle = String(title || '').trim().slice(0, 12)
  return compactTitle ? `回复通知 · ${compactTitle}` : '发送到手机'
}

export function formatRecordingElapsed(elapsedMs) {
  const seconds = Math.max(0, Math.min(99, Math.floor(Number(elapsedMs || 0) / 1000)))
  return `00:${String(seconds).padStart(2, '0')}`
}
