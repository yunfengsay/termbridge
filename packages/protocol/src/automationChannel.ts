import { EventEmitter } from 'node:events';
import type { AutomationMessage } from './automation.js';

/** Each data chunk consumes one credit until its receiver has written it. */
export class Channel extends EventEmitter {
  readonly controller = new AbortController();
  private sequence = 0;
  private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly id: string, private transmit: (m: AutomationMessage) => void) { super(); }
  get signal(): AbortSignal { return this.controller.signal; }
  send(m: Omit<AutomationMessage, 't' | 'id'>) {
    this.signal.throwIfAborted(); this.transmit({ t: 'automation', id: this.id, ...m });
  }
  receive(m: AutomationMessage) {
    if (m.kind === 'ack' && m.seq !== undefined) {
      const p = this.pending.get(m.seq!);
      if (p) { this.pending.delete(m.seq!); clearTimeout(p.timer); p.resolve(); }
    } else if (m.kind === 'cancel') this.abort();
    else this.emit('message', m);
  }
  async data(data: Buffer, stream = 'stdout') {
    for (let offset = 0; offset < data.length; offset += 65536) {
      this.signal.throwIfAborted();
      const seq = ++this.sequence;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error('stream acknowledgement timed out')); this.abort(); }, 70000);
        this.pending.set(seq, { resolve, reject, timer });
        try { this.send({ kind: 'data', seq, stream, data: data.subarray(offset, offset + 65536).toString('base64') }); }
        catch (error) { clearTimeout(timer); this.pending.delete(seq); reject(error); }
      });
    }
  }
  abort() {
    if (this.signal.aborted) return;
    this.controller.abort(new Error('request disconnected or cancelled'));
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('request cancelled')); }
    this.pending.clear(); this.emit('cancel');
  }
}
