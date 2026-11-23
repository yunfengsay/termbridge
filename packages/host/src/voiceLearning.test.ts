import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { encodeControl, parseFrame, FrameType, VoiceLearningRequestSchema, type VoiceLearningRequest } from '@termbridge/protocol';
import { VoiceLearning } from './voiceLearning.js';
import { createTurnJudge } from './voiceTurnJudge.js';
import type { BrainConversationService } from '@termbridge/brain';
import { trainInBackground } from './voiceLearningTrainer.js';

const request = (revision: number): VoiceLearningRequest => ({
  t: 'voice_learning_sync', requestId: randomUUID(), revision, enabled: true,
  samples: [{ id: randomUUID(), group: randomUUID(), at: Date.now(), features: [0.9, 0.5, 0.8, 0, 1, 1], head: 'addressed', label: 1, source: 'human' }],
});
test('real binary control frame → Host private file → model receipt → revoke survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-learning-test-'));
  try {
    const host = new VoiceLearning(dir);
    const input = request(1);
    const frame = parseFrame(encodeControl(input));
    assert(frame.type === FrameType.Control && frame.msg.t === 'voice_learning_sync');
    const result = await host.sync('fixture-phone', frame.msg);
    assert.equal(result.status, 'completed');
    assert(result.model && result.model.addressed[0] > 0);
    assert.doesNotThrow(() => JSON.stringify(result));
    const wire = parseFrame(encodeControl(result));
    assert(wire.type === FrameType.Control && wire.msg.t === 'voice_learning_result');
    assert.deepEqual(wire.msg.model, result.model);
    assert.deepEqual((await host.sync('fixture-phone', input)).model, result.model);
    const revoke = { ...request(2), enabled: false, samples: [] };
    assert.equal((await host.sync('fixture-phone', revoke)).status, 'revoked');
    const file = join(dir, (await readdir(dir))[0]);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.samples, []);
    assert.equal(saved.result.model, undefined);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await new VoiceLearning(dir).sync('fixture-phone', input)).status, 'stale');
    assert.equal((await host.sync('other-phone', input)).status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('out-of-order concurrent requests cannot resurrect older consent/data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-learning-test-'));
  try {
    const host = new VoiceLearning(dir);
    const [a, b, c] = await Promise.all([
      host.sync('phone', request(1)), host.sync('phone', { ...request(3), enabled: false, samples: [] }),
      host.sync('phone', request(2)),
    ]);
    assert.deepEqual([a.status, b.status, c.status], ['completed', 'revoked', 'stale']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('raw audio/text, nonfinite features and unsafe integer values cannot enter wire dataset', () => {
  const valid = request(1);
  assert(VoiceLearningRequestSchema.safeParse(valid).success);
  assert(!VoiceLearningRequestSchema.safeParse({ ...valid, audio: 'secret' }).success);
  assert(!VoiceLearningRequestSchema.safeParse({ ...valid, revision: 2 ** 54 }).success);
  for (const invalid of [Infinity, NaN, -1, 2]) {
    assert(!VoiceLearningRequestSchema.safeParse({ ...valid, samples: [{ ...valid.samples[0], features: [invalid, 0, 0, 0, 0, 0] }] }).success);
  }
  assert(!VoiceLearningRequestSchema.safeParse({ ...valid, samples: [{ ...valid.samples[0], transcript: 'private' }] }).success);
});

test('context consent → training → real judge input changes → delete/restart erases influence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-context-learning-'));
  try {
    const host = new VoiceLearning(dir);
    const input = request(1);
    input.samples[0] = { ...input.samples[0], at: Date.now(), text: '再看一下', context: '我在看同事的游戏直播', label: 0 };
    assert.equal((await host.sync('phone', input)).status, 'failed', 'text cannot persist without separate consent');
    assert.equal((await readdir(dir)).length, 0);
    input.contextConsent = true;
    const receipt = await host.sync('phone', input);
    assert.equal(receipt.assist?.mode, 'context-assist'); assert.equal(receipt.assist?.examples, 1);
    let exampleCount = 0;
    const service: BrainConversationService = { provider: 'bailian', runtime: 'pi', model: 'fixture', async respond(value) {
      exampleCount = JSON.parse(value.messages[0].content).reviewedExamples?.length ?? 0;
      return { provider: 'bailian', model: 'fixture', text: JSON.stringify({ decision: exampleCount ? 'ignore' : 'respond' }), toolCalls: [] };
    } };
    const makeJudge = (store: VoiceLearning) => createTurnJudge(service, () => [], undefined, (text, context) => store.context('phone', text, context));
    assert.equal(await makeJudge(host)({ segments: ['再看一下'], signal: AbortSignal.timeout(2000) }), 'ignore');
    assert.equal(exampleCount, 1);
    assert.deepEqual((await host.context('other-peer', '再看一下')).hints, []);
    assert.equal((await host.sync('phone', { ...input, requestId: randomUUID(), revision: 2, contextConsent: false, samples: [] })).status, 'completed');
    const restarted = new VoiceLearning(dir);
    assert.equal((await makeJudge(restarted)({ segments: ['再看一下'], signal: AbortSignal.timeout(2000) }) as { decision: string }).decision, 'respond');
    assert.equal(exampleCount, 0);
    assert.equal((await restarted.sync('phone', input)).status, 'stale');
    assert.doesNotMatch(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'), /再看|直播/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('revocation during inference invalidates the pending personalized verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-context-race-'));
  try {
    const host = new VoiceLearning(dir), input = request(1);
    input.contextConsent = true; input.samples[0] = { ...input.samples[0], at: Date.now(), text: '稍等一下' };
    await host.sync('phone', input);
    const service: BrainConversationService = { provider: 'bailian', runtime: 'pi', model: 'fixture', async respond() {
      await host.sync('phone', { ...input, revision: 2, enabled: false, samples: [] });
      return { provider: 'bailian', model: 'fixture', text: '{"decision":"respond"}', toolCalls: [] };
    } };
    const judge = createTurnJudge(service, () => [], undefined, (text, context) => host.context('phone', text, context));
    await assert.rejects(judge({ segments: ['稍等一下'], signal: AbortSignal.timeout(2000) }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Host retention removes text and weights without resurrecting an old snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-context-retention-'));
  try {
    const host = new VoiceLearning(dir), input = request(1);
    input.contextConsent = true; input.samples[0].text = 'expired-private-fixture';
    await host.sync('phone', input);
    assert.equal(await host.sweep(Date.now() + 31 * 86400_000), 1);
    const receipt = await host.sync('phone', input);
    assert.equal(receipt.assist?.examples, 0); assert.equal(receipt.model?.samples, 0);
    assert.doesNotMatch(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'), /expired-private/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('500-row training runs in a bounded worker without blocking Host timers', async () => {
  const input = request(1); input.contextConsent = true;
  const groups = Array.from({ length: 20 }, () => randomUUID());
  input.samples = Array.from({ length: 500 }, (_, i) => ({ ...input.samples[0], id: randomUUID(), group: groups[i % 20],
    text: `case-${i} ${'控制语音边界'.repeat(20)}`, context: '正在讨论代码与任务', label: i % 2 as 0 | 1 }));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  try {
    const result = await trainInBackground(input, 'f'.repeat(64));
    assert.equal(result.assist?.examples, 500); assert(ticks > 5, 'event loop remains responsive');
    assert((result.assist?.trainingMs ?? 10_000) < 8000);
  } finally { clearInterval(timer); }
});

test('overlapping retention and sync cannot leave context permanently pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-context-sweep-race-'));
  try {
    const host = new VoiceLearning(dir), input = request(1);
    input.contextConsent = true; input.samples[0].text = '继续';
    await host.sync('phone', input);
    await Promise.all([host.sync('phone', { ...input, revision: 2 }), host.sweep()]);
    const context = await host.context('phone', '继续');
    assert.doesNotMatch(context.version, /^pending/); assert.equal(context.hints.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
