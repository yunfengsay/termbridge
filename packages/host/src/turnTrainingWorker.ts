import { parentPort, workerData } from 'node:worker_threads';
import { prepareTurnExperiment, prepareSecondTurnExperiment, trainTurnExperiment, checkTurnExperiment, verifyTurnExperiment } from './turnTraining.js';
const { stage, directory, trainFile, testFile, previous } = workerData;
try {
  let value;
  if (stage === 'prepare' && trainFile && testFile) value = await prepareTurnExperiment(trainFile, testFile, directory);
  else if (stage === 'prepare-second' && trainFile && testFile && previous) value = await prepareSecondTurnExperiment(previous, trainFile, testFile, directory);
  else if (stage === 'train') value = await trainTurnExperiment(directory, progress => parentPort?.postMessage({ event: 'progress', value: progress }));
  else if (stage === 'check') {
    const { rows: _rows, ...report } = await checkTurnExperiment(directory); value = report;
  } else if (stage === 'verify') value = await verifyTurnExperiment(directory);
  else throw new Error('Invalid training stage');
  parentPort?.postMessage({ event: 'completed', value });
} catch (error) {
  // Local public-data command: bounded message, no stacks, data rows or file contents.
  const code = (error as NodeJS.ErrnoException).code;
  const reason = code === 'EEXIST' ? 'Experiment stage already started or holdout already consumed; do not overwrite' :
    code === 'ENOENT' ? 'Required experiment artifact missing' : 'Training stage failed validation';
  parentPort?.postMessage({ event: 'failed', error: reason });
}
