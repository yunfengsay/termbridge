import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrainConversationService } from '@termbridge/brain';
import { pipelineProcess } from '@termbridge/voice';
import { HostVoicePipeline, pipelineFeedback } from './voicePipeline.js';
import { createTurnJudge } from './voiceTurnJudge.js';

function stored() {
  return { contextConsent: true,
    result: { t: 'voice_learning_result', requestId: randomUUID(), revision: 1, status: 'completed' },
    samples: Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), group: randomUUID(), at: Date.now(),
      features: [0, 0, 0, 0, 0, 0], source: 'human', head: 'finished', label: i % 2,
      text: `已确认的话 ${i}`, context: '之前讨论代码' })) };
}

test('Host only exports consented, recent human completion labels and group-stable holdout', () => {
  const source = stored();
  source.samples[0].head = 'addressed'; source.samples[1].at = 0;
  const a = pipelineFeedback(source), b = pipelineFeedback(source);
  assert.deepEqual(a, b);
  assert.equal(a.rows.length + a.checkRows.length, 98);
  assert(a.rows.length > 0 && a.checkRows.length > 0);
  const groups = new Set(a.rows.map(row => row.group));
  assert(a.checkRows.every(row => !groups.has(row.group)));
  assert.deepEqual(pipelineFeedback({ ...source, contextConsent: false }), { consent: false, rows: [], checkRows: [] });
  source.samples[2].source = 'model';
  assert.throws(() => pipelineFeedback(source));
});

test('local completion verdict preserves original fragments, falls back when unavailable, and keeps cloud clarification', async () => {
  let cloud = 0, local = 0;
  const service: BrainConversationService = { provider: 'bailian', model: 'fixture', runtime: 'pi',
    async respond() { cloud++; return { provider: 'bailian', model: 'fixture', text: '{"decision":"wait"}', toolCalls: [] }; } };
  const judge = createTurnJudge(service, () => [], undefined, undefined, async messages => {
    local++; assert.equal(messages.at(-1)?.content, '我最近的 Agent是什么'); return 'respond';
  });
  assert.equal(await judge({ segments: ['我最近的', 'Agent是什么'], signal: new AbortController().signal }), 'respond');
  assert.equal(cloud, 0); assert.equal(local, 1);
  await judge({ segments: ['我最近的'], clarification: '请继续', signal: new AbortController().signal });
  assert.equal(cloud, 1); assert.equal(local, 1);
  const fallback = createTurnJudge(service, () => [], undefined, undefined, async () => undefined);
  assert.equal(await fallback({ segments: ['hi'], signal: new AbortController().signal }), 'wait');
  assert.equal(cloud, 2);
  const broken = createTurnJudge(service, () => [], undefined, undefined, async () => { throw new Error('model crashed'); });
  assert.equal(await broken({ segments: ['hi'], signal: new AbortController().signal }), 'wait');
  assert.equal(cloud, 3);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => broken({ segments: ['hi'], signal: abort.signal }), /superseded/);
  assert.equal(cloud, 3);
});

test('tb serve cancels actual scheduled work as soon as a call starts and isolates the peer source', async (t) => {
  // Production has server sockets. This isolated fake must keep the event loop
  // alive until the intentionally unref'ed busy monitor aborts its pending job.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const root = await mkdtemp(join(tmpdir(), 'tb-pipeline-bridge-'));
  const peerHash = createHash('sha256').update('fixture-phone').digest('hex');
  const feedback = join(root, 'feedback'); await mkdir(feedback);
  await writeFile(join(root, 'config.json'), JSON.stringify({ peerHash }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ revision: 1, consent: true, active: null }));
  await writeFile(join(feedback, `${peerHash}.json`), JSON.stringify(stored()));
  let inCall = false, cancelled = false;
  const events: unknown[] = [];
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const run: typeof pipelineProcess = async (args, options) => {
    if (args[0] === 'sync') {
      const snapshot = options!.input as { consent: boolean; rows: unknown[] };
      assert(snapshot.consent && snapshot.rows.length > 0);
      return { status: 'queued' };
    }
    started();
    return new Promise((_, reject) => options!.signal!.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true }));
  };
  const host = new HostVoicePipeline(root, feedback, () => inCall, event => events.push(event), run);
  try {
    const job = host.tick(); await running; inCall = true; await job;
    assert(cancelled);
    assert.equal(await host.judge('another-phone', [], new AbortController().signal), undefined);
    assert.doesNotMatch(JSON.stringify(events), /已确认|之前讨论/);
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).peerHash, peerHash);
  } finally { host.stop(); await rm(root, { recursive: true, force: true }); }
});

test('disabled pipeline never reads storage or starts Python', async () => {
  let called = false;
  const host = new HostVoicePipeline(undefined, '/not-used', () => false, () => {}, async () => { called = true; return {}; });
  await host.tick(); host.start(); host.stop(); assert.equal(called, false);
});

test('stopping during source synchronization cannot resurrect a training job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tb-pipeline-stop-'));
  const peerHash = createHash('sha256').update('fixture-phone').digest('hex');
  await writeFile(join(root, 'config.json'), JSON.stringify({ peerHash }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ revision: 1, consent: true, active: null }));
  await writeFile(join(root, `${peerHash}.json`), JSON.stringify(stored()));
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  const run: typeof pipelineProcess = async args => {
    if (args[0] === 'sync') { entered(); await barrier; return { status: 'queued' }; }
    runs++; return { status: 'waiting' };
  };
  const host = new HostVoicePipeline(root, root, () => false, () => {}, run);
  try {
    const task = host.tick(); await waiting;
    host.stop(); release(); await task;
    await host.refresh(); await host.tick(); assert.equal(runs, 0);
  } finally { host.stop(); await rm(root, { recursive: true, force: true }); }
});

test('an in-flight or failed phone mutation cannot restore an older persisted revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tb-pipeline-revision-'));
  const peerHash = createHash('sha256').update('fixture-phone').digest('hex');
  await writeFile(join(root, 'config.json'), JSON.stringify({ peerHash }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ revision: 1, consent: true, active: null }));
  const source = stored();
  await writeFile(join(root, `${peerHash}.json`), JSON.stringify(source));
  let runs = 0;
  const host = new HostVoicePipeline(root, root, () => false, () => {}, async args => {
    runs++; return { status: args[0] === 'sync' ? 'queued' : 'waiting' };
  });
  try {
    host.invalidateForPeer('fixture-phone', 5);
    await host.tick(); await host.refresh(); assert.equal(runs, 0);
    source.result.revision = 5;
    await writeFile(join(root, `${peerHash}.json`), JSON.stringify(source));
    await host.tick(); assert.equal(runs, 2);
    host.invalidateForPeer('another-phone', 100);
    await host.tick(); assert.equal(runs, 3);
  } finally { host.stop(); await rm(root, { recursive: true, force: true }); }
});
