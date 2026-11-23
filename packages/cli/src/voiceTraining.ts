import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
declare const __TB_BUNDLED__: boolean;
type Stage = 'prepare' | 'prepare-second' | 'train' | 'check' | 'verify';
export type TrainingJob = { stage: Stage; directory: string; trainFile?: string; testFile?: string; previous?: string };

/** Same isolated CPU-worker pattern as tb serve personal training; never touches live profiles. */
export async function runVoiceTraining(job: TrainingJob, signal: AbortSignal,
  notify: (event: Record<string, unknown>) => void = () => {}, timeoutMs = 120_000): Promise<unknown> {
  if (signal.aborted) throw new Error('Training cancelled');
  const directory = resolve(job.directory), id = `voice-train:${randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stateFile = resolve(directory, `${id.replace(':', '-')}.job.json`);
  const state = async (status: string) => writeFile(stateFile, JSON.stringify({ id, stage: job.stage, status, at: new Date().toISOString() }), { mode: 0o600 });
  await state('running');
  const emit = (event: Record<string, unknown>) => { try { notify({ id, ...event }); } catch { /* diagnostics cannot change lifecycle */ } };
  emit({ event: 'started', stage: job.stage });
  return new Promise((resolveResult, reject) => {
    const bundled = typeof __TB_BUNDLED__ !== 'undefined' && __TB_BUNDLED__;
    const workerData = { ...job, directory, trainFile: job.trainFile && resolve(job.trainFile),
      testFile: job.testFile && resolve(job.testFile), previous: job.previous && resolve(job.previous) };
    const worker = bundled ? new Worker(new URL('./voice-training-worker.js', import.meta.url), { workerData }) :
      new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('../../host/src/turnTrainingWorker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,
        { eval: true, workerData, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const finish = async (status: 'completed' | 'failed' | 'cancelled' | 'timed-out', value?: unknown, reason?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      await worker.terminate();
      try { await state(status); } catch { emit({ event: 'status-write-failed' }); }
      emit({ event: status });
      if (status === 'completed') resolveResult(value); else reject(new Error(reason ?? `Training ${status}`));
    };
    const abort = () => { void finish('cancelled'); };
    const timer = setTimeout(() => { void finish('timed-out'); }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (settled) return;
      if (message?.event === 'progress') emit(message);
      else if (message?.event === 'completed') void finish('completed', message.value);
      else void finish('failed', undefined, message?.error);
    });
    worker.once('error', () => { void finish('failed', undefined, 'Training worker unavailable'); });
    worker.once('exit', () => { void finish('failed', undefined, 'Training worker exited without a receipt'); });
    if (signal.aborted) abort();
  });
}
export async function trainingCommand(stage: string, directory: string, options: { trainFile?: string; testFile?: string; previous?: string }) {
  if (!['prepare', 'prepare-second', 'train', 'check', 'verify'].includes(stage)) throw new Error('Expected prepare, prepare-second, train, check or verify');
  if (stage.startsWith('prepare') && (!options.trainFile || !options.testFile || (stage === 'prepare-second' && !options.previous))) {
    throw new Error('Prepare requires --train-file and --test-file; prepare-second also requires --previous');
  }
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runVoiceTraining({ stage: stage as Stage, directory, ...options }, controller.signal,
      event => console.error(JSON.stringify(event)));
    console.log(JSON.stringify(result, null, 2));
    if ((stage === 'check' || stage === 'verify') && result && typeof result === 'object' && 'status' in result && result.status === 'rejected') process.exitCode = 2;
  } catch (error) {
    console.error(`[voice training] ${error instanceof Error ? error.message : 'Training failed'}`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
