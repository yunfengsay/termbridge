/** Opt-in, billable synthetic cloud probe. No phone, file, or worker access. */
import assert from 'node:assert/strict';
import { createSilentConversations } from '../packages/host/src/silentExecution.js';

const services = createSilentConversations();
if (!services) throw new Error('Set DASHSCOPE_API_KEY for the synthetic silent-mode probe');
for (const tier of ['advanced', 'deep'] as const) {
  const phases: string[] = [];
  const started = Date.now();
  const response = await services[tier].respond({
    signal: AbortSignal.timeout(60_000),
    instructions: 'Synthetic test only. Use verify_context exactly once, then reply with its marker. Do not invent data.',
    messages: [{ role: 'user', content: '请调用测试工具，返回其中的 marker，不需要额外说明。' }],
    tools: [{ name: 'verify_context', description: 'Read a synthetic context marker.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    onToolCall: async call => {
      assert.equal(call.name, 'verify_context');
      return JSON.stringify({ marker: 'SILENT_CONTEXT_OK' });
    },
    execution: { forkId: `probe-${tier}`, requestId: `probe-${tier}`,
      observer: { onEvent: event => { phases.push(event.phase); } } },
  });
  assert.ok(response.text.includes('SILENT_CONTEXT_OK'));
  assert.equal(response.toolCalls.length, 1);
  assert.equal(phases.at(-1), 'fork_completed');
  console.log(JSON.stringify({ tier, model: response.model, elapsedMs: Date.now() - started,
    toolCalls: response.toolCalls.length, terminal: phases.at(-1), markerVerified: true }));
}
