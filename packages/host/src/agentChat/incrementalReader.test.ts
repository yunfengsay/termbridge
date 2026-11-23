import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_RECORD_BYTES,
  createTranscriptCursor,
  readTranscriptRange,
  readTranscriptSince,
} from './incrementalReader.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tb-chat-read-'));
}

test('a record split across two writes is delivered once, whole, on the later pass', async () => {
  const root = await scratch();
  try {
    const path = join(root, 't.jsonl');
    await writeFile(path, '{"a":1}\n{"b":');
    const cursor = createTranscriptCursor();
    const first = await readTranscriptSince(path, cursor);
    assert.deepEqual(first.lines.map((entry) => entry.line), ['{"a":1}']);

    await appendFile(path, '2}\n');
    const second = await readTranscriptSince(path, cursor);
    assert.deepEqual(second.lines.map((entry) => entry.line), ['{"b":2}']);
    assert.equal(second.lines[0]!.offset, 8);

    // Nothing new means no work and no repeated rows.
    assert.deepEqual((await readTranscriptSince(path, cursor)).lines, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CRLF line endings and empty lines do not produce phantom records', async () => {
  const root = await scratch();
  try {
    const path = join(root, 't.jsonl');
    await writeFile(path, '{"a":1}\r\n\n{"b":2}\r\n');
    const lines = (await readTranscriptSince(path, createTranscriptCursor())).lines;
    assert.deepEqual(lines.map((entry) => entry.line), ['{"a":1}', '{"b":2}']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a single oversized record is dropped without buffering it', async () => {
  const root = await scratch();
  try {
    const path = join(root, 't.jsonl');
    await writeFile(path, `{"big":"${'x'.repeat(MAX_RECORD_BYTES + 10)}"}\n{"a":1}\n`);
    const lines = (await readTranscriptSince(path, createTranscriptCursor())).lines;
    assert.deepEqual(lines.map((entry) => entry.line), ['{"a":1}']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a file that shrank is reported as a rewind rather than decoded as new rows', async () => {
  const root = await scratch();
  try {
    const path = join(root, 't.jsonl');
    await writeFile(path, '{"a":1}\n{"b":2}\n');
    const cursor = createTranscriptCursor();
    await readTranscriptSince(path, cursor);
    await writeFile(path, '{"c":3}\n');
    const result = await readTranscriptSince(path, cursor);
    assert.equal(result.rewound, true);
    assert.deepEqual(result.lines, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a range read keeps a boundary-exact start and drops only a mid-record fragment', async () => {
  const root = await scratch();
  try {
    const path = join(root, 't.jsonl');
    await writeFile(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const exact = await readTranscriptRange(path, 8);
    assert.deepEqual(exact.lines.map((entry) => entry.line), ['{"b":2}', '{"c":3}']);
    assert.equal(exact.atHead, false);

    const mid = await readTranscriptRange(path, 11);
    assert.equal(mid.lines.some((entry) => entry.line === '{"c":3}'), true);
    assert.equal(mid.lines.some((entry) => entry.line === '{"b":2}'), false);

    const bounded = await readTranscriptRange(path, 0, 16);
    assert.deepEqual(bounded.lines.map((entry) => entry.line), ['{"a":1}', '{"b":2}']);
    assert.equal(bounded.atHead, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a long catch-up hands rows over in batches instead of one huge array', async () => {
  const root = await scratch();
  try {
    const path = join(root, 't.jsonl');
    let body = '';
    for (let index = 0; index < 95; index += 1) body += `{"n":${index}}\n`;
    await writeFile(path, body);
    const batches: number[] = [];
    const result = await readTranscriptSince(path, createTranscriptCursor(), (lines) => batches.push(lines.length));
    assert.equal(batches.length + (result.lines.length > 0 ? 1 : 0) > 1, true);
    assert.equal(batches.reduce((sum, size) => sum + size, 0) + result.lines.length, 95);
  } finally { await rm(root, { recursive: true, force: true }); }
});
