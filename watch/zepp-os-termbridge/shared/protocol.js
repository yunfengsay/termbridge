export const BRIDGE_PORT = 47391
export const STATUS_PATH = '/v1/status'
export const VOICE_PATH = '/v1/voice'
export const VOICE_DECISION_PATH = '/v1/voice-decision'
export const OPEN_SESSION_PATH = '/v1/open-session'
export const ACTION_PATH = '/v1/action'
export const REFRESH_MS = 5000
export const VOICE_POLL_MS = 1500
export const ACTION_POLL_MS = 1500

export function normalizeToken(value) {
  return String(value || '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase()
}

export function isTokenValid(value) {
  return /^[0-9a-f]{48}$/.test(normalizeToken(value))
}

export function parseBody(body) {
  if (typeof body === 'string') return JSON.parse(body)
  return body || {}
}
