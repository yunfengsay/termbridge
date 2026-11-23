import type { BrainConversationToolResult } from '@termbridge/brain';

/** A successful fork/query is not a successful message delivery. Expose only
 * current-turn dispatch receipts, never infer a send from the model's answer. */
export function agentDeliveryReceipts(results: BrainConversationToolResult[]) {
  return results.filter(({ call }) => call.name === 'continue_agent' || call.name === 'dispatch_agent').map(({ call, output }) => {
    let result: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
    } catch { /* Malformed output is not proof of delivery. */ }
    return {
      tool: call.name, callId: call.callId, ok: result.ok === true,
      status: typeof result.status === 'string' ? result.status.slice(0, 80) : 'unknown',
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : undefined,
      name: typeof result.name === 'string' ? result.name : undefined,
      taskId: typeof result.taskId === 'string' ? result.taskId : undefined,
    };
  });
}

type Outcome = Record<string, unknown>;
const terminal = (value: Outcome) => ['completed', 'failed', 'denied', 'cancelled', 'expired'].includes(String(value.state));
type Action = { fork: string; call: string; result?: Outcome; resolve?: (value: Outcome) => void };

/** Each action has one speech owner: the active fork OR a later notification.
 * UI receipts remain independent and may report every state transition. */
export class VoiceActionOutcomes {
  private forks = new Map<string, string>();
  private actions = new Map<string, Action>();
  private delivered = new Set<string>();

  begin(fork: string, call: string): void { this.forks.set(fork, call); }
  track(id: string, fork: string): void {
    const call = this.forks.get(fork);
    if (call && !this.actions.has(id) && !this.delivered.has(id)) this.actions.set(id, { fork, call });
  }
  accept(id: string, result: Outcome): boolean {
    if (!terminal(result) || this.delivered.has(id)) return false;
    const action = this.actions.get(id);
    if (action && this.forks.has(action.fork)) {
      action.result = result;
      action.resolve?.(result);
      return false;
    }
    this.actions.delete(id);
    this.remember(id);
    return true;
  }
  async wait(id: string, initial: Outcome, timeoutMs = 8_000): Promise<Outcome> {
    const action = this.actions.get(id);
    if (!action) return initial;
    if (action.result) return action.result;
    if (terminal(initial)) { action.result = initial; return initial; }
    // Human approval is asynchronous; never hold a model turn waiting for a person.
    if (initial.state !== 'running') return initial;
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(initial), timeoutMs);
      const finish = (value: Outcome) => {
        clearTimeout(timer); action.resolve = undefined; resolve(value);
      };
      action.resolve = finish;
    });
  }
  finish(fork: string): Outcome[] {
    this.forks.delete(fork);
    const results: Outcome[] = [];
    for (const [id, action] of this.actions) {
      if (action.fork !== fork || !action.result) continue;
      results.push(action.result); this.remember(id); this.actions.delete(id);
    }
    return results;
  }
  close(call: string): void {
    for (const [fork, key] of this.forks) if (key === call) this.forks.delete(fork);
    for (const [id, action] of this.actions) {
      if (action.call !== call) continue;
      action.resolve?.({ actionId: id, state: 'cancelled', error: 'Voice call ended; native effects are not undone' });
      this.actions.delete(id); this.remember(id);
    }
  }
  private remember(id: string): void {
    this.delivered.add(id);
    while (this.delivered.size > 512) this.delivered.delete(this.delivered.values().next().value!);
  }
}

/** Durable history and realtime media are separate delivery lanes. Full history is
 * coalesced when idle, deferred throughout a call, flushed once on hangup. */
export class BrainSnapshotDelivery {
  private dirty = new Set<number>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  constructor(private active: (id: number) => boolean, private send: (id: number) => void,
    private intervalMs = 1_000) {}
  request(id: number): void {
    this.dirty.add(id);
    if (this.active(id) || this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.flush(id); }, this.intervalMs));
  }
  flush(id: number): void {
    if (this.active(id) || !this.dirty.has(id)) return;
    this.close(id); this.send(id);
  }
  close(id: number): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.dirty.delete(id);
  }
}
