import { gunzipSync } from 'node:zlib';

export const VOLCENGINE_EVENTS = {
  startConnection: 1,
  finishConnection: 2,
  startSession: 100,
  finishSession: 102,
  taskRequest: 200,
  updateConfig: 201,
  endAsr: 400,
  chatTtsText: 500,
  chatTextQuery: 501,
  clientInterrupt: 515,
  connectionStarted: 50,
  connectionFailed: 51,
  connectionFinished: 52,
  sessionStarted: 150,
  sessionFinished: 152,
  sessionFailed: 153,
  usage: 154,
  configUpdated: 251,
  ttsSentenceStart: 350,
  ttsSentenceEnd: 351,
  ttsAudio: 352,
  ttsEnded: 359,
  asrInfo: 450,
  asrResponse: 451,
  asrEnded: 459,
  chatResponse: 550,
  chatEnded: 559,
  commonError: 599,
} as const;

const MESSAGE_FULL_CLIENT = 0x1;
const MESSAGE_AUDIO_CLIENT = 0x2;
const MESSAGE_ERROR = 0xf;
const FLAG_EVENT = 0x4;
const SERIALIZATION_RAW = 0x0;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_GZIP = 0x1;
const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface VolcengineFrame {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  event?: number;
  code?: number;
  sequence?: number;
  sessionId?: string;
  payload: Uint8Array;
  json?: unknown;
}

export function encodeVolcengineJsonEvent(
  event: number,
  payload: unknown,
  sessionId?: string,
): Uint8Array {
  return encodeVolcengineEvent(event, Buffer.from(JSON.stringify(payload), 'utf8'), {
    messageType: MESSAGE_FULL_CLIENT,
    serialization: SERIALIZATION_JSON,
    sessionId,
  });
}

export function encodeVolcengineAudioEvent(
  event: number,
  payload: Uint8Array,
  sessionId: string,
): Uint8Array {
  return encodeVolcengineEvent(event, payload, {
    messageType: MESSAGE_AUDIO_CLIENT,
    serialization: SERIALIZATION_RAW,
    sessionId,
  });
}

export function decodeVolcengineFrame(data: Uint8Array): VolcengineFrame {
  const source = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (source.length < HEADER_BYTES + 4) throw new Error('Volcengine realtime frame is truncated');
  const version = source[0]! >> 4;
  const headerBytes = (source[0]! & 0x0f) * 4;
  if (version !== 1 || headerBytes < HEADER_BYTES || headerBytes > source.length) {
    throw new Error('Volcengine realtime frame header is invalid');
  }
  const messageType = source[1]! >> 4;
  const flags = source[1]! & 0x0f;
  const serialization = source[2]! >> 4;
  const compression = source[2]! & 0x0f;
  let cursor = headerBytes;
  const readInt32 = (): number => {
    if (cursor + 4 > source.length) throw new Error('Volcengine realtime frame is truncated');
    const value = source.readInt32BE(cursor);
    cursor += 4;
    return value;
  };

  let code: number | undefined;
  if (messageType === MESSAGE_ERROR) code = readInt32();
  let sequence: number | undefined;
  if (flags === 0x1 || flags === 0x3) sequence = readInt32();
  const event = (flags & FLAG_EVENT) !== 0 ? readInt32() : undefined;
  let sessionId: string | undefined;
  if (event !== undefined && eventHasSessionId(event)) {
    const size = readInt32();
    if (size < 0 || cursor + size > source.length) throw new Error('Volcengine realtime session id is invalid');
    sessionId = source.subarray(cursor, cursor + size).toString('utf8');
    cursor += size;
  }
  const payloadSize = readInt32();
  if (payloadSize < 0 || payloadSize > MAX_FRAME_BYTES || cursor + payloadSize !== source.length) {
    throw new Error('Volcengine realtime payload size is invalid');
  }
  let payload = source.subarray(cursor, cursor + payloadSize);
  if (compression === COMPRESSION_GZIP) payload = gunzipSync(payload);
  let json: unknown;
  if (serialization === SERIALIZATION_JSON && payload.length > 0) {
    try {
      json = JSON.parse(payload.toString('utf8')) as unknown;
    } catch {
      throw new Error('Volcengine realtime JSON payload is invalid');
    }
  }
  return { messageType, flags, serialization, compression, event, code, sequence, sessionId, payload, json };
}

function encodeVolcengineEvent(
  event: number,
  payload: Uint8Array,
  options: { messageType: number; serialization: number; sessionId?: string },
): Uint8Array {
  if (!Number.isInteger(event) || event <= 0) throw new Error('Volcengine realtime event id is invalid');
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('Volcengine realtime payload is too large');
  const session = options.sessionId ? Buffer.from(options.sessionId, 'utf8') : undefined;
  if (eventHasSessionId(event) && !session) throw new Error('Volcengine realtime session event requires a session id');
  const size = HEADER_BYTES + 4 + (session ? 4 + session.length : 0) + 4 + payload.byteLength;
  const frame = Buffer.allocUnsafe(size);
  frame[0] = 0x11;
  frame[1] = (options.messageType << 4) | FLAG_EVENT;
  frame[2] = options.serialization << 4;
  frame[3] = 0;
  let cursor = HEADER_BYTES;
  frame.writeInt32BE(event, cursor);
  cursor += 4;
  if (session) {
    frame.writeInt32BE(session.length, cursor);
    cursor += 4;
    session.copy(frame, cursor);
    cursor += session.length;
  }
  frame.writeInt32BE(payload.byteLength, cursor);
  cursor += 4;
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, cursor);
  return frame;
}

function eventHasSessionId(event: number): boolean {
  switch (event) {
    case VOLCENGINE_EVENTS.startConnection:
    case VOLCENGINE_EVENTS.finishConnection:
    case VOLCENGINE_EVENTS.connectionStarted:
    case VOLCENGINE_EVENTS.connectionFailed:
    case VOLCENGINE_EVENTS.connectionFinished:
      return false;
    default:
      return true;
  }
}
