import { Worker } from 'node:worker_threads';
import type { VoiceLearningRequest, VoiceLearningResult } from '@termbridge/protocol';
declare const __TB_BUNDLED__: boolean;
let queue: Promise<unknown> = Promise.resolve();
/** One CPU training worker at a time; never stall the realtime Host audio/event loop. */
export function trainInBackground(request: VoiceLearningRequest, digest: string): Promise<Pick<VoiceLearningResult, 'model' | 'assist'>> {
  const job = queue.catch(() => {}).then(() => new Promise<Pick<VoiceLearningResult, 'model' | 'assist'>>((resolve, reject) => {
    const bundled = typeof __TB_BUNDLED__ !== 'undefined' && __TB_BUNDLED__;
    const worker = bundled ? new Worker(new URL('./voice-learning-worker.js', import.meta.url), { workerData: { request, digest } }) :
      new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('./voiceLearningWorker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,
        { eval: true, workerData: { request, digest } });
    let settled = false;
    const finish = (value?: Pick<VoiceLearningResult, 'model' | 'assist'>) => {
      if (settled) return; settled = true; clearTimeout(timer); void worker.terminate();
      if (value) resolve(value); else reject(new Error('Personal training worker unavailable'));
    };
    const timer = setTimeout(() => finish(), 8000);
    worker.once('message', message => finish(message?.ok ? message.value : undefined));
    worker.once('error', () => finish()); worker.once('exit', () => finish());
  }));
  queue = job; return job;
}
