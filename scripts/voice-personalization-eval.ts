/** Reproducible public-data evaluation. No microphone/player. Public examples NEVER enter user training. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createBrainConversationService } from '../packages/brain/src/conversation.js';
import { createTurnJudge } from '../packages/host/src/voiceTurnJudge.js';
import { TurnCoordinator, type TurnClock } from '../packages/voice/src/control/turnCoordinator.js';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: tsx scripts/voice-personalization-eval.ts <open-yap-cache> [--live]');
type Word = { start: number; end: number; word: string };
type Conversation = { conversation_id: string; duration_seconds: number; sample_rate: number;
  speakers: Record<string, { speaker_id: string }>; transcripts: Record<string, { words: Word[] }> };
const files = (await readdir(directory)).filter(name => /^conv_.*\.json$/.test(name)).sort();
const gaps: number[] = [], speakers = new Set<string>(); let hours = 0, words = 0, replays = 0;
const conversationIds: string[] = [];
for (const file of files) {
  const conversation: Conversation = JSON.parse(await readFile(join(directory, file), 'utf8'));
  conversationIds.push(conversation.conversation_id); hours += conversation.duration_seconds / 3600;
  for (const speaker of Object.values(conversation.speakers)) speakers.add(speaker.speaker_id);
  for (const [side, transcript] of Object.entries(conversation.transcripts)) {
    words += transcript.words.length;
    const other = conversation.transcripts[side === 'a' ? 'b' : 'a'].words;
    for (let i = 1; i < transcript.words.length; i++) {
      const before = transcript.words[i - 1], after = transcript.words[i];
      const gap = Math.round((after.start - before.end) * 1000);
      if (gap < 250 || gap > 30_000 || other.some(word => word.end > before.end && word.start < after.start)) continue;
      gaps.push(gap);
      if (gap < 3000 || replays >= 200) continue;
      // Real timestamps, but a scripted WAIT verdict: state-machine evidence, not model accuracy.
      let now = 0, sequence = 0;
      const timers = new Map<number, { at: number; fn: () => void }>();
      const clock: TurnClock = { now: () => now,
        later(fn, ms) { const id = ++sequence; timers.set(id, { at: now + ms, fn }); return id; }, cancel(id) { timers.delete(id as number); } };
      async function advance(ms: number) {
        const target = now + ms;
        while (true) {
          const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          now = due[1].at; timers.delete(due[0]); due[1].fn(); await new Promise(resolve => setImmediate(resolve));
        }
        now = target;
      }
      const commits: string[] = [];
      const turn = new TurnCoordinator(async ({ segments }) => segments.length === 1 ? 'wait' : 'respond', text => commits.push(text), () => {}, clock, () => {});
      turn.speechStart('a'); turn.transcript('a', before.word); turn.speechStop('a'); await advance(gap);
      turn.speechStart('b'); turn.transcript('b', after.word); turn.speechStop('b'); await advance(3500);
      if (commits.length !== 1 || commits[0] !== `${before.word} ${after.word}`) throw new Error('Public-timestamp continuation replay failed');
      turn.close(); if (timers.size) throw new Error('Replay leaked timers'); replays++;
    }
  }
}
gaps.sort((a, b) => a - b);
const report: Record<string, unknown> = { at: new Date().toISOString(), publicData: { name: 'Open Yap 1K public sample',
  manifest: JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), conversations: files.length, speakers: speakers.size, hours, words,
  sameSpeakerPausesWithoutOtherTranscript: gaps.length,
  pauseMs: { p50: gaps[Math.floor(gaps.length * .5)], p95: gaps[Math.floor(gaps.length * .95)] },
  longerThan3s: gaps.filter(gap => gap >= 3000).length, longerThan8s: gaps.filter(gap => gap >= 8000).length,
  stateMachineReplays: replays, replaysPassed: replays,
  caveat: 'English two-person phone calls, machine transcripts; timing proxies are not semantic/device-directed labels. Replay judge is scripted, not cloud inference.' } };
await writeFile(join(directory, 'evaluation.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
if (process.argv.includes('--live')) {
  const repository = 'KE-Team/SemanticVAD-Dataset';
  const get = (url: string) => execFileSync('curl', ['-fsSL', '--retry', '2', '--max-time', '30', url], { maxBuffer: 4 * 1024 * 1024 }).toString();
  const revision = JSON.parse(get(`https://huggingface.co/api/datasets/${repository}`)).sha;
  const raw = get(`https://huggingface.co/datasets/${repository}/resolve/${revision}/testset_4400.json`);
  await writeFile(join(directory, 'semanticvad-test.json'), raw, { mode: 0o600 });
  type Case = { dialog: { speaker: string; text: string }[]; label: string; lang?: string };
  const all = JSON.parse(raw) as Case[];
  if (!Array.isArray(all)) throw new Error('Unsupported public dataset format');
  const service = createBrainConversationService(); if (!service) throw new Error('Cloud credential unavailable');
  // Predeclared fixed-hash, balanced sample. No tuning/training on this test set.
  const hash = (row: Case) => createHash('sha256').update(JSON.stringify(row.dialog.filter(item => item.speaker !== 'VAD'))).digest('hex');
  const selected = ['<完成>', '<未完>'].flatMap(label => all.filter(row => row.label.trim() === label)
    .sort((a, b) => hash(a).localeCompare(hash(b))).slice(0, 40));
  if (selected.length !== 80) throw new Error('Public labels do not match expected completion subset');
  const rows = [];
  for (const row of selected) {
    const dialog = row.dialog.filter(item => item.speaker !== 'VAD')
      .map(item => ({ role: item.speaker === 'Human' ? 'user' as const : 'assistant' as const, content: item.text.trim() }));
    const current = dialog.findLastIndex(item => item.role === 'user');
    if (current < 0) throw new Error('Cannot map public dialogue losslessly');
    const history = dialog.slice(0, current).map(({ role, content }) => ({ role, content }));
    const judge = createTurnJudge(service, () => history);
    const started = Date.now(); let decision = 'error';
    try {
      const verdict = await judge({ segments: [dialog[current].content], signal: AbortSignal.timeout(10_000) });
      decision = typeof verdict === 'string' ? verdict : verdict.decision;
    } catch { /* Count failures rather than silently drop them. */ }
    const expected = row.label.trim() === '<完成>' ? 'respond' : 'wait';
    rows.push({ id: hash(row), expected, decision, latencyMs: Date.now() - started, passed: decision === expected });
    console.log(JSON.stringify(rows.at(-1)));
  }
  report.semantic = { repository, revision, sha256: createHash('sha256').update(raw).digest('hex'), model: service.model,
    total: all.length, tested: rows.length, passed: rows.filter(row => row.passed).length, rows,
    caveat: 'Agreement with publisher Qwen2.5-72B-corrected labels, not independent human truth. No test samples were trained into personal profiles. No audio ASR or noise test.' };
}
await writeFile(join(directory, 'evaluation.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(`Evidence: ${join(directory, 'evaluation.json')}`);
