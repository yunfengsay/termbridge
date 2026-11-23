import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VoiceLearningRequestSchema, VoiceLearningResultSchema } from '@termbridge/protocol';
import { pipelineProcess } from '@termbridge/voice';
import { PipelineJudge } from './voicePipelineJudge.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = { id: string; group: string; label: 0 | 1; lang: 'zh' | 'en'; messages: { role: 'user'; content: string }[] };

/** Only explicit human-finished labels with text consent; addressed/DDSD is a different task. */
export function pipelineFeedback(stored: unknown, now = Date.now()): { consent: boolean; rows: Row[]; checkRows: Row[] } {
  const value = stored as { result?: unknown; contextConsent?: boolean; samples?: unknown };
  const result = VoiceLearningResultSchema.parse(value.result);
  const consent = value.contextConsent === true && result.status === 'completed';
  if (!consent) return { consent: false, rows: [], checkRows: [] };
  const request = VoiceLearningRequestSchema.parse({ t: 'voice_learning_sync', requestId: result.requestId,
    revision: result.revision, enabled: true, contextConsent: true, samples: value.samples });
  const rows: Row[] = [], checkRows: Row[] = [];
  for (const sample of request.samples) {
    if (sample.head !== 'finished' || !sample.text || sample.at < now - 30 * 86400_000 || sample.at > now + 300_000) continue;
    const row: Row = { id: sample.id, group: sample.group, label: sample.label,
      lang: /[\u3400-\u9fff]/u.test(sample.text) ? 'zh' : 'en',
      messages: [...(sample.context?.trim() ? [{ role: 'user' as const, content: sample.context.trim() }] : []),
        { role: 'user', content: sample.text }] };
    // Deterministic group holdout: never train its labels, even in later LoRA cycles.
    (parseInt(hash(sample.group).slice(0, 8), 16) % 5 === 0 ? checkRows : rows).push(row);
  }
  return { consent, rows, checkRows };
}

/** Optional inside tb serve; disabled unless directory + dedicated Python are explicitly configured. */
export class HostVoicePipeline {
  private training?: AbortController;
  private busy = false;
  private sourceDigest = '';
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private sourceReady = false;
  private peerHash = '';
  private judgeProcess?: PipelineJudge;
  private activeVersion = '';
  private generation = 0;
  private closed = false;
  private requiredRevisions = new Map<string, number>();
  private refreshQueue: Promise<void> = Promise.resolve();
  constructor(private readonly root: string | undefined, private readonly feedbackDirectory: string,
    private readonly isBusy: () => boolean, private readonly report: (event: Record<string, unknown>) => void = () => {},
    private readonly run = pipelineProcess) {}

  start() {
    if (!this.root || this.timer) return;
    this.closed = false;
    this.timer = setInterval(() => { void this.tick(); }, 30_000); this.timer.unref();
    void this.tick();
  }
  pauseTraining() { this.training?.abort(); }
  /** Call before applying any phone mutation: stale personal weights must not race revocation. */
  invalidate() { this.generation++; this.sourceReady = false; this.pauseTraining(); this.judgeProcess?.stop(); }
  invalidateForPeer(peerId: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const key = hash(peerId);
    this.requiredRevisions.set(key, Math.max(revision, this.requiredRevisions.get(key) ?? 0));
    if (!this.peerHash || this.peerHash === key) this.invalidate();
  }
  stop() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.invalidate(); }

  refresh(): Promise<void> {
    const operation = this.refreshQueue.catch(() => {}).then(() => this.refreshSource());
    this.refreshQueue = operation; return operation;
  }
  private async refreshSource() {
    if (!this.root || this.closed) return;
    let generation = this.generation;
    const config = JSON.parse(await readFile(join(this.root, 'config.json'), 'utf8'));
    if (typeof config.peerHash !== 'string' || !/^[0-9a-f]{64}$/.test(config.peerHash)) {
      throw new Error('Pipeline must be bound to one registered Peer hash');
    }
    this.peerHash = config.peerHash;
    // The already authenticated/validated store is authoritative, never raw untrusted phone data.
    let snapshot: ReturnType<typeof pipelineFeedback>;
    try {
      const stored = JSON.parse(await readFile(join(this.feedbackDirectory, `${this.peerHash}.json`), 'utf8'));
      if (stored.result?.revision < (this.requiredRevisions.get(this.peerHash) ?? 0)) {
        // A failed/in-flight phone mutation must not silently restore the previous consent/model.
        this.sourceReady = false; return;
      }
      snapshot = pipelineFeedback(stored);
    }
    catch { snapshot = { consent: false, rows: [], checkRows: [] }; } // Missing/corrupt store withdraws learning.
    const digest = hash(JSON.stringify(snapshot));
    if (this.closed || generation !== this.generation) return;
    if (digest !== this.sourceDigest) {
      this.invalidate();
      generation = this.generation;
      const state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'));
      this.revision = Math.max(Date.now(), Number(state.revision) + 1, this.revision + 1);
      const result = await this.run(['sync', this.root], { input: { revision: this.revision, ...snapshot }, timeoutMs: 10_000 });
      if (!['queued', 'unchanged', 'revoked'].includes(String(result.status))) throw new Error('Pipeline sync rejected');
      if (this.closed || generation !== this.generation) return;
      this.sourceDigest = digest;
    }
    this.sourceReady = snapshot.consent;
    await this.warmJudge();
  }
  private async warmJudge() {
    if (!this.root || !this.sourceReady || this.closed) return;
    const generation = this.generation;
    const state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'));
    if (!this.sourceReady || this.closed || generation !== this.generation) return;
    if (!state.consent || !state.active) { this.judgeProcess?.stop(); this.activeVersion = ''; return; }
    if (this.activeVersion !== state.active.receiptSha) {
      // A running call keeps its existing immutable model; switch only between calls.
      if (this.isBusy()) return;
      this.judgeProcess?.stop(); this.judgeProcess = new PipelineJudge(this.root);
      this.activeVersion = state.active.receiptSha;
    }
    if (!this.isBusy()) this.judgeProcess?.start();
  }
  async judge(peerId: string, messages: { role: 'user' | 'assistant'; content: string }[], signal: AbortSignal) {
    if (this.closed || !this.sourceReady || !peerId || hash(peerId) !== this.peerHash || !this.judgeProcess) return undefined;
    const generation = this.generation;
    // Retention/deletion can change the authority file between scheduled ticks.
    try {
      const snapshot = pipelineFeedback(JSON.parse(await readFile(join(this.feedbackDirectory, `${this.peerHash}.json`), 'utf8')));
      if (hash(JSON.stringify(snapshot)) !== this.sourceDigest) { this.invalidate(); void this.refresh().catch(() => {}); return undefined; }
    } catch { this.invalidate(); return undefined; }
    if (this.closed || !this.sourceReady || signal.aborted || generation !== this.generation) return undefined;
    return this.judgeProcess.predict(messages, signal);
  }
  async tick() {
    if (!this.root || this.busy || this.closed) return;
    this.busy = true;
    try {
      await this.refresh();
      if (this.closed || !this.sourceReady || this.isBusy()) return;
      this.training = new AbortController();
      const monitor = setInterval(() => { if (this.isBusy()) this.pauseTraining(); }, 250); monitor.unref();
      try {
        const result = await this.run(['run', this.root, '--idle'], { signal: this.training.signal });
        this.report({ event: 'voice_pipeline', status: result.status, mode: result.mode, id: result.id });
        await this.warmJudge();
      } finally { clearInterval(monitor); this.training = undefined; }
    } catch { this.report({ event: 'voice_pipeline_unavailable' }); }
    finally { this.busy = false; }
  }
}
