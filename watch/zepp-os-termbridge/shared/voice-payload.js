const MAGIC = [0x54, 0x42, 0x56, 0x31]
const HEADER_BYTES = MAGIC.length + 1

export function packVoicePayload(audio, sourceSessionId = '') {
  const audioBytes = toBytes(audio)
  const source = normalizeSourceSessionId(sourceSessionId)
  const payload = new Uint8Array(HEADER_BYTES + source.length + audioBytes.byteLength)

  payload.set(MAGIC, 0)
  payload[MAGIC.length] = source.length
  for (let index = 0; index < source.length; index += 1) {
    payload[HEADER_BYTES + index] = source.charCodeAt(index)
  }
  payload.set(audioBytes, HEADER_BYTES + source.length)
  return payload.buffer
}

export function unpackVoicePayload(payload) {
  const bytes = toBytes(payload)
  if (bytes.byteLength < HEADER_BYTES) throw new Error('invalid_voice_payload')
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new Error('invalid_voice_payload')
  }

  const sourceLength = bytes[MAGIC.length]
  const audioOffset = HEADER_BYTES + sourceLength
  if (bytes.byteLength <= audioOffset) throw new Error('invalid_voice_payload')

  let sourceSessionId = ''
  for (let index = HEADER_BYTES; index < audioOffset; index += 1) {
    sourceSessionId += String.fromCharCode(bytes[index])
  }
  return {
    sourceSessionId: normalizeSourceSessionId(sourceSessionId),
    audio: bytes.slice(audioOffset).buffer
  }
}

function normalizeSourceSessionId(value) {
  const source = String(value || '')
  if (source.length > 255 || /[^\x20-\x7e]/.test(source) || /[\r\n]/.test(source)) {
    throw new Error('invalid_source_session')
  }
  return source
}

function toBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('invalid_voice_payload')
}
