import assert from 'node:assert/strict';
import test from 'node:test';
import { createSilentConversations, SilentExecutions } from './silentExecution.js';
import { createBrainConversationService } from '@termbridge/brain';
import { createVoiceExecutionConversations, selectExecutionConversation } from './voiceExecutionModels.js';

test('voice execution uses Bailian DeepSeek independently of text and silent text models', () => {
  const env = { DASHSCOPE_API_KEY: 'test', TB_BRAIN_MODEL: 'text-model', TB_SILENT_MODEL: 'silent-text-model' };
  const voice = createVoiceExecutionConversations(env)!;
  const text = createBrainConversationService(env);
  const silent = createSilentConversations(env);
  const services = { voice, text, silent };
  for (const workflow of ['standard', 'silent'] as const) {
    for (const modelTier of ['advanced', 'deep'] as const) {
      const selected = selectExecutionConversation({ voiceKey: 'call-1', workflow, modelTier }, services)!;
      assert.equal(selected.model, 'deepseek-v4.1-flash');
      assert.equal(selected.provider, 'bailian');
      assert.equal(selected.runtime, 'pi');
    }
  }
  assert.equal(selectExecutionConversation({}, services), text);
  assert.equal(selectExecutionConversation({ workflow: 'silent' }, services), silent?.advanced);
  assert.equal(selectExecutionConversation({ workflow: 'silent', modelTier: 'deep' }, services), silent?.deep);
  assert.equal(text?.model, 'text-model');
  assert.equal(silent?.advanced.model, 'silent-text-model');
});

test('voice execution accepts only its Host model override and never falls back without credentials', () => {
  assert.equal(createVoiceExecutionConversations({}), undefined);
  const configured = createVoiceExecutionConversations({ DASHSCOPE_API_KEY: 'test', TB_VOICE_EXECUTION_MODEL: ' custom-model ' })!;
  assert.equal(configured.standard.model, 'custom-model');
  assert.equal(configured.deep.model, 'custom-model');
  const text = createBrainConversationService({ DASHSCOPE_API_KEY: 'test' });
  assert.equal(selectExecutionConversation({ voiceKey: 'call-1' }, { voice: undefined, text, silent: undefined }), undefined);
});

test('silent model tiers are Host-owned and never fall back to a local agent', () => {
  assert.equal(createSilentConversations({}), undefined);
  const defaults = createSilentConversations({ DASHSCOPE_API_KEY: 'test' })!;
  assert.equal(defaults.advanced.model, 'deepseek-v4.1-flash');
  assert.equal(defaults.deep.model, 'deepseek-v4.1-flash');
  assert.equal(createBrainConversationService({ DASHSCOPE_API_KEY: 'test' })?.model, 'deepseek-v4.1-flash');
  assert.equal(defaults.deep.runtime, 'pi');
  const configured = createSilentConversations({ DASHSCOPE_API_KEY: 'test',
    TB_SILENT_MODEL: 'allowed-max', TB_SILENT_DEEP_MODEL: 'allowed-deep' })!;
  assert.equal(configured.advanced.model, 'allowed-max');
  assert.equal(configured.deep.model, 'allowed-deep');
});

test('stable request IDs cancel only the selected orchestration', () => {
  const jobs = new SilentExecutions();
  const first = jobs.start('request-1');
  const second = jobs.start('request-2');
  assert.throws(() => jobs.start('request-1'), /already running/);
  assert.equal(jobs.cancel('request-1'), true);
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  jobs.finish('request-1');
  assert.equal(jobs.cancel('request-1'), false);
  assert.equal(jobs.cancel('unknown'), false);
  jobs.finish('request-2');
});
