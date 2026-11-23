import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export const ANDROID_ARTIFACT_CHUNK_BYTES = 96 * 1024;
export const MAX_ANDROID_ARTIFACT_BYTES = 256 * 1024 * 1024;
export { createAndroidArtifactSender, createAndroidArtifactTestReceiver, type AndroidArtifactSender } from '@termbridge/settings';

export interface AndroidArtifactDescriptor {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mime: 'application/vnd.android.package-archive';
}

export function describeAndroidArtifact(path: string): AndroidArtifactDescriptor {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
  if (stats.size <= 0) throw new Error('APK is empty');
  if (stats.size > MAX_ANDROID_ARTIFACT_BYTES) {
    throw new Error(`APK exceeds ${MAX_ANDROID_ARTIFACT_BYTES} bytes`);
  }
  if (!path.toLowerCase().endsWith('.apk')) throw new Error('Android artifact must be an .apk file');

  const hash = createHash('sha256');
  for (const chunk of readAndroidArtifactChunks(path)) hash.update(chunk.data);
  return {
    id: randomUUID(),
    name: basename(path).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'termbridge.apk',
    size: stats.size,
    sha256: hash.digest('hex'),
    mime: 'application/vnd.android.package-archive',
  };
}

export function* readAndroidArtifactChunks(
  path: string,
  chunkBytes = ANDROID_ARTIFACT_CHUNK_BYTES,
): Generator<{ offset: number; data: Buffer }> {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 256 * 1024) {
    throw new Error('invalid artifact chunk size');
  }
  const fd = openSync(path, 'r');
  let offset = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytes === 0) break;
      yield { offset, data: buffer.subarray(0, bytes) };
      offset += bytes;
    }
  } finally {
    closeSync(fd);
  }
}
