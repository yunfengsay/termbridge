import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolScriptStore, parseScript, runToolScript, type ToolScript } from './index.js';

const fixture = (): ToolScript => ({ formatVersion: 1, id: 'daily-check', version: 1,
  description: 'Read the selected workspace view',
  inputs: { view: { type: 'string', description: 'Workspace view', enum: ['overview', 'recent'] } },
  steps: [{ id: 'read', tool: 'inspect_workspace', arguments: { view: { $input: 'view' } } }] });
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-tool-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ToolScriptStore(dir);
  return { store, dir };
}
test('draft persists; approval binds exact content; resave and disable require review', t => {
  const { store, dir } = setup(t), saved = store.save(fixture());
  assert.equal(store.get(saved.id).enabled, false);
  assert.throws(() => store.approve(saved.id, 'old-digest'));
  store.approve(saved.id, saved.digest);
  assert.equal(new ToolScriptStore(dir).get(saved.id).enabled, true);
  assert.equal(store.list()[0].digest, saved.digest);
  store.save(fixture());
  assert.equal(store.get(saved.id).enabled, false);
  store.approve(saved.id, saved.digest);
  store.disable(saved.id);
  assert.equal(store.get(saved.id).enabled, false);
});
test('changed file, invalid id and symlink cannot inherit approval', t => {
  const { store, dir } = setup(t), saved = store.save(fixture());
  store.approve(saved.id, saved.digest);
  writeFileSync(join(dir, `${saved.id}.json`), JSON.stringify({ ...fixture(), description: 'Changed' }));
  assert.equal(store.get(saved.id).enabled, false);
  assert.throws(() => store.get('../elsewhere'));
  symlinkSync(join(dir, `${saved.id}.json`), join(dir, 'alias.json'));
  assert.throws(() => store.get('alias'));
});
test('rejects code, recursion, forward refs, prototype paths and stale session ids', () => {
  for (const step of [
    { id: 'run', tool: 'bash', arguments: {} },
    { id: 'run', tool: 'tool_script', arguments: {} },
    { id: 'run', tool: 'inspect_workspace', arguments: { view: { $result: 'later', path: [] } } },
    { id: 'run', tool: 'inspect_workspace', arguments: { view: { $input: 'missing' } } },
    { id: 'run', tool: 'continue_agent', arguments: { sessionId: 'herdr:old' } },
    { id: 'run', tool: 'continue_agent', arguments: { sessionId: {} } },
    { id: 'run', tool: 'home_assistant', arguments: { action: 'call_service' } },
    { id: 'run', tool: 'inspect_workspace', arguments: JSON.parse('{"__proto__":{}}') },
  ]) assert.throws(() => parseScript({ ...fixture(), steps: [step] }));
  assert.throws(() => parseScript({ ...fixture(), steps: [...fixture().steps,
    { id: 'second', tool: 'inspect_workspace', arguments: { view: { $result: 'read', path: ['constructor'] } } }] }));
});
test('executes reviewed workflow through callback, with typed values and prior results', async t => {
  const { store } = setup(t), script = fixture();
  script.steps.push({ id: 'next', tool: 'workspace_files', arguments: { action: 'read', path: { $result: 'read', path: ['path'] } } });
  const saved = store.save(script); store.approve(saved.id, saved.digest);
  const calls: unknown[] = [];
  const result = await runToolScript(store, saved.id, saved.digest, { view: 'recent' }, 'script-test', async call => {
    calls.push(call);
    return call.name === 'inspect_workspace' ? { ok: true, path: 'README.md', largeId: 9007199254740993n } : { ok: true, text: 'read' };
  }, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, [
    { callId: 'script-test:read', name: 'inspect_workspace', arguments: { view: 'recent' } },
    { callId: 'script-test:next', name: 'workspace_files', arguments: { action: 'read', path: 'README.md' } },
  ]);
  assert.equal(result.steps[0].result.largeId, '9007199254740993');
  assert.doesNotThrow(() => JSON.stringify(result));
});
test('no execution before approval or with wrong digest/inputs', async t => {
  const { store } = setup(t), saved = store.save(fixture());
  let calls = 0;
  const invoke = async () => { calls++; return { ok: true }; };
  const run = (digest: string, inputs: Record<string, unknown>) => runToolScript(store, saved.id, digest, inputs, 'test', invoke, new AbortController().signal);
  assert.equal((await run(saved.digest, { view: 'recent' })).status, 'failed');
  store.approve(saved.id, saved.digest);
  for (const args of [{ view: 'wrong' }, { view: 4 }, { view: 'recent', extra: true }, {}]) {
    assert.equal((await run(saved.digest, args)).status, 'failed');
  }
  assert.equal((await run('wrong-digest', { view: 'recent' })).status, 'failed');
  assert.equal(calls, 0);
});
for (const [output, status] of [
  [{ ok: true, state: 'awaiting_user', actionId: 'phone-1' }, 'pending'],
  [{ ok: true, status: 'dispatched', taskId: 'task-1' }, 'pending'],
  [{ ok: false, status: 'outcome_unknown' }, 'outcome_unknown'],
  [{ ok: false, status: 'failed' }, 'failed'],
  [{ ok: false, status: 'cancelled' }, 'cancelled'],
] as const) test(`receipt ${'state' in output ? output.state : output.status} stops following steps and never retries`, async t => {
  const { store } = setup(t), script = fixture();
  script.steps.push({ ...script.steps[0], id: 'next' });
  const saved = store.save(script); store.approve(saved.id, saved.digest);
  let calls = 0;
  const result = await runToolScript(store, saved.id, saved.digest, { view: 'recent' }, 'test', async () => {
    calls++; return output;
  }, new AbortController().signal);
  assert.equal(result.status, status); assert.equal(calls, 1); assert.equal(result.retryable, false);
});
test('cancel and disable stop before subsequent steps without pretending to undo effects', async t => {
  const { store } = setup(t), script = fixture();
  script.steps.push({ ...script.steps[0], id: 'next' });
  for (const mode of ['cancel', 'disable']) {
    const saved = store.save(script); store.approve(saved.id, saved.digest);
    const controller = new AbortController(); let calls = 0;
    const result = await runToolScript(store, saved.id, saved.digest, { view: 'recent' }, 'test', async () => {
      calls++; if (mode === 'cancel') controller.abort(); else store.disable(saved.id);
      return { ok: true };
    }, controller.signal);
    assert.equal(calls, 1);
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(result.steps.length, 1);
  }
});
test('oversized result is not retained or reused', async t => {
  const { store } = setup(t), saved = store.save(fixture()); store.approve(saved.id, saved.digest);
  const result = await runToolScript(store, saved.id, saved.digest, { view: 'recent' }, 'test',
    async () => ({ ok: true, text: 'x'.repeat(20_000) }), new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.ok(JSON.stringify(result).length < 1000);
});
