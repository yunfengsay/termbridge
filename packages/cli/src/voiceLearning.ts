import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VoiceLearningResultSchema } from '@termbridge/protocol';

/** Local administrative status, not a transcript export. Training is automatic inside tb serve. */
export async function learningStatus(directory = process.env.TB_VOICE_LEARNING_DIR || join(homedir(), '.termbridge', 'voice-personalization-v1')) {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error; }
  const profiles = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    try {
      const stored = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const result = VoiceLearningResultSchema.parse(stored.result);
      profiles.push({ peer: name.slice(0, 12), revision: result.revision, status: result.status,
        samples: result.model?.samples ?? 0, assist: result.assist });
    } catch { profiles.push({ peer: name.slice(0, 12), status: 'unreadable' }); }
  }
  return { backend: 'tb serve / host', training: 'automatic on reviewed snapshot sync',
    transport: 'existing authenticated Peer channel', profiles };
}
export async function printLearningStatus(json = false) {
  const status = await learningStatus();
  if (json) console.log(JSON.stringify(status, null, 2));
  else {
    console.log('Personal voice learning — trained automatically by tb serve');
    if (!status.profiles.length) console.log('No reviewed phone feedback received yet. Enable personal context learning in phone settings.');
    for (const row of status.profiles) console.log(`${row.peer}  ${row.status}  ${'samples' in row ? row.samples : 0} labels  ${'assist' in row ? row.assist?.mode ?? 'shadow' : 'unavailable'}`);
    console.log('This is stored training status, not proof that the Host service is currently running.');
  }
}
