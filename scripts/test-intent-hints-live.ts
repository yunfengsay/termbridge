/** Opt-in Jev evaluation: synthetic Chinese fixtures only, no device/worker operations. */
import { readFileSync } from 'node:fs';
import { createJevEvaluator, type IntentContext } from '../packages/host/src/intentHints.js';
import { GLOBAL_BRAIN_TOOLS } from '../packages/host/src/voiceTools.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to send synthetic fixtures to TypeSafe');
const keyFlag = process.argv.indexOf('--key-file');
const key = keyFlag >= 0 ? readFileSync(process.argv[keyFlag + 1], 'utf8').trim() : process.env.TYPESAFE_API_KEY;
if (!key) throw new Error('Set TYPESAFE_API_KEY or --key-file; credentials are never logged');
const context: IntentContext = { conversationId: 'synthetic', candidates: [
  { sessionId: 'fixture-voice', name: 'termbridge-voice', agent: 'codex', workspace: 'TermBridge' },
  { sessionId: 'fixture-canvas', name: 'canvas-rendering', agent: 'claude', workspace: 'Canvas' },
], tools: GLOBAL_BRAIN_TOOLS, history: [{ role: 'user', text: '最近完成的是谁？' }, { role: 'assistant', text: 'termbridge-voice。' }] };
const cases = [
  { text: '让他提交代码并且 push，发给他就行', intent: 'delegate', target: 'fixture-voice' },
  { text: '告诉 canvas-rendering 继续查那个画布问题', intent: 'delegate', target: 'fixture-canvas' },
  { text: '不要提交，只解释一下为什么要提交', intent: 'discuss' },
  { text: '我现在有多少 Agent 在运行？', intent: 'inspect' },
  { text: '帮我定一个明天早上八点的提醒，带护照', intent: 'phone' },
  { text: '把我选中的这三张旅游照片分类，先给我看分类结果', intent: 'phone' },
  { text: '读一下我明天的日历', intent: 'phone' },
  { text: '关闭客厅的灯', intent: 'home' },
  { text: '取消刚才的任务，不要继续了', intent: 'cancel' },
  { text: '听得到吗？', intent: 'discuss' },
  { text: '让那个 agent 继续', intent: 'delegate', targetChoice: 'none', history: [] },
  { text: '让 worker 继续', intent: 'delegate', targetChoice: 'ambiguous', history: [],
    candidates: context.candidates.map(c => ({ ...c, name: 'worker', workspace: 'same' })) },
];
const evaluate = createJevEvaluator(key);
const expectedTools = ['continue_agent', 'continue_agent', 'none', 'inspect_workspace', 'phone_action',
  'phone_action', 'phone_action', 'home_assistant', 'cancel_execution', 'none'];
const results = [];
for (const [i, fixture] of cases.entries()) {
  const started = performance.now();
  try {
    const result = await evaluate(fixture.text, { ...context,
      history: fixture.history ?? context.history, candidates: fixture.candidates ?? context.candidates }, AbortSignal.timeout(5000));
    const passed = result.intent.choice === fixture.intent &&
      (!expectedTools[i] || result.tool?.choice === expectedTools[i]) &&
      (!fixture.target || result.targetSessionId === fixture.target) &&
      (!fixture.targetChoice || result.target.choice === fixture.targetChoice);
    const row = { case: i + 1, passed, latencyMs: Math.round(performance.now() - started),
      intent: result.intent.choice, target: result.target.choice, tool: result.tool?.choice, confidence: result.intent.confidence,
      inputTokens: result.inputTokens };
    results.push(row); console.log(JSON.stringify(row));
  } catch {
    const row = { case: i + 1, passed: false, latencyMs: Math.round(performance.now() - started), unavailable: true };
    results.push(row); console.log(JSON.stringify(row));
  }
}
const times = results.map(r => r.latencyMs).sort((a, b) => a - b);
console.log(JSON.stringify({ summary: true, passed: results.filter(r => r.passed).length, total: results.length,
  p50Ms: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] }));
if (results.some(r => !r.passed)) process.exitCode = 1;
