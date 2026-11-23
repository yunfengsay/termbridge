export interface TranscriptPatch<T> {
  oldStart: number;
  newStart: number;
  retainCount: number;
  before: T[];
  after: T[];
}

/** Rebuild the next line list while retaining the exact stable node identities. */
export function reconstructTranscriptPatch<T>(
  current: readonly T[],
  patch: TranscriptPatch<T>,
): T[] | undefined {
  const { oldStart, newStart, retainCount, before, after } = patch;
  if (![oldStart, newStart, retainCount].every(Number.isInteger)) return undefined;
  if (oldStart < 0 || newStart < 0 || retainCount < 0) return undefined;
  if (oldStart + retainCount > current.length || newStart !== before.length) return undefined;
  return [...before, ...current.slice(oldStart, oldStart + retainCount), ...after];
}

export function applyRevisionedTranscriptPatch<T>(
  currentRevision: number | undefined,
  current: readonly T[],
  baseRevision: number,
  revision: number,
  patch: TranscriptPatch<T>,
): { revision: number; lines: T[] } | undefined {
  if (!Number.isSafeInteger(baseRevision) || !Number.isSafeInteger(revision)) return undefined;
  if (currentRevision !== baseRevision || revision < baseRevision) return undefined;
  const lines = reconstructTranscriptPatch(current, patch);
  return lines ? { revision, lines } : undefined;
}
