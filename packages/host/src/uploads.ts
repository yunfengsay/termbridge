import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAX_SESSION_UPLOAD_BYTES = 4 * 1024 * 1024;

interface SaveSessionUploadOptions {
  sessionId: string;
  mime: string;
  fileName?: string;
  data: Uint8Array;
  root?: string;
}

const formats = {
  'image/jpeg': {
    extension: 'jpg',
    valid: (data: Uint8Array) => data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
    error: 'invalid JPEG data',
  },
  'image/png': {
    extension: 'png',
    valid: (data: Uint8Array) =>
      data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    error: 'invalid PNG data',
  },
  'image/webp': {
    extension: 'webp',
    valid: (data: Uint8Array) =>
      data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
      Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP',
    error: 'invalid WebP data',
  },
} as const;

/** Save a phone-provided image to a private path that a local agent can inspect. */
export function saveSessionUpload(options: SaveSessionUploadOptions): string {
  // Opaque files are never executed or rendered by Host. Keep only a bounded
  // extension; neither the original name nor a path supplied by a peer is trusted.
  const extension = options.fileName?.match(/\.([a-zA-Z0-9]{1,16})$/)?.[1].toLowerCase() ?? 'bin';
  const format = options.mime === 'application/octet-stream'
    ? { extension, valid: (_data: Uint8Array) => true, error: 'invalid file data' }
    : formats[options.mime as keyof typeof formats];
  if (!format) throw new Error(`unsupported upload type ${options.mime}`);
  if (options.data.length === 0) throw new Error('empty image upload');
  if (options.data.length > MAX_SESSION_UPLOAD_BYTES) {
    throw new Error(`image upload exceeds ${MAX_SESSION_UPLOAD_BYTES} bytes`);
  }
  if (!format.valid(options.data)) throw new Error(format.error);

  const root = options.root || join(homedir(), '.termbridge', 'uploads');
  const safeSessionId = options.sessionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'session';
  const directory = join(root, safeSessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${randomUUID()}.${format.extension}`);
  writeFileSync(path, options.data, { flag: 'wx', mode: 0o600 });
  return path;
}
