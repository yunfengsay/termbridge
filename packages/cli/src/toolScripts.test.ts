import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolScriptStore } from '@termbridge/tool-scripts';
import { registerToolScriptCommands } from './toolScripts.js';

test('Commander check/save/show/enable/list/disable lifecycle', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-script-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ToolScriptStore(join(dir, 'catalog')), file = join(dir, 'workflow.json');
  writeFileSync(file, JSON.stringify({ formatVersion: 1, id: 'status', version: 1, description: 'Read status', inputs: {},
    steps: [{ id: 'read', tool: 'inspect_workspace', arguments: { view: 'overview' } }] }));
  const outputs: unknown[] = [];
  const run = (args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerToolScriptCommands(program, store, v => outputs.push(v));
    return program.parseAsync(['script', ...args], { from: 'user' });
  };
  await run(['check', file]); assert.deepEqual(outputs.pop(), { ok: true, id: 'status', steps: 1 });
  await run(['save', file]); const digest = store.get('status').digest;
  await assert.rejects(run(['enable', 'status', '--digest', digest]));
  assert.equal(store.get('status').enabled, false);
  await run(['show', 'status']);
  await run(['enable', 'status', '--digest', digest, '--reviewed']);
  await run(['list']); assert.equal(store.get('status').enabled, true);
  await run(['disable', 'status']); assert.equal(store.get('status').enabled, false);
});
