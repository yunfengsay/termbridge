import assert from 'node:assert/strict'
import test from 'node:test'

import { packVoicePayload, unpackVoicePayload } from '../shared/voice-payload.js'

test('voice payload preserves binary audio without base64 expansion', () => {
  const audio = Uint8Array.from({ length: 256 }, (_, index) => index).buffer
  const packed = packVoicePayload(audio, 'session-123')
  const decoded = unpackVoicePayload(packed)

  assert.equal(packed.byteLength, audio.byteLength + 5 + 'session-123'.length)
  assert.equal(decoded.sourceSessionId, 'session-123')
  assert.deepEqual(new Uint8Array(decoded.audio), new Uint8Array(audio))
})

test('voice payload rejects malformed packets and unsafe session ids', () => {
  assert.throws(() => unpackVoicePayload(new Uint8Array([1, 2, 3]).buffer), /invalid_voice_payload/)
  assert.throws(() => packVoicePayload(new Uint8Array([1]).buffer, 'bad\nsession'), /invalid_source_session/)
})
