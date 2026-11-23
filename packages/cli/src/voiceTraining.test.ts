import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVoiceTraining } from './voiceTraining.js';
import { createHash } from 'node:crypto';

test('background training starts with stable ID and cancellation returns a terminal receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-training-abort-')), controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  try {
    await assert.rejects(runVoiceTraining({ stage: 'train', directory: dir }, controller.signal, event => {
      events.push(event); if (event.event === 'started') controller.abort();
    }), /cancelled/);
    assert.match(String(events[0].id), /^voice-train:[a-f0-9-]{36}$/);
    assert.equal(events.at(-1)?.event, 'cancelled'); assert.equal(new Set(events.map(event => event.id)).size, 1);
    const file = (await readdir(dir)).find(name => name.endsWith('.job.json'))!;
    assert.equal(JSON.parse(await readFile(join(dir, file), 'utf8')).status, 'cancelled');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker validation failure settles failed, does not leak dataset content, and releases the worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-training-invalid-')), events: Record<string, unknown>[] = [];
  try {
    await writeFile(join(dir, 'input.json'), 'PRIVATE-INVALID-CONTENT');
    await assert.rejects(runVoiceTraining({ stage: 'prepare', directory: join(dir, 'experiment'), trainFile: join(dir, 'input.json'),
      testFile: join(dir, 'input.json') }, new AbortController().signal, event => events.push(event)), /failed validation/);
    assert.equal(events.at(-1)?.event, 'failed'); assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation after a fitted candidate stops the real worker loop before freezing or evaluating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-training-progress-abort-')), controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  try {
    const rows = Array.from({ length: 240 }, (_, i) => ({ id: String(i), group: String(i), lang: 'zh', context: '',
      text: i % 2 ? '任务完成了吗' : '我想问的是', rawText: i % 2 ? '任务完成了吗' : '我想问的是', label: i % 2 }));
    const raw = JSON.stringify(rows, null, 2), sha256 = createHash('sha256').update(raw).digest('hex');
    await writeFile(join(dir, 'train.json'), raw); await writeFile(join(dir, 'dev.json'), raw);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ splits: { train: { sha256 }, dev: { sha256 } } }));
    await assert.rejects(runVoiceTraining({ stage: 'train', directory: dir }, controller.signal, event => {
      events.push(event); if (event.event === 'progress') controller.abort();
    }), /cancelled/);
    assert.ok(events.some(event => event.event === 'progress'), 'an actual candidate was trained before cancel');
    assert.equal(events.at(-1)?.event, 'cancelled');
    const files = await readdir(dir);
    assert.ok(files.some(name => name.endsWith('.model.json')));
    assert.ok(!files.includes('frozen.json')); assert.ok(!files.includes('holdout.consumed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
