export type TurnDecision = 'respond' | 'wait' | 'ignore';
export type TurnVerdict = TurnDecision | { decision: TurnDecision; intent?: string; clarification?: string };
export type TurnJudge = (input: { segments: readonly string[]; clarification?: string; clarificationAfterSegment?: number; signal: AbortSignal }) => Promise<TurnVerdict>;
export interface TurnClock {
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(id: unknown): void;
}
const realClock: TurnClock = {
  now: Date.now, later: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** One commit point. ASR final is a revision, never automatic permission to respond.
 * New speech invalidates timers and in-flight judges, even if they ignore AbortSignal.
 * WAIT spends no further tokens on unchanged context. No tool execution happens here.
 */
export class TurnCoordinator {
  private epoch = 0;
  private speaking = false;
  private stoppedAt = 0;
  private activeItem = '';
  private pendingSince?: number;
  private items = new Map<string, string>();
  private committed = new Set<string>();
  private checks: number[] = [];
  private timer: unknown;
  private judgeAbort?: AbortController;
  private closed = false;
  private retriedEpoch = -1;
  private clarification?: string;
  private clarificationAfterSegment?: number;
  constructor(
    private readonly judge: TurnJudge,
    private readonly commit: (text: string, intent?: string) => void,
    private readonly waiting: (reason: 'incomplete' | 'judge_unavailable' | 'limit' | 'budget' | 'not_addressed') => void,
    private readonly clock: TurnClock = realClock,
    private readonly clarify?: (input: { text: string; question: string }) => void,
  ) {}
  get pendingText(): string { return [...this.items.values()].filter(Boolean).join(' ').trim(); }
  get pendingClarification(): string | undefined { return this.clarification; }
  speechStart(id: string) {
    if (this.closed) return;
    if (this.items.size && this.pendingSince !== undefined && this.clock.now() - this.pendingSince > 30_000) {
      this.items.clear(); this.pendingSince = undefined; this.clarification = undefined; this.clarificationAfterSegment = undefined; this.waiting('limit');
    }
    this.invalidate(); this.speaking = true; this.activeItem = id;
    this.pendingSince ??= this.clock.now();
    if (!this.items.has(id)) this.items.set(id, '');
    if (this.items.size > 12) {
      this.items.clear(); this.items.set(id, ''); this.pendingSince = this.clock.now();
      this.clarification = undefined; this.clarificationAfterSegment = undefined; this.waiting('limit');
    }
  }
  speechStop(id?: string, alreadySilentMs = 0) {
    if (this.closed || (id && id !== this.activeItem)) return;
    this.speaking = false; this.stoppedAt = this.clock.now() - Math.max(0, Math.min(6000, alreadySilentMs)); this.schedule();
  }
  transcript(id: string, text: string) {
    if (this.closed || this.committed.has(id)) return;
    // Only speech_started can introduce an item. A late final after explicit cancel
    // must not resurrect a cleared turn or become an unsolicited new request.
    if (!this.items.has(id)) return;
    // An explicit empty final is terminal, unlike a final that has not arrived.
    // Leaving its placeholder here blocks every subsequent complete utterance.
    if (!text.trim()) { this.rejectItem(id); return; }
    if (this.items.get(id) === text) return; // Provider duplicate final.
    this.invalidate(); this.items.set(id, text.slice(0, 4000));
    this.activeItem ||= id;
    this.schedule();
  }
  private schedule() {
    if (this.closed || this.speaking || !this.items.get(this.activeItem)) return;
    if ([...this.items.values()].some(text => !text)) return; // A preceding final is still missing.
    const current = this.items.get(this.activeItem)!;
    // This is only a scheduling hint. A punctuation mark cannot grant execution permission.
    const pauseMs = /[的把和跟因为所以然后而且，,]$/.test(current.trim()) || current.length < 6 ? 3000 : 1800;
    const epoch = this.epoch;
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = this.clock.later(() => {
      this.timer = undefined;
      void this.check(epoch);
    }, Math.max(0, pauseMs - (this.clock.now() - this.stoppedAt)));
  }
  private async check(epoch: number) {
    if (this.closed || epoch !== this.epoch || this.speaking) return;
    const segments = [...this.items.values()];
    this.checks = this.checks.filter(at => this.clock.now() - at < 60_000);
    if (this.checks.length >= 12) { this.waiting('budget'); return; }
    this.checks.push(this.clock.now());
    if (segments.join('').length > 6000) { this.waiting('limit'); return; }
    const abort = new AbortController(); this.judgeAbort = abort;
    let timeout: unknown;
    let aborted: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      aborted = () => reject(new Error('Turn superseded'));
      abort.signal.addEventListener('abort', aborted, { once: true });
    });
    const expiry = new Promise<never>((_, reject) => {
      timeout = this.clock.later(() => { abort.abort(); reject(new Error('Turn judge deadline')); }, 3500);
    });
    try {
      const verdict = await Promise.race([this.judge({ segments, clarification: this.clarification,
        clarificationAfterSegment: this.clarificationAfterSegment, signal: abort.signal }), expiry, cancellation]);
      const decision = typeof verdict === 'string' ? verdict : verdict.decision;
      const intent = typeof verdict === 'string' ? undefined : verdict.intent?.slice(0, 400);
      if (this.closed || epoch !== this.epoch || this.speaking || abort.signal.aborted) return;
      if (decision === 'ignore') {
        this.cancel(); this.waiting('not_addressed'); return; // No clarification or tool, next speech can start fresh.
      }
      if (decision !== 'respond') {
        this.waiting('incomplete');
        this.scheduleClarification(epoch, typeof verdict === 'string' ? undefined : verdict.clarification);
        return;
      }
      this.items.forEach((_, id) => this.committed.add(id));
      while (this.committed.size > 128) this.committed.delete(this.committed.values().next().value!);
      this.items.clear(); this.activeItem = ''; this.pendingSince = undefined; this.clarification = undefined;
      this.clarificationAfterSegment = undefined; this.invalidate();
      this.commit(segments.join(' ').trim(), intent);
    } catch {
      if (!this.closed && epoch === this.epoch && !this.speaking) {
        if (this.retriedEpoch !== epoch) {
          this.retriedEpoch = epoch;
          this.timer = this.clock.later(() => { this.timer = undefined; void this.check(epoch); }, 250);
        } else this.waiting('judge_unavailable');
      }
    } finally {
      if (timeout !== undefined) this.clock.cancel(timeout);
      abort.signal.removeEventListener('abort', aborted!);
      if (this.judgeAbort === abort) this.judgeAbort = undefined;
    }
  }
  private scheduleClarification(epoch: number, question?: string) {
    if (!this.clarify || this.clarification) return;
    // No second model poll, no task permission, and no repeated prompting on silence.
    this.timer = this.clock.later(() => {
      this.timer = undefined;
      if (this.closed || this.speaking || this.epoch !== epoch || this.clarification || !this.items.size) return;
      this.clarification = question?.trim().slice(0, 120) || '你想接着说吗？我还在听。';
      this.clarificationAfterSegment = this.items.size;
      this.clarify!({ text: [...this.items.values()].join(' ').trim(), question: this.clarification });
    }, Math.max(0, 8000 - (this.clock.now() - this.stoppedAt)));
  }
  private invalidate() {
    this.epoch++;
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined; this.judgeAbort?.abort(); this.judgeAbort = undefined;
  }
  cancel() {
    this.invalidate(); this.items.clear(); this.activeItem = ''; this.pendingSince = undefined;
    this.clarification = undefined; this.clarificationAfterSegment = undefined; this.speaking = false;
  }
  rejectItem(id: string) {
    const index = [...this.items.keys()].indexOf(id);
    if (this.closed || index < 0) return;
    if (index >= 0 && this.clarificationAfterSegment !== undefined && index < this.clarificationAfterSegment) this.clarificationAfterSegment--;
    this.invalidate(); this.items.delete(id);
    if (this.activeItem === id) {
      this.activeItem = [...this.items.keys()].at(-1) || '';
      this.speaking = false;
      this.stoppedAt = this.clock.now();
    }
    if (!this.items.size) { this.pendingSince = undefined; this.clarification = undefined; this.clarificationAfterSegment = undefined; }
    this.waiting('incomplete');
    this.schedule();
  }
  close() { this.closed = true; this.cancel(); }
}
