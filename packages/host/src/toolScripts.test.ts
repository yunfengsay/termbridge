import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolScriptStore } from '@termbridge/tool-scripts';
import { ToolScripts } from './toolScripts.js';
import { createGlobalBrainToolHandler, type ControlToolEnvironment } from './voiceTools.js';

test('real shared harness: saved script -> existing tool -> pending receipt; cannot self-approve', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-script-harness-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ToolScriptStore(dir), service = new ToolScripts(store);
  let dispatches = 0;
  const env: ControlToolEnvironment = {
    now: Date.now, refreshAgents: async () => {}, listAgents: () => [], listAgentProfiles: () => [],
    recentCompletions: () => [], listTasks: () => [], searchWeb: async () => ({ ok: true }),
    inspectImages: async () => ({ ok: true }), workspaceFiles: async () => ({ ok: true }),
    phoneAction: async () => ({ ok: false, state: 'denied' }), homeAssistant: async () => ({ ok: false }),
    dispatchAgent: async () => { dispatches++; return { ok: true, status: 'dispatched', taskId: 'worker-1' }; },
    continueAgent: async () => ({ ok: true, status: 'sent' }), cancelExecution: async () => ({ ok: false }),
    toolScript: (args, id) => service.execute(args, id, async call => JSON.parse(await handle(call))),
  };
  const handle = createGlobalBrainToolHandler(env);
  const call = (args: Record<string, unknown>) => handle({ callId: 'script-call', name: 'tool_script', arguments: args }).then(JSON.parse);
  const saved = await call({ action: 'save', script: { formatVersion: 1, id: 'review-task', version: 1,
    description: 'Delegate a bounded review', inputs: { task: { type: 'string', description: 'Task' } },
    steps: [{ id: 'delegate', tool: 'dispatch_agent', arguments: { task: { $input: 'task' }, agent: 'codex' } }] } });
  assert.equal(saved.status, 'needs_review');
  const args = { action: 'run', id: saved.id, digest: saved.digest, inputs: { task: 'Review the requested file' } };
  assert.equal((await call(args)).ok, false); assert.equal(dispatches, 0);
  assert.equal((await call({ action: 'approve', id: saved.id, digest: saved.digest })).ok, false);
  store.approve(saved.id, saved.digest);
  const receipt = await call(args);
  assert.equal(dispatches, 1); assert.equal(receipt.status, 'pending');
  assert.equal(receipt.steps[0].result.taskId, 'worker-1');
  assert.match(receipt.runId, /^script-[a-f0-9]{24}$/);
  const denied = await call({ action: 'save', script: { formatVersion: 1, id: 'device-check', version: 1,
    description: 'Read calendar', inputs: {}, steps: [{ id: 'phone', tool: 'phone_action', arguments: {
      action: 'calendar.list', startsAt: '2026-09-21T00:00:00+08:00', endsAt: '2026-09-22T00:00:00+08:00',
    } }] } });
  store.approve(denied.id, denied.digest);
  const phone = await call({ action: 'run', id: denied.id, digest: denied.digest, inputs: {} });
  assert.equal(phone.status, 'failed'); assert.equal(phone.steps[0].result.state, 'denied');
});

test('active run IDs are discoverable; cancel waits for receipt then stops subsequent steps', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-script-cancel-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ToolScriptStore(dir), service = new ToolScripts(store);
  const saved = store.save({ formatVersion: 1, id: 'checks', version: 1, description: 'Read twice', inputs: {},
    steps: ['first', 'second'].map(id => ({ id, tool: 'inspect_workspace', arguments: { view: 'overview' } })) });
  store.approve(saved.id, saved.digest);
  let finish!: (v: Record<string, unknown>) => void, calls = 0;
  const running = service.execute({ action: 'run', id: saved.id, digest: saved.digest, inputs: {} }, 'unique-request', async () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  });
  const list = await service.execute({ action: 'list' }, '', async () => ({}));
  const [runId] = list.activeRunIds as string[];
  assert.equal(service.cancel(runId)?.status, 'cancelling');
  finish({ ok: true });
  const receipt = await running;
  assert.equal(receipt.status, 'cancelled'); assert.equal(calls, 1);
  assert.equal(service.cancel(runId), undefined);
});
