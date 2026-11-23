import { resolve } from 'node:path';
import { prepareTurnExperiment, prepareSecondTurnExperiment, trainTurnExperiment, checkTurnExperiment } from '../packages/host/src/turnTraining.js';
const [stage, directory, train, test] = process.argv.slice(2);
if (!directory || !['prepare', 'prepare-second', 'train', 'check'].includes(stage)) throw new Error('Usage: tsx scripts/voice-open-training.ts prepare|train|check <experiment-dir> [train-file test-file]');
if (stage === 'prepare-second') {
  const previous = process.argv[6];
  if (!train || !test || !previous) throw new Error('prepare-second <out> <complete-list> <incomplete-list> <previous-experiment>');
  console.log(JSON.stringify(await prepareSecondTurnExperiment(resolve(previous), resolve(train), resolve(test), resolve(directory)), null, 2));
} else if (stage === 'prepare') {
  if (!train || !test) throw new Error('prepare requires pinned public train and test JSON files');
  console.log(JSON.stringify(await prepareTurnExperiment(resolve(train), resolve(test), resolve(directory)), null, 2));
} else if (stage === 'train') {
  const result = await trainTurnExperiment(resolve(directory), result => console.log(JSON.stringify(result)));
  console.log(JSON.stringify({ selected: result.selected, developmentAccepted: result.developmentAccepted, wallMs: result.wallMs }));
} else console.log(JSON.stringify(await checkTurnExperiment(resolve(directory)), null, 2));
