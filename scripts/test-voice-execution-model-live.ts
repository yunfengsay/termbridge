/** Opt-in billable probe: synthetic context and one in-memory tool; no device/worker access. */
import assert from 'node:assert/strict';
import { createVoiceExecutionConversations } from '../packages/host/src/voiceExecutionModels.js';

assert(process.argv.includes('--live'), 'Pass --live to make a billable Bailian request');
const originalFetch = globalThis.fetch;
let checkedRequests = 0;
globalThis.fetch = async (input, init) => {
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  assert.equal(typeof body, 'string', 'Expected a JSON model request');
  const payload = JSON.parse(body as string);
  assert.equal(payload.enable_thinking, false, 'Voice execution must explicitly disable thinking');
  checkedRequests++;
  return originalFetch(input, init);
};
const services = createVoiceExecutionConversations();
globalThis.fetch = originalFetch; // The service captures the instrumented fetch, without affecting other clients.
assert(services, 'DASHSCOPE_API_KEY is required');
for (const tier of ['standard', 'advanced'] as const) {
  const phases: string[] = [];
  const started = Date.now();
  const result = await services[tier].respond({
    instructions: 'Synthetic test. Call verify_context once, then return its marker verbatim. Never invent the marker.',
    messages: [{ role: 'user', content: '调用测试工具，返回其中的 marker。' }],
    tools: [{ name: 'verify_context', description: 'Read a synthetic marker.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    onToolCall: async call => {
      assert.equal(call.name, 'verify_context');
      return JSON.stringify({ marker: 'VOICE_EXECUTION_OK' });
    },
    execution: { forkId: `probe-${tier}`, requestId: `probe-${tier}`,
      observer: { onEvent: event => { phases.push(event.phase); } } },
  });
  assert(result.text.includes('VOICE_EXECUTION_OK'));
  assert.equal(result.toolCalls.length, 1);
  assert.equal(phases.at(-1), 'fork_completed');
  console.log(JSON.stringify({ tier, model: result.model, elapsedMs: Date.now() - started,
    toolCalls: result.toolCalls.length, terminal: phases.at(-1), markerVerified: true,
    thinking: false, checkedRequests }));
}
