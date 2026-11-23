import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTraining, parseTest, parseEasyTurn, splitTurnCorpus } from './turnTrainingData.js';
import { calibrateTurn, calibrateLanguages, safetyPass, turnMetrics } from './turnTrainingMetrics.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestText } from './turnTrainingData.js';
import { trainTurnExperiment, checkTurnExperiment, verifyTurnExperiment } from './turnTraining.js';

test('training/test adapters strip VAD answers and prompts, keep dialogue, and quarantine related seen tests', () => {
  const training = parseTraining([{ input: '', instruction: '# Dialog\nHuman[历史]:我最近的\nAgent[历史]:请继续\nHuman[实时]:Agent是什么\n',
    output: '<完成>', source: 'Ke-多轮', lang: '中文', system: 'LEAK:<完成>' },
  { input: '', instruction: '# Dialog\nHuman[实时]:unrelated example\n', output: '<完成>', source: 'RAMC', lang: 'en' }]);
  assert.equal(training.length, 1); assert.equal(training[0].text, 'Agent是什么');
  assert.match(training[0].context, /我最近的/); assert.doesNotMatch(training[0].context, /LEAK|完成|Dialog/);
  const tests = parseTest([{ label: '<完成>', lang: '中文', dialog: [
    { speaker: 'Human', text: '我最近的' }, { speaker: 'Agent', text: '请继续' },
    { speaker: 'Human', text: 'Agent是什么' }, { speaker: 'VAD', text: '<完成>' }] }]);
  assert.equal(tests[0].text, 'Agent是什么'); assert.doesNotMatch(tests[0].context, /VAD|完成/);
  const split = splitTurnCorpus(training, tests, new Set([tests[0].id]));
  assert.equal(split.train.length + split.dev.length, 0); assert.equal(split.holdout.length, 0);
  assert.equal(split.excluded.trainTestOverlap, 1); assert.equal(split.excluded.previouslySeenAndRelated, 1);
});

test('Easy Turn adapters remove explicit answer suffixes and preserve recording provenance', () => {
  const rows = parseEasyTurn(JSON.stringify({ key: 'fixture', txt: '我还没说完<INCOMPLETE>', lang: '<CN>', extra: { dataset: 'incomplete_test_real' } }), 0);
  assert.equal(rows[0].text, '我还没说完'); assert.equal(rows[0].sourceKind, 'real');
  assert.doesNotMatch(rows[0].context + rows[0].text, /INCOMPLETE|TRANSCRIBE/);
  assert.throws(() => parseEasyTurn(JSON.stringify({ txt: 'answer<COMPLETE>', lang: '<CN>' }), 0));
});

test('calibration rejects too few examples and checks both wrong-wait and early-response risk', () => {
  const rows = Array.from({ length: 240 }, (_, i) => ({ id: String(i), lang: 'zh', routingLanguage: 'zh' as const,
    label: i % 2 as 0 | 1, score: i % 2 ? .95 : .05, hasContext: false }));
  assert.deepEqual(calibrateTurn(rows.slice(0, 10)), { wait: -1, respond: 2 });
  const thresholds = calibrateLanguages(rows), metrics = turnMetrics(rows, thresholds);
  assert.equal(metrics.coverage, 1); assert.equal(metrics.early, 0); assert.equal(metrics.late, 0);
  assert.ok(safetyPass(metrics)); assert.ok(!safetyPass(turnMetrics(rows, { wait: 1, respond: 2 })));
  assert.equal(turnMetrics(rows.map(row => ({ ...row, score: undefined })), thresholds).fallback, 240);
});

test('train never reads the sealed test; frozen artifact cannot be replaced or evaluated twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tb-training-seal-'));
  const fixture = (size: number, prefix: string) => Array.from({ length: size }, (_, i) => ({
    id: `${prefix}-${i}`, group: `${prefix}-${i}`, lang: 'zh', context: '',
    text: i % 2 ? '任务完成了吗' : '我想问的是', rawText: i % 2 ? '任务完成了吗' : '我想问的是', label: i % 2,
  }));
  const values = { train: fixture(80, 'fit'), dev: fixture(240, 'dev'), holdout: fixture(240, 'test') };
  const raw = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, JSON.stringify(value, null, 2)]));
  try {
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ splits: Object.fromEntries(Object.entries(raw).map(([name, value]) => {
      const rows = JSON.parse(value); return [name, { sha256: digestText(value), count: rows.length,
        idsHash: digestText(rows.map((row: { id: string }) => row.id).sort().join('\n')) }];
    })) }));
    await writeFile(join(directory, 'train.json'), raw.train); await writeFile(join(directory, 'dev.json'), raw.dev);
    // Holdout is deliberately absent: selecting the model must still finish.
    const frozen = await trainTurnExperiment(directory);
    assert.equal(frozen.candidates.length, 6);
    await writeFile(join(directory, 'holdout.json'), raw.holdout);
    const before = await readFile(join(directory, 'frozen.json'), 'utf8');
    const checked = await checkTurnExperiment(directory);
    assert.equal(checked.metrics.total, 240); assert.equal(checked.activation, 'shadow only; no automatic promotion');
    const verified = await verifyTurnExperiment(directory);
    assert.equal(verified.status, checked.status);
    assert.deepEqual(await verifyTurnExperiment(directory), verified, 'loop verifier is repeatable without reusing test inference');
    await assert.rejects(checkTurnExperiment(directory), /EEXIST/);
    await assert.rejects(trainTurnExperiment(directory), /EEXIST/);
    assert.equal(await readFile(join(directory, 'frozen.json'), 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
