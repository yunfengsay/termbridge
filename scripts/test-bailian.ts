import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBrainConversationService } from '../packages/brain/src/index.js';

const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
assert(apiKey, 'DASHSCOPE_API_KEY is required for the live Bailian test');

const marker = `TB_BAILIAN_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const service = createBrainConversationService({
  ...process.env,
  DASHSCOPE_API_KEY: apiKey,
  TB_BRAIN_PROVIDER: 'bailian',
});
assert(service, 'Bailian Global Brain was not created');

const calls: string[] = [];
const lifecycle: string[] = [];
const result = await service.respond({
  instructions: [
    'You are a TermBridge integration test.',
    'For the current request you must call inspect_workspace exactly once, then answer briefly in Chinese.',
    'Preserve opaque verification markers exactly.',
  ].join('\n'),
  messages: [{ role: 'user', content: `请检查当前 Agent，并在回复中原样包含 ${marker}` }],
  tools: [{
    name: 'inspect_workspace',
    description: 'Read the authoritative current Agent roster.',
    parameters: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['overview'] } },
      required: ['view'],
      additionalProperties: false,
    },
  }],
  onToolCall: async (call) => {
    calls.push(`${call.name}:${String(call.arguments.view)}`);
    return JSON.stringify({ ok: true, count: 1, agents: [{ name: 'TermBridge', status: 'working' }] });
  },
  execution: {
    forkId: `fork-${marker}`,
    requestId: marker,
    observer: { onEvent: (event) => { lifecycle.push(event.phase); } },
  },
});

assert.deepEqual(calls, ['inspect_workspace:overview'], 'Bailian did not execute the registered tool exactly once');
assert(result.text.includes(marker), 'Bailian did not preserve the verification marker');
assert.equal(result.provider, 'bailian');
assert.equal(lifecycle[0], 'fork_started');
assert.equal(lifecycle.at(-1), 'fork_completed');
assert(lifecycle.includes('model_started') && lifecycle.includes('model_completed'));
console.log(`PASS Bailian Execution Fork (${result.model}); tool loop and lifecycle completed; marker preserved`);
