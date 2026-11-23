import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pipelinePython, pipelineScript } from '@termbridge/voice';

/** Warm outside the voice latency budget. No model/audio work if there is no accepted artifact. */
export class PipelineJudge {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private pending?: { id: string; finish: (decision?: 'respond' | 'wait') => void };
  constructor(private readonly root: string) {}
  start() {
    if (this.child) return;
    const child = spawn(pipelinePython(), [pipelineScript('judge_service.py'), this.root], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    this.child = child;
    let buffer = '';
    const warmDeadline = setTimeout(() => { if (!this.ready) this.stop(); }, 90_000); warmDeadline.unref();
    child.stderr.resume(); child.stdin.on('error', () => this.stop());
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 32_000) { this.stop(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const result = JSON.parse(line);
          if (result.ready === true) { this.ready = true; clearTimeout(warmDeadline); }
          if (result.id === this.pending?.id) this.pending?.finish(result.decision === 'respond' || result.decision === 'wait' ? result.decision : undefined);
        } catch { this.stop(); return; }
      }
    });
    const done = () => { clearTimeout(warmDeadline); if (this.child === child) this.stop(); };
    child.once('error', done); child.once('close', done);
  }
  predict(messages: { role: 'user' | 'assistant'; content: string }[], signal: AbortSignal): Promise<'respond' | 'wait' | undefined> {
    if (!this.ready || !this.child || this.pending || signal.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const id = randomUUID();
      const abort = () => this.stop();
      const timer = setTimeout(abort, 2200); timer.unref();
      const finish = (decision?: 'respond' | 'wait') => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending = undefined;
        resolve(signal.aborted ? undefined : decision);
      };
      this.pending = { id, finish };
      signal.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, messages }) + '\n');
      if (signal.aborted) abort();
    });
  }
  stop() {
    const child = this.child; this.child = undefined; this.ready = false;
    this.pending?.finish();
    if (child?.pid) {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { /* Already exited. */ }
    }
  }
}
