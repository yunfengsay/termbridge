import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
declare const __TB_BUNDLED__: boolean;

export function pipelineScript(name = 'pipeline.py'): string {
  const bundled = typeof __TB_BUNDLED__ !== 'undefined' && __TB_BUNDLED__;
  return fileURLToPath(new URL(bundled ? `./livekit-turn/${name}` : `../../../training/livekit-turn/${name}`, import.meta.url));
}
export function pipelinePython(): string { return process.env.TB_VOICE_TRAINING_PYTHON || 'python3'; }

/** One bounded subprocess group; stdout is metadata JSON, stderr is never forwarded to clients. */
export function pipelineProcess(args: string[], options: {
  input?: unknown; signal?: AbortSignal; timeoutMs?: number; python?: string;
} = {}): Promise<Record<string, unknown>> {
  if (options.signal?.aborted) return Promise.reject(new Error('Pipeline cancelled'));
  const payload = options.input === undefined ? '' : JSON.stringify(options.input);
  return new Promise((resolve, reject) => {
    const child = spawn(options.python || pipelinePython(), [pipelineScript(), ...args], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    let stdout = '', reason = '', settled = false, force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* Already reaped. */ }
    };
    const stop = (why: string) => {
      if (reason) return; reason = why; kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 4000); force.unref();
    };
    const abort = () => stop('Pipeline cancelled');
    const timer = setTimeout(() => stop('Pipeline deadline'), options.timeoutMs ?? 4800_000); timer.unref();
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 32_000) stop('Pipeline output limit'); });
    child.stderr.resume();
    child.stdin.on('error', () => { /* Exit handler supplies the bounded failure. */ });
    child.once('error', () => finish(new Error('Pipeline runtime unavailable; configure TB_VOICE_TRAINING_PYTHON')));
    child.once('close', code => {
      if (reason) { kill('SIGKILL'); finish(new Error(reason)); return; }
      try {
        const value = JSON.parse(stdout.trim());
        if (!value || typeof value !== 'object' || Array.isArray(value) || (code !== 0 && !['failed', 'rejected', 'cancelled', 'timed-out'].includes(value.status))) throw new Error();
        finish(undefined, value);
      } catch { finish(new Error('Pipeline worker failed; inspect its local job receipt')); }
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(payload);
  });
}
