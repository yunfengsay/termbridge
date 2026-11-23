import { pack, unpack } from 'msgpackr';
import { Buffer } from 'node:buffer';
import type { ControlMessage } from './messages.js';

/**
 * Wire format. Every WebSocket message is one binary frame:
 *
 *   [type:u8][payload...]
 *
 * CONTROL carries msgpack(ControlMessage). PTY frames carry a 16-bit session
 * index (`sid`, negotiated per client connection at attach time) followed by
 * raw bytes — no per-byte encoding overhead on the terminal hot path.
 *
 * One WebSocket connection multiplexes many sessions via `sid`.
 */
export enum FrameType {
  Control = 0,
  PtyOut = 1,
  PtyIn = 2,
  PtyResize = 3,
}

export function encodeControl(msg: ControlMessage): Buffer {
  const body = pack(msg);
  const out = Buffer.allocUnsafe(1 + body.length);
  out[0] = FrameType.Control;
  out.set(body, 1);
  return out;
}

export function framePtyOut(sid: number, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(3 + data.length);
  out[0] = FrameType.PtyOut;
  out.writeUInt16BE(sid, 1);
  out.set(data, 3);
  return out;
}

export function framePtyIn(sid: number, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(3 + data.length);
  out[0] = FrameType.PtyIn;
  out.writeUInt16BE(sid, 1);
  out.set(data, 3);
  return out;
}

export function framePtyResize(sid: number, cols: number, rows: number): Buffer {
  const out = Buffer.allocUnsafe(7);
  out[0] = FrameType.PtyResize;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(1, sid);
  view.setUint16(3, cols);
  view.setUint16(5, rows);
  return out;
}

export type ParsedFrame =
  | { type: FrameType.Control; msg: ControlMessage }
  | { type: FrameType.PtyOut; sid: number; data: Buffer }
  | { type: FrameType.PtyIn; sid: number; data: Buffer }
  | { type: FrameType.PtyResize; sid: number; cols: number; rows: number };

export function parseFrame(buf: Buffer): ParsedFrame {
  const type = buf[0] as FrameType;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (type) {
    case FrameType.Control:
      return { type, msg: unpack(buf.subarray(1)) as ControlMessage };
    case FrameType.PtyOut:
      return { type, sid: view.getUint16(1), data: buf.subarray(3) };
    case FrameType.PtyIn:
      return { type, sid: view.getUint16(1), data: buf.subarray(3) };
    case FrameType.PtyResize:
      return {
        type,
        sid: view.getUint16(1),
        cols: view.getUint16(3),
        rows: view.getUint16(5),
      };
    default:
      throw new Error(`unknown frame type ${type}`);
  }
}

/**
 * Relay envelope — used ONLY on the relay <-> host link:
 *
 *   [clientId:u32][frame...]
 *
 * The relay <-> client link carries bare frames (the client already chose its
 * host in the handshake), so the client/host protocol is identical whether or
 * not a relay sits in the middle. Only the host needs the clientId dimension,
 * because one host fans out to many clients.
 */
export function encodeEnvelope(clientId: number, frame: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + frame.length);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, clientId);
  out.set(frame, 4);
  return out;
}

export function decodeEnvelope(buf: Buffer): { clientId: number; frame: Buffer } {
  return { clientId: new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0), frame: buf.subarray(4) };
}
