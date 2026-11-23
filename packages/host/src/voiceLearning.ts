import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonalExamples, type ExampleHint, type PersonalExample } from '@termbridge/voice';
import { trainInBackground } from './voiceLearningTrainer.js';
import { VoiceLearningRequestSchema, VoiceLearningResultSchema,
  type VoiceLearningRequest, type VoiceLearningResult } from '@termbridge/protocol';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type Stored = { digest: string; contextConsent?: boolean; result: VoiceLearningResult; samples: VoiceLearningRequest['samples'] };
/** Runs inside every tb serve Host. No new public listener or credential. No PCM.
 * v2 short reviewed text requires independent consent; only retrieved cases reach the cloud judge. */
export class VoiceLearning {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pendingRevision = new Map<string, number>();
  constructor(private readonly directory: string) {}

  /** Hourly/startup retention job, also useful for deterministic administration tests. */
  async sweep(now = Date.now()): Promise<number> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    let changed = 0, failures = 0;
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 4096)) {
      const key = name.slice(0, -5), previous = this.queues.get(key) ?? Promise.resolve();
      const job = previous.catch(() => {}).then(async () => {
        const path = join(this.directory, name);
        const saved: Stored = JSON.parse(await readFile(path, 'utf8'));
        VoiceLearningResultSchema.parse(saved.result);
        const samples = saved.samples.filter(row => row.at >= now - RETENTION_MS);
        if (samples.length === saved.samples.length) return;
        const digest = createHash('sha256').update(JSON.stringify(samples)).digest('hex');
        if (saved.result.status === 'completed') Object.assign(saved.result, await trainInBackground({
          t: 'voice_learning_sync', requestId: saved.result.requestId, revision: saved.result.revision,
          enabled: true, samples, contextConsent: saved.contextConsent,
        }, digest));
        saved.samples = samples;
        await writeFile(`${path}.pending`, JSON.stringify(saved), { mode: 0o600 }); await rename(`${path}.pending`, path); changed++;
      });
      this.queues.set(key, job);
      try { await job; } catch { failures++; }
      finally { if (this.queues.get(key) === job) this.queues.delete(key); }
    }
    if (failures) throw new Error('Some personal snapshots could not be expired');
    return changed;
  }

  /** Read fresh on each judgement, including after cloud inference: revocation takes effect in calls. */
  async context(peerId: string, text: string, history = ''): Promise<{ version: string; hints: ExampleHint[]; rule?: 'ignore' | 'wait' }> {
    if (!peerId || peerId.length > 128) return { version: 'off', hints: [] };
    const key = createHash('sha256').update(peerId).digest('hex');
    // Training must not stall realtime turns. Until the newest snapshot commits, use the
    // generic judge; this also withdraws old examples immediately on deletion/revocation.
    if (this.pendingRevision.has(key)) return { version: `pending-${this.pendingRevision.get(key)}`, hints: [] };
    try {
      const saved: Stored = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8'));
      if (!saved.contextConsent || saved.result.status !== 'completed') return { version: 'off', hints: [] };
      const rows = this.examples(saved.samples);
      const index = new PersonalExamples(rows);
      return { version: `${saved.result.revision}:${rows.map(row => row.id).join(',')}`,
        hints: index.hints(text, history), rule: index.rule(text, history) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 'off', hints: [] };
      throw new Error('Personal context unavailable'); // No private content in exceptions.
    }
  }

  private examples(samples: VoiceLearningRequest['samples']): PersonalExample[] {
    const cutoff = Date.now() - RETENTION_MS;
    return samples.filter(row => row.at >= cutoff && row.text).map(row => ({
      id: row.id, group: row.group, head: row.head, label: row.label, text: row.text!, context: row.context,
    }));
  }

  sync(peerId: string, request: VoiceLearningRequest): Promise<VoiceLearningResult> {
    const failure = (): VoiceLearningResult => ({
      t: 'voice_learning_result', requestId: typeof request.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(request.requestId) ? request.requestId : randomUUID(),
      revision: Number.isSafeInteger(request.revision) && request.revision >= 0 ? request.revision : 0,
      status: 'failed', error: 'Personal control training or private storage failed; retry explicitly',
    });
    if (typeof peerId !== 'string' || !peerId || peerId.length > 128) return Promise.resolve(failure());
    const key = createHash('sha256').update(peerId).digest('hex');
    if (Number.isSafeInteger(request.revision) && request.revision > (this.pendingRevision.get(key) ?? 0)) this.pendingRevision.set(key, request.revision);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.apply(key, request)).catch(failure);
    this.queues.set(key, job);
    void job.finally(() => {
      if (this.queues.get(key) === job) this.queues.delete(key);
      if (this.pendingRevision.get(key) === request.revision) this.pendingRevision.delete(key);
    });
    return job;
  }

  private async apply(key: string, input: VoiceLearningRequest): Promise<VoiceLearningResult> {
    const request = VoiceLearningRequestSchema.parse(input);
    if (request.contextConsent !== true && request.samples.some(row => row.text !== undefined || row.context !== undefined)) throw new Error('Context consent required');
    if (request.samples.some(row => row.at > Date.now() + 300_000)) throw new Error('Future feedback is invalid');
    const path = join(this.directory, `${key}.json`);
    let old: { digest: string; result: VoiceLearningResult } | undefined;
    try {
      const decoded = JSON.parse(await readFile(path, 'utf8'));
      old = { digest: String(decoded.digest), result: VoiceLearningResultSchema.parse(decoded.result) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; // Corruption must not reset consent.
    }
    const digest = createHash('sha256').update(JSON.stringify({ enabled: request.enabled, samples: request.samples,
      ...(request.contextConsent === undefined ? {} : { contextConsent: request.contextConsent }) })).digest('hex');
    if (old && request.revision <= old.result.revision) {
      if (request.revision === old.result.revision && digest === old.digest) return { ...old.result, requestId: request.requestId };
      return { t: 'voice_learning_result', requestId: request.requestId, revision: old.result.revision, status: 'stale' };
    }
    const unique = new Set(request.samples.map(row => row.id));
    if (unique.size !== request.samples.length || (!request.enabled && request.samples.length)) throw new Error('Invalid snapshot');
    const result: VoiceLearningResult = { t: 'voice_learning_result', requestId: request.requestId,
      revision: request.revision, status: request.enabled ? 'completed' : 'revoked' };
    const samples = request.samples.filter(row => row.at >= Date.now() - RETENTION_MS);
    if (request.enabled) {
      Object.assign(result, await trainInBackground({ ...request, samples }, digest));
    }
    // An atomic single-file replacement also erases deleted samples/old weights. Revocation retains
    // only a revision tombstone, so reconnect replay cannot resurrect withdrawn consent.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.pending`;
    await writeFile(temporary, JSON.stringify({ digest, result,
      contextConsent: request.enabled && request.contextConsent === true,
      samples: request.enabled ? samples : [] }), { mode: 0o600 });
    await rename(temporary, path);
    return result;
  }
}
