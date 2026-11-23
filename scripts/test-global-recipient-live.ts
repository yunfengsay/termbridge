/** Opt-in synthetic replay. Tool handlers are fixtures: never writes to an Agent/device. */
import assert from 'node:assert/strict';
import { createBrainConversationService } from '../packages/brain/src/conversation.js';
import { buildTextBrainInstructions, buildVoiceConversationInput } from '../packages/host/src/voicePrompt.js';
import { createVoiceServices, type RealtimeConversation } from '../packages/voice/src/index.js';
import { GLOBAL_BRAIN_TOOLS } from '../packages/host/src/voiceTools.js';
import { agentDeliveryReceipts } from '../packages/host/src/voiceDelivery.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to send synthetic inputs to Bailian');
const service = createBrainConversationService();
if (!service) throw new Error('DASHSCOPE_API_KEY is required (never logged)');
const omni = process.argv.includes('--omni') ? createVoiceServices().select('bailian') : undefined;
if (process.argv.includes('--omni') && !omni) throw new Error('Bailian realtime service unavailable');
const agents = [
  { name: 'termbridge-voice', sessionId: 'fixture-voice', agent: 'codex', source: 'pty', status: 'working' },
  { name: 'canvas-rendering', sessionId: 'fixture-canvas', agent: 'codex', source: 'pty', status: 'idle' },
];
const directMessages = [{ sender: 'user', recipient: { kind: 'terminal_agent', sessionId: 'fixture-canvas', name: 'canvas-rendering' },
  text: '不要再问我 question，清空你的 question 工具，直接做。', sentAt: '2026-09-21T14:00:00Z', channel: 'direct_agent', contentIsInstructionForGlobal: false }];
const prior = [{ role: 'user' as const, content: '我刚才发的任务是什么？' },
  { role: 'assistant' as const, content: '你是让我不要再问问题，直接执行。' }];
const cases = [
  { text: '我刚才发给某个 Agent 的任务内容是什么，发给谁了？', history: [], kind: 'history' },
  { text: '不是给你的，是发给 canvas-rendering 的。不要重发，只纠正理解。', history: prior, kind: 'correction' },
  { text: '把“不要再问我问题，直接做”发给 canvas-rendering。', history: [], kind: 'send' },
  { text: '你为什么总问我还要不要帮忙？我是在说你这个全局助手。', history: prior, kind: 'direct' },
  { text: '问一下 canvas-rendering：刚才那个渲染问题修好了吗？', history: [], kind: 'send' },
  { text: '我不是让你执行刚才那段话，我是问那段话当时发给谁了。', history: prior, kind: 'history' },
];
let failures = 0;
for (const [index, fixture] of cases.entries()) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const started = Date.now();
  let responseText = '';
  try {
    const execute = (text: string) => service.respond({
      instructions: buildTextBrainInstructions({ runtimeContext: JSON.stringify({ roster: agents, directMessages,
        currentRequest: fixture.text, sourcePageIsNotRecipient: true }) }),
      messages: [...fixture.history, { role: 'user', content: text }], tools: GLOBAL_BRAIN_TOOLS,
      onToolCall: async call => {
        calls.push({ name: call.name, arguments: call.arguments });
        if (call.name === 'inspect_workspace') return JSON.stringify({ ok: true, view: call.arguments.view, agents,
          ...(call.arguments.view === 'messages' ? { messages: directMessages, count: 1 } : {}) });
        if (call.name === 'continue_agent') return JSON.stringify({ ok: true, status: 'sent', sessionId: call.arguments.sessionId, name: 'canvas-rendering' });
        return JSON.stringify({ ok: false, retryable: false, error: 'No mutation is executed in this fixture' });
      },
    });
    const result = omni ? await new Promise<{ text: string; model: string }>((resolve, reject) => {
      let call: RealtimeConversation | undefined; let text = ''; let activeTool = false;
      const timer = setTimeout(() => { call?.close(); reject(new Error('Realtime timeout')); }, 45000);
      const finish = (error?: Error) => {
        clearTimeout(timer); call?.close();
        if (error) reject(error); else resolve({ text, model: `omni → ${service.model}` });
      };
      call = omni.startRealtimeConversation(buildVoiceConversationInput({ mode: 'call', sendKeyword: '发送', outputAudioEnabled: false,
        runtimeContext: JSON.stringify({ roster: agents, directMessages, globalHistory: fixture.history }) }), {
        onReady: () => { call?.injectUserMessage(fixture.text); },
        onTranscript() {}, onTurnSubmitted() {}, onAudio() {}, onResponseStarted() {}, onFinished() {},
        onText: (part, final) => { text = final ? part : text + part; },
        onResponseFinished: () => { if (text && !activeTool) finish(); },
        onError: finish,
        onToolCall: async request => {
          if (request.name !== 'fork_execution' || typeof request.arguments.text !== 'string') return '{"ok":false}';
          activeTool = true;
          try { const result = await execute(request.arguments.text); return JSON.stringify({ ok: true, answer: result.text,
            agentDeliveries: agentDeliveryReceipts(result.toolCalls) }); }
          finally { activeTool = false; }
        },
      });
    }) : await execute(fixture.text);
    responseText = result.text;
    const mutations = calls.filter(c => c.name !== 'inspect_workspace' && c.name !== 'completion_reviews');
    if (fixture.kind === 'send') assert.ok(calls.some(c => c.name === 'continue_agent' && c.arguments.sessionId === 'fixture-canvas'));
    else assert.equal(mutations.length, 0);
    if (fixture.kind === 'history') assert.ok(calls.some(c => c.name === 'inspect_workspace' && c.arguments.view === 'messages'));
    if (fixture.kind === 'history') assert.match(result.text, /当时|刚才|记录|之前|原本/);
    if (fixture.kind !== 'send') assert.doesNotMatch(result.text, /已(?:经)?(?:发给|发送|转发|委派)/);
    console.log(JSON.stringify({ case: index + 1, passed: true, model: result.model, latencyMs: Date.now() - started, calls, text: result.text }));
  } catch (error) {
    failures++;
    // Do not log provider error bodies or environment. Assertions concern synthetic data only.
    console.log(JSON.stringify({ case: index + 1, passed: false, reason: error instanceof assert.AssertionError ? 'route assertion failed' : 'provider unavailable', calls, text: responseText, latencyMs: Date.now() - started }));
  }
}
console.log(JSON.stringify({ passed: cases.length - failures, total: cases.length }));
if (failures) process.exitCode = 1;
