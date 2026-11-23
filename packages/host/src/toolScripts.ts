import { createHash } from 'node:crypto';
import { ToolScriptStore, runToolScript, type ScriptCall } from '@termbridge/tool-scripts';

/** Host-local catalog. No approval endpoint is exposed to the model. */
export class ToolScripts {
  private active = new Map<string, AbortController>();
  constructor(readonly store = new ToolScriptStore()) {}

  cancel(id: string): Record<string, unknown> | undefined {
    const controller = this.active.get(id);
    if (!controller) return undefined;
    controller.abort();
    return { ok: true, id, status: 'cancelling',
      summary: 'Stop requested; waiting for the current tool receipt, then no further steps. Existing side effects and dispatched workers are not undone.' };
  }

  async execute(args: Record<string, unknown>, callKey: string,
    invoke: (call: ScriptCall) => Promise<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      if (Object.keys(args).some(k => !['action', 'id', 'digest', 'inputs', 'script', 'offset'].includes(k))) throw new Error('Unknown script argument');
      switch (args.action) {
        case 'list': {
          const offset = args.offset ?? 0;
          if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('Invalid catalog offset');
          const all = this.store.list();
          return { ok: true, scripts: all.slice(Number(offset), Number(offset) + 16).map(({ inputs: _inputs, ...summary }) => summary),
            nextOffset: Number(offset) + 16 < all.length ? Number(offset) + 16 : null, activeRunIds: [...this.active.keys()] };
        }
        case 'show': {
          if (typeof args.id !== 'string') throw new Error('id is required');
          return { ok: true, ...this.store.get(args.id) };
        }
        case 'save': return { ok: true, ...this.store.save(args.script) };
        case 'run': {
          if (typeof args.id !== 'string' || typeof args.digest !== 'string' || !args.inputs ||
              typeof args.inputs !== 'object' || Array.isArray(args.inputs)) throw new Error('run requires id, digest and inputs');
          if (this.active.size >= 4) throw new Error('Too many active scripts');
          const runId = `script-${createHash('sha256').update(callKey).digest('hex').slice(0, 24)}`;
          if (this.active.has(runId)) throw new Error('This script call is already running');
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          this.active.set(runId, controller);
          try {
            return { ...await runToolScript(this.store, args.id, args.digest,
              args.inputs as Record<string, unknown>, runId, invoke, controller.signal) };
          } finally {
            this.active.delete(runId);
            signal?.removeEventListener('abort', abort);
          }
        }
        default: throw new Error('Unknown script action; approval is local only');
      }
    } catch (error) {
      return { ok: false, status: 'failed', error: error instanceof Error ? error.message : 'Script failed', retryable: false };
    }
  }
}
