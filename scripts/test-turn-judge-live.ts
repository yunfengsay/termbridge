/** Bounded, opt-in semantic regression. Authored text only; no microphone or playback. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainConversationService } from '../packages/brain/src/conversation.js';
import { createTurnJudge } from '../packages/host/src/voiceTurnJudge.js';

if (!process.argv.includes('--live')) throw new Error('Use --live for bounded cloud inference');
const service = createBrainConversationService();
if (!service) throw new Error('Cloud credential not configured');
const question = '您想让我做什么呢？';
const history: { role: 'user' | 'assistant'; content: string }[] = [
  { role: 'user', content: '刚才哪个 Agent 在执行任务？' },
  { role: 'assistant', content: 'TermBridge 在检查语音链路。' },
  { role: 'assistant', content: question },
];
const cases = [
  { name: 'listening-continuation', segments: ['你现在在听。', '在听我说话吗？'], clarification: question, history, expected: 'respond' },
  { name: 'without-history', segments: ['你现在在听。', '在听我说话吗？'], clarification: question, history: [], expected: 'respond' },
  { name: 'without-clarification', segments: ['你现在在听。', '在听我说话吗？'], history: history.slice(0, 2), expected: 'respond' },
  { name: 'standalone-check', segments: ['在听我说话吗？'], history, expected: 'respond' },
  { name: 'single-full-question', segments: ['你现在在听我说话吗？'], history, expected: 'respond' },
  { name: 'unfinished-agent', segments: ['我最近的'], history: [], expected: 'wait' },
  { name: 'agent-continuation', segments: ['我最近的', 'Agent 是什么'], clarification: question, history, expected: 'respond' },
  { name: 'still-thinking', segments: ['我最近的', '对，我还在想，没说完'], clarification: question, history, expected: 'wait' },
  { name: 'unresolved-task', segments: ['帮我把那个'], clarification: question, history, expected: 'wait' },
  { name: 'self-correction', segments: ['那个服务的', '不对，我是想问你能收到声音吗'], clarification: question, history, expected: 'respond' },
  { name: 'stop-request', segments: ['先不要继续了'], history, expected: 'respond' },
  { name: 'greeting', segments: ['你好'], history: [], expected: 'respond' },
  { name: 'no-punctuation-continuation', segments: ['你现在在听', '在听我说话吗'], clarification: question, history: [], expected: 'respond' },
];
const rows = [];
for (const fixture of cases) {
  const started = Date.now();
  let raw = '';
  const judge = createTurnJudge({ ...service, provider: service.provider, runtime: service.runtime, model: service.model,
    async respond(input) { const reply = await service.respond(input); raw = reply.text; return reply; },
  }, () => fixture.history);
  let error: string | undefined;
  let verdict;
  try { verdict = await judge({ ...fixture, clarificationAfterSegment: fixture.clarification ? 1 : undefined, signal: AbortSignal.timeout(15_000) }); }
  catch (failure) { error = failure instanceof Error ? failure.message : 'failed'; }
  const decision = typeof verdict === 'string' ? verdict : verdict?.decision;
  const row = { ...fixture, verdict, raw, error, latencyMs: Date.now() - started, passed: decision === fixture.expected };
  rows.push(row); console.log(JSON.stringify(row));
}
const directory = await mkdtemp(join(tmpdir(), 'tb-turn-judge-live-'));
await writeFile(join(directory, 'report.json'), JSON.stringify({ at: new Date().toISOString(), model: service.model,
  provenance: 'authored synthetic text, not recorded private history', rows }, null, 2), { mode: 0o600 });
console.log(`Evidence: ${join(directory, 'report.json')}`);
if (rows.some(row => !row.passed) && !process.argv.includes('--measure-only')) process.exitCode = 1;
