import { bindInputs, resolveValue } from './schema.js';
import type { ToolScriptStore } from './store.js';

export interface ScriptCall { callId: string; name: string; arguments: Record<string, unknown> }
export interface ScriptRunResult {
  ok: boolean;
  status: 'completed' | 'failed' | 'cancelled' | 'pending' | 'outcome_unknown';
  scriptId: string;
  runId: string;
  steps: { id: string; tool: string; status: string; result: Record<string, unknown> }[];
  error?: string;
  retryable: false;
}

/** Bounded sequential tool program. No eval, shell, loops, imports or recursive scripts. */
export async function runToolScript(store: ToolScriptStore, id: string, digest: string,
  inputs: Record<string, unknown>, runId: string, invoke: (call: ScriptCall) => Promise<Record<string, unknown>>,
  signal: AbortSignal): Promise<ScriptRunResult> {
  const result: ScriptRunResult = { ok: false, status: 'failed', scriptId: id, runId, steps: [], retryable: false };
  try {
    const entry = store.get(id);
    if (!entry.enabled || entry.digest !== digest) throw new Error('Script is unapproved or changed; review required');
    bindInputs(entry.script, inputs);
    const outputs: Record<string, unknown> = Object.create(null);
    for (const step of entry.script.steps) {
      signal.throwIfAborted();
      const current = store.get(id);
      if (!current.enabled || current.digest !== digest) throw new Error('Script changed or disabled during execution');
      const args = resolveValue(step.arguments, inputs, outputs) as Record<string, unknown>;
      if (JSON.stringify(args).length > 16_000) throw new Error('Step arguments too large');
      // Do not race a mutation and pretend cancellation undid it. Wait for its receipt,
      // then stop before the next step. Tool-specific cancellation remains available.
      const raw = await invoke({ callId: `${runId}:${step.id}`, name: step.tool, arguments: args });
      const output = JSON.parse(JSON.stringify(raw, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value)) as Record<string, unknown>;
      const status = typeof output.state === 'string' ? output.state : typeof output.status === 'string' ? output.status : 'completed';
      // Keep receipts bounded before inserting them; never truncate a JSON document.
      if (JSON.stringify(output).length + JSON.stringify(result).length > 12_000) {
        result.steps.push({ id: step.id, tool: step.tool, status, result: { omitted: 'Output exceeds script budget' } });
        throw new Error('Step output too large; no further steps executed');
      }
      result.steps.push({ id: step.id, tool: step.tool, status, result: output });
      if (['outcome_unknown', 'timeout'].includes(status)) { result.status = 'outcome_unknown'; return result; }
      if (status === 'cancelled') { result.status = 'cancelled'; return result; }
      if (output.ok === false || ['failed', 'denied', 'cancelled', 'expired'].includes(status)) {
        result.error = 'A script step failed; earlier effects are not rolled back'; return result;
      }
      if (['awaiting_user', 'queued', 'dispatched', 'running', 'pending', 'sent'].includes(status)) {
        result.ok = true; result.status = 'pending'; return result;
      }
      outputs[step.id] = output;
    }
    signal.throwIfAborted();
    result.ok = true; result.status = 'completed';
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'failed';
    result.error = signal.aborted ? 'Stopped before further steps; earlier actions are not undone' :
      error instanceof Error ? error.message : 'Script failed';
  }
  return result;
}
