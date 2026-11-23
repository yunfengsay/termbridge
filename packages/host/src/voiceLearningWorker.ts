import { parentPort, workerData } from 'node:worker_threads';
import { trainSnapshot } from './voiceLearningTraining.js';
try { parentPort!.postMessage({ ok: true, value: trainSnapshot(workerData.request, workerData.digest) }); }
catch { parentPort!.postMessage({ ok: false }); } // Never log or return private feedback.
