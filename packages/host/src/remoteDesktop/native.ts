import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolResponse } from '../bridge.js';

declare const __TB_BUNDLED__: boolean;
const bundled = typeof __TB_BUNDLED__ !== 'undefined' && __TB_BUNDLED__;
const here = dirname(fileURLToPath(import.meta.url));
export const screenOperations = new Set([
  'status', 'permissions', 'displays', 'capture', 'inspect', 'pointer', 'key', 'text', 'scroll', 'space', 'press', 'release',
]);
export function isLocalScreenOperation(op: string): boolean {
  return op === 'screen.attention' || (op.startsWith('screen.') && screenOperations.has(op.slice(7)));
}

export type DesktopEvent = Record<string, unknown> & { event: string };
type Pending = { resolve: (result: ToolResponse) => void; timer: NodeJS.Timeout };

/** Sole owner of the private native process. Never retries a possibly delivered input. */
export class NativeDesktop {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closing: Promise<void> | undefined;
  private closed = false;
  private idle: NodeJS.Timeout | undefined;
  private streaming = false;
  onEvent?: (event: DesktopEvent) => void;

  constructor(private readonly options: { executable?: string; args?: string[]; timeoutMs?: number; idleMs?: number } = {}) {}

  private launch(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const executable = this.options.executable ?? process.env.TB_DESKTOP_HELPER ?? (bundled
      ? resolve(here, 'native/termbridge-desktop')
      : resolve(here, '../../../../macos/TermBridgeDesktop/.build/debug/termbridge-desktop'));
    if (!this.options.executable && process.platform !== 'darwin') throw new Error('Desktop capture currently requires macOS 14 or newer');
    if (!existsSync(executable)) throw new Error('TermBridge Desktop helper is missing; rebuild or update the Host');
    const child = spawn(executable, this.options.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffered = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 24 * 1024 * 1024) { void this.retire('Desktop helper output exceeded limit'); return; }
      let newline: number;
      while ((newline = buffered.indexOf(10)) >= 0) {
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (!message || typeof message !== 'object') throw new Error('invalid message');
          if (typeof message.event === 'string') {
            this.onEvent?.(message as DesktopEvent);
          } else {
            const pending = this.pending.get(String(message.id));
            if (!pending) continue;
            if (typeof message.ok !== 'boolean') throw new Error('invalid reply');
            clearTimeout(pending.timer); this.pending.delete(String(message.id));
            pending.resolve(message as unknown as ToolResponse);
            this.armIdle();
          }
        } catch { void this.retire('Invalid desktop helper output'); return; }
      }
    });
    // Drain diagnostics; screen content and accessibility text never enter Host logs.
    child.stderr.resume();
    child.stdin.on('error', () => { void this.retire('Desktop input pipe failed'); });
    child.on('error', () => { void this.retire('Desktop helper failed to launch'); });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined; this.streaming = false;
      this.failPending('Desktop helper exited; execution outcome unknown (not retried)');
      this.onEvent?.({ event: 'closed' });
    });
    return child;
  }

  async request(op: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
    if (this.closed) return { ok: false, error: 'Desktop service is closed' };
    if (this.closing) await this.closing;
    if (this.closed) return { ok: false, error: 'Desktop service is closed' };
    if (!screenOperations.has(op) && !['start', 'stop', 'ack'].includes(op)) return { ok: false, error: 'Unsupported desktop operation' };
    if (this.pending.size >= 48) return { ok: false, error: 'Desktop command queue is full' };
    let child: ChildProcessWithoutNullStreams;
    try { child = this.launch(); } catch (error) { return { ok: false, error: (error as Error).message }; }
    clearTimeout(this.idle);
    const id = `desktop-${++this.sequence}`;
    const line = JSON.stringify({ ...args, id, op }) + '\n';
    if (Buffer.byteLength(line) > 1_048_576) return { ok: false, error: 'Desktop request too large' };
    if (op === 'start') this.streaming = true;
    const result = await new Promise<ToolResponse>((resolve) => {
      const timer = setTimeout(() => { void this.retire('Desktop operation timed out; execution outcome unknown (not retried)'); }, this.options.timeoutMs ?? 15_000);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(line);
    });
    if (op === 'stop' || (op === 'start' && !result.ok)) this.streaming = false;
    this.armIdle();
    return result;
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    if (!this.pending.size && !this.streaming && !this.closed) {
      this.idle = setTimeout(() => { void this.retire('Desktop helper idle'); }, this.options.idleMs ?? 45_000);
      this.idle.unref();
    }
  }

  private failPending(error: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error }); }
    this.pending.clear();
  }

  private retire(reason: string): Promise<void> {
    if (this.closing) return this.closing;
    clearTimeout(this.idle); this.streaming = false;
    const child = this.child;
    this.child = undefined;
    this.failPending(reason);
    if (!child) return Promise.resolve();
    // EOF releases held keys/buttons in the helper. Wait before replacing its owner.
    this.closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    }).finally(() => { this.closing = undefined; });
    this.onEvent?.({ event: 'closed' });
    return this.closing;
  }

  async close(): Promise<void> { this.closed = true; await this.retire('Desktop service closed; execution outcome unknown (not retried)'); }
  async reset(): Promise<void> { await this.retire('Desktop session ended; execution outcome unknown (not retried)'); }
}
