/** Capped cloud teacher ablation on author-written public fixtures; no user's history/audio.
 * Predictions are advisory research data and are never ingested as human feedback.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBrainConversationService } from '../packages/brain/src/conversation.js';
import { createTurnJudge } from '../packages/host/src/voiceTurnJudge.js';
if (!process.argv.includes('--live')) throw new Error('Use --live for at most 32 bounded cloud text judgments');
const service = createBrainConversationService();
if (!service) throw new Error('Cloud credential unavailable');
const outputIndex = process.argv.indexOf('--out');
const directory = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : await mkdtemp(join(tmpdir(), 'tb-control-teacher-'));
await mkdir(directory, { recursive: true });
const fixtures = [
  { id: 'deictic-unfinished', segments: ['帮我找一下那个'], expected: 'wait', history: '电脑里有几个代码仓库。' },
  { id: 'conditional-unfinished', segments: ['如果今天构建通过', '那么'], expected: 'wait', history: '我们在讨论构建后的下一步。' },
  { id: 'direct-count', segments: ['现在有多少个任务还没有结束'], expected: 'respond', history: '我们在检查本机任务的状态。' },
  { id: 'two-tasks', segments: ['我昨天开的那两个任务', '分别做到哪一步了'], expected: 'respond', history: '你昨天的两个任务是检查日历权限与调整图标。' },
  { id: 'referent', segments: ['哪一个'], expected: 'respond', history: '你昨天的两个任务里，有一个失败了。' },
  { id: 'withhold', segments: ['别执行刚才的命令', '等我把参数说完整'], expected: 'wait', history: '你还在口述尚未派发的命令。' },
  { id: 'confirmation', segments: ['对，就是这个'], expected: 'respond', history: '你是否要只读检查刚才选中的 TermBridge 仓库？' },
  { id: 'inspect-and-report', segments: ['先查最新的日志', '然后告诉我失败在哪一步'], expected: 'respond', history: '我们在讨论本机昨天构建失败的任务。' },
];
const rows = [];
// 2 × 2 factorial: history and preceding segments are separate variables, not one bundle.
for (const withContext of [false, true]) for (const fullSegments of [false, true]) for (const fixture of fixtures) {
  const judge = createTurnJudge(service, () => withContext ? [{ role: 'assistant', content: fixture.history }] : []);
  const started = Date.now();
  try {
    const verdict = await judge({ segments: fullSegments ? fixture.segments : fixture.segments.slice(-1), signal: AbortSignal.timeout(8000) });
    const decision = typeof verdict === 'string' ? verdict : verdict.decision;
    rows.push({ ...fixture, withContext, fullSegments, decision, interpretation: typeof verdict === 'string' ? undefined : verdict.intent,
      latencyMs: Date.now() - started, correct: decision === fixture.expected, source: 'cloud-advisory' });
  } catch { rows.push({ id: fixture.id, withContext, fullSegments, source: 'cloud-advisory', error: 'cloud judgment failed', latencyMs: Date.now() - started }); }
}
await writeFile(join(directory, 'report.json'), JSON.stringify({ model: service.model, calls: rows.length,
  at: new Date().toISOString(), design: '2x2: history x full segments; 8 fresh authored scenes, prompt frozen before evaluation',
  expectedLabels: 'author judgment using full context, not measured user intent',
  note: 'No training on these outputs. Small sanity set, not a general intelligence score or permission to distill vendor outputs', rows }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ path: join(directory, 'report.json'), rows }));
