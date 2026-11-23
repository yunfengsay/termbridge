import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { fitTurnText, scoreTurnText, parseTurnTextModel, type TurnTextModel, type TextFeatures } from '@termbridge/voice';
import { parseTraining, parseTest, parseEasyTurn, splitTurnCorpus, digestText, TURN_DATA_REVISION, TURN_TRAIN_SHA, type TrainingRow } from './turnTrainingData.js';
import { TURN_GATES, calibrateTurn, calibrateLanguages, turnMetrics, safetyPass, type ScoredTurn, type TurnThresholds } from './turnTrainingMetrics.js';

const TEST_SHA = '598d875a05017fee24b3b15aa7f45fe9664da793fa3aea7128ddf195f1af1ee0';
const json = (value: unknown) => JSON.stringify(value, null, 2);
async function save(directory: string, name: string, value: unknown) {
  // Experimental artifacts only. Never write a live profile or active model pointer.
  await writeFile(join(directory, name + '.pending'), json(value), { mode: 0o600 });
  await rename(join(directory, name + '.pending'), join(directory, name));
}
async function load(directory: string, name: string) { return JSON.parse(await readFile(join(directory, name), 'utf8')); }
export async function prepareTurnExperiment(trainPath: string, testPath: string, directory: string) {
  const training = await readFile(trainPath, 'utf8'), testing = await readFile(testPath, 'utf8');
  if (digestText(training) !== TURN_TRAIN_SHA || digestText(testing) !== TEST_SHA) throw new Error('Pinned dataset digest mismatch');
  const rawTest = JSON.parse(testing);
  // EXACT sample selection from the prior published 80-example evaluation: now diagnostic, never blind.
  const oldHash = (row: { dialog: { speaker: string }[] }) => digestText(JSON.stringify(row.dialog.filter(item => item.speaker !== 'VAD')));
  const seen: string[] = ['<完成>', '<未完>'].flatMap(label => rawTest.filter((row: { label: string }) => row.label.trim() === label)
    .sort((a: { dialog: { speaker: string }[] }, b: { dialog: { speaker: string }[] }) => oldHash(a).localeCompare(oldHash(b)))
    .slice(0, 40).map(oldHash));
  const split = splitTurnCorpus(parseTraining(JSON.parse(training)), parseTest(rawTest), new Set(seen));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Refuse overwriting an experiment or recycling a consumed holdout.
  await writeFile(join(directory, 'experiment.lock'), 'turn-text-v1\n', { flag: 'wx', mode: 0o600 });
  for (const name of ['train', 'dev', 'holdout'] as const) await save(directory, `${name}.json`, split[name]);
  const manifest = { schema: 1, createdAt: new Date().toISOString(), dataset: 'KE-Team/SemanticVAD-Dataset',
    revision: TURN_DATA_REVISION, sourceSha: { train: TURN_TRAIN_SHA, test: TEST_SHA },
    license: 'publisher Apache-2.0; Ke synthetic completion text only; no third-party weights/audio',
    excluded: split.excluded, caveat: split.caveat,
    splits: Object.fromEntries((['train', 'dev', 'holdout'] as const).map(name => [name, {
      count: split[name].length, groups: new Set(split[name].map(row => row.group)).size,
      sha256: digestText(json(split[name])), idsHash: digestText(split[name].map(row => row.id).sort().join('\n')) }])) };
  await save(directory, 'manifest.json', manifest); return manifest;
}
async function verifiedRows(directory: string, name: 'train' | 'dev' | 'holdout'): Promise<TrainingRow[]> {
  const manifest = await load(directory, 'manifest.json'), raw = await readFile(join(directory, name + '.json'), 'utf8');
  if (digestText(raw) !== manifest.splits[name].sha256) throw new Error('Frozen split changed');
  return JSON.parse(raw);
}
export async function prepareSecondTurnExperiment(previous: string, completePath: string, incompletePath: string, directory: string) {
  if ((await load(previous, 'check.json')).status !== 'rejected') throw new Error('Round 2 requires a rejected, consumed Round 1');
  const complete = await readFile(completePath, 'utf8'), incomplete = await readFile(incompletePath, 'utf8');
  if (digestText(complete) !== '0b35356353848bf25200a2fc0f6d5e25f2a3e86a1baa5b0e1a6e4cfe86ee26a3' ||
      digestText(incomplete) !== '01b2465c0bbeb9b434b955d15274f7f74a03bec18ba22f30981ba555b191e476') throw new Error('Pinned Easy Turn digest mismatch');
  const priorTrain = await verifiedRows(previous, 'train');
  const priorDev = [...await verifiedRows(previous, 'dev'), ...await verifiedRows(previous, 'holdout')];
  const priorTrainIds = new Set(priorTrain.map(row => row.id));
  const prepared = splitTurnCorpus([...priorTrain, ...priorDev], [...parseEasyTurn(complete, 1), ...parseEasyTurn(incomplete, 0)], new Set());
  const remaining = [...prepared.train, ...prepared.dev], dev = remaining.filter(row => !priorTrainIds.has(row.id));
  const devGroups = new Set(dev.map(row => row.group));
  const split = { train: remaining.filter(row => priorTrainIds.has(row.id) && !devGroups.has(row.group)), dev, holdout: prepared.holdout };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'experiment.lock'), 'turn-text-v2\n', { flag: 'wx', mode: 0o600 });
  for (const name of ['train', 'dev', 'holdout'] as const) await save(directory, `${name}.json`, split[name]);
  const manifest = { schema: 1, createdAt: new Date().toISOString(), calibration: 'language-domain',
    training: { dataset: 'KE synthetic text; same gradient-only fit split as Round 1', revision: TURN_DATA_REVISION },
    calibrationNote: 'Round 1 holdout permanently demoted to calibration. NO gradient training on it.',
    dataset: 'ASLP-lab/Easy-Turn-Testset', revision: '5812651dbab429b9a4fab293de7127bfb9a56650',
    sourceSha: { complete: digestText(complete), incomplete: digestText(incomplete) },
    license: 'publisher Apache-2.0; transcription metadata only, no audio', excluded: prepared.excluded,
    splits: Object.fromEntries((['train', 'dev', 'holdout'] as const).map(name => [name, {
      count: split[name].length, groups: new Set(split[name].map(row => row.group)).size,
      sha256: digestText(json(split[name])), idsHash: digestText(split[name].map(row => row.id).sort().join('\n')) }])) };
  await save(directory, 'manifest.json', manifest); return manifest;
}
function scores(model: TurnTextModel, rows: TrainingRow[], context = true): ScoredTurn[] {
  return rows.map(row => ({ id: row.id, label: row.label, lang: row.lang, hasContext: !!row.context, sourceKind: row.sourceKind,
    routingLanguage: /\p{Script=Han}/u.test(row.text) ? 'zh' : 'en',
    score: scoreTurnText(model, row.text, context ? row.context : '') }));
}
function measured(model: TurnTextModel, rows: TrainingRow[]) {
  for (const row of rows.slice(0, 30)) scoreTurnText(model, row.text, row.context);
  const durations = rows.map(row => { const start = performance.now(); scoreTurnText(model, row.text, row.context); return performance.now() - start; }).sort((a, b) => a - b);
  return { p50Ms: durations[Math.floor(durations.length * .5)], p95Ms: durations[Math.floor(durations.length * .95)],
    weightBytes: model.weights.length * 4, jsonBytes: Buffer.byteLength(json(model)) };
}
function baseline(rows: TrainingRow[]) {
  const entries = rows.map(row => ({ id: row.id, lang: row.lang, label: row.label, score: 1 }));
  return { alwaysRespond: turnMetrics(entries, { wait: -1, respond: 1 }),
    alwaysWait: turnMetrics(entries.map(row => ({ ...row, score: 0 })), { wait: 0, respond: 2 }),
    punctuation: turnMetrics(rows.map(row => ({ ...row, score: /[.!?。！？][”"']?$/.test(row.rawText) ? 1 : 0 })), { wait: 0, respond: 1 }) };
}
function slices(rows: ScoredTurn[], thresholds: TurnThresholds) {
  return Object.fromEntries(['zh', 'en'].map(lang => [lang, turnMetrics(rows.filter(row => row.lang === lang), thresholds)]));
}
export async function trainTurnExperiment(directory: string, notify: (value: unknown) => void = () => {}) {
  const train = await verifiedRows(directory, 'train'), dev = await verifiedRows(directory, 'dev');
  const calibration = (await load(directory, 'manifest.json')).calibration;
  // Loop never reads the holdout file. One run per experiment; resume uses a NEW explicitly named run.
  await writeFile(join(directory, 'training.started'), new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  const started = performance.now(), cpu = process.cpuUsage();
  const candidates = [];
  for (const features of ['body', 'suffix', 'context'] as TextFeatures[]) for (const epochs of [8, 20]) {
    const at = performance.now(), model = fitTurnText(train, features, epochs);
    const trainingMs = performance.now() - at, rows = scores(model, dev), thresholds = calibration === 'language-domain' ?
      calibrateLanguages(rows) : calibrateTurn(rows, false, calibration === 'domain');
    const metrics = turnMetrics(rows, thresholds), performanceStats = measured(model, dev);
    const accepted = safetyPass(metrics) && metrics.coverage >= TURN_GATES.coverage &&
      performanceStats.p95Ms < TURN_GATES.p95Ms && performanceStats.jsonBytes <= TURN_GATES.bytes;
    const name = `${features}-${epochs}`;
    const result = { name, trainingMs, thresholds, metrics, performance: performanceStats, accepted,
      byLanguage: slices(rows, thresholds), noContext: turnMetrics(scores(model, dev, false), thresholds),
      forcedBinary: turnMetrics(rows, { wait: .5 - Number.EPSILON, respond: .5 }),
      modelHash: digestText(json(model)) };
    await save(directory, `${name}.model.json`, model);
    await save(directory, `${name}.dev.json`, { ...result, rows });
    candidates.push(result); await save(directory, 'loop.json', { phase: 'development', gates: TURN_GATES, candidates });
    notify(result);
  }
  // Prefer accepted, then safe, then coverage. No held-out score is involved in selection.
  candidates.sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.metrics.coverage - a.metrics.coverage || a.name.localeCompare(b.name));
  const selected = candidates[0];
  const report = { phase: 'frozen', gates: TURN_GATES, selected: selected.name, modelHash: selected.modelHash,
    thresholds: selected.thresholds, developmentAccepted: selected.accepted, candidates, baselines: baseline(dev),
    wallMs: performance.now() - started, cpuMicros: process.cpuUsage(cpu), rssBytes: process.memoryUsage().rss,
    environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
    activation: 'shadow only; production Host and personal profiles untouched' };
  await save(directory, 'frozen.json', report); return report;
}
export async function checkTurnExperiment(directory: string) {
  const frozen = await load(directory, 'frozen.json');
  const manifest = await load(directory, 'manifest.json');
  if (!/^(body|suffix|context)-(8|20)$/.test(frozen.selected)) throw new Error('Invalid frozen candidate');
  const modelRaw = await readFile(join(directory, frozen.selected + '.model.json'), 'utf8');
  if (digestText(modelRaw) !== frozen.modelHash) throw new Error('Frozen model changed');
  const model = parseTurnTextModel(JSON.parse(modelRaw));
  // Burn seal BEFORE inspecting holdout. A crash cannot silently create a second tuning opportunity.
  await writeFile(join(directory, 'holdout.consumed'), new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  const holdout = await verifiedRows(directory, 'holdout'), rows = scores(model, holdout);
  const thresholds: TurnThresholds = frozen.thresholds, metrics = turnMetrics(rows, thresholds), performanceStats = measured(model, holdout);
  const accepted = frozen.developmentAccepted && safetyPass(metrics) && metrics.coverage >= TURN_GATES.coverage &&
    performanceStats.p95Ms < TURN_GATES.p95Ms && performanceStats.jsonBytes <= TURN_GATES.bytes;
  const report = { schema: 1, at: new Date().toISOString(), status: accepted ? 'accepted-offline-only' : 'rejected',
    model: frozen.selected, modelHash: frozen.modelHash, thresholds, metrics, byLanguage: slices(rows, thresholds),
    noContext: turnMetrics(scores(model, holdout, false), thresholds), baselines: baseline(holdout), performance: performanceStats,
    bySource: Object.fromEntries(['real', 'synthetic'].map(source => [source, turnMetrics(rows.filter(row => row.sourceKind === source), thresholds)])),
    gates: TURN_GATES, rows, activation: 'shadow only; no automatic promotion',
    caveat: manifest.dataset === 'ASLP-lab/Easy-Turn-Testset' ?
      'Public Chinese text, publisher human labels; no English, audio playback, noise, owner DDSD, personalized or device acceptance.' :
      'Public text, publisher/model-assisted labels; not ASR, noise, owner DDSD, personalized or device acceptance.' };
  await save(directory, 'check.json', report); return report;
}

/** Repeatable loop verifier: inspect sealed artifacts, NEVER infer on the test a second time. */
export async function verifyTurnExperiment(directory: string) {
  const frozen = await load(directory, 'frozen.json'), checked = await load(directory, 'check.json');
  if (!/^(body|suffix|context)-(8|20)$/.test(frozen.selected) || checked.modelHash !== frozen.modelHash ||
      checked.model !== frozen.selected || json(checked.thresholds) !== json(frozen.thresholds) ||
      json(checked.gates) !== json(TURN_GATES) || json(frozen.gates) !== json(TURN_GATES)) throw new Error('Frozen evaluation recipe changed');
  const model = await readFile(join(directory, frozen.selected + '.model.json'), 'utf8');
  if (digestText(model) !== frozen.modelHash) throw new Error('Frozen model changed');
  await readFile(join(directory, 'holdout.consumed'), 'utf8');
  const manifest = await load(directory, 'manifest.json');
  if (!Array.isArray(checked.rows) || checked.rows.length !== manifest.splits.holdout.count ||
      digestText(checked.rows.map((row: ScoredTurn) => row.id).sort().join('\n')) !== manifest.splits.holdout.idsHash) throw new Error('Evaluation rows changed');
  const metrics = turnMetrics(checked.rows, frozen.thresholds);
  const passed = frozen.developmentAccepted && safetyPass(metrics) && metrics.coverage >= TURN_GATES.coverage &&
    checked.performance.p95Ms < TURN_GATES.p95Ms && checked.performance.jsonBytes <= TURN_GATES.bytes;
  return { status: passed ? 'accepted-offline-only' : 'rejected', model: frozen.selected, modelHash: frozen.modelHash,
    metrics, repeatable: true, activation: 'shadow only; no automatic promotion' };
}
