/**
 * Bounded incremental reader for a provider's append-only JSONL transcript.
 *
 * Adapted from Orca `src/main/native-chat/transcript-incremental-reader.ts`
 * at revision 55b33920180efa188a19dfb7fac0fc993f10a922.
 * Copyright (c) 2026 Lovecast Inc. — MIT. See THIRD_PARTY_NOTICES.md.
 *
 * A running Agent appends to this file while we read it, so the reader keeps a
 * byte offset and a partial-line buffer: a record split across chunks is
 * completed on the next pass, an over-long record is dropped rather than
 * buffered without bound, and a file that shrank (rotation or truncation) is
 * reported so the caller can rebuild instead of decoding garbage.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** A single record larger than this is dropped; no transcript row is this big. */
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
/** Batch size at which a long catch-up hands rows to the caller mid-read. */
const BATCH_LIMIT = 40;

export interface TranscriptCursor {
  offset: number;
  pendingChunks: Buffer[];
  pendingStart: number;
  pendingBytes: number;
  droppingOversized: boolean;
}

export function createTranscriptCursor(offset = 0): TranscriptCursor {
  return { offset, pendingChunks: [], pendingStart: offset, pendingBytes: 0, droppingOversized: false };
}

export function resetTranscriptCursor(cursor: TranscriptCursor, offset = 0): void {
  cursor.offset = offset;
  cursor.pendingChunks.length = 0;
  cursor.pendingStart = offset;
  cursor.pendingBytes = 0;
  cursor.droppingOversized = false;
}

/** One decoded record plus the offset of the line that produced it. */
export interface TranscriptLine {
  /** Byte offset where this record's line begins. */
  offset: number;
  line: string;
}

export interface IncrementalReadResult {
  lines: TranscriptLine[];
  /** True when the file shrank below the cursor: the caller must rebuild. */
  rewound: boolean;
  /** Size observed at the start of this pass. */
  size: number;
}

/**
 * Read every complete record appended since `cursor.offset`. `onBatch` receives
 * long catch-ups in slices so a large backlog never materializes at once.
 */
export async function readTranscriptSince(
  filePath: string,
  cursor: TranscriptCursor,
  onBatch?: (lines: TranscriptLine[]) => void,
  endByte?: number,
): Promise<IncrementalReadResult> {
  const observed = (await stat(filePath)).size;
  const size = endByte === undefined ? observed : Math.min(observed, endByte);
  if (observed < cursor.offset) return { lines: [], rewound: true, size: observed };
  if (size <= cursor.offset) return { lines: [], rewound: false, size };

  const lines: TranscriptLine[] = [];
  const stream = createReadStream(filePath, { start: cursor.offset, end: size - 1 });
  try {
    let absolute = cursor.offset;
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      let segmentStart = 0;
      let newline = chunk.indexOf(0x0a);
      while (newline >= 0) {
        retain(chunk.subarray(segmentStart, newline));
        if (!cursor.droppingOversized) flushLine();
        resetPending(absolute + newline + 1);
        segmentStart = newline + 1;
        newline = chunk.indexOf(0x0a, segmentStart);
      }
      if (segmentStart < chunk.length) retain(chunk.subarray(segmentStart));
      absolute += chunk.length;
      cursor.offset = absolute;
    }
    return { lines, rewound: false, size };
  } finally {
    stream.destroy();
  }

  function retain(part: Buffer): void {
    if (cursor.droppingOversized) return;
    cursor.pendingBytes += part.length;
    if (cursor.pendingBytes > MAX_RECORD_BYTES) {
      cursor.pendingChunks.length = 0;
      cursor.droppingOversized = true;
      return;
    }
    cursor.pendingChunks.push(part);
  }

  function resetPending(nextStart: number): void {
    cursor.pendingChunks.length = 0;
    cursor.pendingBytes = 0;
    cursor.droppingOversized = false;
    cursor.pendingStart = nextStart;
  }

  function flushLine(): void {
    let line = Buffer.concat(cursor.pendingChunks).toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) return;
    lines.push({ offset: cursor.pendingStart, line });
    if (onBatch && lines.length >= BATCH_LIMIT) onBatch(lines.splice(0));
  }
}

/**
 * Read complete records in `[startByte, endByte)`. Opening a conversation reads
 * its recent tail instead of a multi-megabyte backlog, and `loadEarlier` walks
 * backwards by asking for the window before what it already holds.
 *
 * The read begins one byte early so a boundary-exact `startByte` keeps its first
 * record; a start that lands mid-record yields one unparsable fragment, which
 * every decoder drops.
 */
export async function readTranscriptRange(
  filePath: string,
  startByte: number,
  endByte?: number,
): Promise<{ lines: TranscriptLine[]; size: number; atHead: boolean }> {
  const size = (await stat(filePath)).size;
  const limit = endByte === undefined ? size : Math.max(0, Math.min(endByte, size));
  const from = Math.max(0, Math.min(startByte, limit));
  const cursor = createTranscriptCursor(from > 0 ? from - 1 : 0);
  const result = await readTranscriptSince(filePath, cursor, undefined, limit);
  const lines = from > 0 ? result.lines.filter((entry) => entry.offset >= from - 1) : result.lines;
  return { lines, size, atHead: from === 0 };
}
