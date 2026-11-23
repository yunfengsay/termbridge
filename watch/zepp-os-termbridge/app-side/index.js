import { BaseSideService, settingsLib } from '@zeppos/zml/base-side'
import { ACTION_PATH, BRIDGE_PORT, OPEN_SESSION_PATH, STATUS_PATH, VOICE_DECISION_PATH, VOICE_PATH, isTokenValid, normalizeToken, parseBody } from '../shared/protocol'
import { unpackVoicePayload } from '../shared/voice-payload'

function pairingToken() {
  return normalizeToken(settingsLib.getItem('termbridgePairingCode'))
}

function authorizedHeaders(token, contentType, sourceSessionId) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(sourceSessionId ? { 'X-TermBridge-Source-Session': sourceSessionId } : {})
  }
}

function actionHeaders(token, action, sourceSessionId) {
  return {
    ...authorizedHeaders(token, null, sourceSessionId),
    'X-TermBridge-Action': action
  }
}

function voiceDecisionHeaders(token, voiceId, decision) {
  return {
    ...authorizedHeaders(token),
    'X-TermBridge-Voice-Id': voiceId,
    'X-TermBridge-Voice-Decision': decision
  }
}

async function getStatus() {
  const token = pairingToken()
  if (!isTokenValid(token)) {
    return { kind: 'pairing_required' }
  }

  try {
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${STATUS_PATH}`,
      method: 'GET',
      headers: authorizedHeaders(token)
    })
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.version !== 1 || !Array.isArray(body.agents)) return { kind: 'bridge_invalid' }
    return { kind: 'status', snapshot: body }
  } catch (error) {
    return { kind: 'phone_unavailable' }
  }
}

async function uploadVoice(audioBuffer, sourceSessionId) {
  const token = pairingToken()
  if (!isTokenValid(token)) return { kind: 'pairing_required' }
  if (!(audioBuffer instanceof ArrayBuffer) || audioBuffer.byteLength < 64 || audioBuffer.byteLength > 1000000) {
    return { kind: 'voice_error', error: 'invalid_audio' }
  }
  const source = typeof sourceSessionId === 'string' && sourceSessionId.length <= 256 && !/[\r\n]/.test(sourceSessionId)
    ? sourceSessionId
    : ''
  try {
    const audio = Buffer.from(audioBuffer).toString('base64')
    console.log(`[TBWATCH] side voice packet bytes=${audioBuffer.byteLength} contextual=${Boolean(source)}`)
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${VOICE_PATH}`,
      method: 'POST',
      headers: authorizedHeaders(token, 'text/plain; charset=us-ascii', source),
      body: audio
    })
    console.log(`[TBWATCH] side voice HTTP ${String(response && response.status || '')}`)
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.error) return { kind: 'voice_error', error: body.error }
    if (body.version !== 1 || !body.voiceId) return { kind: 'bridge_invalid' }
    return { kind: 'voice', snapshot: body }
  } catch (error) {
    console.log(`[TBWATCH] side voice fetch failed ${String(error && error.message || error || 'unknown').slice(0, 96)}`)
    return { kind: 'phone_unavailable' }
  }
}

async function getVoiceStatus(voiceId) {
  const token = pairingToken()
  if (!isTokenValid(token)) return { kind: 'pairing_required' }
  if (!/^[0-9a-f-]{36}$/i.test(String(voiceId || ''))) return { kind: 'voice_error', error: 'not_found' }
  try {
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${VOICE_PATH}/${voiceId}`,
      method: 'GET',
      headers: authorizedHeaders(token)
    })
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.error) return { kind: 'voice_error', error: body.error }
    return { kind: 'voice', snapshot: body }
  } catch (error) {
    return { kind: 'phone_unavailable' }
  }
}

async function submitVoiceDecision(voiceId, decision) {
  const token = pairingToken()
  if (!isTokenValid(token)) return { kind: 'pairing_required' }
  if (!/^[0-9a-f-]{36}$/i.test(String(voiceId || ''))) return { kind: 'voice_error', error: 'not_found' }
  if (!['confirm', 'rewrite', 'discard'].includes(decision)) return { kind: 'voice_error', error: 'invalid_decision' }
  try {
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${VOICE_DECISION_PATH}`,
      method: 'POST',
      headers: voiceDecisionHeaders(token, voiceId, decision)
    })
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.error) return { kind: 'voice_error', error: body.error }
    if (body.version !== 1 || body.voiceId !== voiceId) return { kind: 'bridge_invalid' }
    return { kind: 'voice', snapshot: body }
  } catch (error) {
    return { kind: 'phone_unavailable' }
  }
}

async function openSession(sourceSessionId) {
  const token = pairingToken()
  if (!isTokenValid(token)) return { kind: 'pairing_required' }
  const source = typeof sourceSessionId === 'string' && sourceSessionId.length <= 256 && !/[\r\n]/.test(sourceSessionId)
    ? sourceSessionId
    : ''
  if (!source) return { kind: 'handoff_error', error: 'invalid_session' }
  try {
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${OPEN_SESSION_PATH}`,
      method: 'POST',
      headers: authorizedHeaders(token, null, source)
    })
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.error) return { kind: 'handoff_error', error: body.error }
    if (body.version !== 1 || body.opened !== true) return { kind: 'bridge_invalid' }
    return { kind: 'handoff', opened: true }
  } catch (error) {
    return { kind: 'phone_unavailable' }
  }
}

async function submitAction(action, sourceSessionId) {
  const token = pairingToken()
  if (!isTokenValid(token)) return { kind: 'pairing_required' }
  const source = typeof sourceSessionId === 'string' && sourceSessionId.length <= 256 && !/[\r\n]/.test(sourceSessionId)
    ? sourceSessionId
    : ''
  const supported = ['summarize', 'retry', 'continue', 'stop', 'snooze']
  if (!source || !supported.includes(action)) return { kind: 'action_error', error: 'invalid_action' }
  try {
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${ACTION_PATH}`,
      method: 'POST',
      headers: actionHeaders(token, action, source)
    })
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.error) return { kind: 'action_error', error: body.error }
    if (body.version !== 1 || !body.actionId) return { kind: 'bridge_invalid' }
    return { kind: 'action', snapshot: body }
  } catch (error) {
    return { kind: 'phone_unavailable' }
  }
}

async function getActionStatus(actionId) {
  const token = pairingToken()
  if (!isTokenValid(token)) return { kind: 'pairing_required' }
  if (!/^[0-9a-f-]{36}$/i.test(String(actionId || ''))) return { kind: 'action_error', error: 'not_found' }
  try {
    const response = await fetch({
      url: `http://127.0.0.1:${BRIDGE_PORT}${ACTION_PATH}/${actionId}`,
      method: 'GET',
      headers: authorizedHeaders(token)
    })
    const body = parseBody(response.body)
    if (body.error === 'unauthorized') return { kind: 'pairing_rejected' }
    if (body.error) return { kind: 'action_error', error: body.error }
    return { kind: 'action', snapshot: body }
  } catch (error) {
    return { kind: 'phone_unavailable' }
  }
}

AppSideService(
  BaseSideService({
    onInit() {},
    async onRequest(req, res) {
      if (req instanceof ArrayBuffer) {
        try {
          const payload = unpackVoicePayload(req)
          res(null, await uploadVoice(payload.audio, payload.sourceSessionId))
        } catch (error) {
          res(null, { kind: 'voice_error', error: 'invalid_audio' })
        }
        return
      }
      switch (req.method) {
        case 'GET_STATUS':
          res(null, await getStatus())
          break
        case 'VOICE_STATUS':
          res(null, await getVoiceStatus(req.params && req.params.voiceId))
          break
        case 'VOICE_DECISION':
          res(null, await submitVoiceDecision(req.params && req.params.voiceId, req.params && req.params.decision))
          break
        case 'OPEN_SESSION':
          res(null, await openSession(req.params && req.params.sessionId))
          break
        case 'SUBMIT_ACTION':
          res(null, await submitAction(req.params && req.params.action, req.params && req.params.sessionId))
          break
        case 'ACTION_STATUS':
          res(null, await getActionStatus(req.params && req.params.actionId))
          break
        default:
          res(null, { kind: 'unsupported' })
      }
    },
    onSettingsChange() {
      this.call({ kind: 'settings_changed' })
    },
    onRun() {},
    onDestroy() {}
  })
)
