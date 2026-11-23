import { readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { MAX_SCRIPT_BYTES, parseScript, ToolScriptStore } from '@termbridge/tool-scripts';

export function registerToolScriptCommands(program: Command, store = new ToolScriptStore(),
  print: (value: unknown) => void = value => console.log(JSON.stringify(value, null, 2))): void {
  const read = (file: string) => {
    if (statSync(file).size > MAX_SCRIPT_BYTES) throw new Error('Script too large');
    return parseScript(JSON.parse(readFileSync(file, 'utf8')));
  };
  const command = program.command('script').description('manage local reusable tool workflows (no arbitrary code execution)');
  command.command('list').action(() => { print(store.list()); });
  command.command('show <id>').action(id => { print(store.get(id)); });
  command.command('check <file>').description('validate structure and references; does not execute tools')
    .action(file => { const script = read(file); print({ ok: true, id: script.id, steps: script.steps.length }); });
  command.command('save <file>').description('save a draft; always invalidates previous approval')
    .action(file => { print(store.save(read(file))); });
  command.command('enable <id>').description('enable the exact workflow you reviewed locally')
    .requiredOption('--digest <sha256>', 'digest printed by show')
    .requiredOption('--reviewed', 'confirm you reviewed all tool calls, inputs, and side effects')
    .action((id, options) => { store.approve(id, options.digest); print({ id, enabled: true }); });
  command.command('disable <id>').action(id => { store.disable(id); print({ id, enabled: false }); });
}
